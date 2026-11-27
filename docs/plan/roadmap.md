# Delivery roadmap

Release 1.0 is delivered in documented steps. Each step is a GitHub Issue with
scope, acceptance evidence and specification references. A step closes only when
its fixtures, tests and evidence are merged to `main`; milestone-sized steps are
tagged as GitHub Releases.

The plan follows the specification build plan (`docs/reference/specification.md`,
section 16, sixteen part-time weeks for one experienced maintainer) without
recording current calendar dates. Weeks are planning windows, not deadlines.

## Status

| Step | Status |
| --- | --- |
| S00 | Complete: repository baseline, protection, Wiki, security settings and issue plan |
| S01 | Released as `v0.1.0` (foundation) |
| S02 | Released as `v0.2.0` (settlement core and partner API) |
| S03 | Released as `v0.3.0` (AI Policy Lab and P01 comparison) |
| S04 | Released as `v0.4.0` (live local model adapter and 40-prompt evaluation) |
| S05 | Released as `v0.5.0` (Noir eligibility circuit and sponsored account lane) |
| S06 | Released as `v0.6.0` (controlled local rollup, protocol run and bridge withdrawal trace; blob DA stays an open gap) |
| S07 | Economics and operations | Released as `v0.7.0` |
| S08 | Verification and release candidate | Released as `v0.8.0` |
| S09 | Public release | Released as `v0.9.0` |
| S10 | Release film | Planned |

Current next step: S10, the 60-second release film and the final v1.0.0.

## Steps

| Step | Issue | Milestone | Focus | Exit evidence |
| --- | --- | --- | --- | --- |
| S00 | [#1](https://github.com/SergeyGer/eurorollup-settlement-lab/issues/1) | M0 Repository publication | Repository, governance, security baseline, Wiki, issue plan | Repository settings evidence, Wiki pages, protected `main` |
| S01 | [#2](https://github.com/SergeyGer/eurorollup-settlement-lab/issues/2) | M1 Foundation | Instruments, UTC calendar, integer money, G01/P01 fixtures, evidence schemas, portfolio replay | `evidence/g01/golden-run.json`, fixture tests, replay UI, release `v0.1.0` |
| S02 | [#3](https://github.com/SergeyGer/eurorollup-settlement-lab/issues/3) | M2 Settlement core | Spot router, fund vault, order API, outbox, journal, SDK | G01 via UI/API/SDK, `dealing-cases.json`, `invariants.json`, release `v0.2.0` |
| S03 | [#4](https://github.com/SergeyGer/eurorollup-settlement-lab/issues/4) | M3 Policy Lab | Shared dealing functions, snapshot replay, typed rule diff, two-branch comparison | P01 comparison pack, cross-runtime hash equality, release `v0.3.0` |
| S04 | [#5](https://github.com/SergeyGer/eurorollup-settlement-lab/issues/5) | M3 Policy Lab | Typed model contract, live adapter, confirmation boundary, 40-prompt evaluation | `policy-lab/eval.json`, recorded proposal, release `v0.4.0` |
| S05 | [#6](https://github.com/SergeyGer/eurorollup-settlement-lab/issues/6) | M4 AA and devnet | EntryPoint, sponsorship, Noir eligibility circuit, personas | `policy-matrix.json`, `aa-receipts.json`, release `v0.5.0` |
| S06 | [#7](https://github.com/SergeyGer/eurorollup-settlement-lab/issues/7) | M4 AA and devnet | Controlled local OP Stack, calldata batch publication, bridge withdrawal, ADR-01 to ADR-04 | `evidence/a05/protocol-run.json`, `evidence/a05/bridge-trace.json`, release `v0.6.0` |
| S07 | [#8](https://github.com/SergeyGer/eurorollup-settlement-lab/issues/8) | M5 Economics and operations | Measured bundle reconciliation, cost experiment, funding guard, RPC/batch/indexer/NAV drills, dashboard, provider evaluation, incident postmortem | `evidence/a07/bundle-reconciliation.json`, `benchmarks/`, `docs/operations/`, release `v0.7.0` |
| S08 | [#9](https://github.com/SergeyGer/eurorollup-settlement-lab/issues/9) | M6 Verification and release | Gates A01-A09, offline verifier, release candidate | `evidence/release-checks.json`, per-gate artifacts, release `v0.8.0` |
| S09 | [#10](https://github.com/SergeyGer/eurorollup-settlement-lab/issues/10) | M6 Verification and release | Public replay, release package, documentation, A08 public checks | `evidence/a08/public-release.json`, public replay URL verified signed out, release `v0.9.0` |
| S10 | [#11](https://github.com/SergeyGer/eurorollup-settlement-lab/issues/11) | M6 Verification and release | Release film, captions and transcript | MP4, WebVTT, transcript, media metadata |

The umbrella tracking issue is [#12](https://github.com/SergeyGer/eurorollup-settlement-lab/issues/12).

## Release train

| Tag | Contents |
| --- | --- |
| `v0.1.0` | Foundation: fixtures, money arithmetic, calendar, G01 evidence |
| `v0.2.0` | Settlement core and partner API |
| `v0.3.0` | AI Policy Lab: typed proposal, scenario API and deterministic P01 comparison |
| `v0.4.0` | Live local model adapter: pinned model, failure policy and 40-prompt evaluation |
| `v0.5.0` | Eligibility circuit, three-persona policy matrix and sponsored account lane |
| `v0.4.0` | Live model adapter and 40-prompt evaluation |
| `v0.5.0` | Sponsored account lane and eligibility circuit |
| `v0.6.0` | Pinned local rollup and protocol evidence |
| `v0.7.0` | Economics, operations and provider evaluation |
| `v0.8.0` | Acceptance gates A01-A09 and offline verifier |
| `v1.0.0` | Public release with replay, evidence packs, film and captions |

## Acceptance gates

A release requires A01-A09 evidence on its release commit. Gate procedures are
defined in the specification, section 15.

| Gate | Area | Primary artifact |
| --- | --- | --- |
| A01 | Portfolio | `golden-run.json` and journal diff |
| A02 | NAV and dealing | `dealing-cases.json` |
| A03 | Eligibility | `policy-matrix.json` and proof vectors |
| A04 | Account abstraction | `aa-receipts.json` |
| A05 | Chain | `protocol-run.json` and bridge trace |
| A06 | Accounting | `invariants.json` and balance audit |
| A07 | Economics and operations | `benchmarks/` and incident report |
| A08 | Public release | `release-checks.json` and `media/` |
| A09 | AI Policy Lab | `policy-lab/eval.json` and comparison pack |

## Working agreements

- `main` is protected: pull request, required CI status checks, linear history,
  no force pushes, no branch deletion.
- Every change references an issue. Step issues close only with evidence.
- Commits follow Conventional Commits; repository documentation is English.
- Money is integer base units serialized as decimal strings. No floating-point
  money arithmetic, ever.
- A simulation result is reproducible: canonical JSON hash excluding model
  prose, execution timestamps and run IDs.
- Model output never executes directly; only a confirmed, typed proposal reaches
  the deterministic engine.

## Delivery priorities and deferred scope

Defer a hosted testnet, block explorer, additional proof types and a third asset
class until the settlement journey, the Policy Lab and the release evidence pass
acceptance.
