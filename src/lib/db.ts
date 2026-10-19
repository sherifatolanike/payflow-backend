import { DatabaseSync } from "node:sqlite";

/**
 * Schema notes.
 *
 * `plans` and `mandates` are projections rebuilt from contract events, so every
 * write is an idempotent upsert keyed on the on-chain id. Re-indexing the same
 * ledger range twice must not change the result.
 *
 * `charges` is an append-only log keyed on (tx_hash, mandate_id) so a replayed
 * ledger cannot double-count revenue.
 *
 * `mandate_events` is the churn log: one row per mandate per lifecycle event
 * (started, cancelled, ended, completed), stamped with the ledger close time
 * of the event. It is keyed on (mandate_id, slot) and written with
 * INSERT OR IGNORE, so replaying a ledger range cannot record the same
 * event — or the same departure — twice.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS cursor (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  last_ledger  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  id          INTEGER PRIMARY KEY,
  merchant    TEXT    NOT NULL,
  name        TEXT    NOT NULL DEFAULT '',
  token       TEXT    NOT NULL,
  amount      TEXT    NOT NULL,
  period      INTEGER NOT NULL,
  active      INTEGER NOT NULL DEFAULT 1,
  ledger      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS plans_merchant ON plans(merchant);

CREATE TABLE IF NOT EXISTS mandates (
  id           INTEGER PRIMARY KEY,
  subscriber   TEXT    NOT NULL,
  merchant     TEXT    NOT NULL,
  plan_id      INTEGER NOT NULL,
  amount       TEXT    NOT NULL,
  period       INTEGER NOT NULL,
  next_charge  INTEGER NOT NULL,
  last_charge  INTEGER NOT NULL DEFAULT 0,
  charges_made INTEGER NOT NULL DEFAULT 0,
  max_charges  INTEGER NOT NULL DEFAULT 0,
  fee_bps      INTEGER NOT NULL DEFAULT 0,
  status       TEXT    NOT NULL DEFAULT 'Active',
  -- 'subscriber' or 'merchant' once cancelled; NULL otherwise.
  ended_by     TEXT,
  ledger       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mandates_subscriber ON mandates(subscriber);
CREATE INDEX IF NOT EXISTS mandates_merchant   ON mandates(merchant);
CREATE INDEX IF NOT EXISTS mandates_due        ON mandates(status, next_charge);

CREATE TABLE IF NOT EXISTS charges (
  tx_hash      TEXT    NOT NULL,
  mandate_id   INTEGER NOT NULL,
  subscriber   TEXT    NOT NULL,
  merchant     TEXT    NOT NULL,
  amount       TEXT    NOT NULL,
  fee          TEXT    NOT NULL,
  charges_made INTEGER NOT NULL,
  next_charge  INTEGER NOT NULL,
  ledger       INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (tx_hash, mandate_id)
);
CREATE INDEX IF NOT EXISTS charges_merchant   ON charges(merchant);
CREATE INDEX IF NOT EXISTS charges_subscriber ON charges(subscriber);
CREATE INDEX IF NOT EXISTS charges_mandate    ON charges(mandate_id);

CREATE TABLE IF NOT EXISTS vault_events (
  tx_hash      TEXT    NOT NULL,
  kind         TEXT    NOT NULL,
  user         TEXT    NOT NULL,
  token        TEXT    NOT NULL,
  counterparty TEXT,
  amount       TEXT    NOT NULL,
  balance      TEXT    NOT NULL,
  ledger       INTEGER NOT NULL,
  PRIMARY KEY (tx_hash, kind, user, amount)
);
CREATE INDEX IF NOT EXISTS vault_events_user ON vault_events(user);
CREATE INDEX IF NOT EXISTS vault_events_user_token_ledger
  ON vault_events(user, token, ledger DESC);
CREATE INDEX IF NOT EXISTS vault_events_user_ledger
  ON vault_events(user, ledger DESC);

CREATE TABLE IF NOT EXISTS fee_history (
  tx_hash      TEXT    PRIMARY KEY,
  old_fee_bps  INTEGER NOT NULL,
  new_fee_bps  INTEGER NOT NULL,
  ledger       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS fee_history_ledger ON fee_history(ledger DESC);

-- One row per mandate per lifecycle event, used by the merchant churn
-- endpoint. The "at" column is the ledger close time of the event in unix
-- seconds, so buckets follow the chain's clock rather than the indexer's
-- wall clock.
--
-- The "slot" column is 'start' or 'departure' and is part of the primary key,
-- so a mandate has exactly one start and at most one departure however many
-- times the event is applied. That is what makes the churn report's net
-- figure correct by construction: a mandate can never be counted as leaving
-- twice.
CREATE TABLE IF NOT EXISTS mandate_events (
  mandate_id INTEGER NOT NULL,
  slot       TEXT    NOT NULL,
  merchant   TEXT    NOT NULL,
  kind       TEXT    NOT NULL,
  at         INTEGER NOT NULL,
  ledger     INTEGER NOT NULL,
  PRIMARY KEY (mandate_id, slot)
);
CREATE INDEX IF NOT EXISTS mandate_events_merchant ON mandate_events(merchant, kind, at);
`;

/**
 * Columns added after the first deployment. CREATE TABLE IF NOT EXISTS leaves
 * an existing table alone, so new columns have to be added explicitly. Each
 * entry is applied only when absent, which keeps repeated startups a no-op.
 */
const ADDED_COLUMNS: ReadonlyArray<[table: string, column: string, decl: string]> = [
  ["plans", "name", "TEXT NOT NULL DEFAULT ''"],
  ["mandates", "fee_bps", "INTEGER NOT NULL DEFAULT 0"],
  ["mandates", "ended_by", "TEXT"],
];

/**
 * Indexes added after the first deployment. Each is created only when its
 * table exists (a migration may run against a partially built database) and
 * `IF NOT EXISTS` keeps repeated startups a no-op. These are covering indexes
 * for the merchant and subscriber summary routes: the aggregates read only
 * the indexed columns, so the planner never touches the table b-tree.
 */
const ADDED_INDEXES: ReadonlyArray<[table: string, name: string, columns: string]> = [
  ["mandates", "mandates_merchant_status_period_amount", "merchant, status, period, amount"],
  ["charges", "charges_merchant_amount", "merchant, amount"],
  ["charges", "charges_subscriber_amount_fee", "subscriber, amount, fee"],
];

export function migrate(db: DatabaseSync): void {
  for (const [table, column, decl] of ADDED_COLUMNS) {
    const columns = db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as {
      name: string;
    }[];
    // An empty result means the table itself is absent, so there is nothing to
    // migrate -- SCHEMA will have created it with the column already present.
    if (columns.length === 0) continue;
    if (!columns.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    }
  }

  for (const [table, name, columns] of ADDED_INDEXES) {
    const exists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table);
    if (exists) db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${table}(${columns})`);
  }
}

/**
 * Open one connection to a SQLite file with the pragmas the service needs.
 *
 * WAL lets a reader work while a writer commits, and `foreign_keys` is a
 * per-connection setting, so every handle of a pool needs its own.
 */
function connect(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  // A second handle on the same file waits for the write lock instead of
  // failing on the first try.
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

export function openDatabase(path: string): DatabaseSync {
  const db = connect(path);
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** How many connections a pool keeps for one database file. */
export interface PoolOptions {
  /**
   * Connections opened when the pool starts and kept open, so a burst of
   * traffic never pays the cost of opening one.
   */
  min: number;
  /** Hard cap on open connections. */
  max: number;
}

/** The state of a pool, for logs and health checks. */
export interface PoolStats {
  /** Connections open. */
  open: number;
  /** Connections open but not handed out. */
  idle: number;
  /** Connections handed to a consumer. */
  inUse: number;
  /** Connections kept open from the start. */
  min: number;
  /** Cap on open connections. */
  max: number;
}

/**
 * The connections of one database file, bounded.
 *
 * `node:sqlite` is synchronous, so a connection is busy only while a
 * statement runs and the pool is not about throughput. It is about how many
 * handles the service keeps open, and about giving the long-running passes
 * (the indexer and the keeper) a handle of their own so a sweep never
 * shares one with the API.
 *
 * The pool opens `min` connections when it starts and never goes above `max`.
 * A consumer that needs a connection of its own takes one with
 * {@link acquire} and keeps it; everything else reads through
 * {@link shared}, which is always available. At the cap {@link acquire} hands
 * out the shared connection instead of refusing: the pool bounds handles, it
 * never turns work away.
 */
export class DatabasePool {
  private readonly path: string;
  private readonly options: PoolOptions;
  /** Every connection the pool has opened. */
  private readonly connections = new Set<DatabaseSync>();
  /** Connections opened but not handed out. */
  private readonly spare: DatabaseSync[] = [];
  /** Connections handed to a consumer. */
  private readonly handedOut = new Set<DatabaseSync>();
  private primary: DatabaseSync | undefined;
  private closed = false;

  constructor(path: string, options: PoolOptions) {
    if (!Number.isInteger(options.min) || options.min < 1) {
      throw new Error(`pool min must be a positive integer, got ${options.min}`);
    }
    if (!Number.isInteger(options.max) || options.max < options.min) {
      throw new Error(
        `pool max must be an integer of at least min (${options.min}), got ${options.max}`,
      );
    }
    this.path = path;
    this.options = options;
    // The first connection owns the schema; the rest join a database that is
    // already there.
    const primary = this.open();
    primary.exec(SCHEMA);
    migrate(primary);
    this.primary = primary;
    for (let i = 1; i < options.min; i += 1) this.spare.push(this.open());
  }

  /**
   * The connection every caller may use at any time. The API reads through
   * it, so it is never handed out exclusively.
   */
  get shared(): DatabaseSync {
    const primary = this.primary;
    if (this.closed || !primary) throw new Error("database pool is closed");
    return primary;
  }

  /**
   * A connection of the consumer's own, for work that runs for a long time
   * (an indexer or keeper pass) and should not share a handle with the API.
   */
  acquire(): DatabaseSync {
    if (this.closed) throw new Error("database pool is closed");
    const spare = this.spare.pop();
    if (spare) {
      this.handedOut.add(spare);
      return spare;
    }
    if (this.connections.size < this.options.max) {
      const db = this.open();
      this.handedOut.add(db);
      return db;
    }
    // At the cap: share the primary rather than refuse the work.
    return this.shared;
  }

  /** Pool state, for logs and health checks. */
  stats(): PoolStats {
    return {
      open: this.connections.size,
      idle: this.spare.length,
      inUse: this.handedOut.size,
      min: this.options.min,
      max: this.options.max,
    };
  }

  /** Close every connection the pool opened. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const db of this.connections) db.close();
    this.connections.clear();
    this.spare.length = 0;
    this.handedOut.clear();
    this.primary = undefined;
  }

  private open(): DatabaseSync {
    const db = connect(this.path);
    this.connections.add(db);
    return db;
  }
}

/** Open a pool of connections to one database file. */
export function openDatabasePool(path: string, options: PoolOptions): DatabasePool {
  return new DatabasePool(path, options);
}

export function readCursor(db: DatabaseSync, fallback: number): number {
  const row = db.prepare("SELECT last_ledger FROM cursor WHERE id = 1").get() as
    | { last_ledger: number }
    | undefined;
  return row?.last_ledger ?? fallback;
}

export function writeCursor(db: DatabaseSync, ledger: number): void {
  db.prepare(
    `INSERT INTO cursor (id, last_ledger) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET last_ledger = excluded.last_ledger`,
  ).run(ledger);
}
