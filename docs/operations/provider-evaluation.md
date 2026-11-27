# Provider and ownership decisions

The sandbox evaluates two RPC profiles and one indexing alternative. The weights are
fixed by the specification and the measured probes come from the local drills
(`benchmarks/provider-evaluation.json`).

| Criterion | Weight | Rationale |
| --- | --- | --- |
| Availability and observed correctness | 35% | A wrong read is worse than a slow one; correctness is checked by the chain-id and finalized-checkpoint verification before reads resume. |
| Recovery independence | 25% | A failover target sharing the primary failure domain does not improve resilience. |
| Integration effort | 15% | The cheaper the switch and checkpoint replay, the faster an incident recovers. |
| Cost | 15% | Provider pricing is a real but bounded part of the decision. |
| Data portability | 10% | Replayable checkpoints and standard RPC keep the exit path open. |

## Profiles

| Profile | Role | Measured probes | Notes |
| --- | --- | --- | --- |
| `primary-local-fixture-rpc` | Primary reads | RPC failover drill primary probes | Simulated outage after three failed probes; the drill switches away from it. |
| `secondary-verifier-rpc` | Independent verifier RPC | RPC failover drill secondary probes | Chain id and finalized checkpoint verified before reads resume; recovery was well under the 60 s target. |
| `event-log-indexer-alternative` | Indexing alternative | Indexer restore drill | Deterministic replay from the latest finalized checkpoint, per-asset reconciliation and refusal of a corrupted statement. |

The weighted scores, measured availability/latency values, unknowns and rationale are
stored in `benchmarks/provider-evaluation.json`. Recorded unknowns include production
internet latency, provider SLAs, billing data and external-indexer behaviour.

## Provider switch and checkpoint replay

1. Probe the active RPC; after three failed five-second probes switch reads to the
   independent verifier RPC.
2. Verify the chain id and the finalized checkpoint before serving reads again.
3. Replay the latest finalized checkpoint, recompute the statement digests and
   reconcile each asset with the balance oracle.
4. Refuse to promote any statement whose digest or per-asset balance disagrees with
   the canonical replay; record the reconciliation difference as a named item.
5. Publish the incident timeline and follow-ups, and re-run the provider evaluation
   probes when a real provider is available.
