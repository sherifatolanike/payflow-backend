import { extname } from "node:path";
import { BASE_FEE, StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";

/** Split a comma-separated URL list, dropping blanks and duplicates. */
function rpcUrls(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(",")) {
    const url = part.trim();
    if (url !== "") seen.add(url);
  }
  return [...seen];
}

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Upper bound on the connections a pool may open. SQLite needs a file handle
 * per connection, so a typo in a pool size must not open thousands of them.
 */
const MAX_DATABASE_CONNS = 64;

const contractId = z
  .string()
  .refine((value) => StrKey.isValidContract(value), "must be a valid Stellar contract ID");
const optionalSecret = z
  .string()
  .optional()
  .transform((value) => (value === "" ? undefined : value))
  .refine(
    (value) => value === undefined || StrKey.isValidEd25519SecretSeed(value),
    "must be a valid Stellar secret seed",
  );

const schema = z.object({
  STELLAR_NETWORK: z.string().default("testnet"),
  /** One or more RPC endpoints; the client fails over between them. */
  SOROBAN_RPC_URL: z
    .string()
    .default("https://soroban-testnet.stellar.org")
    .transform(rpcUrls)
    .pipe(
      z
        .array(z.string().refine(isHttpUrl, "must be an http(s) URL"))
        .min(1, "must list at least one URL"),
    ),
  NETWORK_PASSPHRASE: z.string().default("Test SDF Network ; September 2015"),

  PLAN_REGISTRY_ID: contractId,
  VAULT_ID: contractId,
  SUBSCRIPTION_ID: contractId,
  TOKEN_ID: contractId.optional(),

  /** Extra networks to serve beside the default, comma-separated. */
  NETWORKS: z.string().default(""),

  KEEPER_SECRET: optionalSecret,
  /**
   * Standby key for zero-downtime rotation. When set, the keeper falls back
   * to it if `KEEPER_SECRET` becomes unusable mid-pass, and accepts it as the
   * new primary on SIGHUP without a restart.
   */
  KEEPER_SECRET_NEXT: optionalSecret,
  /**
   * Extra channel accounts, comma-separated. Each channel signs and sequences
   * its own transactions (paying its own fees), so one pass can settle in
   * parallel instead of one account at a time. `KEEPER_SECRET` stays the
   * first channel, which keeps single-key setups unchanged. Duplicates of the
   * primary/standby keys or of each other are dropped by the keeper.
   */
  KEEPER_CHANNEL_SECRETS: z
    .string()
    .default("")
    .transform((raw) => raw.split(",").map((part) => part.trim()).filter(Boolean))
    .pipe(
      z.array(
        z
          .string()
          .refine(StrKey.isValidEd25519SecretSeed, "must be a valid Stellar secret seed"),
      ),
    ),
  KEEPER_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  /**
   * Which due mandate to settle first: `oldest` (due date ascending, the
   * historical behaviour) or `largest` (amount descending, to prioritise
   * high-value mandates under a fee budget).
   */
  KEEPER_ORDER: z.enum(["oldest", "largest"]).default("oldest"),
  KEEPER_FEE_PERCENTILE: z.enum(["50", "60", "70", "80", "90", "95", "99"]).default("90"),
  KEEPER_MAX_FEE: z.coerce
    .bigint()
    .min(BigInt(BASE_FEE), `must be at least BASE_FEE (${BASE_FEE})`)
    .default(100_000n),
  KEEPER_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true"),

  INDEXER_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
  INDEXER_START_LEDGER: z.coerce.number().int().nonnegative().default(0),
  /**
   * How often the reconciler re-checks a sample of active mandates against the
   * contract state. An indexer pass can miss an event (RPC gap, bug); this
   * pass repairs drift the projection would otherwise keep forever.
   */
  RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(600_000),
  /**
   * How many active mandates one reconcile pass samples. Each sampled mandate
   * costs one read-only RPC simulation, so keep this small relative to the
   * interval.
   */
  RECONCILE_SAMPLE_SIZE: z.coerce.number().int().positive().default(25),
  /**
   * How many ledger windows one pass may fetch at once. Events are still
   * applied in ledger order and the cursor advances per applied window; set
   * this to 1 for strictly sequential reads.
   */
  INDEXER_FETCH_CONCURRENCY: z.coerce.number().int().positive().max(16).default(4),

  PORT: z.coerce.number().int().positive().default(8080),
  API_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  API_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  DATABASE_PATH: z.string().default("./payflow.db"),
  /**
   * Connections the store may open per database file. One -- the default --
   * is what the service did before the pool existed: a single handle per
   * network. Raise it to give the indexer and keeper passes a handle of their
   * own, so a sweep never shares one with API traffic; see the README for
   * sizing.
   */
  DATABASE_MAX_CONNS: z.coerce
    .number({ error: "must be a number" })
    .int("must be a whole number")
    .min(1, "must be at least 1")
    .max(MAX_DATABASE_CONNS, `must be at most ${MAX_DATABASE_CONNS}`)
    .default(1),
  /**
   * Connections the store opens when it starts and keeps open, so a burst of
   * traffic never pays the cost of opening one. Never above
   * `DATABASE_MAX_CONNS`.
   */
  DATABASE_MIN_CONNS: z.coerce
    .number({ error: "must be a number" })
    .int("must be a whole number")
    .min(1, "must be at least 1")
    .max(MAX_DATABASE_CONNS, `must be at most ${MAX_DATABASE_CONNS}`)
    .default(1),
  CORS_ORIGIN: z.string().default("*"),
  LOG_LEVEL: z.string().default("info"),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),

  ADMIN_TOKEN: z.string().optional(),

});

export type Config = z.infer<typeof schema>;

/** One network this instance indexes and serves. */
export interface NetworkConfig {
  /** Route segment (`/api/<name>/...`) and log label. */
  name: string;
  rpcUrl: string | string[];
  networkPassphrase: string;
  planRegistryId: string;
  vaultId: string;
  subscriptionId: string;
  defaultToken?: string | undefined;
  /** Where the indexer starts when its database has no cursor. */
  startLedger: number;
  /** SQLite file holding this network's projection. */
  databasePath: string;
  /**
   * Connections this network's store may open. The network's own
   * `<NAME>_DATABASE_MAX_CONNS` wins over the global `DATABASE_MAX_CONNS`.
   */
  maxConns: number;
  /**
   * Connections this network's store keeps open from the start. The network's
   * own `<NAME>_DATABASE_MIN_CONNS` wins over the global `DATABASE_MIN_CONNS`.
   */
  minConns: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  if (parsed.data.KEEPER_ENABLED && !parsed.data.KEEPER_SECRET) {
    throw new Error("KEEPER_ENABLED=true requires KEEPER_SECRET to be set");
  }
  if (parsed.data.DATABASE_MIN_CONNS > parsed.data.DATABASE_MAX_CONNS) {
    throw new Error(
      `Invalid environment configuration: DATABASE_MIN_CONNS (${parsed.data.DATABASE_MIN_CONNS}) must not be greater than DATABASE_MAX_CONNS (${parsed.data.DATABASE_MAX_CONNS})`,
    );
  }
  return parsed.data;
}

/** Route segments have to survive a URL path: lowercase letters, digits, dashes. */
const NETWORK_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * Resolve every network to serve: the default one first, configured entirely
 * by the unprefixed variables, then any extra names from `NETWORKS`, each
 * configured by `<NAME>_`-prefixed variables. A name that repeats the default
 * is ignored. The first entry is the network served by unprefixed routes.
 */
export function networkConfigs(config: Config, env: NodeJS.ProcessEnv = process.env): NetworkConfig[] {
  const names: string[] = [];
  const seen = new Set([config.STELLAR_NETWORK]);
  for (const name of config.NETWORKS.split(",").map((n) => n.trim()).filter(Boolean)) {
    if (!NETWORK_NAME.test(name)) {
      throw new Error(
        `Invalid network name "${name}" in NETWORKS: use lowercase letters, digits and dashes, e.g. "mainnet"`,
      );
    }
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }

  return [
    {
      name: config.STELLAR_NETWORK,
      rpcUrl: config.SOROBAN_RPC_URL,
      networkPassphrase: config.NETWORK_PASSPHRASE,
      planRegistryId: config.PLAN_REGISTRY_ID,
      vaultId: config.VAULT_ID,
      subscriptionId: config.SUBSCRIPTION_ID,
      startLedger: config.INDEXER_START_LEDGER,
      databasePath: config.DATABASE_PATH,
      maxConns: config.DATABASE_MAX_CONNS,
      minConns: config.DATABASE_MIN_CONNS,
    },
    ...names.map((name) => extraNetwork(name, config, env)),
  ];
}

function extraNetwork(name: string, base: Config, env: NodeJS.ProcessEnv): NetworkConfig {
  const prefix = name.toUpperCase().replace(/-/g, "_");
  const schema = z.object({
    [`${prefix}_SOROBAN_RPC_URL`]: z.string().url(),
    [`${prefix}_NETWORK_PASSPHRASE`]: z.string().min(1),
    [`${prefix}_PLAN_REGISTRY_ID`]: contractId,
    [`${prefix}_VAULT_ID`]: contractId,
    [`${prefix}_SUBSCRIPTION_ID`]: contractId,
    [`${prefix}_INDEXER_START_LEDGER`]: z.coerce.number().int().nonnegative().default(0),
    [`${prefix}_DATABASE_PATH`]: z.string().min(1).optional(),
    // A network's own pool size wins over the global one; unset, the global
    // value applies.
    [`${prefix}_DATABASE_MAX_CONNS`]: z.coerce
      .number({ error: "must be a number" })
      .int("must be a whole number")
      .min(1, "must be at least 1")
      .max(MAX_DATABASE_CONNS, `must be at most ${MAX_DATABASE_CONNS}`)
      .optional(),
    [`${prefix}_DATABASE_MIN_CONNS`]: z.coerce
      .number({ error: "must be a number" })
      .int("must be a whole number")
      .min(1, "must be at least 1")
      .max(MAX_DATABASE_CONNS, `must be at most ${MAX_DATABASE_CONNS}`)
      .optional(),
  });
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration for network "${name}":\n${issues}`);
  }
  const data = parsed.data as unknown as Record<string, string | number | undefined>;
  const databasePath = data[`${prefix}_DATABASE_PATH`];
  const maxConns = Number(data[`${prefix}_DATABASE_MAX_CONNS`] ?? base.DATABASE_MAX_CONNS);
  const minConns = Number(data[`${prefix}_DATABASE_MIN_CONNS`] ?? base.DATABASE_MIN_CONNS);
  if (minConns > maxConns) {
    throw new Error(
      `Invalid configuration for network "${name}": DATABASE_MIN_CONNS (${minConns}) must not be greater than DATABASE_MAX_CONNS (${maxConns})`,
    );
  }
  return {
    name,
    rpcUrl: String(data[`${prefix}_SOROBAN_RPC_URL`]),
    networkPassphrase: String(data[`${prefix}_NETWORK_PASSPHRASE`]),
    planRegistryId: String(data[`${prefix}_PLAN_REGISTRY_ID`]),
    vaultId: String(data[`${prefix}_VAULT_ID`]),
    subscriptionId: String(data[`${prefix}_SUBSCRIPTION_ID`]),
    startLedger: Number(data[`${prefix}_INDEXER_START_LEDGER`] ?? 0),
    databasePath:
      databasePath === undefined ? databasePathFor(base.DATABASE_PATH, name) : String(databasePath),
    maxConns,
    minConns,
  };
}

/** `./payflow.db` + `mainnet` becomes `./payflow-mainnet.db`, beside the base file. */
function databasePathFor(basePath: string, name: string): string {
  const ext = extname(basePath);
  return `${basePath.slice(0, basePath.length - ext.length)}-${name}${ext}`;
}
