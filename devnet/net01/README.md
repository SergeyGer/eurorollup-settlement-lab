# NET-01 consensus-backed lane

The lane from `docs/verification/s19-net01-attempt.md`: a real L1 consensus chain
(geth execution + lighthouse beacon/validator, minimal preset) with one OP chain
(op-reth + op-node), op-batcher in **blob DA** mode and op-proposer.

## Status

**Verified.** The image/genesis mismatch is resolved by pinning lighthouse v8.0.0 and
geth v1.16.1 against the pinned genesis generator. The lane accepts blob blocks, the
batcher publishes type-3 transactions, the deriving verifier matches the sequencer block
hash and L1 finality covers the blob transaction. Evidence:
`evidence/s19/net01-lane.json`, verification `pnpm s19:verify`, record
`docs/verification/s19-net01-consensus-lane.md`. The failed attempts remain recorded in
`evidence/s19/upstream-blocker.json`.

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

## Operating notes

- Blob blocks require the lighthouse/geth pair that matches the pinned genesis generator;
  the verified pair is lighthouse v8.0.0 + geth v1.16.1. Do not move these images without
  re-running the capture and `pnpm s19:verify`.
- The canonical portal withdrawal is replayed from the accelerated calldata lane (A05)
  with its recorded clock acceleration; the consensus lane uses the real seven-day portal
  timers, which are not waited out. This is labelled in the evidence and is not a
  production-latency claim.
