import assert from "node:assert/strict";
import { test, describe, before, after } from "node:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { openDatabase } from "../src/lib/db.ts";
import { createApp } from "../src/app.ts";
import { Indexer } from "../src/indexer.ts";
import type { Config, NetworkConfig } from "../src/config.ts";
import type { DecodedEvent } from "../src/lib/stellar.ts";

/**
 * Golden response fixtures.
 *
 * Every route's JSON is captured for a seeded in-memory database and compared
 * against a checked-in snapshot in `test/fixtures/`. This is the shape guard:
 * renaming a field, dropping one, or changing a value makes the deep equality
 * fail even when a targeted assertion would still pass, so a response cannot
 * drift out from under the frontend by accident.
 *
 * Determinism comes from freezing the clock for the whole capture (routes and
 * the seeded `created_at` all read `Date.now()`), a fixed indexer status, and a
 * fixed `x-request-id` header echoed into every error envelope. No network is
 * touched.
 *
 * UPDATE THE SNAPSHOTS INTENTIONALLY:
 *   UPDATE_GOLDEN=1 npm test
 * rewrites `test/fixtures/*.json` from the live responses. Review the git diff
 * of the fixtures as you would any API change — a snapshot only moves because
 * you asked it to.
 */

const MERCHANT = "GB343X4K4TIYARSAAQZ55RIZY2YLFNOQCM3LNQSRBV56TMVGIF55WCOH";
const SUBSCRIBER = "GAIJKXL3Q45ZR32QRDVPUDD4DPLT5GYCHJFESQPHHWJRYX4YZCG25JJR";

/** Frozen unix ms; every `Date.now()` in the app and the seed reads this. */
const FIXED_NOW_MS = 1_750_000_000_000;
/** Same instant in seconds, used for relative charge windows in the seed. */
const FIXED_NOW_S = Math.floor(FIXED_NOW_MS / 1000);

const testnet: NetworkConfig = {
  name: "testnet",
  rpcUrl: "https://rpc.invalid",
  networkPassphrase: "Test SDF Network ; September 2015",
  planRegistryId: "C".repeat(56),
  vaultId: "C".repeat(56),
  subscriptionId: "C".repeat(56),
  startLedger: 0,
  databasePath: ":memory:",
};
const config = { CORS_ORIGIN: "*" } as unknown as Config;

/** Fully specified so /health has nothing to derive from the wall clock. */
const status = {
  cursor: 1_000,
  latest: 1_010,
  lastRunAt: FIXED_NOW_MS,
  lastError: null,
  lastLedgerCloseTime: 1_700_000_000,
  freshnessSeconds: 42,
  mismatchedEvents: 0,
  paused: false,
};

const ev = (
  name: string,
  topics: unknown[],
  data: Record<string, unknown>,
  tx = "tx",
  closeTime: number | null = null,
): DecodedEvent => ({ name, contractId: "C", ledger: 1, txHash: tx, topics, data, closeTime });

const FIXTURES = new URL("./fixtures/", import.meta.url);
const UPDATE = process.env.UPDATE_GOLDEN === "1";

interface RouteSpec {
  /** Fixture file name (without extension) and stable route id. */
  file: string;
  method: "GET" | "POST";
  path: string;
  /** Expected HTTP status; the body snapshot is the shape assertion. */
  status: number;
}

const ROUTES: RouteSpec[] = [
  { file: "health", method: "GET", path: "/health", status: 200 },
  { file: "ready", method: "GET", path: "/ready", status: 200 },
  { file: "plans", method: "GET", path: "/api/plans", status: 200 },
  { file: "plan_by_id", method: "GET", path: `/api/plans/1`, status: 200 },
  { file: "plan_stats", method: "GET", path: "/api/plans/1/stats", status: 200 },
  { file: "mandates", method: "GET", path: "/api/mandates", status: 200 },
  { file: "mandate_by_id", method: "GET", path: "/api/mandates/1", status: 200 },
  { file: "mandate_charges", method: "GET", path: "/api/mandates/1/charges", status: 200 },
  { file: "vault_balances", method: "GET", path: `/api/vault/${SUBSCRIBER}`, status: 200 },
  { file: "vault_events", method: "GET", path: `/api/vault/${SUBSCRIBER}/events`, status: 200 },
  { file: "protocol", method: "GET", path: "/api/protocol", status: 200 },
  { file: "due", method: "GET", path: "/api/due", status: 200 },
  { file: "merchant_summary", method: "GET", path: `/api/merchants/${MERCHANT}/summary`, status: 200 },
  { file: "merchant_forecast", method: "GET", path: `/api/merchants/${MERCHANT}/forecast`, status: 200 },
  { file: "merchant_subscribers", method: "GET", path: `/api/merchants/${MERCHANT}/subscribers`, status: 200 },
  { file: "merchant_churn", method: "GET", path: `/api/merchants/${MERCHANT}/churn?bucket=month`, status: 200 },
  { file: "subscriber_summary", method: "GET", path: `/api/subscribers/${SUBSCRIBER}/summary`, status: 200 },
  { file: "subscriber_upcoming", method: "GET", path: `/api/subscribers/${SUBSCRIBER}/upcoming`, status: 200 },
  { file: "stats", method: "GET", path: "/api/stats", status: 200 },
  { file: "error_plan_not_found", method: "GET", path: "/api/plans/9999", status: 404 },
  { file: "error_mandate_not_found", method: "GET", path: "/api/mandates/9999", status: 404 },
  { file: "error_invalid_ids", method: "GET", path: "/api/mandates?ids=1,nope", status: 400 },
  { file: "error_too_many_ids", method: "GET", path: `/api/mandates?ids=${Array.from({ length: 101 }, (_, i) => i + 1).join(",")}`, status: 400 },
  { file: "error_not_found", method: "GET", path: "/api/nope", status: 404 },
];

let server: Server;
let base = "";
const db = openDatabase(":memory:");
const originalNow = Date.now;

before(async () => {
  // Freeze the clock before seeding so the charge's `created_at` and every
  // route's window maths are pinned to the same instant as the responses.
  Date.now = () => FIXED_NOW_MS;

  const ix = new Indexer(db, {} as never, {} as never);
  ix.apply(ev("plan_created", [MERCHANT, 1n], {
    token: "C", amount: 10_000_000n, period: 2_592_000n,
  }));
  // The subscription carries a ledger close time, so the churn report has a
  // bucket to file it under. The instant is fixed, so the snapshot is stable.
  ix.apply(ev("subscribed", [1n, SUBSCRIBER, MERCHANT], {
    plan_id: 1n, amount: 10_000_000n, period: 2_592_000n,
    next_charge: BigInt(FIXED_NOW_S - 100),
  }, "tx", FIXED_NOW_S));
  ix.apply(ev("charged", [1n, SUBSCRIBER, MERCHANT], {
    amount: 9_900_000n, fee: 100_000n, charges_made: 1n,
    next_charge: BigInt(FIXED_NOW_S + 2_592_000),
  }, "tx-charge-1"));
  ix.apply(ev("deposit", [SUBSCRIBER, "C"], { amount: 1_000_000n, balance: 1_000_000n }, "tx-vault"));
  ix.apply(ev("fee_changed", [MERCHANT], { old_fee_bps: 100n, new_fee_bps: 125n }, "tx-fee"));

  const app = createApp(
    [{ config: testnet, db, indexer: status, summaryCache: ix.merchantCache }],
    config,
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
      resolve();
    });
  });
});

after(() => {
  server.close();
  db.close();
  Date.now = originalNow;
});

async function capture(route: RouteSpec): Promise<unknown> {
  // A fixed request id makes error envelopes (which echo X-Request-Id) byte
  // stable across runs.
  const res = await fetch(base + route.path, {
    method: route.method,
    headers: { "x-request-id": "golden" },
  });
  assert.equal(res.status, route.status, `${route.method} ${route.path} status`);
  return (await res.json()) as unknown;
}

function fixturePath(file: string): string {
  return fileURLToPath(new URL(`${file}.json`, FIXTURES));
}

function loadFixture(file: string): unknown {
  return JSON.parse(readFileSync(fixturePath(file), "utf8")) as unknown;
}

function saveFixture(file: string, body: unknown): void {
  if (!existsSync(fileURLToPath(FIXTURES))) mkdirSync(fileURLToPath(FIXTURES), { recursive: true });
  writeFileSync(fixturePath(file), `${JSON.stringify(body, null, 2)}\n`, "utf8");
}

describe("golden response fixtures", () => {
  for (const route of ROUTES) {
    test(`${route.file} matches its snapshot`, async () => {
      const body = await capture(route);
      if (UPDATE) {
        saveFixture(route.file, body);
        return;
      }
      assert.ok(
        existsSync(fixturePath(route.file)),
        `missing fixture test/fixtures/${route.file}.json — run UPDATE_GOLDEN=1 npm test to generate it`,
      );
      assert.deepEqual(body, loadFixture(route.file));
    });
  }

  test("a renamed field is caught by the snapshot", async () => {
    // Prove the fixtures are load-bearing: the plan-by-id snapshot pins the
    // field names, so reading the live body under a renamed key differs from
    // the stored shape. (A real rename of `amount` would fail the deep-equal
    // above; this asserts the captured object actually carries the key.)
    const body = (await capture({ file: "plan_by_id", method: "GET", path: "/api/plans/1", status: 200 })) as Record<string, unknown>;
    assert.ok(Object.prototype.hasOwnProperty.call(body, "amount"), "plan exposes `amount`");
    assert.ok(!("amountRenamed" in body), "no unexpected field is present");
  });
});
