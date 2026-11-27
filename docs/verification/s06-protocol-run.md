# S06 verification: controlled rollup devnet, protocol run and bridge withdrawal

This record verifies the S06 exit evidence: a real two-layer OP Stack network, L2
settlement activity published to L1 as batch transactions, and one canonical ETH
withdrawal proven and finalized through the `OptimismPortal`.

## Reproduce

```bash
pnpm devnet:local:up      # deploy the L1 contracts and start the network
pnpm local:evidence       # capture both A05 packs
pnpm a05:verify           # offline verification of the committed packs
pnpm devnet:local:down    # stop the network
```

CI runs `pnpm a05:verify`, which validates both packs against the committed JSON
Schemas and checks the A05 invariants without starting a chain.

## Pinned runtime

| Layer | Component | Image | Resolved digest |
| --- | --- | --- | --- |
| L2 execution | op-reth `v2.4.0` | `us-docker.pkg.dev/oplabs-tools-artifacts/images/op-reth:v2.4.0` | `sha256:4bc077fc2068…c1bbc861` |
| L2 consensus | op-node `v1.19.3` | `us-docker.pkg.dev/oplabs-tools-artifacts/images/op-node:v1.19.3` | `sha256:2254e2a715cf…a202fcb72e` |
| Batch submission | op-batcher `v1.16.11` | `us-docker.pkg.dev/oplabs-tools-artifacts/images/op-batcher:v1.16.11` | `sha256:af95492b091d…ec9934af48` |
| Output proposals | op-proposer `v1.16.3` | `us-docker.pkg.dev/oplabs-tools-artifacts/images/op-proposer:v1.16.3` | `sha256:31b21fae8941…245d87836` |
| L1 execution | anvil (Foundry 1.10.1) | local binary, Cancun hardfork, synthetic 2 s block clock | n/a |
| L1 contracts | op-deployer `v0.6.0` | pinned GitHub release binary, sha256 verified by the launcher | n/a |

Chain ids: L1 `11155111`, L2 `16584`. L2 block time 2 s, L2 gas limit
60,000,000, sequencer drift 600 s, sequencing window 3,600 s, channel timeout
300 s, batch inbox `0x0098faa3fd68e74587cfad4029165ae7a85a73b5`.

## Deployed L1 contracts

| Contract | Address |
| --- | --- |
| `OptimismPortalProxy` | `0xf7f5bf6f23443b8424ae9b597b695e8a8cc3dade` |
| `SystemConfigProxy` | `0x003671a7621758a51f1bb42db31171687d93ae64` |
| `L1StandardBridgeProxy` | `0x9d453f53411ba0a28db9bfafa78510d44d29f5df` |
| `L1CrossDomainMessengerProxy` | `0x0d1109fccf8d45ee7f8ea2f3eb6be4aa171a3bbc` |
| `DisputeGameFactoryProxy` | `0xc2d47eb05a7f8f815598072b0e8225f1cd5ae3ae` |
| `AnchorStateRegistryProxy` | `0x432c9562df818695f9e7486a079325bac66ebc7b` |
| `PermissionedDisputeGameImpl` | `0x58bf355c5d4edfc723ef89d99582eccfd143266a` |
| `FaultDisputeGameImpl` | `0x6ddba09bc4ccb0d6ca9fc5350580f74165707499` |

The actor/role inventory (deployer, admin, system config owner, unsafe block
signer, batcher, proposer, challenger, fee vault recipients and withdrawal
recipient) is recorded in `evidence/a05/protocol-run.json` under `actors`.

## Protocol run evidence

`evidence/a05/protocol-run.json`:

- Deposit: L1 tx `0xa7ab85cc29e7e9078295db092712e8b25311c64dd886f900756ce7de1450437d`
  (block 215) → L2 deposit tx `0x81295df4eda86d1b4d661b595f8bef8531636bf2cf6d4edee7df2f60aa61755e`
  (block 190), 0.5 ETH.
- Six labelled L2 settlement transactions in blocks 191–201.
- Ten batch transactions to the batch inbox in L1 blocks 217–284 (calldata,
  501+ bytes each, no versioned blob hashes), which advanced the L2 safe head
  from the genesis state to safe block 189.
- Data availability mode: **calldata**. The summary records
  `blobDataAvailability: false`; blob DA remains an open gap (see
  `docs/architecture/adr-02-batch-and-da.md`).
- L1 finality: not modelled. The execution-only anvil L1 exposes synthetic
  safe/finalized tags, so the evidence does not claim consensus finality. L2
  safe/finalized heads from op-node are recorded (safe 189, finalized 129).

## Bridge trace evidence

`evidence/a05/bridge-trace.json`:

| Step | Location | Value |
| --- | --- | --- |
| Withdrawal initiation | L2 tx `0x522aca350c61a246ab201cd2cf5f03956036d0e6f6e5cac0146a1b003e9f41bf`, L2 block 204 | 0.1 ETH through `L2StandardBridge` |
| Withdrawal hash | `0xfbdf46187f8f6d34e864473ee7b1c56d1c05d6c4a1aa32cd4f2acc4125ef79bc` | recorded by `L2ToL1MessagePasser` |
| Output root proof | dispute game 17 `0xD469cD347faF02a9ded3641A3C5782507E4B9062`, L2 block 207 | proven output root equals the game root claim |
| L1 proving | tx `0x08fa341056252c7b23edfcd7a374a078e8872570ab9a133dbe67ed13f905db90` (block 305) | `proveWithdrawalTransaction` |
| Game resolution | resolveClaim `0x70ec65b8…` and resolve `0x4f1abd49…` | status `2` = `DEFENDER_WINS` |
| Finalization | tx `0xee79950e4773d3bd95fac9c71f28e7554aa739e26272ac342abbc37a7136b951` (block 323) | status 1, recipient delta exactly `100000000000000000` wei |
| Messenger relay | finalize receipt contains an `L1CrossDomainMessenger` log | 0.1 ETH relayed to the recipient |

Configured timers enforced by the portal and game (not shortened):

- `proofMaturityDelaySeconds = 604800`
- `disputeGameFinalityDelaySeconds = 302400`
- game `maxClockDuration = 302400`
- game `clockExtension = 10800`
- respected game type `1`

The private anvil clock was advanced by `302507` and `604912` seconds
(`evm_increaseTime`, recorded with before/after timestamps) to satisfy those real
timers. This is a local test-lane procedure, not a claim that a production
withdrawal is quick, and the acceleration is recorded in the evidence pack.

## Results

| Check | Result |
| --- | --- |
| L2 blocks produced and L2 activity derived back from L1 | pass |
| Batch transactions observed on the batch inbox | 10 |
| L2 safe head covers the recorded activity | pass |
| Withdrawal proven against an output root | pass |
| Dispute game resolved to `DEFENDER_WINS` | pass |
| Portal finalization succeeded and relayed exactly 0.1 ETH | pass |
| Blob data availability demonstrated | **not demonstrated** (open gap) |
| L1 consensus finality observed | **not modelled** (execution-only L1) |

## Known gaps carried forward

1. **Blob DA.** The pinned upstream Kurtosis lane that would provide a
   consensus-backed L1 with a beacon API is currently blocked by an upstream
   image/genesis mismatch. Until blob batches are shown, A05 is satisfied for
   batch publication and the withdrawal path but not for blob-specific data
   availability; the gap is recorded in the evidence summary.
2. **L1 finality.** An execution-only L1 cannot produce consensus finality.
   Demonstrating L1 safe/finalized observations requires the consensus-backed
   lane.
3. **Time acceleration.** The bridge trace uses a recorded private-clock
   acceleration for the real portal timers; it does not measure production
   latency.
