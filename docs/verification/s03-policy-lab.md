# Verification — step S03 (AI Policy Lab)

This page records the verification evidence for development step S03: the typed
proposal contract, revisioned drafts with confirmation binding, the deterministic
P01 two-branch comparison and the browser Policy Lab. Results are attached to
the GitHub release `v0.3.0`.

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
pnpm policy:replay -- --check
pnpm policy:verify
pnpm verify
pnpm demo:partner
```

All commands are expected to exit zero on the release commit. CI runs the same
sequence on every pull request.

## Gate A09 — deterministic comparison subset

| Evidence | Result |
| --- | --- |
| `evidence/policy-lab/p01-comparison.json` | P01 baseline vs candidate pack |
| Comparison digest | `c5405bc564a1a2d44b5485aa14bddf6e29af91dfba2d560177cde58e8d1f5f2f` |
| Pack digest | `653646b2f9031af28b7b7a95687fd02e3ab368b72456d4605503c65296c1738d` |
| Boundary replay cases | 6/6 pass in the pack |

The pack contains both branch policies and hashes, branch event-log hashes,
per-order results (dealing date, units, NAV, reserved cash at Friday close),
Friday and Monday portfolio snapshots, the order-level changes, the result card
values, all boundary replay cases, the evidence checklist and the digests.

Checked outcomes:

- F-1450 settles Friday in both branches with 3.125000 units.
- F-1530 settles Friday in the baseline and Monday in the candidate with
  3.000000 units at NAV 100.00.
- Baseline Friday close: 1,400.00 spendable, 0.00 reserved, 6.250000 units.
- Candidate Friday close: 1,400.00 spendable, 300.00 reserved, 3.125000 units.
- Candidate Monday close: 1,400.00 spendable, 0.00 reserved, 6.125000 units.
- 1 of 2 orders changes dealing date; EUR 300.00 extra reserved at Friday close.
- F-1530 settles 72 hours later with 0.125000 fewer units.
- Boundary cases at 14:59:59, 15:00:00, 16:00:00 UTC, a closed Monday with a
  Tuesday NAV and a missing Monday NAV all match their frozen expectations.

## Cross-runtime equality

| Runtime | How the digest is produced |
| --- | --- |
| Browser | AI Policy Lab view recomputes both branches locally and compares its pack digest with the committed CLI pack; the view displays "matches committed CLI evidence" |
| Service | `POST /v1/scenarios/{id}/runs` executes the same package through the outbox worker; run result and `/evidence` payload are compared with the committed pack in `apps/api/test/scenarios.test.ts` |
| CLI | `pnpm policy:replay -- --check` reproduces the committed bytes; `pnpm policy:verify` re-runs the replay and checks file digests |

The API test asserts that the service's evidence payload is byte-identical to
`evidence/policy-lab/p01-comparison.json`.

## Proposal contract, drafts and confirmation

Tests in `packages/policy-lab/test/draft.test.ts` cover:

- the recorded proposal producing the Friday 16:00 → 15:00 diff as revision 1;
- clarification when manual fields are incomplete (missing weekday/time/timezone);
- unsupported weekday and out-of-range time dispositions;
- `NO_CHANGE` when the proposed time equals the baseline;
- rejection of a stated prior time that disagrees with the baseline;
- manual edits producing a new revision with a parent link and a new confirmation
  digest;
- the discriminated JSON Schema with `additionalProperties: false` and the
  500-character text limit;
- live mode returning a recoverable "not configured" state until S04.

Scenario API tests in `apps/api/test/scenarios.test.ts` cover:

- draft creation, manual clarification and revisioned edits;
- stale revision (409), unknown fields (422), session ownership (403), prior time
  mismatch (422) and `NO_CHANGE` runs (422);
- run idempotency (same key and body returns the same run, changed body 409),
  confirmation mismatch (409) and evidence only after success;
- queued → succeeded run lifecycle through the outbox worker;
- byte parity of the run evidence with the committed CLI pack.

## Browser Policy Lab

The view implements the five guided states:

1. **Select inputs** — fixture, baseline policy version, calendar, UTC labels and
   the recorded question preset, plus a manual-edit form.
2. **Review proposal** — one structured diff (asset, order type, weekday, old/new
   UTC times, fixture digest, baseline hash, revision, draft and confirmation
   digests) with editable supported fields.
3. **Clarify or reject** — the clarification question with the missing fields, or
   the unsupported/`NO_CHANGE` state; the run button is not available.
4. **Confirm and compare** — the run binds the visible diff to the revision,
   baseline and fixture digest; duplicate submission is disabled while computing.
5. **Read the impact** — affected/total orders, extra cash reserved, per-order
   rows with dates, units and reason, Friday/Monday snapshots, timeline, boundary
   checks, comparison download and reset.

Screenshots: `docs/media/s03-policy-lab-impact.jpg` (confirmed comparison) and
`docs/media/s03-policy-lab-review.jpg` (manual-edit path).

## Test inventory

134 tests across:

- the S01 foundation and S02 settlement-core suites (money, time, calendar,
  policy, journal, G01 evidence, API evidence and invariants);
- 35 Policy Lab tests: proposal contract, drafting and revisions, P01 branch
  numbers, branch isolation, boundary replay, digest stability and committed
  evidence byte parity;
- scenario API tests including cross-runtime evidence parity.

## Known limitations at this step

- The recorded proposal preset is a deterministic fixture; the working local
  model adapter, free-text parsing and the 40-prompt evaluation arrive in S04.
- A run recomputes the whole P01 pack synchronously in the worker; a hosted
  runner and longer scenarios are out of scope for release 1.0.
- Eligibility personas do not affect the Policy Lab comparison; S05 adds the
  eligibility policy matrix.
