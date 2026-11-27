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

The host-side orchestration is committed and reproducible, but the upstream
Kurtosis package currently mixes image tags from different release eras, which
prevents a fully working network in this environment:

- the pinned optimism-package resolves an ethereum-package whose L1 launcher
  passes the legacy `--allow-insecure-unlock` flag (removed in geth 1.17), so geth
  is pinned to 1.16.9 and tagged as the expected `latest`;
- the generated L1 genesis includes post-Electra forks that older consensus
  clients cannot parse, while the current lighthouse image rejects locally
  produced blocks on a single-node devnet with a data-column validation error;
- mixing newer genesis fields with older client images fails in the opposite
  direction (`missing entry for fork "osaka" in blobSchedule`).

The next attempt replaces the package orchestration with a directly controlled
local stack (op-deployer intent with shortened dispute-game timers, op-reth +
op-node, a local batcher and proposer, and calldata DA as the explicitly
reported development mode). The deploy configuration and ADRs in this directory
remain the pinned target; the protocol-run evidence will be regenerated once the
network is up.
