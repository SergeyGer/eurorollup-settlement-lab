# ADR-02: Batch submission and data availability

## Status

Accepted for release 1.0, with a recorded data-availability gap.

## Context

The rollup must publish L2 batches to L1 and make its data-availability mode
explicit. The target for the release devnet is blob DA (EIP-4844). Blob
derivation requires an L1 beacon endpoint; the controlled local lane runs an
execution-only anvil L1 and therefore cannot fetch blob sidecars.

## Decision

- **Batcher**: op-batcher `v1.16.11`, `--data-availability-type=calldata`,
  one-L1-block channel duration, short poll interval.
- **Batch inbox**: the address derived by op-deployer for the chain; every batch
  is linked to its L1 transaction and to the L2 safe-head advancement it caused.
- **DA mode on the evidence lane**: calldata. This is an explicitly reported
  development mode: the evidence pack records `dataAvailabilityMode: "calldata"`,
  the calldata size of every batch transaction and an empty versioned-blob-hash
  list, and the summary marks `blobDataAvailability: false`.
- **Blob DA target**: the consensus-backed path uses the pinned Kurtosis lane
  once the upstream package image/genesis mismatch is resolved. The current
  evidence must not be read as blob-DA proof.

## Consequences

- Batch publication, derivation and the resulting safe-head progression are
  real and verifiable on the local L1.
- Blob-specific properties (blob gas, versioned hashes, sidecar availability) are
  not demonstrated. This is the remaining A05 gap and is recorded in the evidence
  summary and the verification document.
- Calldata batches are larger than blob batches; the cost comparison belongs to
  the economics step (S07).

## Update: NET-01 lane attempt

The consensus-backed lane was attempted four times with pinned client images; the lane
launches and op-batcher publishes blob transactions, but the consensus client rejects
every blob block with `InvalidCellProofLength { expected: 128, actual: 1 }` (image/genesis
mismatch between the pinned upstream package revision and the client releases), and the
older lighthouse release that would accept the pre-Fulu block cannot start against the
generated genesis. The exact attempts are recorded in
`evidence/s19/upstream-blocker.json` and `docs/verification/s19-net01-attempt.md`.
The calldata lane remains the working local evidence path until the upstream mismatch is
resolved; NET-01 stays open.

## Verification

`evidence/a05/protocol-run.json` contains the batch transactions observed on the
batch inbox, their L1 blocks, calldata sizes and the L2 safe head after indexing.
