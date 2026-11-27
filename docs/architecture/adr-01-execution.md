# ADR-01: Execution clients, block building and the local network

## Status

Accepted for release 1.0.

## Context

The release needs a reproducible two-layer network that can produce real L2
blocks, batch them to L1 and execute the canonical withdrawal path. The original
plan pinned the `ethpandaops/optimism-package` Kurtosis devnet, but that upstream
package currently mixes a genesis format with client binaries from different
release trains: the generated L1 genesis contains post-Electra fork data while the
pinned geth release no longer accepts the launcher flags, and the current
lighthouse image rejects locally produced blocks on a single-node devnet with a
data-column validation error. The package lane therefore cannot be used as-is.

## Decision

- **L2 execution**: op-reth `v2.4.0` (`us-docker.pkg.dev/oplabs-tools-artifacts/images/op-reth`).
- **L2 consensus**: op-node `v1.19.3` in sequencer mode.
- **L2 block time**: 2 seconds; L2 gas limit 60,000,000.
- **L1**: anvil (Foundry) in Cancun mode on chain id 11155111, run as an
  execution-only chain with a synthetic two-second block clock (`anvil_mine`
  driven from the launcher). The L1 contract stack is deployed from scratch with
  **op-deployer `v0.6.0`** using a `custom` intent.
- Chain ids: L1 `11155111`, L2 `16584`.
- Every component version is pinned by tag; the launcher and the evidence
  capture record the resolved image digests (`evidence/a05/protocol-run.json`).

The launcher is `devnet/local/up.sh`; it is deterministic, uses public anvil
development keys and rebuilds the network from an empty enclave.

## Consequences

- The stack is under our control and reproducible on one host: `pnpm
  devnet:local:up` brings the rollup up, `pnpm devnet:local:down` tears it down.
- The L1 is execution-only: there is no L1 consensus client, no beacon API and no
  blob sidecars. Batch data therefore uses calldata mode (see ADR-02) and L1
  finality is not modelled (see ADR-03).
- Block times and throughput are a development lane, not a production
  representation.

## Alternatives considered

- **Pinned Kurtosis optimism-package lane**: intended but currently broken by the
  upstream image/genesis mismatch described above. It stays the longer-term path
  for a consensus-backed L1 with blob DA.
- **op-geth instead of op-reth**: supported by op-node, but the exercise
  explicitly calls for an op-reth pairing and op-reth is used in the validated
  lane.

## Verification

`evidence/a05/protocol-run.json` records the chain ids, block times, rollup
configuration, contract addresses, pinned images with digests, L2 activity,
calldata batch transactions and the observed L2 safe/finalized heads.
