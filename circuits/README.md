# Zero-knowledge circuits

The application proof establishes membership in the issuer's synthetic
eligibility set. It is a real Noir circuit, not a mock.

## Pinned toolchain

- `nargo` 1.0.0
- `bb` (Barretenberg) 6.1.0
- Pedersen hash over BN254 for leaves and Merkle nodes

Install with `noirup -v 1.0.0` and `bbup -v 6.1.0` (or see
`docs/policy-lab/eligibility.md`). The compiled circuit, verification key and
verification key hash are committed under `circuits/eligibility/artifacts/`.

## Circuit

`eligibility/src/main.nr` proves:

- knowledge of a salt whose pedersen leaf hash is committed in the current root;
- the Merkle path reconstructs that root;
- the public wallet, class, epoch and expiry are exactly the leaf attributes;
- the proof is bound to a non-zero chain id, gate address, epoch and expiry.

Policy decisions are separate: the issuer decides the eligible class, the
dealing policy decides whether a movement may execute, and the sponsor decides
whether to pay for gas.

## Fixture tools

`hash-leaf` and `hash-node` are offline tools used by
`scripts/build-eligibility-fixtures.ts` to build deterministic roots and witness
paths. They never run in production paths.

## Commands

```bash
cd circuits
nargo compile --workspace
nargo test --workspace
cd eligibility && nargo execute        # uses Prover.toml
bb prove -b target/eligibility.json -w target/eligibility.gz --write_vk -o target
bb verify -p target/proof -k target/vk
```
