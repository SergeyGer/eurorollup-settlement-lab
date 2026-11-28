# S20 verification: canonical reconciliation and reorg recovery (LED-01)

This record verifies LED-01: balances are read at an exact block hash, noncanonical anchors
are rejected, a controlled reorg replaces an unsafe branch, orphaned events are marked, the
projection rewinds to the common ancestor, the replacement branch is replayed and
reservations are released exactly once. Duplicate delivery and an interrupted restart are
exercised, and per-account/per-asset reconciliation is asserted at one exact block hash.

## Drill lane

`pnpm s20:run` starts a controlled anvil execution chain (chain id 16584) with the
settlement contracts, then:

1. Reserves EUR 300 and allocates 3.125000 eFUND for order A (two blocks).
2. Replaces those two blocks with `anvil_reorg` (depth 2).
3. Reserves EUR 200 and allocates 2.000000 eFUND for order B on the replacement branch.
4. Drives the canonical reconciliation ledger through the reorg.

Exact-hash reads use the EIP-1898 `eth_call` block-hash parameter; the orphan block is no
longer available by hash after the reorg.

## Results

| Check | Result |
| --- | --- |
| Exact-block-hash balance read | accepted at the strategy tip |
| Noncanonical anchor | rejected with `NONCANONICAL_ANCHOR` and the current canonical hash in the reason |
| Orphaned events | 3 (reserve + release + allocate from the replaced branch) |
| Rewind to common ancestor | completed before replay |
| Replacement replay | 3 events (reserve + release + allocate for order B) |
| Reservations released exactly once | one release per order, counted |
| Duplicate delivery | 3 duplicate events skipped, projection unchanged |
| Interrupted restart | checkpoint restored; projection digest equal |
| Per-account differences at exact block hash | 0 |
| Per-asset conservation | dEUR, tWETH and eFUND account totals equal total supplies |
| Audit trail | both branches retained (orphan/replay entries) |

Evidence: `evidence/s20/reconciliation-reorg.json`. Offline verification:
`pnpm s20:verify` (also in CI and the release-check matrix). Contract-level and ledger unit
tests: `pnpm contracts:test` and `pnpm test` (the reconciliation ledger test covers reorg,
duplicate delivery, release-once, restart and exact-hash observation comparison).

## Recorded limitations

- The drill runs on a controlled anvil execution chain with automined blocks; it exercises
  the reconciliation and recovery logic, not a production consensus reorg.
- Exact-hash reads rely on EIP-1898; chains without that RPC extension need a block-number
  read plus a canonical hash check.
- The ledger tracks the settlement contracts used in the drill; the partner API projection
  is reconciled by the same rules but is not replayed in this drill.
