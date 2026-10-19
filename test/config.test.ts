import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { loadConfig, networkConfigs } from "../src/config.ts";

/** The minimum viable environment: contract ids pass the 56-char check. */
const VALID_CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32));
const BASE = {
  PLAN_REGISTRY_ID: VALID_CONTRACT_ID,
  VAULT_ID: VALID_CONTRACT_ID,
  SUBSCRIPTION_ID: VALID_CONTRACT_ID,
};

describe("soroban rpc endpoints", () => {
  test("defaults to the public testnet endpoint when unset", () => {
    assert.deepEqual(loadConfig({ ...BASE }).SOROBAN_RPC_URL, [
      "https://soroban-testnet.stellar.org",
    ]);
  });

  test("a single URL stays a one-element list", () => {
    assert.deepEqual(
      loadConfig({ ...BASE, SOROBAN_RPC_URL: "https://a.example" }).SOROBAN_RPC_URL,
      ["https://a.example"],
    );
  });

  test("a comma-separated list is split, trimmed and deduplicated", () => {
    const env = " https://a.example , https://b.example,https://a.example ";
    assert.deepEqual(loadConfig({ ...BASE, SOROBAN_RPC_URL: env }).SOROBAN_RPC_URL, [
      "https://a.example",
      "https://b.example",
    ]);
  });

  test("blank segments are dropped", () => {
    assert.deepEqual(
      loadConfig({ ...BASE, SOROBAN_RPC_URL: "https://a.example,,https://b.example" })
        .SOROBAN_RPC_URL,
      ["https://a.example", "https://b.example"],
    );
  });

  test("a list is rejected when it contains a non-URL", () => {
    assert.throws(
      () => loadConfig({ ...BASE, SOROBAN_RPC_URL: "https://a.example,not-a-url" }),
      /SOROBAN_RPC_URL/,
    );
  });

  test("non-http(s) schemes are rejected", () => {
    assert.throws(
      () => loadConfig({ ...BASE, SOROBAN_RPC_URL: "ftp://a.example" }),
      /SOROBAN_RPC_URL/,
    );
  });

  test("an empty list is rejected", () => {
    assert.throws(() => loadConfig({ ...BASE, SOROBAN_RPC_URL: "" }), /SOROBAN_RPC_URL/);
    assert.throws(() => loadConfig({ ...BASE, SOROBAN_RPC_URL: " , " }), /SOROBAN_RPC_URL/);
  });
});

describe("keeper order", () => {
  test("KEEPER_ORDER defaults to oldest, today's settled behaviour", () => {
    assert.equal(loadConfig({ ...BASE }).KEEPER_ORDER, "oldest");
  });

  test("KEEPER_ORDER accepts oldest and largest", () => {
    assert.equal(loadConfig({ ...BASE, KEEPER_ORDER: "oldest" }).KEEPER_ORDER, "oldest");
    assert.equal(loadConfig({ ...BASE, KEEPER_ORDER: "largest" }).KEEPER_ORDER, "largest");
  });

  test("KEEPER_ORDER rejects anything else", () => {
    assert.throws(() => loadConfig({ ...BASE, KEEPER_ORDER: "newest" }), /KEEPER_ORDER/);
    assert.throws(() => loadConfig({ ...BASE, KEEPER_ORDER: "" }), /KEEPER_ORDER/);
  });
});

describe("keeper channel secrets", () => {
  test("defaults to no channels, so single-key setups are untouched", () => {
    assert.deepEqual(loadConfig({ ...BASE }).KEEPER_CHANNEL_SECRETS, []);
  });

  test("a comma-separated list is split, trimmed and kept in order", () => {
    const a = Keypair.random().secret();
    const b = Keypair.random().secret();
    assert.deepEqual(
      loadConfig({ ...BASE, KEEPER_CHANNEL_SECRETS: ` ${a} , ${b}` }).KEEPER_CHANNEL_SECRETS,
      [a, b],
    );
  });

  test("blanks between commas are dropped", () => {
    const a = Keypair.random().secret();
    assert.deepEqual(
      loadConfig({ ...BASE, KEEPER_CHANNEL_SECRETS: `,${a},` }).KEEPER_CHANNEL_SECRETS,
      [a],
    );
  });

  test("anything that is not a Stellar secret seed is rejected", () => {
    assert.throws(
      () => loadConfig({ ...BASE, KEEPER_CHANNEL_SECRETS: "not-a-secret" }),
      /KEEPER_CHANNEL_SECRETS/,
    );
    assert.throws(
      () =>
        loadConfig({
          ...BASE,
          KEEPER_CHANNEL_SECRETS: `${Keypair.random().secret()},GB343X4K4TIYARSAAQZ55RIZY2YLFNOQCM3LNQSRBV56TMVGIF55WCOH`,
        }),
      /KEEPER_CHANNEL_SECRETS/,
      "a public key is not a signing secret",
    );
  });
});

describe("keeper inclusion fee configuration", () => {
  test("uses the default percentile and cap", () => {
    const config = loadConfig(env());
    assert.equal(config.KEEPER_FEE_PERCENTILE, "90");
    assert.equal(config.KEEPER_MAX_FEE, 100_000n);
  });

  test("rejects unsupported percentiles and fees below BASE_FEE", () => {
    assert.throws(() => loadConfig(env({ KEEPER_FEE_PERCENTILE: "85" })), /KEEPER_FEE_PERCENTILE/);
    assert.throws(() => loadConfig(env({ KEEPER_MAX_FEE: "1" })), /KEEPER_MAX_FEE/);
  });
});

const ID = VALID_CONTRACT_ID;

/** Environment holding only what the default network needs. */
function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PLAN_REGISTRY_ID: ID,
    VAULT_ID: ID,
    SUBSCRIPTION_ID: ID,
    ...overrides,
  };
}

describe("reconciliation", () => {
  test("defaults to a ten-minute interval and a 25-mandate sample", () => {
    const config = loadConfig(env());
    assert.equal(config.RECONCILE_INTERVAL_MS, 600_000);
    assert.equal(config.RECONCILE_SAMPLE_SIZE, 25);
  });

  test("rejects a non-positive interval and sample size", () => {
    assert.throws(() => loadConfig(env({ RECONCILE_INTERVAL_MS: "0" })), /RECONCILE_INTERVAL_MS/);
    assert.throws(() => loadConfig(env({ RECONCILE_INTERVAL_MS: "-1" })), /RECONCILE_INTERVAL_MS/);
    assert.throws(() => loadConfig(env({ RECONCILE_SAMPLE_SIZE: "0" })), /RECONCILE_SAMPLE_SIZE/);
  });
});

describe("network configs", () => {
  test("with no NETWORKS there is exactly the default network", () => {
    const config = loadConfig(env());
    const networks = networkConfigs(config, env());
    assert.equal(networks.length, 1);
    assert.equal(networks[0]!.name, "testnet");
    assert.equal(networks[0]!.databasePath, "./payflow.db");
  });

  test("an extra network is built from its prefixed variables", () => {
    const overrides = {
      NETWORKS: "mainnet",
      DATABASE_PATH: "/data/payflow.db",
      MAINNET_SOROBAN_RPC_URL: "https://mainnet.sorobanrpc.example",
      MAINNET_NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015",
      MAINNET_PLAN_REGISTRY_ID: ID,
      MAINNET_VAULT_ID: ID,
      MAINNET_SUBSCRIPTION_ID: ID,
      MAINNET_INDEXER_START_LEDGER: "5110418",
    };
    const config = loadConfig(env(overrides));
    const networks = networkConfigs(config, env(overrides));

    assert.deepEqual(networks.map((n) => n.name), ["testnet", "mainnet"]);
    const mainnet = networks[1]!;
    assert.equal(mainnet.rpcUrl, overrides.MAINNET_SOROBAN_RPC_URL);
    assert.equal(mainnet.startLedger, 5_110_418);
    // The default path is a template so both databases sit side by side.
    assert.equal(mainnet.databasePath, "/data/payflow-mainnet.db");
  });

  test("naming the default network in NETWORKS does not duplicate it", () => {
    const overrides = { NETWORKS: "testnet, testnet" };
    const config = loadConfig(env(overrides));
    const networks = networkConfigs(config, env(overrides));
    assert.equal(networks.length, 1);
  });

  test("a missing variable names the network and the variable", () => {
    const overrides = { NETWORKS: "mainnet" };
    const config = loadConfig(env(overrides));
    assert.throws(
      () => networkConfigs(config, env(overrides)),
      /Invalid configuration for network "mainnet"[\s\S]*MAINNET_VAULT_ID/,
    );
  });

  test("a name that is not a URL-safe segment is rejected", () => {
    const overrides = { NETWORKS: "main net" };
    const config = loadConfig(env(overrides));
    assert.throws(
      () => networkConfigs(config, env(overrides)),
      /Invalid network name "main net"/,
    );
  });
});

describe("Stellar identifier validation", () => {
  test("accepts a valid contract id and secret seed", () => {
    const secret = Keypair.random().secret();
    const config = loadConfig({ ...BASE, KEEPER_SECRET: secret });
    assert.equal(config.PLAN_REGISTRY_ID, VALID_CONTRACT_ID);
    assert.equal(config.KEEPER_SECRET, secret);
  });

  test("rejects a public key where a contract id is required", () => {
    const publicKey = Keypair.random().publicKey();
    assert.throws(
      () => loadConfig({ ...BASE, PLAN_REGISTRY_ID: publicKey }),
      /PLAN_REGISTRY_ID: must be a valid Stellar contract ID/,
    );
  });

  test("rejects a malformed contract id and names the variable", () => {
    assert.throws(
      () => loadConfig({ ...BASE, VAULT_ID: "C".repeat(56) }),
      /VAULT_ID: must be a valid Stellar contract ID/,
    );
  });

  test("rejects malformed keeper secrets without echoing them", () => {
    const secret = "S".repeat(56);
    assert.throws(
      () => loadConfig({ ...BASE, KEEPER_SECRET: secret }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /KEEPER_SECRET: must be a valid Stellar secret seed/);
        assert.equal(error.message.includes(secret), false);
        return true;
      },
    );
  });

  test("rejects non-string identifiers without including their values", () => {
    assert.throws(
      () => loadConfig({ ...BASE, SUBSCRIPTION_ID: 123 as unknown as string }),
      /SUBSCRIPTION_ID: Invalid input/,
    );
  });
});
