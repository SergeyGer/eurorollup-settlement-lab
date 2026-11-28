# S19 verification: NET-01 rollup and finality

This record verifies NET-01 on the consensus-backed lane: the A05 image/genesis mismatch
is resolved, the lane commits one real investment-sized batch through **blob DA**, follows
the blob transaction to its L1 block, beacon slot and sidecar commitment, matches the
activity block hash on an **independent deriving verifier**, samples unsafe/safe/finalized
heads on both layers and references the accelerated canonical portal withdrawal.

## Pinned lane

| Component | Pin |
| --- | --- |
| L1 execution | geth `ethereum/client-go:v1.16.1` |
| L1 consensus + validator | lighthouse `sigp/lighthouse:v8.0.0` (minimal preset) |
| L2 execution | `op-reth:v2.4.0` |
| L2 consensus | `op-node:v1.19.3` |
| Batch submission | `op-batcher:v1.16.11`, `--data-availability-type=blobs` (no DA server) |
| Output proposals | `op-proposer:v1.16.3` |
| Chain config deployer | `op-deployer:v0.4.2`, `tag://op-contracts/v4.0.0` |

Kurtosis runs the pinned upstream `optimism-package` revision
`7bef190d7c0b9f619438ed08b17bd5e5f51e72ff`; the lane recipe is
`devnet/net01/network-params.yaml` and `devnet/net01/run.sh`. The image IDs, config and
genesis digests are recorded in the evidence pack.

The earlier four failed image configurations and their exact errors are kept in
`evidence/s19/upstream-blocker.json` and
[`s19-net01-attempt.md`](s19-net01-attempt.md).

## Captured evidence

Lane id `NET01-NET01G-16584` (`evidence/s19/net01-lane.json`):

| Item | Value |
| --- | --- |
| L2 chain id | 16584 |
| Batch activity | 8 real L2 transactions, blocks 1330–1338 (recorded run) |
| Blob transaction | type-3 L1 transaction with one versioned hash, receipt status 1, non-zero blob gas |
| L1 block / beacon | blob block hash equals the beacon execution payload hash; beacon slot and root recorded |
| Sidecar | KZG commitment and proof fetched from the beacon API, versioned hash matches the L1 transaction |
| Derivation | op-node safe head advances past the activity; activity block hash derived from L1 |
| Independent verifier | separate op-reth + op-node pair started from the committed rollup/genesis configs derives the chain from L1 and returns the **same activity block hash** as the sequencer |
| L1 finality | finalized L1 block covers the blob transaction block; beacon finalized checkpoint recorded |
| Heads | unsafe/safe/finalized sampled before and after with timestamps on both layers |
| Registry/health | L1 RPC, beacon health/version, op-node RPC and L2 RPC probed |

## Canonical portal withdrawal

The canonical `OptimismPortal` withdrawal path is replayed from the accelerated calldata
lane (A05): initiation, output-root proof, dispute-game resolution and portal finalization
with the exact 0.1 ETH relay are referenced with their transaction hashes. The private L1
clock acceleration (302,507 s + 604,912 s) is recorded explicitly. The consensus lane uses
the real seven-day portal timers, which are not waited out; the evidence makes no
production-latency claim.

## Verification

- `pnpm s19:verify` — offline checks of pinned manifests, genesis/rollup digests, blob
  transaction, beacon slot and sidecar commitment, L1 finality, sequencer/verifier block
  hash match, head samples and the accelerated withdrawal reference.
- `pnpm s19:run` — captures the evidence on the running lane;
  `pnpm exec tsx scripts/s19-deriving-verifier.ts` captures the independent verifier
  comparison.
- CI runs `pnpm s19:verify`; the release-check matrix includes it.

## Recorded limitations

- The lane is a local minimal-preset consensus network; timestamps are local test-lane
  values, not production latency.
- The withdrawal is replayed on the accelerated calldata lane with the recorded clock
  acceleration; consensus-timer execution is not attempted.
- The independent deriving verifier shares the lane's L1/beacon endpoints and the pinned
  op-node/reth images; it is a separate execution engine, not a separate operator.
