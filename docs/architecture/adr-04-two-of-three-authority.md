# ADR-04: Two-of-three upgrade authority with timelock and forward recovery

## Status

Accepted for the v1.2 infrastructure work.

## Context

The infrastructure update needs an authority path that cannot be activated by one key,
cannot be activated before its timelock, and does not lose the audit trail when an
execution fails against the target contract.

## Decision

- **Two of three owners** must approve a proposal before it can execute.
- A **timelock** (`eta`) is enforced at execution time; executing earlier reverts with
  `TimelockNotElapsed`.
- **Failed executions are recorded** (`ExecutionFailed`, `failed=true`) instead of silently
  reverting the proposal. `recover` clears the failed flag so the same proposal can be
  retried after the target is fixed, keeping the approvals and the audit trail.
- `Activated` records the activation block for the acceptance record.
- Non-owners cannot propose, approve, execute or recover.

## Consequences

- The rehearsal covers the early-activation rejection, activation block, failed execution
  and forward recovery, and the contract tests cover the same paths.
- The production authority delay and owner key management remain deployment concerns; the
  rehearsal uses a ten-second timelock on a controlled chain.

## Verification

`contracts/test/Authority.t.sol` and `evidence/s21/ops-money-authority.json`.
