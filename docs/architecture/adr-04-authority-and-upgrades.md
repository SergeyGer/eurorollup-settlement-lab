# ADR-04: Authority, keys and upgrades

## Status

Accepted for release 1.0.

## Context

The exercise requires an inventory of the actors that can change protocol
behaviour, separate local signers, and a rehearsed versioned policy upgrade with
two-of-three approval and a test-only timelock.

## Decision

- **Protocol actors** are distinct local keys, all derived from the public anvil
  development mnemonic and therefore not secret material:
  - L1/L2 proxy admin owners and superchain proxy admin/guardian: `admin`;
  - superchain protocol versions owner: `admin`;
  - system config owner: `systemConfig`;
  - unsafe block signer (sequencer): `sequencer`;
  - batcher: `batcher`;
  - proposer: `proposer`;
  - challenger: `challenger`;
  - fee vault recipients: separate `baseFee`, `l1Fee`, `sequencerFee` accounts;
  - deployer: a dedicated deployment key used only by op-deployer;
  - withdrawal recipient: a separate end-user account.
- The deployment intent and the deployed role addresses are recorded with the
  protocol-run evidence.
- A versioned policy upgrade with two-of-three approval and a test-only timelock,
  including the activation block and the forward recovery procedure, is rehearsed
  in the operations step (S07) and recorded there.

## Consequences

- No production keys or credentials exist anywhere in the repository.
- Roles are split so an evidence reader can tell who can halt, upgrade, batch,
  propose and challenge.
- The two-of-three approval and timelock add latency to upgrades; the exercise
  treats this as acceptable and rehearses the recovery path.

## Verification

The actor/role inventory is captured with the deployed contract addresses in
`evidence/a05/protocol-run.json`; the upgrade rehearsal, activation point and
recovery procedure belong to the S07 operations evidence.
