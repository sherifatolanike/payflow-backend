/** Index every configured network until caught up, then exit. For cron and backfills. */
import { loadConfig, networkConfigs } from "../config.ts";
import { openDatabasePool } from "../lib/db.ts";
import { makeRpc } from "../lib/stellar.ts";
import { Indexer } from "../indexer.ts";
import { logger } from "../lib/logger.ts";

const config = loadConfig();
let failed = false;

for (const network of networkConfigs(config)) {
  const pool = openDatabasePool(network.databasePath, {
    min: network.minConns,
    max: network.maxConns,
  });
  const indexer = new Indexer(pool.acquire(), makeRpc(network), network);
  try {
    const events = await indexer.catchUp();
    logger.info({ network: network.name, events }, "backfill complete");
  } catch (err) {
    failed = true;
    logger.error({ err, network: network.name }, "backfill failed");
  } finally {
    pool.close();
  }
}

if (failed) process.exitCode = 1;
