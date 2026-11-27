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

## Unreleased

- S02: settlement core, order API, outbox, journal projection and partner SDK.
