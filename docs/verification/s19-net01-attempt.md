# S19 attempt: consensus-backed lane and blob DA (NET-01)

This record documents the NET-01 attempt. The consensus-backed lane was brought up and
the batcher published real blob transactions, but the lane is **blocked by an upstream
image/genesis mismatch**: every block containing a blob is rejected by the consensus
client with `InvalidCellProofLength { expected: 128, actual: 1 }`. The working calldata
lane (A05) remains the local path, and no blob-DA, sidecar or consensus-finality claims
are made from this attempt.

## Attempts

| # | Configuration | Observed result |
| --- | --- | --- |
| A | Upstream defaults (floating `ethpandaops/lighthouse:unstable`, `ethereum/client-go:latest`) | Lane launches; L1 block production stalls on the first pending blob transaction; `InvalidCellProofLength { expected: 128, actual: 1 }` |
| B | `sigp/lighthouse:v8.3.3` beacon + validator, `ethereum/client-go:v1.16.9` | Same rejection; empty blocks are produced, blob blocks are not |
| C | Same pins, participant `supernode: false`; stale local package supernode patch removed | Same rejection; L1 head stalls at the first pending blob transaction |
| D | `sigp/lighthouse:v7.1.0`, `ethereum/client-go:v1.15.11` | Beacon node fails to start against the generated genesis; lane does not come up |

The exact image tags, chain id 16584, op component pins and error excerpts are recorded in
`evidence/s19/upstream-blocker.json`.

## What was verified

- The Kurtosis lane provisions the L1 execution + consensus clients, the L2
  op-reth/op-node pair, op-batcher and op-proposer.
- The beacon chain and geth produce and verify empty blocks.
- The L2 sequencer produces blocks and op-batcher submits type-3 (blob) transactions
  carrying one blob each.
- The L2 chain id 16584 is configured and development accounts are funded.
- The lane definition is reproducible: `devnet/net01/run.sh` with
  `devnet/net01/network-params.yaml`.

## What is not verified (and must not be claimed)

- Blob versioned hashes, L1 blob transaction receipts, beacon slots and sidecar
  commitments (the blob block never lands).
- L2 order block hash on a deriving verifier.
- Unsafe/safe/finalized head progression from L1 blobs and L1 consensus finality.
- Canonical portal withdrawal against consensus timers; the A05 calldata lane repeats the
  withdrawal with its recorded private-clock acceleration.

## Blocker analysis

The pinned upstream `optimism-package` revision (September 2025) uses a genesis generator
output that is pre-Fulu, while the client images that start against it expect post-Fulu
cell proofs for blob blocks; the older lighthouse release that predates the check cannot
start against that genesis. This is the image/genesis mismatch already carried in A05,
confirmed here with exact errors and four configuration attempts.

## Next options

1. Rerun when an upstream optimism-package/ethereum-package image set agrees on the
   Fulu/PeerDAS cell-proof format; `devnet/net01/run.sh` is ready.
2. Pin a coherent image list from an ethpandaops release CI.
3. Build the L1 consensus images from the same source revision as the genesis generator.

NET-01 remains open; the blocker is tracked in issue #54 with this record.
