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

## [0.3.0] — AI Policy Lab

### Added

- `packages/policy-lab`: discriminated proposal JSON Schema (proposed / clarify /
  unsupported, `additionalProperties: false`, documented enums, 500-character
  text limit), server-owned draft derivation, revisioning with parent links,
  confirmation digests bound to baseline policy, fixture and revision.
- Deterministic P01 two-branch replay: identical ordered intents and NAV
  observations, isolated branch state, per-branch policy hash and event-log hash,
  per-order results and Friday/Monday portfolio snapshots. Both branches report
  the specification numbers: 3.125000 vs 3.000000 units, 1 of 2 orders affected,
  EUR 300.00 extra reserved at Friday close, 72-hour later settlement.
- Scenario API: `POST /v1/scenarios/drafts`, `PATCH /v1/scenarios/{id}/draft`,
  `POST /v1/scenarios/{id}/runs`, `GET /v1/scenario-runs/{id}` and
  `/evidence`, with session ownership, stale-revision and confirmation-mismatch
  rejections, run idempotency and a durable outbox-driven computation.
- Browser AI Policy Lab view implementing the five guided states: select inputs,
  review the typed diff, clarify or reject, confirm and compare, read the impact
  with per-order rows, snapshots, timeline, boundary checks and comparison
  download.
- P01 evidence pack `evidence/policy-lab/p01-comparison.json` plus manifest; the
  comparison digest is identical in the browser, the service and the CLI.
- Boundary replay cases: 14:59:59, 15:00:00, 16:00:00 UTC, a closed Monday with a
  Tuesday NAV, and a missing Monday NAV that keeps the candidate order pending.
- CLI: `pnpm policy:replay [--fixture P01] [--check]` and `pnpm policy:verify`.

### Evidence

- Comparison digest: `c5405bc564a1a2d44b5485aa14bddf6e29af91dfba2d560177cde58e8d1f5f2f`.
- Pack digest: `653646b2f9031af28b7b7a95687fd02e3ab368b72456d4605503c65296c1738d`.
- Boundary replay cases: 6/6 pass in the same pack.
- 134 tests green; the browser Policy Lab view verifies its locally computed pack
  digest against the committed CLI evidence at runtime.

## [0.4.0] — Live local model adapter

### Added

- Working local inference adapter over the Ollama HTTP API, pinned to
  `qwen3:4b` (content digest recorded in evidence), prompt version
  `p01-live-v10`, temperature `0`, seed `42`, context 4096 and a 120-token
  generation budget.
- Structured-output contract: the runtime is constrained by a decoding schema
  (status and field enums, no additional properties) and the adapter re-validates
  every parsed object against the full proposal schema.
- Failure policy: one retry with schema feedback after malformed output; a second
  failure, a configured 15-second deadline per attempt or an unreachable runtime
  returns a recoverable `MODEL_OUTPUT_INVALID`, `MODEL_TIMEOUT` or
  `MODEL_UNAVAILABLE` with `Retry-After`. A failed request never falls back to
  the recorded preset.
- Confirmation boundary and evidence: the typed proposal plus model metadata
  (provider, model, digest, prompt version, attempts, elapsed time) is recorded
  with the draft; computed results and digests never depend on the model. Raw
  free text stays session-local.
- Live mode in the AI Policy Lab with three input modes (recorded proposal,
  manual edit, live local model) and model metadata in the review state.
- `GET /v1/model/status` reporting the pinned model, digest, prompt version and
  availability; the scenario API returns recoverable `503` model errors.
- 40-prompt A09 evaluation: 20 valid paraphrases, 10 ambiguous requests and 10
  unsupported requests, with thresholds of 18/20 exact valid drafts, 10/10
  clarifications and 10/10 non-executable unsupported dispositions. The committed
  report passes all three (20/20, 10/10, 10/10) and records every prompt, model
  settings, elapsed times and failures.
- Genuine recorded live capture: `fixtures/policy-lab/p01-recorded-proposal.json`
  now contains a real adapter proposal with capture metadata, and
  `evidence/policy-lab/live-model-draft.json` records the captured draft. The
  deterministic comparison remains a separate file.
- CLI: `pnpm policy:eval [--adapter ollama|mock] [--verify-only]`,
  `pnpm policy:record`, `pnpm policy:model:status`.

### Evidence

- `evidence/policy-lab/eval.json` — 20/20 valid, 10/10 clarify, 10/10
  non-executable unsupported; model `qwen3:4b`, prompt `p01-live-v10`.
- `evidence/policy-lab/live-model-draft.json` — genuine captured live proposal
  with draft and confirmation digests.
- `evidence/policy-lab/p01-comparison.json` — deterministic comparison, unchanged
  by the model capture.
- 157 tests green; CI runs the scripted evaluation harness and validates the
  committed evaluation structure and thresholds.

## [0.5.0] — Eligibility and sponsorship

### Added

- Real Noir eligibility circuit (UltraHonk over BN254, pedersen Merkle tree):
  proves membership of a wallet-bound credential in the issuer's current root and
  binds the proof to wallet, chain id, gate address, class, epoch and expiry.
  The compiled circuit, verification key and verifier metadata (circuit hash,
  verification-key hash, versions) are committed.
- Deterministic fixture pipeline: versioned personas, two issuer epochs with a
  root rotation, screening fixtures and demo witnesses generated with the pinned
  Noir hash tools.
- Three-persona dealing policy matrix: verified investors may use every route;
  basic investors get spot and redemption but receive `ELIGIBILITY_REQUIRED`
  before reserving cash for fund subscription and share transfer; flagged personas
  are declined with `SCREENING_DECLINED`. Stale screening, review dispositions,
  missing proofs and expired credentials hold the movement with a reason.
- Root rotation between fund request and allocation: reserved cash stays in
  custody, no units are minted, `POLICY_CHANGED` exposes `authorized_refund` and
  `revalidate_with_current_proof`.
- Independent sponsorship decision (`SPONSOR_LIMIT`) that leaves holdings
  untouched.
- Browser proving and local verification in the new "Eligibility & sponsorship"
  view; the demo witness stays in the tab and is discarded after proving.
- Sponsored account lane against the pinned ERC-4337 EntryPoint v0.7.0 with the
  `VerifyingPaymaster` sample on a local Anvil chain: sponsored success, included
  failure and exhausted sponsor receipts, with sponsor deposit movements, user
  charge and hash presence recorded.
- API: `GET /v1/eligibility/policy`, `GET /v1/eligibility/accounts/{accountId}`,
  `POST /v1/eligibility/proofs`, `POST /v1/eligibility/proofs/verify`,
  `GET /v1/sponsorship/status`, `GET /v1/account-abstraction/receipts`. Managed
  order acceptance enforces the screening disposition and issuer class before any
  state is written.
- CLI: `pnpm eligibility:fixtures`, `eligibility:artifacts`, `eligibility:matrix`,
  `eligibility:proofs`, `eligibility:verify`, `aa:scenario`, `aa:verify`.

### Evidence

- `evidence/a03/policy-matrix.json` — 19 decisions (8 allow, 4 hold, 7 decline)
  and 9 assertions, all passing.
- `evidence/a03/proof-vectors.json` — 3/3 positive proofs verified and 5/5
  negative vectors rejected.
- `evidence/a03/browser-proving.json` — cold proving 20,530 ms including backend
  initialisation, warm proving 3,334 ms and 3,285 ms, verification about 1.3 s.
- `evidence/a04/aa-receipts.json` — sponsored success, included failure and
  exhausted sponsor observed on the local chain with consistent deposit deltas.
- 181 tests; CI rebuilds the policy matrix, verifies committed proofs and
  artifact hashes, and verifies the account-abstraction receipts offline.

## [0.7.0] — Economics and operations

### Added

- `@eurorollup/economics`: deterministic integer arithmetic for measured bundle
  reconciliation (sponsor payment, bundler revenue, per-operation allocation with a
  separate failed/unattributable bucket and an explicit residual, named
  reconciliation differences, unavailable components recorded as null), an
  interactive cost experiment (scenario matrix, budget exhaustion, break-even
  charge, explicit unavailable handling), a sponsorship funding guard and chain
  operator economics.
- `pnpm a07:economics`: measures one real two-operation sponsored ERC-4337 bundle on
  a local Anvil chain (pinned EntryPoint v0.7.0, SimpleAccount factory and
  VerifyingPaymaster) and writes `evidence/a07/bundle-reconciliation.json` plus
  `benchmarks/cost-experiment.json`.
- `pnpm a07:operations`: RPC failover drill in a two-node lab, indexer restore drill
  over the frozen G01 event log, delayed-NAV drill over the dealing engine, and the
  performance publication (200 warm portfolio reads and 30 real Noir UltraHonk proof
  generations on the named local host).
- `pnpm a07:batch-drill`: pauses and restores the batcher on the controlled local OP
  Stack devnet under sustained L2 load, records the stalled safe head, the delayed
  finality alert with the preserved unsafe receipt status, backlog clearance and the
  resulting L1 batch publication.
- Operating dashboard snapshot, weighted provider evaluation (two RPC profiles plus
  one indexing alternative) and a simulated incident postmortem with named roles.
- Browser view "Economics & operations" with the observed bundle beside an editable
  cost scenario; API endpoints `GET /v1/economics/observed`,
  `POST /v1/economics/scenario` and `GET /v1/operations/dashboard`.
- Versioned evidence plus offline verifier `pnpm a07:verify` (also in CI), and
  documentation under `docs/economics/` and `docs/operations/`.

### Evidence

- `evidence/a07/bundle-reconciliation.json`: real bundle outer tx `0x9c38a36a…`
  status 1, sponsor payment `472351559302104` wei, bundler revenue equal to the
  sponsor payment; allocations plus failed/unattributable bucket plus residual
  reproduce the bundle total exactly; L1 data fee and operator fee recorded as
  unavailable.
- `benchmarks/cost-experiment.json`: five scenarios including a budget exhaustion
  point and a default scenario built from the measured execution cost.
- `benchmarks/rpc-failover.json`: recovery inside the 60 s target with chain id and
  finalized checkpoint verified on the independent verifier RPC.
- `benchmarks/indexer-restore.json`: a corrupted statement is refused, the restored
  digest equals the pre-restore digest and the restore is within the five-minute
  target.
- `benchmarks/nav-source-drill.json`: a mismatched valuation date holds the order,
  a stale NAV is rejected and a valid new observation releases the order exactly
  once.
- `benchmarks/performance.json`: 200 portfolio reads (p95 well under 500 ms) and 30
  real proof generations (warm p95 well under 5 000 ms) on the named host.
- `benchmarks/operations-dashboard.json`, `benchmarks/provider-evaluation.json`,
  `benchmarks/incident-report.json` and `benchmarks/batch-publication-drill.json`.

## [0.6.0] — Controlled rollup devnet and bridge withdrawal

### Added

- Reproducible controlled local OP Stack devnet under `devnet/local/`: anvil L1
  with a synthetic two-second block clock, op-deployer `v0.6.0` deploying the full
  L1 contract stack from a `custom` intent, op-reth `v2.4.0`, op-node `v1.19.3`
  (sequencer), op-batcher `v1.16.11` and op-proposer `v1.16.3`. Commands:
  `pnpm devnet:local:up`, `pnpm devnet:local:down`.
- A05 evidence capture `pnpm local:evidence`: an L1 -> L2 deposit, six labelled L2
  settlement transactions, calldata batch publication linked to the L2 safe head,
  an L2 -> L1 ETH withdrawal, the output-root proof, dispute-game resolution and
  portal finalization with the real portal timers.
- Versioned JSON Schemas `schemas/a05-protocol-run.schema.json` and
  `schemas/a05-bridge-trace.schema.json`, and the offline verifier
  `pnpm a05:verify` (also run in CI).
- Architecture decision records ADR-01 (execution), ADR-02 (batch and data
  availability), ADR-03 (finality and withdrawals), ADR-04 (authority and
  upgrades), plus `devnet/README.md` and the S06 verification record.

### Evidence

- `evidence/a05/protocol-run.json` — chain ids `11155111` / `16584`, deployed
  contract addresses and actor roles, pinned images with resolved digests, a
  0.5 ETH deposit (L1 tx `0xa7ab85cc…`, L2 tx `0x81295df4…`), six L2 settlement
  transactions and ten calldata batch transactions on the batch inbox that
  advanced the L2 safe head to block 189.
- `evidence/a05/bridge-trace.json` — withdrawal hash
  `0xfbdf46187f8f6d34e864473ee7b1c56d1c05d6c4a1aa32cd4f2acc4125ef79bc` proven
  against dispute game 17 (`0xD469cD34…`), resolved to `DEFENDER_WINS`, and
  finalized on L1 with tx `0xee79950e…`; the recipient received exactly
  `100000000000000000` wei through the L1CrossDomainMessenger relay. The recorded
  timers are the production values (604800 s proof maturity, 302400 s dispute-game
  finality, 302400 s game clock); the private anvil clock was advanced with
  `evm_increaseTime` and every acceleration is recorded in the pack.

### Known limitations

- The local L1 is execution-only: there is no L1 consensus client and no beacon
  API. Batch data therefore uses calldata mode, the evidence reports
  `blobDataAvailability: false`, and L1 consensus finality is not modelled. Blob
  DA remains an open A05 gap and the pinned consensus-backed lane stays blocked by
  an upstream package image/genesis mismatch.
- The bridge trace satisfies the real portal timers with a recorded private-clock
  acceleration; it does not measure production latency.

