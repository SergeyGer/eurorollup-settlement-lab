# Changelog

Notable changes to EuroRollup Settlement Lab. The same content is published as
GitHub Releases with evidence artifacts attached. Repository documentation never
records current calendar dates.

## [0.1.0] — Foundation

### Added

- pnpm TypeScript workspace with `apps/web`, `apps/api`, `packages/dealing` and
  `packages/sdk` boundaries and root commands.
- Instrument registry for dEUR (6 decimals), tWETH (18 decimals) and eFUND
  (6 decimals), with integer base-unit money arithmetic, decimal-string
  serialization, round-down unit issuance, residual cash return and zero-unit
  rejection.
- Versioned UTC calendar `LAB-UTC-1` with dealing-day assignment, cutoff
  boundaries, weekend handling and a second calendar with a closed Monday.
- Frozen fixtures: G01 portfolio lifecycle, G01 redemption case, P01 Friday
  cutoff experiment and A02 boundary dealing cases.
- Versioned JSON Schemas for receipts, journal, golden run, evidence manifest and
  dealing cases.
- Pure settlement engine: seeded accounts, spot quote and fill with the fixed
  EUR 0.05 charge, fund subscription with cash reservation, authorized NAV
  observation, allocation, redemption, double-entry journal and portfolio
  projection.
- CLI evidence runner: `pnpm scenario:golden`, `pnpm scenario:boundary`,
  `pnpm verify`.
- Browser portfolio replay for G01 and the separate redemption case, labelled as
  recorded replay with a fixture clock and synthetic-data label.
- CI workflow running typecheck, tests, build, evidence byte checks and pack
  verification.

### Evidence

- `evidence/g01/golden-run.json` and `evidence/g01/manifest.json`: G01 and G01-R
  replay with deterministic business digest
  `72b49ec1256c38fe68f1d63f12a73bc299cbeaa2e74108eb09f86f7b4c0d08cf`.
- `evidence/a02/dealing-cases.json`: 8/8 boundary dealing cases pass.

### Verification

- 64 tests across money, time, calendar, policy, journal, G01, fixtures, schemas
  and evidence determinism.
- `pnpm scenario:golden -- --check` and `pnpm verify` confirm the committed pack
  is byte-identical to a fresh replay.

## [0.2.0] — Settlement core

### Added

- Local partner API (`apps/api`) built on Fastify with `node:sqlite` persistence:
  quotes, orders, order list/read/cancel, portfolios, issuer NAV publication and
  local fixture controls.
- Durable event log, double-entry journal projection and transactional outbox
  worker: accepted orders settle asynchronously and keep their id through
  retries and restarts.
- Idempotent order acceptance (`Idempotency-Key`): same-key retries reuse the
  order, changed bodies return `409`.
- Spot buy and reverse sell (inventory and minimum-proceeds checks, fixed EUR
  0.05 charge), fund subscription with reservation and authorized-NAV
  allocation, redemption at the next applicable NAV, and eligible cancellation
  before the dealing-day cutoff.
- Reason codes and refusal contracts: stale price, price-source outage with
  `Retry-After`, expired quote, insufficient cash/inventory/liquidity, zero-unit
  fill, `NAV_MISSING`, `CANCELLATION_NOT_ALLOWED`, role authority and idempotency
  conflicts.
- Typed partner SDK (`packages/sdk`): dependency-free HTTP client with typed
  request and response contracts, typed errors and explicit idempotency keys.
- Runnable quickstart (`pnpm demo:partner`) that places the G01 orders through
  the SDK over HTTP and asserts the golden portfolio.
- Browser "Local API lab": ticket for spot buy, fund subscription and
  redemption, live portfolio buckets, order receipts, money movements and
  fixture controls (clock, NAV publication, reset).
- OpenAPI 3.1 document generated from the route schemas and committed at
  `docs/api/openapi.json`.
- API evidence: 19 A02 dealing cases and 6 A06 invariant cases with canonical
  business digests.
- Engine additions: reverse quotes with `MINIMUM_PROCEEDS_NOT_MET`, explicit
  subscription and redemption cancellation events.

### Evidence

- `evidence/g01/golden-run.json`: G01 + G01-R, digest
  `e2dc0b07bca023a90d05f8f72a26d849066df694e766499a65b280ea350657df`.
- `evidence/a02/api-dealing-cases.json`: 19/19 cases, digest
  `95b542d22198fef92a078c52dd305babfc3229d5f7e12ec70e5028c28bbf5e43`.
- `evidence/a06/invariants.json`: 6/6 cases, digest
  `14620af3535c0f4fbb9a6783cd7eac97589b34e97a5c321b371e7a55ae864104`.

### Verification

- 85 tests green; `pnpm scenario:api -- --check`, `pnpm api:openapi -- --check`
  and `pnpm verify` reproduce the committed artifacts.
- `pnpm demo:partner` reproduces the G01 golden portfolio through the API.

## Unreleased

- S03: Policy Lab simulation (scenario API, typed rule diff, two-branch comparison).

