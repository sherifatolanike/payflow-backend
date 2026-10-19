# Changelog

All notable changes to payflow-backend. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[semantic versioning](https://semver.org/).

## [Unreleased]

### Added
- **Configurable database connection pool.** The store opens every SQLite
  projection through a bounded pool of connections. `DATABASE_MAX_CONNS` caps
  the connections a database file may have open and `DATABASE_MIN_CONNS` is
  how many are opened at startup and kept open; unset, the service keeps the
  single connection it has always used. A value that is not a positive whole
  number, or a minimum above the maximum, is a startup error. A network can
  size its own pool with `<NAME>_DATABASE_MAX_CONNS` and
  `<NAME>_DATABASE_MIN_CONNS`, which win over the global values. The README
  documents the two, how to size them and where the size comes from.
- **Parallel settlement with keeper channel accounts (#36).** Extra signing
  accounts listed in `KEEPER_CHANNEL_SECRETS` become parallel settlement
  channels: due mandates are pulled from one shared queue by one worker per
  channel, so every account sequences its own transactions (paying its own
  fees) while channels settle concurrently — a single key manages only a few
  charges per minute and large merchants were billed hours late. A channel
  whose account cannot pay is skipped for the pass (logged by public key) and
  its share settles through the live channels instead of backing off against
  a dead key; with one channel the pass is the old sequential behaviour and
  makes no extra RPC call. A fee-bump design was rejected because a fee bump
  consumes the *fee source's* sequence number, which would serialize every
  transaction against the main key again. Tested with three channels: no
  sequence-number collisions, all channels sign, results keep due order.
- **Merchant churn metrics (#30).** `GET /api/merchants/:address/churn` reports
  how a merchant's mandate base moved over time: mandates started, cancelled
  by the subscriber, ended by the merchant, and completed, plus the net, in
  `day`, `week` or `month` buckets. The indexer records each lifecycle event
  in a new `mandate_events` log stamped with the ledger's close time, so the
  buckets are the chain's calendar and not the indexer's wall clock, and
  replaying a ledger range leaves the report unchanged.
- **Per-plan statistics (#29).** `GET /api/plans/:id/stats` reports a plan's
  active and total mandates, cancellations, gross amount collected and the
  average number of settled charges per mandate, so merchants can compare
  plans side by side. The collected total stays a decimal string in the
  token's smallest unit, and an unknown plan is `404 plan_not_found`.
- **Zero-downtime keeper key rotation (#71).** The keeper accepts a standby
  key in `KEEPER_SECRET_NEXT`: if the active key's source account is unusable
  it rotates mid-pass and retries the same mandate, and after a pass settles
  with the new key it logs that the previous key can be retired. Secrets are
  reloaded on `SIGHUP` (`.env` re-read, config re-validated) so promotion of
  the standby needs no restart. Tested by swapping keys between passes.
- **Typed API client (#72).** `src/client/index.ts` is a small typed fetch
  client for every endpoint, returning the same response types the route
  handlers annotate their bodies with (`src/routes/types.ts`) — shared, not
  copied. Exposed as the `payflow-backend/client` subpath after `npm run
  build` and tested against the HTTP test server.
- **Spec-driven event decoding (#73).** Event shapes live in the committed
  contract spec `src/lib/event_spec.json`. The indexer validates every
  decoded event before projecting it: mismatches (renamed fields, wrong
  types, extra data or topics) are logged with the exact problems, counted
  per pass in `TickResult.mismatched` and in `/health`'s
  `indexer.mismatchedEvents`, and never stored as zeros.
- **`arr` on the merchant summary.** `/api/merchants/:address/summary` now
  reports annual recurring revenue next to `mrr`: every active mandate
  normalised to a 365-day year. Both formulas are documented in the README.
- **Parallel window backfill (#59).** The indexer fetches up to
  `INDEXER_FETCH_CONCURRENCY` (default 4, max 16) 8,000-ledger windows at
  once and applies them in ledger order. The cursor advances only after a
  window is applied, so a failed later window resumes at the last applied
  one; `1` restores strictly sequential reads.
- **Batch mandate lookup (#61).** `/api/mandates?ids=1,2,3` returns up to 100
  mandates in one request. Unknown ids are omitted, more than 100 ids is
  `400 too_many_ids`, and a non-numeric id is `400 invalid_ids`. The typed
  client's `MandatesQuery` gained `ids`.
- **SQL template lint rule (#65).** ESLint rejects `prepare()` calls whose
  SQL is an interpolated template literal. Vetted static fragments carry an
  explained `eslint-disable-next-line` comment, and a test runs the real
  config against a deliberately bad query to prove the rule fires.
- **Volume and fee statistics (#55).** `/api/stats` reports 24-hour and all-time
  charge volume (gross: net amount plus protocol fee), total fees and the
  number of merchants with an active mandate, alongside the existing counts.
  Amounts are decimal strings.
- **RPC endpoint failover (#60).** `SOROBAN_RPC_URL` now accepts a comma-separated
  list. Calls go to the active endpoint and switch to the next when one fails;
  a health probe prefers the endpoint with the freshest ledger, so a reachable
  but lagging node does not hold the indexer back either. `/health` reports the
  active endpoint and the full list under `rpc`.
- **`/api/subscribers/:address/upcoming` (#62).** Projects each active mandate's
  charges over the next `days` (default 30, capped at 365), following the
  contract's scheduling rule — a due mandate at `now`, a future one at its
  `next_charge`, then every `period` — and stops at a mandate's remaining
  `max_charges` allowance. Each entry is the gross per-charge the subscriber
  pays, with the projected time; `truncated` flags the per-mandate cap.
- **`/ready` readiness probe (#58).** Answers 503 (`starting`, then `catching_up`)
  until the indexer's projection trails the network by no more than 120
  ledgers, so orchestrators do not route traffic to an instance that is still
  backfilling. `/health` stays a liveness probe answering 200.
- **Merchant revenue forecast (#63).** `/api/merchants/:address/forecast` projects
  the charges a merchant's active mandates will produce over the next `days`
  (default 30, capped at 365), each occurrence net of the mandate's fee, and
  returns the window and assumptions it used.
- **Token-protected `/admin` operator endpoints (#64).** Trigger an indexer pass,
  run a keeper pass, or read the keeper's backoff list. They exist only when
  `ADMIN_TOKEN` is set, require `Authorization: Bearer`, and the token is
  compared in constant time. Triggered passes queue behind any pass already
  running rather than overlapping it.
- **Dependabot and an audit gate**: weekly npm and GitHub Actions updates, and
  CI now fails on high or critical advisories in production dependencies
  (`npm audit --omit=dev --audit-level=high`).
- **Container image on release**: pushing a `v*` tag builds the Dockerfile and
  publishes `ghcr.io/mmm-pay/payflow-backend:<version>` to GHCR.
- **A Dockerfile and Fly.io configuration**: a multi-stage image that runs the
  API and indexer as a non-root user, and a `fly.toml` with a volume for the
  SQLite file, `/health` checks and autostop.
- **Several networks from one instance**: `NETWORKS` lists extra networks
  beside the default one. Each gets its own indexer, cursor and SQLite
  database, and its routes under `/api/<name>/...`; unprefixed routes keep
  serving the default network unchanged. `/health` reports every network.
- A route test suite for two configured networks.

### Changed

- **Summary query indexes (#66).** Covering indexes for the merchant and
  subscriber summary aggregates (`mandates(merchant, status, period, amount)`,
  `charges(merchant, amount)`, `charges(subscriber, amount, fee)`) are added
  through the startup migration, so existing databases gain them without a
  rebuild. `EXPLAIN QUERY PLAN` now reports covering-index searches instead
  of table lookups.
- **One router per resource (#74).** `src/routes/index.ts` is split into
  `plans.ts`, `mandates.ts`, `merchants.ts`, `subscribers.ts` and `stats.ts`
  with shared query helpers in `helpers.ts`. No change in behaviour: paths,
  query handling and response shapes are identical and the existing API
  tests pass unchanged.

- **Express 5 (#77).** `express` and `@types/express` move to 5.x. No removed
  API was in use — no `app.del`, no `res.send(status)`, no wildcard or
  regex paths for path-to-regexp v8 to reject — so routes and response shapes
  are untouched and payflow-frontend needs no migration note. What does change
  is where a failure lands: Express 5 awaits a handler's result and forwards a
  rejected promise to the error middleware, so an `async` route no longer needs
  a manual `try`/`catch` to avoid leaving the caller hanging with an unhandled
  rejection. The four-argument handler in `src/app.ts` is now the single
  boundary for every failure, is exported as `errorHandler`, hands back errors
  whose response has already started, and logs `loggableError(err)` (type,
  message, status, stack) instead of the raw error — `body-parser` hangs the
  caller's request body off its `SyntaxError`, and that must not reach a log
  line.

### Fixed

- **Merchant totals no longer mix tokens (#56).** `/api/merchants/:address/summary`
  summed every charge into one figure even when the merchant's plans used
  several tokens. Revenue and MRR are now also grouped per token in a `tokens`
  array, and the flat fields report the default token (`TOKEN_ID`) when one is
  configured — without one they keep their previous all-token meaning.

### Security

- Patched transitive advisories in `proxy-addr` (critical) and `qs`
  (moderate) with `npm audit fix`; the production audit is clean.


## [0.2.0] - 2026-10-09

Points at the v0.2.0 contract suite on testnet.

### Fixed

- **The keeper could stall behind failing mandates.** Every pass retried the
  25 oldest due mandates first, so 25 underfunded vaults blocked every other
  mandate indefinitely. A failed charge now backs off (1 minute, doubling, up
  to 6 hours) and a success clears it.
- **Passes could overlap.** Indexer and keeper ran on `setInterval`, so a pass
  slower than the interval ran alongside the next one. Overlapping indexer
  passes could move the cursor backwards; overlapping keeper passes submitted
  transactions with the same sequence number. Each loop now waits for its pass
  to finish.
- **A fresh indexer saw only the last ~11 hours.** With no cursor it started
  8,000 ledgers back. It now starts at `INDEXER_START_LEDGER` or, if unset, the
  oldest ledger the RPC node serves, and moves a cursor that fell out of
  retention forward instead of failing.
- **Ranges could end early.** A page with fewer than 200 events was taken to
  mean the range was exhausted. Paging now continues until a page is empty or
  passes the end of the range, which is passed to RPC as `endLedger`.
- **`npm run indexer` indexed one window and exited.** It now runs until it has
  caught up.
- **`npm run lint` could not run**: ESLint was not installed. ESLint 9 with
  typescript-eslint is configured and CI enforces it.
- **The Render blueprint could not deploy on the free plan**, which has no
  persistent disk. It now rebuilds the projection from the deployment ledger.

### Added

- `mandate_ended` events (a merchant ending a mandate) are projected as
  `Cancelled`, and mandates record who ended them in `ended_by`.
- `/health` reports `starting`, `ok` or `catching_up`, the indexer cursor, its
  lag behind the network, and the last error.
- A scheduled GitHub Actions keeper that settles due testnet mandates without
  an always-on server.

### Changed

- `@stellar/stellar-sdk` 13 → 17, for testnet's current protocol.
- 24 → 39 tests, including indexer sync against a fake RPC node, keeper
  backoff, and loop overlap.

## [0.1.0] - 2026-09-02

Event indexer, settlement keeper and read API for the first testnet
deployment.

[Unreleased]: https://github.com/MMM-pay/payflow-backend/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/MMM-pay/payflow-backend/releases/tag/v0.2.0
