# ADR-01: Execution clients and block building

## Status

Accepted for release 1.0.

## Context

The release needs a reproducible two-layer network with a real L1 consensus and
execution pair, a single L2 sequencer, an L2 verifier path, a batcher and the
fault-proof components. The rollup execution client must be supported by the
chosen op-node pairing and must keep upstream block-building rules.

## Decision

- L2 execution: **op-reth** (`ghcr.io/paradigmxyz/op-reth:v1.6.0`), the Rust
  OP-Stack execution client from the official release train.
- L2 consensus: **op-node** (`us-docker.pkg.dev/oplabs-tools-artifacts/images/op-node:v1.13.4`).
- L1 execution: geth `v1.16.9`; L1 consensus: lighthouse `v7.1.0` (pinned to the
  version contemporaneous with the pinned ethereum-package; Fulu is not
  activated on the devnet, so no data-column supernode mode is required).
- Block time: 2 seconds; L2 gas limit: 60,000,000; L1 chain id 3151908; L2 chain
  id 31338.
- Block building keeps the upstream op-reth/op-node rules; the sequencer is a
  single local node and no custom builder is introduced.

The exact image references and resolved content digests are recorded in
`evidence/a05/protocol-run.json`; the deploy configuration is committed under
`devnet/` and is launched with `pnpm devnet:up`.

## Consequences

- The L2 EL/CL pairing is part of the official OP Stack release train, which
  minimises divergence from upstream block-building behaviour.
- op-reth gives a fast local execution client and a compact image; both clients
  are pinned and the images are resolved by digest in the evidence.
- The devnet runs on a single host with CPU-only resources; block times and
  throughput are adequate for protocol evidence but not representative of a
  production sequencer deployment.

## Alternatives considered

- **op-geth** with op-node: the default ethereum-package pairing. It is supported
  and simpler to configure, but the exercise explicitly calls for an op-reth
  pairing; op-geth is kept as the fallback if an op-reth image cannot be resolved.
- **Custom rollup-boost builder**: adds moving parts and a modified block-building
  path; deferred until there is a measured block-building problem to solve.

## Verification

`pnpm devnet:up` brings the network up; `pnpm devnet:evidence` captures chain ids,
block time, gas limit, image digests, heads and a blob batch linking L2 activity
to an L1 transaction.
