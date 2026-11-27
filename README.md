# EuroRollup Settlement Lab

An open-source euro settlement sandbox for crypto trades and tokenized fund
orders, with an AI Policy Lab that turns a plain-English dealing-rule question
into a confirmed, replayable comparison.

> Synthetic data only. The sandbox uses invented balances, prices, instruments
> and identities. It moves no real funds, serves no real investors, and is not
> financial, legal or regulatory advice.

## What the project demonstrates

A crypto purchase has filled while a fund subscription waits for its net asset
value (NAV). The sandbox explains exactly when cash becomes an asset, reserves
pending cash explicitly, and links every state change to a reproducible
receipt. The same journeys run through a typed partner API, a browser ticket and
a command-line evidence verifier.

| Journey | What a visitor can do |
| --- | --- |
| Investor portfolio | Buy or sell test wrapped ETH, subscribe or redeem fictional fund units, inspect cash reservations and policy holds. |
| Product owner workspace | Ask an English question about the weekly fund cutoff, inspect the typed rule change, confirm it and compare affected orders side by side. |
| Institutional developer | Place the same orders through the typed API, reproduce a scenario from saved policy versions, and verify the evidence pack with a command-line verifier. |
| Issuer and operator | Publish a synthetic NAV, rotate an eligibility root, diagnose a delayed batch and recover a projection, each with a defined authority and audit event. |
| Public visitor | Watch the release film, step through the recorded settlement and run the reference policy comparison in the browser. |

Model output and computed simulation results are always labelled separately:
a proposal is not an execution, and every numerical outcome is calculated by the
deterministic engine after confirmation.

## Golden fixtures

All figures below are frozen inputs in `fixtures/` and are asserted by tests.

### G01 — one investor and two investment lifecycles

| Investor checkpoint | Spendable dEUR | Reserved dEUR | tWETH | eFUND |
| --- | --- | --- | --- | --- |
| Seed | 1,000.00 | 0.00 | 0 | 0 |
| Buy €200 at €2,000 per tWETH | 799.95 | 0.00 | 0.100000 | 0 |
| Request €300 at indicative NAV €100 | 499.95 | 300.00 | 0.100000 | 0 |
| Strike and settle at NAV €96 | 499.95 | 0.00 | 0.100000 | 3.125000 |

Closing portfolio value at the fixture marks of €2,000 and €96 is €999.95. A
separate redemption case redeems one unit at €98 and leaves €597.95 spendable
and 2.125000 units.

### P01 — the Friday cutoff experiment

Two independent €300 fund subscriptions from two verified investors, each
starting with €1,000:

| Order received Friday | Baseline · 16:00 cutoff | Candidate · 15:00 cutoff |
| --- | --- | --- |
| F-1450 · 14:50 UTC | Friday allocation, 3.125000 units at €96 | Friday allocation, 3.125000 units at €96 |
| F-1530 · 15:30 UTC | Friday allocation, 3.125000 units at €96 | Monday allocation, 3.000000 units at €100 |

Result card: **1 of 2 orders changes dealing date** and **€300 more reserved at
Friday close**. F-1530 settles 72 hours later and receives 0.125000 fewer units
at the supplied Monday NAV.

## Replay preview

The browser replay steps through the recorded G01 settlement with the pure
dealing engine running locally. While the fund request awaits its authorized
NAV, EUR 300.00 is displayed once as pending cash and is not counted as a
holding:

![Recorded replay: spendable EUR 499.95 and EUR 300.00 pending while awaiting NAV](docs/media/s01-portfolio-reserved.jpg)

See [`docs/verification/s01-foundation.md`](docs/verification/s01-foundation.md)
for the verified checkpoints, receipts and digests of the foundation step.

## Local API lab

The second view drives the local partner API through the typed SDK: create a
quote, accept an order, advance the fixture clock, publish the issuer NAV and
watch the outbox worker settle the order. While the EUR 300.00 fund request
awaits its NAV, the portfolio shows the reservation in its own bucket:

![Local API lab: EUR 300.00 pending while the fund request awaits its NAV](docs/media/s02-live-pending.jpg)

After the authorized NAV of 96.00 EUR is published, the pending cash becomes
3.125000 eFUND and the marked portfolio value stays at EUR 999.95:

![Local API lab after allocation: 3.125000 eFUND at NAV 96.00](docs/media/s02-live-allocated.jpg)

API documentation: [`docs/api/partner-api.md`](docs/api/partner-api.md) and the
generated [`openapi.json`](docs/api/openapi.json). Settlement-core verification:
[`docs/verification/s02-settlement-core.md`](docs/verification/s02-settlement-core.md).

## AI Policy Lab

The third view turns an English rule question into a typed proposal, requires
confirmation, and replays both settlement branches deterministically. The Friday
cutoff experiment is computed locally from the frozen P01 fixture and checked
against the committed CLI comparison pack:

![AI Policy Lab: 1 of 2 orders changes dealing date and EUR 300.00 stays reserved over the weekend](docs/media/s03-policy-lab-impact.jpg)

The result card reports 1 of 2 orders changing dealing date, EUR 300.00 more
reserved at Friday close and 0.125000 fewer units for the 15:30 order. The
comparison digest is identical in the browser, the service and the CLI; every
boundary replay case (14:59:59, 15:00:00, 16:00:00, closed Monday, missing NAV)
passes. Policy Lab documentation:
[`docs/policy-lab/p01-friday-cutoff.md`](docs/policy-lab/p01-friday-cutoff.md) and
verification: [`docs/verification/s03-policy-lab.md`](docs/verification/s03-policy-lab.md).

## Live local model

The Policy Lab can draft the rule change from a short English question with a
local model runtime. The model only produces the typed proposal; the deterministic
engine still computes the comparison. On release 1.0 the adapter is pinned to
`qwen3:4b` with prompt version `p01-live-v10`, temperature `0` and seed `42`.

![AI Policy Lab live-mode proposal with model metadata and deterministic impact](docs/media/s04-policy-lab-live.jpg)

```bash
ollama serve
ollama pull qwen3:4b
pnpm policy:model:status   # provider, pinned model, digest, prompt version
pnpm policy:eval           # 40-prompt A09 evaluation, writes evidence/policy-lab/eval.json
pnpm policy:record         # capture a genuine live proposal as the recorded preset
```

The A09 evaluation requires at least 18/20 exact valid drafts, 10/10 clarification
responses and 10/10 non-executable unsupported responses; the committed report
passes all three with every prompt recorded, including each failure. Malformed
model output is retried once with schema feedback and then rejected with a
recoverable `503`; a failed free-text request is never silently replaced by the
recorded preset, and the recorded preset and manual editor stay available.
Adapter documentation: [`docs/policy-lab/live-model-adapter.md`](docs/policy-lab/live-model-adapter.md);
verification: [`docs/verification/s04-live-model.md`](docs/verification/s04-live-model.md).

## Eligibility and euro sponsorship

Managed spot and fund dealing require current synthetic screening and issuer
class eligibility. The issuer commits wallet-bound credentials in versioned
Merkle roots, a real Noir circuit proves membership bound to wallet, chain, gate,
class, epoch and expiry, and a verified browser proof is generated locally:

![Eligibility view: three personas, policy matrix, browser proof and sponsored UserOperations](docs/media/s05-eligibility.jpg)

The policy matrix records 19 decisions (8 allow, 4 hold, 7 decline) and 9
assertions. A basic investor's fund subscription is refused before reserving cash
(`ELIGIBILITY_REQUIRED`), a flagged persona is declined on every managed route
(`SCREENING_DECLINED`), and a root rotation between request and allocation holds
the reserved cash, mints no units and exposes `POLICY_CHANGED`. A sponsorship
limit is declined independently with `SPONSOR_LIMIT` and leaves holdings
untouched. The sponsored lane runs against the pinned ERC-4337 EntryPoint v0.7.0
with a verifying paymaster: a sponsored success, an included failure that still
costs the sponsor and an exhausted sponsor that reverts with `AA31`.

```bash
pnpm eligibility:matrix -- --check   # documented policy decisions
pnpm eligibility:verify              # circuit, verification key, proofs and vectors
pnpm aa:verify                       # committed sponsored UserOperation receipts
```

Regenerating the circuit and receipts needs the pinned toolchain
(`nargo` 1.0.0, `bb` 6.1.0, Foundry `anvil`): `pnpm eligibility:fixtures`,
`pnpm eligibility:artifacts`, `pnpm eligibility:proofs`, `pnpm aa:scenario`.
Eligibility documentation: [`docs/policy-lab/eligibility.md`](docs/policy-lab/eligibility.md);
account abstraction: [`docs/aa/account-abstraction.md`](docs/aa/account-abstraction.md);
verification: [`docs/verification/s05-eligibility-aa.md`](docs/verification/s05-eligibility-aa.md).

## Quick start

Requirements: Node.js 22 or newer and pnpm 9 or newer
(`corepack enable` provides pnpm).

```bash
pnpm install
pnpm test              # deterministic unit, fixture and API tests
pnpm typecheck         # TypeScript project checks
pnpm scenario:golden   # replay G01 and write the evidence pack
pnpm scenario:api      # regenerate the A02 and A06 API evidence
pnpm policy:replay     # replay the P01 comparison and write its evidence pack
pnpm policy:verify     # verify the committed P01 comparison pack
pnpm policy:eval       # run the 40-prompt live-model evaluation (needs Ollama)
pnpm policy:record     # capture a genuine live-model proposal
pnpm verify            # verify the committed G01 evidence pack
pnpm dev               # browser: recorded replay, Local API lab and AI Policy Lab
pnpm api               # local partner API on http://127.0.0.1:3000
pnpm demo:partner      # SDK quickstart: G01 orders over HTTP
pnpm api:openapi       # regenerate docs/api/openapi.json
```

The browser "Local API lab" view needs the API running (`pnpm api`); the
recorded replay works without a wallet, a model key or a network connection.

See [`docs/`](docs/README.md) for architecture, fixtures, evidence formats and
the delivery plan, and the project Wiki for the reader-facing project pages.

## Repository layout

```text
apps/web             Browser replay, Local API lab and AI Policy Lab views
apps/api             Local partner API, event log, journal, outbox worker and scenario service
packages/dealing     Pure deterministic dealing engine shared by browser, CLI and worker
packages/policy-lab  Proposal schema, draft revisions and two-branch replay (shared by browser, API and CLI)
packages/sdk         Typed partner SDK and HTTP client
contracts           Foundry contracts (spot router, fund vault, share token)
circuits            Noir eligibility circuit and vectors
fixtures            Frozen synthetic inputs (G01, P01, calendars, instruments)
schemas             Versioned JSON Schemas for receipts, journals and evidence packs
evidence            Committed evidence packs for released gates
docs                Architecture, fixtures, plan, ADRs and verification notes
```

## Delivery status and roadmap

The project is delivered in documented steps tracked as GitHub Issues and
Milestones. Each step closes only when its fixtures, tests and evidence are
merged, and larger steps are tagged as GitHub Releases.

- `v0.1.0` — foundation: frozen fixtures, integer money arithmetic, versioned UTC
  calendar, the G01 portfolio replay with a reproducible evidence pack.
- `v0.2.0` — settlement core: local partner API, durable event log and outbox,
  idempotent orders, cancellation windows, typed SDK, browser Local API lab and
  the A02/A06 evidence.
- `v0.3.0` — AI Policy Lab: typed proposal schema, revisioned drafts with
  confirmation binding, deterministic P01 two-branch comparison, scenario API,
  browser Policy Lab view and the A09 deterministic evidence pack.
- `v0.4.0` — live local model adapter: pinned `qwen3:4b`, prompt version
  `p01-live-v10`, the 40-prompt evaluation and a genuine recorded live capture.
- `v0.5.0` — eligibility and sponsorship: real Noir membership circuit, three
  personas and policy matrix, browser proving, sponsored account lane against the
  pinned ERC-4337 EntryPoint and A04 receipts.
- Next: the pinned local rollup, blob batch publication and bridge withdrawal
  (S06).

See the development roadmap in the GitHub Issues and
[`docs/plan/roadmap.md`](docs/plan/roadmap.md). API surface:
[`docs/api/partner-api.md`](docs/api/partner-api.md).

## Security

The sandbox is synthetic and local-first. Local credentials are never committed:
the maintainer's GitHub token lives in an ignored `.git-token` file. Dependency
alerts, secret scanning, push protection and branch protection are enabled on
the repository. Please report vulnerabilities according to
[`SECURITY.md`](SECURITY.md).

## License

Apache License 2.0 — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
