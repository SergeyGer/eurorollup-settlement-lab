# Verification — step S02 (settlement core)

This page records the verification evidence for development step S02: the local
partner API, the durable outbox and event log, order idempotency, cancellation windows and the A02/A06 evidence produced by the
API.

Results are attached to the GitHub release `v0.2.0`.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm scenario:golden -- --check
pnpm scenario:boundary -- --check
pnpm scenario:api -- --check
pnpm api:openapi -- --check
pnpm verify
pnpm demo:partner
```

All commands are expected to exit zero on the release commit. CI runs the same
sequence on every pull request.

## Evidence digests

| Artifact | Summary | Business digest |
| --- | --- | --- |
| `evidence/g01/golden-run.json` | G01 + G01-R deterministic replay (engine 0.2.0) | `e2dc0b07bca023a90d05f8f72a26d849066df694e766499a65b280ea350657df` |
| `evidence/a02/dealing-cases.json` | 8/8 boundary dealing assignments | `0340e01bac5e8edb72f40c0a33beb017d328c9c75d73c50b6beeecaaaa0273f2` |
| `evidence/a02/api-dealing-cases.json` | 19/19 API dealing cases | `95b542d22198fef92a078c52dd305babfc3229d5f7e12ec70e5028c28bbf5e43` |
| `evidence/a06/invariants.json` | 6/6 accounting and replay invariants | `14620af3535c0f4fbb9a6783cd7eac97589b34e97a5c321b371e7a55ae864104` |

The G01 digest changes when the engine version changes; the `v0.1.0` evidence was
produced by engine `0.1.0` and remains attached to that release.

## Gate A02 — NAV and dealing (API level)

The 19 API cases exercise the request path end to end, including the outbox
worker and the issuer authority:

| Case | What it proves |
| --- | --- |
| `A02-API-QUOTE-VALIDATION` | Unsupported combos, zero amounts, unknown accounts and malformed bodies return documented codes |
| `A02-API-CUTOFF-BEFORE` | 15:59:59 UTC stays on Friday's dealing day |
| `A02-API-CUTOFF-EXACT` | 16:00:00 UTC advances to Monday |
| `A02-API-WEEKEND` | Weekend requests advance to the next dealing day |
| `A02-API-HOLIDAY` | A closed Monday in `LAB-UTC-2` advances to Tuesday |
| `A02-API-QUOTE-EXPIRY` | A 30-second spot quote cannot be used after expiry |
| `A02-API-STALE-PRICE` | A 61-second-old price source refuses the quote |
| `A02-API-PRICE-UNAVAILABLE` | A down price source returns `503` with `Retry-After: 5` |
| `A02-API-INSUFFICIENT-CASH` | A 1,200.00 dEUR subscription is refused before acceptance |
| `A02-API-SPOT-FILL` | Spot fill records 200.00 cash, 0.05 charge and 0.1 tWETH |
| `A02-API-FUND-ALLOCATION` | Reserved cash becomes 3.125000 eFUND at NAV 96.00 |
| `A02-API-DUST` | 1,041,666 units are issued and 64 base units of dust return |
| `A02-API-MISSING-NAV` | Missing NAV keeps cash reserved with `NAV_MISSING` |
| `A02-API-CANCEL-BEFORE` | Cancellation before the cutoff releases the reservation |
| `A02-API-CANCEL-AFTER` | Cancellation after the cutoff is refused |
| `A02-API-ZERO-UNIT-BOUNDARY` | Zero-unit fills are refused at quote time |
| `A02-API-REDEMPTION` | One unit redeems at the next NAV of 98.00 and pays 98.00 dEUR |
| `A02-API-SPOT-SELL` | Reverse quote sells 0.05 tWETH, checks inventory and charges 0.05 |
| `A02-API-G01-MATCH` | G01 through the API matches the CLI evidence exactly |

## Gate A06 — accounting and replay invariants (API level)

| Case | What it proves |
| --- | --- |
| `A06-IDEMPOTENT-ORDERS` | Same-key retries reuse one order; changed bodies conflict with 409 |
| `A06-CONCURRENT-CASH` | Two competing 600.00 reservations cannot overspend 1,000.00; the second is declined |
| `A06-CONSERVATION` | The journal balances to zero per asset across spot, fund and redemption |
| `A06-RESTART-RECOVERY` | Projections rebuild from the event log; a pending order resumes after restart |
| `A06-REPLAY-EQUALITY` | Identical action sequences produce identical canonical state |
| `A06-DUPLICATE-EVENT` | A duplicate event id cannot create a second business effect |

## Browser ticket

The "Local API lab" view drives the same endpoints through the typed SDK. The
specification's G01 journey is reproduced live:

- `docs/media/s02-live-pending.jpg` — spot fill done, EUR 300.00 pending while the
  fund request waits for its NAV.
- `docs/media/s02-live-allocated.jpg` — NAV 96.00 published, 3.125000 eFUND
  allocated, spendable EUR 499.95 and marked value EUR 999.95.

The browser sends explicit idempotency keys, shows the order and receipt, and
labels the API mode as a local fixture.

## Quickstart

`pnpm demo:partner` starts the API in-process, uses the SDK over real HTTP to buy
EUR 200 of tWETH and subscribe EUR 300 to eFUND, advances the fixture clock,
publishes the issuer NAV and asserts the G01 portfolio. It prints a pass/fail
summary and exits non-zero on mismatch.

## Test inventory

85 tests across:

- money, time, calendar, policy, journal and receipt schemas (S01 suite);
- engine reverse quotes, minimum proceeds and fund cancellations;
- API routes, error mapping, role authority, dev cursors and reset;
- 19 API evidence cases and 6 invariant cases reproduced byte for byte;
- OpenAPI document regeneration;
- browser replay data and evidence determinism.

## Known limitations at this step

- Chain state is a placeholder (`NOT_SUBMITTED`); the pinned rollup and receipt
  hashes arrive in S06.
- Eligibility personas are stored but not enforced; S05 adds the circuit and the
  persona policy matrix.
- The Policy Lab scenario API and comparison endpoints arrive in S03.
