# Eligibility and euro sponsorship

The sandbox keeps three decisions separate: the issuer decides who belongs to an
eligible class, the dealing policy decides whether a movement may execute, and
the sponsor decides whether to pay for gas. The issuer decision is a real Noir
zero-knowledge membership proof; the dealing decision is a deterministic policy
matrix; the sponsor decision is an independent budget check.

## Issuer: wallet-bound credentials and roots

`fixtures/eligibility/personas.json` commits eight synthetic wallet-bound leaves.
Each leaf preimage is
`pedersen_hash([wallet, class, epoch, expiry, salt])`; the tree is a depth-3
binary Merkle tree with `pedersen_hash` as the node function. Class codes are
`VERIFIED = 3`, `BASIC = 2`, `FLAGGED = 1`.

`fixtures/eligibility/epochs.json` publishes two issuer epochs:

- epoch 1 contains the three demo personas and five filler investors;
- epoch 2 rotates the first leaf away from `persona-verified`, so an approval
  issued under epoch 1 is invalid at execution.

`fixtures/eligibility/root-epochs.json` and `witnesses.json` are generated
deterministically by `pnpm eligibility:fixtures` with the pinned Noir hash tools,
so the fixtures and the circuit use the same pedersen implementation.

## Circuit

`circuits/eligibility/src/main.nr` proves:

- knowledge of a salt whose leaf hash is committed in the current root;
- the Merkle path reconstructs that root;
- the public wallet, class, epoch and expiry are exactly the leaf attributes;
- the proof is bound to a non-zero chain id, gate address, epoch and expiry.

Public inputs: `wallet`, `root`, `chain_id`, `gate`, `class`, `epoch`, `expiry`.
The compiled circuit, verification key and verifier metadata are committed under
`packages/eligibility/artifacts/`; the metadata records the circuit hash, the
verification-key hash, the proof system (`ultra_honk`), the Noir and Barretenberg
versions and the public-input list.

## Dealing policy matrix

`packages/eligibility/src/policy.ts` applies the documented policy:

| Persona | Spot | Fund subscription | Fund redemption | Share transfer |
| --- | --- | --- | --- | --- |
| Verified | allow | allow | allow | allow |
| Basic | allow | `ELIGIBILITY_REQUIRED` before reserving cash | allow | `ELIGIBILITY_REQUIRED` |
| Flagged | `SCREENING_DECLINED` | `SCREENING_DECLINED` | `SCREENING_DECLINED` | `SCREENING_DECLINED` |

Missing, stale or `REVIEW` screening holds the movement with a reason. A root
rotation between a fund request and its allocation holds the reserved cash,
mints no units and exposes `POLICY_CHANGED` with the allowed
`authorized_refund` and `revalidate_with_current_proof` actions.

`evidence/a03/policy-matrix.json` records 19 decisions (8 allow, 4 hold,
7 decline) and 9 assertions that all pass. `pnpm eligibility:matrix -- --check`
reproduces the committed bytes exactly.

## Proof vectors

`evidence/a03/proof-vectors.json` records real proofs produced with the committed
circuit:

- three positive vectors (verified fund gate, basic spot gate, flagged spot gate)
  verify against their public inputs;
- five negative vectors are rejected: a proof checked against the epoch-2 root, a
  proof with one flipped byte, a persona removed by rotation (no witness), a
  fund-gate receipt presented at the spot gate, and an expired credential.

`pnpm eligibility:verify` re-verifies the committed proofs and checks the circuit
and verification-key hashes against the committed artifacts.

## Browser proving

The browser view generates and verifies the proof locally. The demo witness stays
in the tab, the proving backend is loaded lazily, and only the public inputs are
displayed. `evidence/a03/browser-proving.json` records measured samples:

| Sample | Proving | Verify |
| --- | --- | --- |
| 1 (cold, includes backend initialisation) | 20,530 ms | 1,324 ms |
| 2 (warm) | 3,334 ms | 1,314 ms |
| 3 (warm) | 3,285 ms | 1,309 ms |

Warm proving is below the declared 5-second target; the cold sample includes
one-time backend initialisation. The measurement is taken on the release build in
headless Chromium on the recorded hardware.

## Sponsorship

`GET /v1/sponsorship/status` exposes the sponsor budget, native deposit and the
current decision. The demo configuration exceeds the remaining daily budget with
the next operation ceiling, so sponsorship is declined with `SPONSOR_LIMIT`
independently of the business decision: holdings are untouched and the
eligibility receipt remains valid.

## Commands

```bash
pnpm eligibility:fixtures     # rebuild roots and demo witnesses with the Noir toolchain
pnpm eligibility:artifacts    # compile the circuit and regenerate the vk metadata
pnpm eligibility:matrix       # write evidence/a03/policy-matrix.json
pnpm eligibility:proofs       # generate real proofs and write evidence/a03/proof-vectors.json
pnpm eligibility:verify       # verify committed evidence, proofs and artifact hashes
```

Toolchain: `nargo` 1.0.0 and `bb` 6.1.0 (`noirup -v 1.0.0`, `bbup -v 6.1.0`).
