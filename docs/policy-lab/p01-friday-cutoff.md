# The Friday cutoff experiment (P01)

The AI Policy Lab answers a product-owner question — *what if the fund moved its
Friday subscription cutoff from 16:00 to 15:00 UTC?* — by turning the question
into one typed rule change, requiring confirmation, and replaying two settlement
branches deterministically from the same frozen inputs.

## Why a deterministic simulation

The model proposes a rule. It never calculates an outcome. All numbers come from
replaying frozen intents and NAV observations through the same pure dealing
engine the order worker uses. That separation is what makes the result auditable:
a reviewer can reproduce every unit and every euro from versioned inputs.

## Frozen inputs

- Fixture `P01` v1.0.0: two independent EUR 300.00 fund subscriptions from
  verified investors (14:50 and 15:30 UTC on Friday), each starting with
  EUR 1,000.00.
- Calendar `LAB-UTC-1`: Friday 20 November 2026 and Monday 23 November 2026 are
  dealing days; the weekend is closed.
- NAVs: Friday 96.00 EUR and Monday 100.00 EUR, each a separate signed
  observation at 17:00 UTC.
- Baseline policy v1: weekly eFUND subscription cutoff 16:00 UTC.
- Candidate policy v2 (the confirmed patch): Friday cutoff 15:00 UTC.

## Expected result

| Order | Baseline | Candidate |
| --- | --- | --- |
| F-1450, 14:50 UTC | Friday, 3.125000 units at 96.00 | Friday, 3.125000 units at 96.00 |
| F-1530, 15:30 UTC | Friday, 3.125000 units at 96.00 | Monday, 3.000000 units at 100.00 |

| Snapshot across both accounts | Baseline | Candidate |
| --- | --- | --- |
| Friday 17:01 UTC | 1,400.00 spendable, 0.00 reserved, 6.250000 units | 1,400.00 spendable, 300.00 reserved, 3.125000 units |
| Monday 17:01 UTC | 1,400.00 spendable, 0.00 reserved, 6.250000 units | 1,400.00 spendable, 0.00 reserved, 6.125000 units |

Result card: **1 of 2 orders changes dealing date**, **EUR 300.00 more reserved at
Friday close**, F-1530 settles **72 hours later** and receives **0.125000 fewer
units**. Both branches spend EUR 600.00; the unit difference is not cash.

## Boundary replay cases

| Case | Requested | Baseline | Candidate |
| --- | --- | --- | --- |
| `P01-B-145959` | Fri 14:59:59 | Fri, 3.125000 | Fri, 3.125000 |
| `P01-B-150000` | Fri 15:00:00 | Fri, 3.125000 | Mon, 3.000000 |
| `P01-B-160000` | Fri 16:00:00 | Mon, 3.000000 | Mon, 3.000000 |
| `P01-B-163000` | Fri 16:30:00 | Mon, 3.000000 | Mon, 3.000000 |
| `P01-B-MONDAY-CLOSED` | Fri 15:30, Monday closed | Fri, 3.125000 | Tue, 3.030303 at 99.00 |
| `P01-B-MISSING-MONDAY-NAV` | Fri 15:30, Monday NAV missing | Fri, 3.125000 | Mon, pending, 300.00 reserved |

## Replay contract

1. Each branch starts from the same opening snapshot and replays the same ordered
   intents and external observations.
2. Observation time is respected; the engine only allocates after an authorized
   NAV for the assigned dealing day exists.
3. Branch state is isolated; the only variable is the confirmed policy patch.
4. Per-asset arithmetic is integer base units; no floating point is involved.
5. Branches record the policy hash, event-log hash, engine version, schema
   version and per-order results.
6. A stable comparison digest is computed over canonical JSON with sorted object
   keys and stable array order, hashed as SHA-256. Execution timestamps, run ids
   and model prose are excluded.

## Cross-runtime equality

The comparison digest is identical in the browser view, the scenario API and the
CLI evidence runner. The browser displays the locally computed pack digest next
to the committed CLI pack digest; a mismatch would be shown as an error.

```bash
pnpm policy:replay          # write evidence/policy-lab/p01-comparison.json
pnpm policy:replay -- --check
pnpm policy:verify
```

Digests of the committed pack:

- Comparison digest:
  `c5405bc564a1a2d44b5485aa14bddf6e29af91dfba2d560177cde58e8d1f5f2f`
- Pack digest:
  `653646b2f9031af28b7b7a95687fd02e3ab368b72456d4605503c65296c1738d`

## Proposal contract

The model-facing contract is a discriminated JSON Schema with
`additionalProperties: false`:

- `proposed`: `operation`, `asset`, `weekday`, `timeUtc`, `timezone` and an
  optional `expectedTimeUtc` (a stated prior time that must match the baseline);
- `clarify`: `question` and `missingFields`;
- `unsupported`: `reasonCode`.

Only one change is supported in release 1.0: one weekday's weekly eFUND
subscription cutoff, whole-minute UTC times from 00:01 to 16:59. Redemption
deadlines, NAV sources, fees and eligibility rules stay fixed. A question about
several changes requires narrowing the scope.

## Run it

- Browser: `pnpm dev`, open the **AI Policy Lab** view, load the recorded
  proposal, confirm and compare.
- API: `POST /v1/scenarios/drafts`, `PATCH /v1/scenarios/{id}/draft`,
  `POST /v1/scenarios/{id}/runs`, then `GET /v1/scenario-runs/{id}` and
  `/evidence`. See [`docs/api/partner-api.md`](../api/partner-api.md).
- CLI: `pnpm policy:replay` and `pnpm policy:verify`.

## Known limitation

The recorded proposal preset is a deterministic fixture for step S03. The working
local model adapter and the 40-prompt evaluation arrive in step S04, which
replaces the recorded capture with a genuine one; the deterministic replay and
its digests are unaffected by that change.
