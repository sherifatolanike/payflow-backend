/** Run a single settlement pass on the default network and exit. */
import { loadConfig, networkConfigs } from "../config.ts";
import { openDatabasePool } from "../lib/db.ts";
import { makeRpc } from "../lib/stellar.ts";
import { Keeper } from "../keeper.ts";
import { logger } from "../lib/logger.ts";

const config = loadConfig();
const network = networkConfigs(config)[0]!;
const pool = openDatabasePool(network.databasePath, {
  min: network.minConns,
  max: network.maxConns,
});
const keeper = new Keeper(pool.acquire(), makeRpc(network), config);

keeper
  .tick()
  .then((results) => {
    logger.info({ results }, "settlement pass complete");
    pool.close();
  })
  .catch((err) => {
    logger.error({ err }, "settlement pass failed");
    process.exitCode = 1;
  });
