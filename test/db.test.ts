import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, openDatabasePool, type DatabasePool } from "../src/lib/db.ts";

type Db = ReturnType<typeof openDatabase>;

/**
 * A database file in a temporary directory. A pool needs a real file: every
 * connection to `:memory:` is a database of its own.
 */
function tempFile(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "payflow-pool-"));
  return { path: join(dir, "payflow.db"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The query plan SQLite would use for `sql`, as one readable line. */
function queryPlan(db: Db, sql: string, args: unknown[] = []): string {
  return db
    // A fixed prefix over fixed test SQL; no request data is involved.
    // eslint-disable-next-line no-restricted-syntax
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...(args as never[]))
    .map((r) => String((r as { detail: string }).detail))
    .join(" | ");
}

describe("summary query indexes", () => {
  test("migrate creates the covering indexes", () => {
    const db = openDatabase(":memory:");
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
        name: string;
      }[]
    ).map((r) => r.name);

    assert.ok(names.includes("mandates_merchant_status_period_amount"));
    assert.ok(names.includes("charges_merchant_amount"));
    assert.ok(names.includes("charges_subscriber_amount_fee"));
    db.close();
  });

  test("merchant summary queries use covering indexes, not table scans", () => {
    const db = openDatabase(":memory:");

    const active = queryPlan(
      db,
      "SELECT COUNT(*) AS n FROM mandates WHERE merchant = ? AND status = 'Active'",
      ["M"],
    );
    assert.match(active, /COVERING INDEX/);
    assert.doesNotMatch(active, /SCAN mandates\b/);

    const collected = queryPlan(
      db,
      "SELECT COALESCE(SUM(CAST(amount AS INTEGER)), 0) AS total, COUNT(*) AS n FROM charges WHERE merchant = ?",
      ["M"],
    );
    assert.match(collected, /COVERING INDEX/);
    assert.doesNotMatch(collected, /SCAN charges\b/);

    const recurring = queryPlan(
      db,
      `SELECT COALESCE(SUM(CAST(amount AS INTEGER) * 2592000 / period), 0) AS mrr
         FROM mandates WHERE merchant = ? AND status = 'Active' AND period > 0`,
      ["M"],
    );
    assert.match(recurring, /COVERING INDEX/);
    assert.doesNotMatch(recurring, /SCAN mandates\b/);

    db.close();
  });

  test("subscriber summary total uses a covering index", () => {
    const db = openDatabase(":memory:");
    const paid = queryPlan(
      db,
      "SELECT COALESCE(SUM(CAST(amount AS INTEGER) + CAST(fee AS INTEGER)), 0) AS total FROM charges WHERE subscriber = ?",
      ["S"],
    );
    assert.match(paid, /COVERING INDEX/);
    assert.doesNotMatch(paid, /SCAN charges\b/);
    db.close();
  });
});

describe("database connection pool", () => {
  test("the pool opens the minimum number of connections at startup", () => {
    const file = tempFile();
    const pool = openDatabasePool(file.path, { min: 2, max: 4 });
    try {
      const stats = pool.stats();
      assert.equal(stats.open, 2);
      assert.equal(stats.idle, 1);
      assert.equal(stats.inUse, 0);
      assert.equal(stats.min, 2);
      assert.equal(stats.max, 4);
    } finally {
      pool.close();
      file.cleanup();
    }
  });

  test("a consumer takes a connection of its own below the cap", () => {
    const file = tempFile();
    const pool = openDatabasePool(file.path, { min: 1, max: 3 });
    try {
      const own = pool.acquire();
      assert.notEqual(own, pool.shared);
      assert.equal(pool.stats().open, 2);
      assert.equal(pool.stats().inUse, 1);
    } finally {
      pool.close();
      file.cleanup();
    }
  });

  test("at the cap the shared connection is handed out, never a refusal", () => {
    const file = tempFile();
    const pool = openDatabasePool(file.path, { min: 1, max: 2 });
    try {
      const first = pool.acquire();
      const second = pool.acquire();
      assert.notEqual(first, second);
      assert.notEqual(first, pool.shared);

      // The cap is reached: the pool shares its primary connection instead of
      // opening a third one or turning the work away.
      const third = pool.acquire();
      assert.equal(third, pool.shared);
      assert.equal(pool.stats().open, 2);
    } finally {
      pool.close();
      file.cleanup();
    }
  });

  test("every connection works on the same database", () => {
    const file = tempFile();
    const pool = openDatabasePool(file.path, { min: 1, max: 2 });
    try {
      const own = pool.acquire();
      pool.shared.prepare("INSERT INTO cursor (id, last_ledger) VALUES (1, 42)").run();

      const row = own.prepare("SELECT last_ledger FROM cursor WHERE id = 1").get() as {
        last_ledger: number;
      };
      assert.equal(row.last_ledger, 42);
    } finally {
      pool.close();
      file.cleanup();
    }
  });

  test("the pool creates the schema of a fresh database", () => {
    const file = tempFile();
    const pool = openDatabasePool(file.path, { min: 1, max: 1 });
    try {
      const tables = (
        pool.shared.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string;
        }[]
      ).map((row) => row.name);
      assert.ok(tables.includes("plans"));
      assert.ok(tables.includes("mandates"));
    } finally {
      pool.close();
      file.cleanup();
    }
  });

  test("closing the pool closes every connection it opened", () => {
    const file = tempFile();
    const pool: DatabasePool = openDatabasePool(file.path, { min: 2, max: 2 });
    const own = pool.acquire();
    const shared = pool.shared;

    pool.close();

    assert.equal(shared.isOpen, false);
    assert.equal(own.isOpen, false);
    assert.throws(() => pool.shared, /closed/);
    file.cleanup();
  });

  test("a pool size that makes no sense is rejected", () => {
    const file = tempFile();
    try {
      assert.throws(() => openDatabasePool(file.path, { min: 0, max: 2 }), /min/);
      assert.throws(() => openDatabasePool(file.path, { min: 3, max: 2 }), /max/);
      assert.throws(() => openDatabasePool(file.path, { min: 1.5, max: 2 }), /min/);
    } finally {
      file.cleanup();
    }
  });
});
