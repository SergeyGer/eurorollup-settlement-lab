# ADR-02: Batch submission and data availability

## Status

Accepted for release 1.0.

## Context

The rollup must publish L2 batches to L1 and make the data availability mode
explicit. The release devnet should use blob DA; calldata mode is allowed only as
an explicitly reported development mode.

## Decision

- Batcher: **op-batcher** (`us-docker.pkg.dev/oplabs-tools-artifacts/images/op-batcher:v1.14.0`).
- DA mode on the release devnet: **blobs** (EIP-4844 type-3 transactions). The
  L1 must expose a beacon endpoint; the package runs lighthouse in supernode mode
  so the single-node devnet can validate data columns.
- Batch posting window: the devnet uses a one-second poll interval and a small
  channel duration; the recorded posting window and safety margin are captured
  from the rollup configuration and the observed batch transactions.
- Every batch is linked to its L1 transaction and versioned blob hashes. The
  evidence records the L2 activity, the L1 blob transaction, the versioned hashes
  and the block that included it.
- Calldata mode is not used for the release evidence. If a development run uses
  it, it must be recorded separately with the same linkage fields.

## Consequences

- Blob DA keeps L1 calldata small, but ties the devnet to a beacon chain. The L1
  beacon endpoint is part of the pinned compose configuration.
- The batch posting window is short in the devnet; the safety margin between
  posting and the sequencing window is recorded but the devnet does not model
  mainnet L1 congestion.

## Verification

`evidence/a05/protocol-run.json` records the batch transaction hash, blob
versioned hashes, blob count, blob gas, inclusion block and the L2 activity that
produced the batch. A later bridge/withdrawal trace reuses the same devnet.
