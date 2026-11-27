# ADR-03: Finality and withdrawals

## Status

Accepted for release 1.0.

## Context

The protocol evidence must trace one test ETH withdrawal from L2 initiation
through L1 proving to finalization, expose the two transaction layers and record
the observed delays and configured timers.

## Decision

- **Withdrawal path**: canonical OP Stack path. ETH is withdrawn through the
  L2StandardBridge predeploy, the message is recorded by the
  L2ToL1MessagePasser, proven on L1 with an output-root proof against a dispute
  game, and finalized through the `OptimismPortal`.
- **Output proposals**: op-proposer `v1.16.3` proposes output roots into the
  respected dispute game type deployed by op-deployer.
- **Dispute resolution**: the proposal is resolved after the game clock expires;
  the game must reach `DEFENDER_WINS` before the portal accepts finalization.
- **Timers**: the real production timers are recorded, not shortened:
  `proofMaturityDelaySeconds = 604800`, `disputeGameFinalityDelaySeconds =
  302400`, game `maxClockDuration = 302400`, `clockExtension = 10800`.
- **Local time acceleration**: the private anvil L1 clock is advanced with
  `evm_increaseTime` to satisfy those real timers in a test lane. Every
  acceleration is recorded with the before/after timestamps in the bridge trace.
- **Finality observations**: the L2 safe/finalized heads come from op-node. The
  execution-only L1 cannot produce consensus finality, so the trace marks L1
  finality as unavailable instead of inventing a value.

## Consequences

- The withdrawal trace is a real end-to-end execution of the canonical path on a
  private L1, including the portal accounting, the dispute-game resolution and the
  messenger relay to the recipient.
- The timers are the production values; the trace is not evidence that a
  production user waits 7 days, only that the configured delays are enforced.
- L1 finality behaviour remains to be demonstrated on a consensus-backed lane.

## Verification

`evidence/a05/bridge-trace.json` records the withdrawal initiation, output-root
proof, game resolution, finalization transaction, the observed recipient balance
delta and the configured timers with the clock accelerations.
