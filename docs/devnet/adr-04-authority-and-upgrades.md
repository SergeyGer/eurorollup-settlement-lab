# ADR-04: Authority and upgrades

## Status

Accepted for release 1.0.

## Context

The exercise requires an inventory of the actors that can change protocol
behaviour, separate local signers, and a rehearsed versioned policy upgrade with
two-of-three approval and a test-only timelock.

## Decision

- Actors and keys: L1 upgrade administrator, L2 proxy admin, sequencer, batch
  signer, proposer, challenger, guardian, issuer and sponsor each have a separate
  local development key. The deployer wallets and role addresses are recorded in
  `evidence/a05/protocol-run.json`.
- The chain deployment uses the standard OP contracts deployment with a local
  proxy admin; no production keys are used anywhere.
- A versioned policy upgrade is demonstrated with a two-of-three approval
  (multisig simulation) and a test-only timelock; the activation block/timestamp
  and the forward recovery procedure are recorded in the operations evidence
  (S07).
- Sponsor and issuer keys stay separate from protocol keys; the account
  abstraction sponsor signer is a distinct local key.

## Consequences

- Local keys are development-only and are not secret material; the repository
  contains no production credentials.
- Two-of-three approval and a timelock add latency to upgrades; the exercise
  treats this as acceptable and rehearses the recovery path.

## Verification

The actor and role inventory is captured with the protocol run evidence; the
upgrade rehearsal, activation block and recovery procedure are captured in the
S07 operations evidence.
