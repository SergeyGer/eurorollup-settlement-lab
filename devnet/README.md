# Pinned local devnet

The devnet runs a real two-layer OP Stack network for the A05 protocol evidence.

## Components and pins

| Layer | Component | Image |
| --- | --- | --- |
| L1 | execution | `ethereum/client-go:v1.16.9` (tagged locally as the package-expected `latest`, see note) |
| L1 | consensus | `sigp/lighthouse:v7.1.0` |
| L2 | execution | `us-docker.pkg.dev/oplabs-tools-artifacts/images/op-reth:v2.10.0` |
| L2 | consensus | `us-docker.pkg.dev/oplabs-tools-artifacts/images/op-node:v1.21.0` |
| L2 | batcher | `us-docker.pkg.dev/oplabs-tools-artifacts/images/op-batcher:v1.19.0` |
| L2 | deployer | `us-docker.pkg.dev/oplabs-tools-artifacts/images/op-deployer:v0.4.2` |
| L2 | proposer | `us-docker.pkg.dev/oplabs-tools-artifacts/images/op-proposer:v1.10.0` (package default) |

The L1 chain uses the minimal preset with a short slot time; the L2 uses a
two-second slot time and the standard fault-proof deployment produced by
`op-deployer`.

> Notes: the upstream ethereum-package launcher still passes the legacy
> `--allow-insecure-unlock` flag, which geth 1.17 removed, so `pnpm devnet:up`
> pins geth 1.16.9 and tags it as the package-expected `latest`. The consensus
> client is pinned to lighthouse `v7.1.0`; newer lighthouse builds validate
> data-column sidecars even when Fulu is not activated and break a single-node
> devnet. The L1 network parameters are supplied explicitly so the pinned
> package does not replace the participant list with its own default.

## Commands

```bash
pnpm devnet:up        # start the pinned devnet in the `eurorollup` enclave
pnpm devnet:status    # show enclave services and RPC ports
pnpm devnet:evidence  # capture the A05 protocol run and bridge trace
pnpm devnet:down      # stop the enclave
```

Kurtosis is required (`kurtosis engine start`). The devnet is ephemeral: the
enclave is destroyed by `pnpm devnet:down`, and the evidence file is the
reproducible artifact.

## Current status

A controlled local lane is now validated end-to-end on this host:

- **L1**: anvil execution chain with a synthetic two-second block clock
  (`anvil_mine` driven from a small loop), chain id 11155111, Cancun hardfork.
- **L2**: op-reth v2.4.0 + op-node v1.19.3 sequencer, op-batcher v1.16.11
  posting real calldata batches (Ecotone derivation), op-proposer v1.16.3
  proposing output roots into a permissioned dispute game.
- **Deployment**: op-deployer v0.6.0 (`custom` intent) deployed the full L1
  contract set (OptimismPortal2, SystemConfig, L1StandardBridge, L1CrossDomainMessenger,
  DisputeGameFactory, AnchorStateRegistry, PermissionedDisputeGame, FaultDisputeGame).
- **Withdrawal trace**: canonical ETH deposit (L1 portal -> L2 mint), then an L2
  withdrawal through the L2StandardBridge, an output-root proof submitted to the
  portal, dispute-game resolution and `finalizeWithdrawalTransaction`. The finalize
  receipt relays 0.1 ETH through the L1CrossDomainMessenger to the recipient.
  The portal's real timers (604800s proof maturity, 302400s dispute-game finality,
  302400s game clock) were satisfied by advancing the private anvil clock; this is
  a local test-lane acceleration and must never be presented as a production delay.

The earlier Kurtosis-based blob-DA lane is still blocked by an upstream package
image mismatch (new genesis with older client binaries, and the current lighthouse
image rejecting locally produced blocks on a single-node devnet with a data-column
validation error). The local lane therefore posts batches in calldata mode and the
blob-DA requirement remains tracked as an open gap for the devnet release.

## Next steps

1. Codify the validated lane: anvil launcher, deterministic dev keys, op-deployer
   intent, L1 contract deployment, op-reth/op-node/batcher/proposer containers and
   the L1 block clock as committed scripts under `devnet/local/`.
2. Write the A05 evidence capture (protocol run + bridge trace) against the codified
   lane and regenerate `evidence/a05/protocol-run.json` and
   `evidence/a05/bridge-trace.json` from a single clean run.
3. Update the ADRs and verification docs to the validated client versions, then
   ship release v0.6.0 with the evidence assets.
