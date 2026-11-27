# ADR-03: Finality and withdrawals

## Status

Accepted for release 1.0.

## Context

The protocol evidence must trace one test ETH withdrawal from L2 initiation
through L1 proving to finalization, and must expose the two transaction layers,
the observed delay and the configured timers.

## Decision

- Finality observations: the evidence records L1 safe/finalized heads from the
  consensus pair and L2 unsafe/safe/finalized heads from op-node
  (`optimism_syncStatus`), together with the block heights and hashes.
- Withdrawals use the canonical OP Stack path: an L2 withdrawal message proven
  against an output root on L1 and finalized through the `OptimismPortal`.
- The L1 `OptimismPortal` exposes `proofMaturityDelaySeconds`,
  `disputeGameFinalityDelaySeconds` and the respected dispute game type; these
  timers are recorded in the evidence.
- Shortened dispute-game timers are a private-devnet testing parameter only. Any
  shortened value must be recorded next to the default it replaces, so no reader
  mistakes it for a production wait time.

## Consequences

- The devnet is single-host and ephemeral; the trace records real transaction
  hashes on the local L1/L2 and the configured delay, not a production mainnet
  delay.
- Fault-proof resolution depends on the proposer/challenger roles deployed by the
  chain deployment; the evidence records the respected game type and the game
  contracts that exist.

## Verification

`evidence/a05/protocol-run.json` records the finality heads and timers;
`evidence/a05/bridge-trace.json` records the L2 initiation, the L1 proving
transaction and the L1 finalization transaction for the same devnet run.
