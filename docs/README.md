# Documentation

Project documentation for EuroRollup Settlement Lab. Everything here is written
in English. Current calendar dates are not recorded in repository documentation;
fixture dates and version numbers are content, not publication dates.

## Sections

| Section | Contents |
| --- | --- |
| [`reference/specification.md`](reference/specification.md) | The project specification (Markdown conversion; the DOCX in the same directory is the normative source). |
| [`plan/roadmap.md`](plan/roadmap.md) | Delivery steps, milestone exit evidence, acceptance gates and release train. |
| [`architecture/overview.md`](architecture/overview.md) | Components, state model, determinism rules and repository layout. |
| [`api/partner-api.md`](api/partner-api.md) | Partner API surface, roles, idempotency, error contract and local fixture controls. |
| [`policy-lab/p01-friday-cutoff.md`](policy-lab/p01-friday-cutoff.md) | AI Policy Lab proposal contract, P01 replay, boundary cases and cross-runtime digests. |
| [`policy-lab/eligibility.md`](policy-lab/eligibility.md) | Noir eligibility circuit, three-persona policy matrix, browser proving and sponsorship. |
| [`aa/account-abstraction.md`](aa/account-abstraction.md) | Pinned EntryPoint, verifying paymaster, sponsored UserOperation receipts and offline verification. |
| [`../devnet/README.md`](../devnet/README.md) | Controlled local OP Stack devnet: pinned components, launcher commands and recorded limitations. |
| [`architecture/adr/`](architecture/adr/) | Numbered decision records for the rollup, batch, finality and authority decisions. |
| [`fixtures/`](fixtures/) | Frozen inputs: G01 portfolio, P01 cutoff experiment, calendar, instruments and boundary cases. |
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
