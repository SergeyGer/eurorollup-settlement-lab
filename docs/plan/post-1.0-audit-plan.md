# Post-1.0 audit development plan

The release audit brief expands work after `v1.0.0` into two milestones. The execution
plan is tracked in GitHub Issues; the milestone and dependency map is in the roadmap
tracker issue.

## M7 · Presentation update (`v1.1.0`)

| Step | Issue | Scope |
| --- | --- | --- |
| S11 | [#46](https://github.com/SergeyGer/eurorollup-settlement-lab/issues/46) | Social preview redesign and owner approval (ART-01) |
| S12 | [#47](https://github.com/SergeyGer/eurorollup-settlement-lab/issues/47) | Investor journey UX fixes (UX-01/02/03) and usability pilot |
| S13 | [#48](https://github.com/SergeyGer/eurorollup-settlement-lab/issues/48) | README/Wiki navigation, commands, portability and release attestation (REL-01/02) |
| S14 | [#49](https://github.com/SergeyGer/eurorollup-settlement-lab/issues/49) | Film re-cut, accessible playback and `v1.1.0` |

## M8 · Settlement and protocol infrastructure (`v1.2.0`)

| Step | Issue | Scope |
| --- | --- | --- |
| S15 | [#50](https://github.com/SergeyGer/eurorollup-settlement-lab/issues/50) | SET-01 contract-backed settlement vertical slice |
| S16 | [#51](https://github.com/SergeyGer/eurorollup-settlement-lab/issues/51) | SET-02 onchain eligibility enforcement |
| S17 | [#52](https://github.com/SergeyGer/eurorollup-settlement-lab/issues/52) | SET-03 sponsor the actual order |
| S18 | [#53](https://github.com/SergeyGer/eurorollup-settlement-lab/issues/53) | SET-04 settlement evidence pack |
| S19 | [#54](https://github.com/SergeyGer/eurorollup-settlement-lab/issues/54) | NET-01 consensus-backed lane, blobs and finality |
| S20 | [#55](https://github.com/SergeyGer/eurorollup-settlement-lab/issues/55) | LED-01 canonical reconciliation and reorg recovery |
| S21 | [#56](https://github.com/SergeyGer/eurorollup-settlement-lab/issues/56) | OPS-01/OPS-02 benchmark and authority reconciliation |
| S22 | [#57](https://github.com/SergeyGer/eurorollup-settlement-lab/issues/57) | Independent acceptance and `v1.2.0` |

## Status

- S11: three candidate social preview revisions are awaiting the project owner's explicit
  approval in #46; integration into README, Wiki and film is blocked until then.
- S12: UX-01/02/03 implemented and covered by `pnpm ui:checks` (18/18 checks); the
  five-participant usability pilot is recorded as blocked/deferred by the project owner's
  decision, with the published script plus automated legibility/accessibility checks as
  the accepted milestone fallback.
- S13: publication commands/aliases, LF line-ending policy, REL-01 release attestation
  and the signed-out link check are implemented and verified; README first-screen and the
  Wiki map remain open pending the owner-approved Social Preview.
- S14–S22: not started.

## Gates and external inputs

- The new artwork enters the README, Wiki and film only after the project owner approves
  an identified revision in [#46](https://github.com/SergeyGer/eurorollup-settlement-lab/issues/46).
- The five-participant usability pilot in [#47](https://github.com/SergeyGer/eurorollup-settlement-lab/issues/47)
  needs real participants and observed outcomes. If sessions are unavailable, the blocked
  pilot is recorded explicitly and the published script plus an automated
  accessibility/checklist pass is reported instead.
- The infrastructure milestone keeps the existing static replay and calldata lane
  available while the consensus-backed lane is built.

## References

- Audit and development brief: `docs/reference/specification.md` covers the original
  release; the post-1.0 brief is attached to the roadmap issue
  [#58](https://github.com/SergeyGer/eurorollup-settlement-lab/issues/58).
- Current release evidence: `evidence/release-checks.json`.
