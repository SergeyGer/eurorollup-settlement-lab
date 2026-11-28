# S21 verification: OPS-01 batch-setting benchmark and OPS-02 money/authority reconciliation

This record covers the two operations findings: the batch-setting decision benchmark with
six identical runs (OPS-01), and the money/authority reconciliation with failover,
batcher pause/resume, indexer restore and a timelocked two-of-three upgrade rehearsal
(OPS-02).

## OPS-01 · Batch-setting benchmark

Six runs — the identical 200-order arrival schedule three times for each maximum channel
duration of **4** and **12 L1 blocks** — on the controlled local OP Stack devnet
(anvil L1 with a two-second clock, op-reth + op-node + op-batcher, calldata DA). Each run
retains raw per-order timestamps, raw L1 batch transaction receipts, completed/failed
counts, batch fill, L1 expenditure and unsafe-to-safe latency samples.

| Setting | Runs | Completed | Failed | p50 | p95 | Mean per-success cost |
| --- | --- | --- | --- | --- | --- | --- |
| 4 L1 blocks | 3 | 600/600 | 0 | ~46 s | ~68.5 s | ~1.10e13 wei |
| 12 L1 blocks | 3 | 600/600 | 0 | ~46 s | ~69.0 s | ~1.19e13 wei |

Percentiles use the **nearest-rank** method over all 600 order samples per setting; per-run
values are retained. Batch fill is reported in blob-equivalents (batch data bytes /
131,072). Both settings meet the 240 s p95 target; the tool selects the **lowest mean
per-success cost** among qualifying settings — **4 L1 blocks**.

Evidence: `evidence/s21/ops-batch-setting-benchmark.json`, verification
`pnpm s21:verify`.

## OPS-02 · Money and authority

**Two-operation Anvil bundle** (`evidence/a07/bundle-reconciliation.json`, recomputed):

- execution cost **257,949,913,782,357 wei** and sponsor payment
  **472,351,559,302,104 wei**, matching the audit brief;
- allocations plus residual equal the sponsor payment exactly;
- L1 data fee and operator fee are **null** on that lane and are recorded as unavailable.

**OP-lane component receipts** (from the OPS-01 runs): L1 execution gas cost and the
applicable DA cost are reported with a zero residual. The benchmark lane carries no
paymaster, so sponsor contribution and beneficiary revenue are **null with reasons**
(sponsored contribution is reconciled on the Anvil lane evidence); a separate L1 data fee
component and an operator fee are recorded as unavailable.

**Drills archived in the report:** live RPC failover (dead primary, direct fallback
recovery), batcher pause/resume (safe head stalled, backlog recorded, recovery to the
paused unsafe head), indexer restore (corrupted statement refused, restored digest equals
the canonical pre-restore digest) and the canonical-ledger restart checkpoint.

**Two-of-three upgrade rehearsal** (contract `TwoOfThreeAuthority`, controlled anvil):
early activation is rejected; two approvals and the timelock activate the target version
with the activation block recorded; a failed execution is recorded and recovered forward
after the target fix; a non-owner proposal is rejected. Contract tests cover the same
paths (`contracts/test/Authority.t.sol`).

Evidence: `evidence/s21/ops-money-authority.json`.

## Recorded limitations

- The benchmark runs on a controlled local OP Stack devnet, not a production network; the
  latencies are test-lane values.
- Synthetic ETH-transfer orders exercise batch publication and derivation latency, not the
  full settlement business path; calldata DA is the lane mode.
- The upgrade rehearsal uses a ten-second timelock on a controlled anvil chain, not the
  production authority delay.
- OPS-01 records a caveat: the local L1 clock and the calldata lane keep both settings
  comfortably below the latency target, so the choice is cost-driven.
