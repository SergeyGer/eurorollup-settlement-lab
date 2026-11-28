# ADR-03: Canonical anchors and reorg recovery

## Status

Accepted for the v1.2 infrastructure work.

## Context

Balance reads and event indexes must be tied to one exact chain state. Reading "latest"
allows a reorg to move the anchor between two reads, and accepting a block by number alone
can silently include a block from an orphaned branch. The settlement ledger therefore needs
an explicit canonical-anchor policy and a deterministic recovery path after a reorg.

## Decision

- **Exact block hash as the only anchor.** Balance reads and log queries carry the block
  hash (EIP-1898 for `eth_call`/`eth_getLogs`). When a chain lacks the extension, the anchor
  is a block number followed by a mandatory canonical-hash check before and after the reads.
- **Reject noncanonical anchors.** A snapshot whose hash differs from the canonical block at
  the same number is rejected with `NONCANONICAL_ANCHOR`; it is never indexed.
- **Rewind, mark, replay.** On a reorg the ledger rewinds to the common ancestor, marks the
  previous branch events as orphaned in the audit trail, and replays the replacement branch.
  The audit trail keeps both branches; the previous branch is never deleted.
- **Release exactly once.** A reservation release for an already released order is counted
  as a duplicate and does not move money; duplicates are idempotent.
- **Restart deterministic.** Checkpoints serialize balances, reservations, released
  reservations, processed event ids and the audit trail; restoring a checkpoint reproduces
  the projection digest.

## Consequences

- Reconciliation evidence names the exact block hash for every balance comparison and
  records zero per-account differences and per-asset conservation.
- Chains without EIP-1898 require an extra canonical check; this is recorded as a
  limitation rather than hidden.
- The controlled reorg drill is an execution-chain drill, not a production consensus reorg;
  the recovery logic is exercised end to end and recorded as such.

## Verification

`evidence/s20/reconciliation-reorg.json`, `pnpm s20:verify` and the ledger unit tests.
