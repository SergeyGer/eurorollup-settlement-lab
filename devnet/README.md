# Local OP Stack devnet

A reproducible two-layer network used for the A05 protocol-run and bridge-trace
evidence.

```
devnet/
├── README.md
└── local/            # controlled anvil-backed OP Stack lane (launcher, teardown, docs)
```

## Components and pins

| Layer | Component | Reference |
| --- | --- | --- |
| L1 | execution | `anvil` (Foundry 1.10.1), Cancun hardfork, chain id `11155111`, synthetic two-second block clock |
| L2 | execution | `us-docker.pkg.dev/oplabs-tools-artifacts/images/op-reth:v2.4.0` |
| L2 | consensus | `us-docker.pkg.dev/oplabs-tools-artifacts/images/op-node:v1.19.3` (sequencer) |
| L2 | batcher | `us-docker.pkg.dev/oplabs-tools-artifacts/images/op-batcher:v1.16.11` (calldata DA) |
| L2 | proposer | `us-docker.pkg.dev/oplabs-tools-artifacts/images/op-proposer:v1.16.3` |
| L1 contracts | deployer | `op-deployer v0.6.0` (pinned GitHub release binary, sha256 verified by the launcher) |

The L2 chain id is `16584`, the L2 block time is 2 seconds and the L2 gas limit is
60,000,000. The L1 contract stack (portal, system config, bridges, message passer,
dispute game factory, anchor state registry and game implementations) is deployed
from scratch by a `custom` op-deployer intent. The launcher records the resolved
container image digests next to these tags in `evidence/a05/protocol-run.json`.

## Commands

```bash
pnpm devnet:local:up     # deploy and start the network (~3-4 minutes)
pnpm local:evidence      # capture evidence/a05/protocol-run.json and bridge-trace.json
pnpm devnet:local:down   # stop containers, clock loop and the L1
```

Requirements: Foundry (`anvil`, `cast`), Docker, `curl`, `python3`, `openssl`.
Runtime state is written to `.devnet-local/` (gitignored).

## What the evidence run does

1. Deploys the L1 stack and starts op-reth, op-node, op-batcher and op-proposer.
2. Deposits test ETH from L1 to L2 through the portal and waits for derivation.
3. Sends six labelled L2 settlement transactions, waits for the batcher to publish
   them as calldata batches, and links the batch transactions to the L2 safe head.
4. Withdraws test ETH through the L2StandardBridge, proves the output root on L1,
   resolves the dispute game and finalizes the withdrawal through the portal.
5. Satisfies the real portal timers by advancing the private anvil clock with
   `evm_increaseTime`; every acceleration is recorded in the evidence.

## Known limitations (also recorded in the evidence)

- The L1 is execution-only: no L1 consensus client, no beacon API, no blob
  sidecars. Batches therefore use calldata mode and L1 finality is not modelled.
- Blob data availability remains an open A05 gap; the consensus-backed target lane
  is described in `docs/architecture/adr-02-batch-and-da.md`.
- The portal timers are the production values; time acceleration is a private
  test-lane procedure, not a claim that the production wait is short.

## Architecture decisions

- `docs/architecture/adr-01-execution.md`
- `docs/architecture/adr-02-batch-and-da.md`
- `docs/architecture/adr-03-finality-and-withdrawals.md`
- `docs/architecture/adr-04-authority-and-upgrades.md`
