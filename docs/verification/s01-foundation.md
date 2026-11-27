# Verification — step S01 (foundation)

This page records the verification evidence for development step S01: frozen
fixtures, integer money arithmetic, the versioned UTC calendar and the G01
portfolio replay. Results are attached to the GitHub release `v0.1.0` and to
the commit that closes issue S01.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm scenario:golden -- --check
pnpm scenario:boundary -- --check
pnpm verify
```

All commands are expected to exit zero on the release commit. CI runs the same
sequence on every pull request.

## Gate A01 — portfolio

G01 is replayed twice (the main lifecycle and the separate redemption case) on
the frozen seed. The committed `evidence/g01/golden-run.json` is byte-identical
to a fresh replay.

| Investor checkpoint | Spendable dEUR | Reserved dEUR | tWETH | eFUND | Marked value |
| --- | --- | --- | --- | --- | --- |
| Seed | 1,000.00 | 0.00 | 0 | 0 | 1,000.00 |
| Buy EUR 200 at EUR 2,000 per tWETH | 799.95 | 0.00 | 0.100000 | 0 | 999.95 |
| Request EUR 300 at indicative NAV EUR 100 | 499.95 | 300.00 | 0.100000 | 0 | 999.95 |
| Strike and settle at NAV EUR 96 | 499.95 | 0.00 | 0.100000 | 3.125000 | 999.95 |
| Redemption case: one unit at EUR 98 | 597.95 | 0.00 | 0.100000 | 2.125000 | 1,006.20 |

Receipts:

| Receipt | Business state | Units | Cash | Charge |
| --- | --- | --- | --- | --- |
| G01-SPOT-01 | FILLED | 0.100000 tWETH | 200.00 dEUR deployed | 0.05 dEUR |
| G01-FUND-01 | ALLOCATED | 3.125000 eFUND | 300.00 dEUR at NAV 96.00 | 0.00 dEUR |
| G01-RED-01 | REDEEMED | 1.000000 eFUND burned | 98.00 dEUR paid at NAV 98.00 | 0.00 dEUR |

Deterministic identifiers (engine `0.1.0`, as released in `v0.1.0`):

- G01 business digest:
  `72b49ec1256c38fe68f1d63f12a73bc299cbeaa2e74108eb09f86f7b4c0d08cf`
- Engine version `0.2.0` (settlement core) regenerated the G01 evidence with a new
  digest; see [`s02-settlement-core.md`](s02-settlement-core.md) for the current
  artifact.
- G01-R case digest is recorded inside the same pack.
- The journal balances to zero per asset; the issuer, escrow, fee recipient and
  issuance control accounts are reconciled by the engine.

## Gate A02 — dealing boundaries (foundation subset)

`evidence/a02/dealing-cases.json` contains all frozen boundary assignments.

| Case | Requested | Baseline | Candidate |
| --- | --- | --- | --- |
| B-1459-59 | Fri 14:59:59 UTC | Fri 20 Nov | Fri 20 Nov |
| B-1500-00 | Fri 15:00:00 UTC | Fri 20 Nov | Mon 23 Nov |
| B-1600-00 | Fri 16:00:00 UTC | Mon 23 Nov | Mon 23 Nov |
| B-1630-00 | Fri 16:30:00 UTC | Mon 23 Nov | Mon 23 Nov |
| B-SATURDAY | Sat 14:00 UTC | Mon 23 Nov | Mon 23 Nov |
| B-SUNDAY | Sun 12:00 UTC | Mon 23 Nov | Mon 23 Nov |
| B-MONDAY-BEFORE | Mon 10:00 UTC | Mon 23 Nov | Mon 23 Nov |
| B-HOLIDAY-MONDAY | Mon 10:00 UTC, closed Monday | Tue 24 Nov | Tue 24 Nov |

Boundary digest: `0340e01bac5e8edb72f40c0a33beb017d328c9c75d73c50b6beeecaaaa0273f2`.
Summary: 8/8 passed.

The rest of gate A02 (stale price refusal, insufficient cash, dust, zero-unit
fill, cancellation and missing NAV holds) is asserted by engine guard-rail
tests here and receives its full evidence file in step S02, where the order API
and worker exercise the same pure functions.

## Browser replay

The browser replay renders the same numbers from the same fixture and the same
pure engine. Screenshots from the recorded replay:

- `docs/media/s01-portfolio-reserved.jpg` — spendable EUR 499.95, pending EUR
  300.00, marked value EUR 999.95 while the fund order awaits its NAV.
- `docs/media/s01-portfolio-final.jpg` — 3.125000 eFUND allocated, no reserved
  cash.
- `docs/media/s01-redemption.jpg` — redemption case with EUR 597.95 spendable
  and 2.125000 units.

The page is labelled "Synthetic data" and "Recorded replay"; it displays a
fixture clock rather than wall-clock time and labels computed results separately
from model output.

## Test inventory

64 tests across:

- integer base-unit money arithmetic, precision rejection, rounding and dust;
- UTC instant parsing, cutoff seconds, dealing-day assignment and calendars;
- policy change validation, `NO_CHANGE`, revisioning and digests;
- double-entry journal conservation and ordering;
- G01 checkpoints, receipts, redemption and guard rails;
- P01 dealing-day assignments and unit math;
- JSON Schema validation of evidence, receipts, journal and boundary cases;
- byte determinism of the committed evidence pack;
- tamper detection through file digests.

## Known limitations at this step

- `apps/api` and `packages/sdk` are documented boundaries only; the partner API
  arrives in S02.
- P01 two-branch allocation replay arrives in S03; this step freezes the
  scenario and verifies assignment and unit arithmetic.
- The engine guard rails are covered by unit tests, but their full evidence
  files (stale price, insufficient cash, dust, cancellation, missing NAV) are
  produced by the API step.
