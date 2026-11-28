# S22 verification: independent acceptance record

This record is the independent acceptance of the infrastructure update. The machine-readable
record is `evidence/s22/acceptance.json`, verified offline by `pnpm s22:verify` (also in CI
and the release-check matrix). The acceptance source commit is the `S22` release-code commit
recorded in the JSON as `commit`; the tag relationship is recorded in the release
attestation.

## Independence and attribution

The acceptance ran from a **fresh clone** of the accepted commit (clean clone status and the
same tree hash are recorded) against the pinned dependency store, so the evidence verifiers
executed on a source tree independent from the generation workspace. The toolchain gates
(typecheck, test suite, production build, Foundry tests) and the walkthrough test ran in the
clean accepted worktree. A separate-host rebuild was **not** executed in this environment
and is attributed as such in the record; the acceptance record lists exactly which gates were
executed versus verified from evidence.

## Gates

| ID | Gate | Mode | Result |
| --- | --- | --- | --- |
| S22-AC-01 | Settlement slice deterministic replay (SET-01) | deterministic | qualified |
| S22-AC-02 | On-chain eligibility and root rotation (SET-02) | policy-boundary | qualified |
| S22-AC-03 | Sponsored order and negative paths (SET-03) | negative-path | qualified |
| S22-AC-04 | Settlement pack and tamper detection (SET-04) | negative-path | qualified |
| S22-AC-05 | Consensus lane, blob DA and deriving verifier (NET-01) | live-lane | qualified |
| S22-AC-06 | Canonical reconciliation and reorg recovery (LED-01) | negative-path | qualified |
| S22-AC-07 | Operations benchmark and authority reconciliation (OPS-01/02) | deterministic | qualified |
| S22-AC-08 | Release-check matrix | package | qualified |
| S22-AC-09 | Public release checks (A08) | public-walkthrough | qualified |
| S22-AC-10 | TypeScript typecheck | deterministic | qualified |
| S22-AC-11 | Application and library test suite | deterministic | qualified |
| S22-AC-12 | Production build | deterministic | qualified |
| S22-AC-13 | Foundry contract tests | deterministic | qualified |
| S22-AC-14 | Final walkthrough: P01 cutoff change and F-1530 | policy-boundary | qualified |
| S22-AC-15 | Public landing page and replay signed out | public-walkthrough | qualified |
| S22-AC-16 | Release film asset addressable | public-walkthrough | qualified |
| S22-AC-17 | Separate WebVTT captions addressable | public-walkthrough | qualified |
| S22-AC-18 | Earlier tagged releases addressable | public-walkthrough | qualified |
| S22-AC-19 | Downloadable package and manifest | package | qualified |

All 19 gates are **qualified**, with 0 incomplete and 0 failed. Each gate records its source
commit, mode, command, environment, expected and observed result, evidence link and reviewer
disposition in `evidence/s22/acceptance.json`; the record also carries SHA-256 digests for the
main evidence files so a later checkout can verify the accepted evidence was not altered.

## Final walkthrough

- Public landing page and replay: unauthenticated HTTP 200 with the application.
- Release film and captions: the tagged film asset is addressable and the separate WebVTT
  captions are published and reachable; the player starts with captions off.
- Portfolio replay and P01 cutoff change: `F-1530` moves to Monday, EUR 300 is additionally
  reserved and its units change from 3.125000 to 3.000000 (`changedOrderIds` exactly
  `["P01-F-1530"]`, unit delta `−125000`), covered by the Policy Lab test.
- Live lane: the G01 investment witness is verified against the canonical chain and a
  deliberately mismatched receipt is refused with the first mismatch reported (S18 evidence).
- Earlier tagged releases (`v1.0.0`, `v1.1.0`) remain addressable from the releases page.

## Release-page gates

The `v1.2.0` release notes display the gate table above and link the acceptance record, the
release-check matrix and the earlier tagged releases. The matrix reports no failed gate and no
pending gate; the historical release records are kept addressable by tag.
