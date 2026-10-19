import { loadConfig, networkConfigs } from "./config.ts";
import { openDatabasePool } from "./lib/db.ts";
import { makeRpc } from "./lib/stellar.ts";
import { makeSimulationReader, TokenMetadataService } from "./lib/tokens.ts";
import { createApp } from "./app.ts";
import { Indexer } from "./indexer.ts";
import { Keeper } from "./keeper.ts";
import type { AdminHooks } from "./routes/admin.ts";
import { logger } from "./lib/logger.ts";
import { drain, every, serial, type Loop } from "./lib/loop.ts";
import { Reconciler } from "./reconcile.ts";
import { initTelemetry, withSpan } from "./lib/telemetry.ts";

const config = loadConfig();
const stopTelemetry = initTelemetry(config.OTEL_EXPORTER_OTLP_ENDPOINT);
const networks = networkConfigs(config);

// One indexer and one database per network, so cursors and projections never
// mix. `runtimes[0]` is the default network: it serves the unprefixed routes.
const runtimes = networks.map((network) => {
  const pool = openDatabasePool(network.databasePath, {
    min: network.minConns,
    max: network.maxConns,
  });
  const server = makeRpc(network);
  // The API reads through the shared connection; the indexer takes a
  // connection of its own, so a pass never shares a handle with API traffic.
  const indexer = new Indexer(pool.acquire(), server, network);
  const runPass = serial(async () => {
    try {
      const r = await withSpan(`indexer.pass.${network.name}`, () => indexer.tick());
      indexer.status.lastRunAt = Date.now();
      indexer.status.lastError = null;
      if (r.applied > 0) {
        logger.info({ network: network.name, events: r.applied, cursor: r.cursor }, "indexed");
      }
      return r;
    } catch (err) {
      indexer.status.lastError = err instanceof Error ? err.message : String(err);
      logger.error({ err, network: network.name }, "indexer pass failed");
      throw err;
    }
  });
  // Token metadata is read from the token contract itself through the same
  // RPC failover the indexer uses, cached by contract id (see lib/tokens.ts).
  const tokens = new TokenMetadataService(
    makeSimulationReader(server, network.networkPassphrase),
    { networkPassphrase: network.networkPassphrase },
  );
  // Re-reads a sample of active mandates from the contract and repairs any
  // drift the indexer missed (RPC gap, bug, outage mid-range).
  const reconciler = new Reconciler(
    pool.acquire(),
    server,
    network.subscriptionId,
    network.networkPassphrase,
    config.RECONCILE_SAMPLE_SIZE,
    // A repaired mandate changes the merchant's summary; evict it so the API
    // serves the corrected projection instead of a stale cache entry.
    (merchant) => indexer.merchantCache.invalidate(merchant),
  );
  return { network, pool, db: pool.shared, server, indexer, runPass, tokens, reconciler };
});
const defaultRuntime = runtimes[0]!;

const keeper = config.KEEPER_ENABLED
  ? new Keeper(defaultRuntime.pool.acquire(), defaultRuntime.server, config)
  : undefined;
const activeKeeper = keeper;
if (keeper) {
  if (runtimes.length > 1) {
    logger.warn(
      { network: defaultRuntime.network.name },
      "keeper settles the default network only",
    );
  }
  logger.info(
    { keeper: keeper.publicKey, channels: keeper.channelCount, network: defaultRuntime.network.name },
    "keeper enabled",
  );
} else {
  logger.info("keeper disabled (KEEPER_ENABLED=false)");
}

const runKeeperPass = keeper
  ? serial(async () => {
      try {
        const results = await withSpan("keeper.pass", () => keeper.tick());
        const settled = results.filter((r) => r.status === "settled").length;
        if (results.length > 0) logger.info({ settled, attempted: results.length }, "keeper pass");
        return results;
      } catch (err) {
        logger.error({ err }, "keeper pass failed");
        throw err;
      }
    })
  : undefined;

const adminHooks: AdminHooks = {
  reindex: async () => {
    const results = await Promise.all(runtimes.map((rt) => rt.runPass()));
    return results[0]!;
  },
  // Runtime indexer control: hold every network's loop back without taking the
  // API down. While paused, each tick is a no-op, so the cursor and projection
  // are preserved and /health reports `indexer.paused: true`.
  pauseIndexer: () => {
    for (const rt of runtimes) rt.indexer.pause();
    return null;
  },
  resumeIndexer: () => {
    for (const rt of runtimes) rt.indexer.resume();
    return null;
  },
};
if (keeper && runKeeperPass) {
  adminHooks.keeperPass = () => runKeeperPass();
  adminHooks.keeperBackoff = () => keeper.backoffList();
  adminHooks.keeperHistory = () => keeper.passHistory();
}

const app = createApp(
  runtimes.map((rt) => ({
    config: rt.network,
    db: rt.db,
    events: rt.indexer.events,
    indexer: rt.indexer.status,
    summaryCache: rt.indexer.merchantCache,
    rpc: rt.server,
    tokens: rt.tokens,
  })),
  config,
  adminHooks,
);

const http = app.listen(config.PORT, () => {
  logger.info(
    { port: config.PORT, networks: networks.map((n) => n.name) },
    "api listening",
  );
});

for (const rt of runtimes) {
  logger.info(
    { network: rt.network.name, pool: rt.pool.stats() },
    "database pool ready",
  );
}

const loops: Loop[] = [];

for (const rt of runtimes) {
  loops.push(
    every(config.INDEXER_INTERVAL_MS, async () => {
      try {
        await rt.runPass();
      } catch {
        // Handled in runPass
      }
    }),
  );
  loops.push(
    every(config.RECONCILE_INTERVAL_MS, async () => {
      try {
        const r = await rt.reconciler.tick();
        rt.indexer.status.reconciliations = (rt.indexer.status.reconciliations ?? 0) + 1;
        rt.indexer.status.corrections = (rt.indexer.status.corrections ?? 0) + r.corrections;
        if (r.errors > 0) {
          logger.warn(
            {
              network: rt.network.name,
              sampled: r.sampled,
              onChain: r.onChain,
              errors: r.errors,
              lastError: r.lastError,
            },
            "reconcile pass had failures",
          );
        }
        if (r.corrections > 0) {
          logger.info(
            { network: rt.network.name, corrections: r.corrections, sampled: r.sampled },
            "reconcile pass corrected drift",
          );
        }
      } catch {
        // Reconciler.tick logs and swallows its own failures; this is defensive.
      }
    }),
  );
}

if (runKeeperPass) {
  loops.push(
    every(config.KEEPER_INTERVAL_MS, async () => {
      try {
        await runKeeperPass();
      } catch {
        // Handled in runKeeperPass
      }
    }),
  );
}

/**
 * Rotate the keeper key without downtime: update KEEPER_SECRET /
 * KEEPER_SECRET_NEXT (and the rest of the env), then `kill -HUP <pid>`.
 * Node re-reads `.env`, the config is re-validated and the running keeper
 * swaps its signing keys mid-loop; the next successful pass logs that the
 * previous key can be retired.
 */
process.on("SIGHUP", () => {
  logger.info("SIGHUP received; reloading configuration");
  try {
    process.loadEnvFile();
  } catch {
    // No .env file to re-read; the process environment is the source of truth.
  }
  try {
    const next = loadConfig();
    if (activeKeeper) {
      activeKeeper.reloadFromConfig(next);
    } else {
      logger.info("configuration reloaded; keeper is not running");
    }
  } catch (err) {
    logger.error({ err }, "configuration reload failed; keeping the previous config");
  }
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutting down");
  // Let a pass that is mid-write or mid-transaction finish before the database
  // closes, but never hang forever on a stuck RPC call.
  const outcome = await drain(loops, config.SHUTDOWN_TIMEOUT_MS);
  if (outcome === "timeout") logger.warn({ timeoutMs: config.SHUTDOWN_TIMEOUT_MS }, "passes still running; closing anyway");
  await stopTelemetry().catch(() => {});
  http.close(() => {
    for (const rt of runtimes) rt.pool.close();
    process.exit(0);
  });
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
