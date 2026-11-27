# Controlled local OP Stack devnet

A reproducible two-layer network used for the A05 protocol-run and bridge-trace
evidence:

- **L1**: `anvil` (Foundry) execution chain on chain id `11155111`, Cancun
  hardfork. Anvil has no consensus client; a small clock loop mines one block
  every two seconds so L1 timestamps advance with wall-clock time.
- **L2 execution**: op-reth `v2.4.0` (engine API, historical proof window enabled).
- **L2 consensus**: op-node `v1.19.3` in sequencer mode. The local L1 has no
  beacon endpoint, so the node runs with the beacon check ignored and the
  batcher posts **calldata** batches (an explicitly reported development mode;
  blob-DA remains the target for the pinned Kurtosis lane).
- **Batch submission**: op-batcher `v1.16.11`, calldata DA, one-block channel
  duration.
- **Output proposals**: op-proposer `v1.16.3` into the respected dispute game
  type deployed by the L1 contract stack.
- **L1 contracts**: op-deployer `v0.6.0` with a `custom` intent deploys the full
  contract set from scratch (portal, system config, bridges, message passer,
  dispute game factory, anchor state registry and dispute game implementations).

All keys are the public well-known anvil development keys. Nothing in this
directory is suitable for a public network.

## Usage

```bash
pnpm devnet:local:up       # deploy and start everything (~5 minutes)
pnpm local:evidence        # capture A05 protocol-run + bridge-trace evidence
pnpm devnet:local:down     # stop containers, clock loop and the L1
```

Runtime state (deployment, genesis, rollup config, jwt, logs, env.json) lives in
`.devnet-local/` and is gitignored.

## Known limitations (reported in the evidence)

- The L1 is execution-only: no L1 consensus client, no blob sidecars, no beacon
  API. Batch data is therefore posted as calldata.
- L1 finality is not modelled. The evidence records the L2 safe/finalized heads
  produced by op-node and marks the L1 finality observations as unavailable.
- The portal's production dispute-game timers are real (7-day proof maturity and
  3.5-day dispute-game finality). The bridge trace satisfies them by advancing
  the private anvil clock with `evm_increaseTime`, which is recorded explicitly
  as a local test-lane acceleration.
