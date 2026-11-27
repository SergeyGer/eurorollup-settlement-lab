# S07 verification: economics and operations

This record verifies the S07 exit evidence: measured bundle economics, the cost
experiment, the sponsorship funding guard and the operating drills that back the
A07 gate.

## Reproduce

```bash
pnpm a07:economics    # measure one real sponsored bundle and write the economics evidence
pnpm a07:operations   # run the RPC, indexer, delayed-NAV and performance drills
pnpm devnet:local:up && pnpm a07:batch-drill && pnpm devnet:local:down
pnpm a07:verify       # offline verification of all A07 evidence (also in CI)
```

CI runs `pnpm a07:verify` on every pull request; the live drills require a local
Anvil chain or the controlled devnet.

## Measured bundle

`evidence/a07/bundle-reconciliation.json` records one real `handleOps` transaction
with two sponsored UserOperations (one success, one included failure) on a local
Anvil chain with the pinned EntryPoint v0.7.0, SimpleAccount factory and
VerifyingPaymaster.

| Quantity | Value |
| --- | --- |
| Outer transaction | `0x9c38a36a…` status 1 |
| Sponsor payment | `472351559302104` wei |
| Bundler beneficiary revenue | equal to the sponsor payment |
| Successful-operation allocation | `243103977863383` wei |
| Failed/unattributable bucket | `229247581438721` wei |
| Residual | `0` wei |
| Allocations + residual = bundle total | pass |
| Explicit investor charge | 0.05 dEUR (50 000 micro-EUR) |
| Unavailable fee components | L1 data fee, operator fee (recorded as null) |

The reconciliation differences are named items (`networkCostVsSponsorPaid`,
`sponsorPaidVsBundlerRevenue`), not hidden adjustments. The EUR/ETH conversion is a
timestamped demo fixture stamped at the measurement block time, not a live rate.

## Cost experiment

`benchmarks/cost-experiment.json` contains the observed defaults and five scenarios
(observed default, cheap DA, low utilization, lower investor fee, higher volume).
Each scenario reports the per-order sponsor cost, the sponsor contribution, the daily
sponsorship need, the remaining budget, the first daily order count that exhausts the
budget and the break-even investor charge. Missing inputs are returned as
`unavailable` and never replaced with zero. The same deterministic model runs in the
browser view **Economics & operations** and through
`POST /v1/economics/scenario`.

## Funding guard and operator economics

The funding guard enforces, in order: rate freshness (60 seconds), per-operation cap,
daily budget including outstanding reservations, and the native deposit reserve.
Rejections preserve reservations and keep the fund escrow visible. Operator economics
counts the fee-vault inflow and the batcher L1 outflow once, flags duplicate flow
identifiers and reports infrastructure spend separately.

## Operating drills

| Drill | Result |
| --- | --- |
| RPC failover | Three failed five-second probes switch reads to the independent verifier RPC; chain id and finalized checkpoint verified; recovery inside the 60 s target |
| Batch publication | Batcher paused under sustained load: unsafe head advances, safe head stalls, finality marked delayed with the unsafe receipt status preserved; resumed batcher clears the backlog and the L1 batch transactions are linked |
| Indexer restore | Corrupted statement refused; restored digest equals the pre-restore digest; restore inside the five-minute target |
| Delayed NAV | Mismatched valuation date holds the order; stale NAV rejected; valid new observation releases exactly once |
| Performance | 200 portfolio reads and 30 real Noir UltraHonk proof generations on the named local host; read p95 under 500 ms and warm proving p95 under 5 000 ms |

The dashboard snapshot, weighted provider evaluation (two RPC profiles plus one
indexing alternative) and the simulated incident postmortem are committed under
`benchmarks/`.

## Recorded limitations

- The local Anvil chain used for the measured bundle has no OP-stack L1 data fee or
  operator fee, so both are recorded as unavailable rather than modeled as measured.
- The EUR/ETH conversion is a frozen demo fixture.
- The drills use local fixture servers and the deterministic balance oracle instead of
  production providers; the provider evaluation records these unknowns.
- The batch drill window is measured in L1 blocks on the accelerated lab clock and
  stands in for two production posting windows.
