# S08 verification: release candidate and A01–A09 gate matrix

This record verifies the release-candidate decision. The machine-readable matrix is
`evidence/release-checks.json`; it is generated from the source tree by
`pnpm release:checks` and verified offline by `pnpm release:verify`, which also runs
in CI.

## Reproduce

```bash
pnpm release:checks   # run all gate commands, validate evidence, write the matrix
pnpm release:verify   # offline verification of the committed matrix
```

## Gate matrix

| Gate | Title | Status | Evidence and commands |
| --- | --- | --- | --- |
| A01 | Portfolio replay | pass | `evidence/g01/golden-run.json`, `manifest.json`; `scenario:golden --check`, `verify` |
| A02 | NAV and dealing boundaries | pass | `evidence/a02/dealing-cases.json`, `api-dealing-cases.json`; `scenario:boundary --check`, `scenario:api --check` |
| A03 | Eligibility and policy matrix | pass | `evidence/a03/policy-matrix.json`, `proof-vectors.json`, `browser-proving.json`; `eligibility:matrix --check`, `eligibility:verify` |
| A04 | Account abstraction receipts | pass | `evidence/a04/aa-receipts.json`; `aa:verify` |
| A05 | Chain batch publication and withdrawal | **pass with recorded limitations** | `evidence/a05/protocol-run.json`, `bridge-trace.json`; `a05:verify` |
| A06 | Accounting invariants | pass | `evidence/a06/invariants.json`; `scenario:api --check` |
| A07 | Economics and operations | pass | `evidence/a07/bundle-reconciliation.json`, `benchmarks/*`; `a07:verify` |
| A08 | Public release | pending (S10 film; public replay, package and links verified in S09) | `evidence/a08/public-release.json`, `evidence/a08/release-package.json`; `a08:verify`; requires the 60-second film |
| A09 | AI Policy Lab | pass | `evidence/policy-lab/p01-comparison.json`, `eval.json`, recorded live draft; `policy:replay --check`, `policy:verify`, both evaluation modes |

The matrix also runs the shared commands: `typecheck`, tests, build, the generated
OpenAPI check and the partner demo. Every command must exit zero for its gate to
pass, and every evidence file must validate against its versioned JSON Schema; the
matrix records SHA-256 for every evidence file.

## Recorded limitations (A05)

The A05 gate passes for what the controlled local lane can prove: batch publication
and a canonical ETH withdrawal with the real portal timers. Two observations are
explicitly recorded as missed, with a cause and a follow-up instead of being hidden:

1. **Blob data availability** is not demonstrated. The execution-only local L1 posts
   calldata batches (documented development mode). Cause: the controlled lane has no
   L1 consensus client or beacon API, and the consensus-backed Kurtosis lane is
   blocked by an upstream image/genesis mismatch. Follow-up: resolve the
   consensus-backed lane and re-capture A05 with blob batches.
2. **L1 consensus finality** is not modelled. The evidence records L2 safe/finalized
   heads from op-node and the L1 head, but the execution-only L1 has no consensus
   client. Follow-up: record L1 safe/finalized heads on the consensus-backed lane.

These limitations are carried into the release-check matrix (`limitations` and
`missedTargets`) and into the A05 verification record.

## Release-candidate decision

The matrix summary is: 7 pass, 1 pass with recorded limitations, 1 pending (A08), 0
failed. The release-candidate flag is true because no gate fails and the only pending
gate is the public-release gate. S09 delivers the public replay, the clean-browser
check, the public links and the downloadable package; S10 delivers the 60-second film.
The final `v1.0.0` requires A08 on its commit.
