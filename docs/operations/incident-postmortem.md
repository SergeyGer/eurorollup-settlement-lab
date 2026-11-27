# Incident exercise postmortem

This is a **simulated** incident exercise over the local drills. Roles and timings are
labelled as simulated; the measured drill outputs are the source of the numbers.

## Roles

| Role | Simulated owner | Responsibility |
| --- | --- | --- |
| Incident lead | Maintainer agent | Runs the exercise, owns the timeline and follow-ups |
| NAV and compliance owner | Issuer (simulated) | Owns NAV corrections and the compliance review |
| Batch and RPC operations owner | Protocol operator (simulated) | Owns the RPC failover and batch publication recovery |

## Trigger

Three failed five-second probes on the primary RPC in the two-node lab, combined with
a delayed NAV observation and a deliberately corrupted indexer statement.

## Customer impact

- Reads pause until failover; the independent verifier RPC verifies chain id and
  finalized checkpoint before reads resume (measured recovery well under the 60 s
  target; see `benchmarks/rpc-failover.json`).
- The delayed NAV leaves the affected fund order waiting with its cash reserved; a
  stale record is rejected and a valid new observation releases the order exactly once
  (`benchmarks/nav-source-drill.json`).
- The corrupted indexer statement is refused before promotion because its digest and
  per-asset balances disagree with the canonical replay; the restored statement then
  matches the pre-restore digest (`benchmarks/indexer-restore.json`).
- During the batch publication drill the unsafe head keeps advancing while the safe
  head is stuck; finality is marked delayed (the unsafe receipt status is preserved),
  the batcher is restored and the backlog clears, with the L1 batch publication linked
  in `benchmarks/batch-publication-drill.json`.

## Recovery

| Signal | Measured result |
| --- | --- |
| RPC failover | Recovery within the 60 s target; chain id and finalized checkpoint verified |
| Indexer restore | Discrepant statement refused; restored digest equal to the pre-restore digest |
| Delayed NAV | Released once after a valid new observation; duplicate release rejected |
| Batch publication | Stalled safe head marked delayed; alert recorded; backlog cleared; L1 publication linked |

## Follow-ups

1. Re-run the provider evaluation with a real provider contract, including SLAs and
   billing data.
2. Replace the balance oracle with a real independent chain read in the indexer drill.
3. Wire the failover alert into the operating dashboard interval instead of a drill
   snapshot.
4. Publish the drill results with every release and report any missed target with a
   measured cause instead of hiding it.
