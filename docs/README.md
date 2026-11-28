# Documentation

Project documentation for EuroRollup Settlement Lab. Everything here is written
in English. Current calendar dates are not recorded in repository documentation;
fixture dates and version numbers are content, not publication dates.

## Sections

| Section | Contents |
| --- | --- |
| [`reference/specification.md`](reference/specification.md) | The project specification (Markdown conversion; the DOCX in the same directory is the normative source). |
| [`plan/roadmap.md`](plan/roadmap.md) | Delivery steps, milestone exit evidence, acceptance gates and release train. |
| [`plan/post-1.0-audit-plan.md`](plan/post-1.0-audit-plan.md) | Post-1.0 audit programme: M7 presentation update and M8 settlement infrastructure. |
| [`architecture/overview.md`](architecture/overview.md) | Components, state model, determinism rules and repository layout. |
| [`api/partner-api.md`](api/partner-api.md) | Partner API surface, roles, idempotency, error contract and local fixture controls. |
| [`policy-lab/p01-friday-cutoff.md`](policy-lab/p01-friday-cutoff.md) | AI Policy Lab proposal contract, P01 replay, boundary cases and cross-runtime digests. |
| [`policy-lab/eligibility.md`](policy-lab/eligibility.md) | Noir eligibility circuit, three-persona policy matrix, browser proving and sponsorship. |
| [`aa/account-abstraction.md`](aa/account-abstraction.md) | Pinned EntryPoint, verifying paymaster, sponsored UserOperation receipts and offline verification. |
| [`../devnet/README.md`](../devnet/README.md) | Controlled local OP Stack devnet: pinned components, launcher commands and recorded limitations. |
| [`economics/README.md`](economics/README.md) | A07 economics: measured bundle reconciliation, interactive cost experiment and funding guard. |
| [`operations/`](operations/) | A07 operations: service objectives, drills, dashboard, provider evaluation and incident postmortem. |
| [`architecture/`](architecture/overview.md) | Architecture overview and numbered ADRs (execution, batch/DA, finality/withdrawals, authority). |
| [`fixtures/`](fixtures/) | Frozen inputs: G01 portfolio, P01 cutoff experiment, calendar, instruments and boundary cases. |
| [`release/README.md`](release/README.md) | Public replay URL, release film, downloadable package and the A08 public checks. |
| [`verification/s10-release-film.md`](verification/s10-release-film.md) | S10 film verification: frames, narration, loudness, captions and link checks. |
| [`verification/s12-investor-journey.md`](verification/s12-investor-journey.md) | S12 investor journey: display precision, replay entry, receipt next actions and UI checks. |
| [`verification/s12-usability-pilot.md`](verification/s12-usability-pilot.md) | S12 five-participant usability pilot script, scoring and deferred status. |
| [`verification/s12-accessibility-checklist.md`](verification/s12-accessibility-checklist.md) | S12 accessibility checklist used as the pilot fallback. |
| [`verification/s13-publication-checks.md`](verification/s13-publication-checks.md) | S13 publication commands, line-ending policy, REL-01 attestation and link check. |
| [`verification/s14-release-film.md`](verification/s14-release-film.md) | S14 film re-cut: approved artwork, separate captions, playback checks. |
| [`verification/s15-settlement-slice.md`](verification/s15-settlement-slice.md) | S15 settlement slice: contracts, G01 on L2 and the canonical balance witness. |
| [`verification/s16-onchain-eligibility.md`](verification/s16-onchain-eligibility.md) | S16 onchain eligibility: real UltraHonk proofs, cached approvals, root rotation recovery. |
| [`verification/s17-sponsored-order.md`](verification/s17-sponsored-order.md) | S17 sponsored order: ERC-4337 v0.7 bundles, scoped expiring permits, lost-response recovery. |
| [`verification/s18-settlement-pack.md`](verification/s18-settlement-pack.md) | S18 settlement pack: run evidence export, joined chain witness, tamper detection. |
| [`verification/s19-net01-attempt.md`](verification/s19-net01-attempt.md) | S19 NET-01 attempt: consensus lane, blob batching and the recorded upstream blocker. |
| [`evidence/README.md`](evidence/README.md) | Evidence pack structure, hashing rules and verifier usage. |
| [`glossary.md`](glossary.md) | Shared vocabulary for the domain, the Policy Lab and the rollup. |
| [`operations/`](operations/) | Runbooks, drills and incident records. |
| [`verification/`](verification/) | Step-by-step verification records, gate evidence and release checks. |

## Project Wiki

The repository Wiki carries the reader-facing project pages: overview,
architecture, fixtures, roadmap, evidence, security and development setup. The
Wiki is generated from the same English content as this directory; it never
records current calendar dates.

## Documentation rules

- English only.
- No current calendar dates in repository documentation, issues or release
  notes. Fixture dates (for example the synthetic dealing days of P01) are part
  of the test content.
- Every claim about a computed number links to a fixture and to the command that
  reproduces it.
- Model output and deterministic simulation results are described separately.
