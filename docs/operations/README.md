# Operations

Service objectives and recovery drills for the local settlement lane. All drills
are local and deterministic; simulated roles and timings are labelled as such, and
measured misses are reported against the stated performance targets.

| Drill | Trigger and action | Evidence |
| --- | --- | --- |
| RPC failover | After three failed five-second probes, switch reads to an independent verifier RPC; verify chain id and finalized checkpoint before resuming. | `benchmarks/rpc-failover.json` |
| Batch publication | After two posting windows without safe-head progress during sustained load, mark finality delayed, preserve the unsafe receipt status, pause and restore the batcher, and link the resulting L1 publication. | `benchmarks/batch-publication-drill.json` |
| Indexer restore | Restore the latest finalized checkpoint, replay canonical logs, reconcile each asset with the balance oracle and refuse a discrepant statement. | `benchmarks/indexer-restore.json` |
| Delayed NAV or policy source | Wait for a signed NAV for the dealing date, accept a newly issued record no older than 15 minutes, and hold a mismatched valuation date. | `benchmarks/nav-source-drill.json` |

## Operating dashboard

`benchmarks/operations-dashboard.json` publishes the drill snapshot: RPC p50/p95/p99
latency and errors, unsafe/safe/finalized lag, indexer restore lag, pending NAV age,
sponsorship runway, ledger difference and an example interval with zero samples. Every
panel states its unit, sample count, time range and data mode; an interval without
samples displays `noSamples: true` instead of zero.

## Performance publication

`benchmarks/performance.json` publishes measured figures on the named local host:

- 200 local portfolio reads with warm-up, p50/p95/p99 and the samples;
- 30 real Noir UltraHonk proof generations (one cold, 29 warm) with p50/p95 and
  verification of the first and last proof.

Targets: portfolio read p95 under 500 ms and warm proving p95 under 5 000 ms.

## Provider and ownership decisions

See [`provider-evaluation.md`](provider-evaluation.md) for the weighted evaluation of
two RPC profiles and one indexing alternative, the probes and traffic profile, the
recorded unknowns and the provider-switch and checkpoint-replay procedure.

Incident exercise: [`incident-postmortem.md`](incident-postmortem.md).

## Commands

```bash
pnpm a07:operations   # run the RPC, indexer, delayed-NAV and performance drills
pnpm a07:batch-drill  # batch publication pause/restore drill (requires devnet:local:up)
pnpm a07:verify       # offline verification of all A07 evidence (also in CI)
```
