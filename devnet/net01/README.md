# NET-01 consensus-backed lane

The lane from `docs/verification/s19-net01-attempt.md`: a real L1 consensus chain
(geth execution + lighthouse beacon/validator, minimal preset) with one OP chain
(op-reth + op-node), op-batcher in **blob DA** mode and op-proposer.

## Status

**Blocked by an upstream image/genesis mismatch.** The lane launches and the batcher
publishes blob transactions, but the consensus client rejects every block that contains a
blob with `InvalidCellProofLength { expected: 128, actual: 1 }`. The chain only makes
progress with empty blocks, so blob DA, blob sidecars and L2 safe-head derivation from
blobs cannot be captured yet. The details of the four attempted configurations are in
`evidence/s19/upstream-blocker.json`; the lane recipe below is the last attempt.

## Run

```bash
# requires docker + kurtosis (CLI 1.23.0 tested)
devnet/net01/run.sh
# inspect service ports:
kurtosis enclave inspect net01
devnet/net01/down.sh
```

The script clones the upstream `ethpandaops/optimism-package` at the revision the
repository was tested against, resets `main.star` and runs the pinned parameters. All
other components are pinned through the image tags in `network-params.yaml`; the genesis
generator is pinned by the upstream ethereum-package revision.

## Known blockers carried by the release

- Blob blocks are rejected by the consensus client (cell proof length mismatch).
- L1 consensus finality cannot advance past the point where the first blob transaction is
  pending; the L2 safe head never leaves genesis.
- The canonical portal withdrawal is therefore replayed from the accelerated calldata
  lane (A05) with its recorded clock acceleration; it is not re-executed against
  consensus timers on this lane.

## Next options (tracked in issue #54)

1. Wait for an upstream optimism-package/ethereum-package image set where the genesis
   generator and lighthouse release agree on Fulu/PeerDAS cell proofs, then rerun.
2. Pin a coherent set from an ethpandaops release CI image list instead of floating
   client images.
3. Build the L1 consensus image set from the same source revision as the genesis
   generator when an upstream fix lands.
