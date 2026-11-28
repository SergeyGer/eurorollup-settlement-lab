# S16 verification: onchain eligibility enforcement (SET-02)

This record verifies SET-02: the issuer's eligibility roots are checked onchain with a
real UltraHonk proof, the approvals are cached with their policy version, root, epoch,
class and expiry, and every movement that needs eligibility fails closed with a decoded
reason. The root rotation between request and allocation is exercised end to end.

## Circuit and verifier

- Circuit: the committed `eligibility` Noir circuit (Merkle membership over
  `pedersen_hash([wallet, class, epoch, expiry, salt])`, public inputs `wallet, root,
  chain_id, gate, class, epoch, expiry`).
- EVM verification key: regenerated for the `evm` target (`ultra_honk_evm`); the generated
  Solidity verifier is committed at `contracts/src/verifier/HonkVerifier.sol`.
- The S16 evidence uses **real proofs** built over the synthetic settlement accounts,
  not the static demo personas; the witness/root fixtures are written to
  `evidence/s16/eligibility-fixtures.json` (chain id 16584).
- Verification runs onchain: the deployed verifier accepted an authentic proof and
  rejected a tampered one; the registry refuses a proof whose wallet, root, chain id,
  gate, epoch, expiry, class or verification result does not match.

## Policy

The registry stores the issuer's current `{root, epoch, policyVersion}` and a per-gate
approval cache. Every check re-derives the requirements:

| Movement | Gate | Required class |
| --- | --- | --- |
| Spot fill | – (no eligibility needed) | – |
| eFUND mint (allocation, recipient) | `FUND_SUBSCRIPTION` | VERIFIED |
| eFUND transfer (both holders) | `SHARE_TRANSFER` | VERIFIED |
| eFUND burn (redemption source) | `FUND_REDEMPTION` | BASIC |

Approvals carry the policy version, root, epoch, class and expiry; `requireEligible`
reports distinct custom errors: `EligibilityMissing`, `EligibilityStale`,
`EligibilityRootChanged`, `EligibilityEpochChanged`, `EligibilityExpired`,
`EligibilityClassTooLow`, plus `UnknownRoot`, `UnknownEpoch`, `ChainMismatch`,
`GateMismatch`, `WalletMismatch`, `ProofInvalid` and `UnauthorizedIssuer`.

## Onchain scenario on the controlled L2

`pnpm s16:run` deploys the verifier, registry, tokens, restricted eFUND, escrow and DvP
settlement (29 successful transactions), then:

1. Caches epoch-1 approvals from real proofs (investor subscription/transfer, dealer
   transfer/redemption).
2. Exercises spot fill, subscription mint, transfer between two eligible holders and
   redemption (all succeed).
3. Reserves EUR 300 for G01.
4. Rotates the issuer root to epoch 2 / policy version 2.
5. Attempts the G01 allocation: it reverts with `EligibilityStale(investor, 1, 2)`; the
   transaction is recorded with **status 0**, escrow keeps **EUR 300**, the investor keeps
   **0.050000 eFUND** and **zero new shares** are issued.
6. Recovers once: the investor re-proves under epoch 2, the same reservation is allocated
   exactly once (3.125000 eFUND), and a second allocation reverts with
   `Escrow: insufficient reservation`.
7. Redeems 1.000000 eFUND for EUR 98 under the epoch-2 redemption approval.
8. Negative paths: an expired credential reverts with `EligibilityExpired`, an
   unauthorized issuer with `UnauthorizedIssuer`, a stale transfer with
   `EligibilityStale`, and the tampered proof is rejected.

Final canonical witness: investor EUR 587.95 / 0.1 tWETH / 2.175000 eFUND; dealer
EUR 205 / 0.9 tWETH; fee recipient EUR 0.05; issuer treasury EUR 707; escrow EUR 0;
eFUND total supply 2.175000.

Evidence: `evidence/s16/eligibility-onchain.json`,
`evidence/s16/eligibility-fixtures.json`, ABIs under `contracts/abi/`.
Offline verification: `pnpm s16:verify` (also in CI and the release-check matrix);
contract-level unit tests: `pnpm contracts:test` (17 tests, 10 of them for the eligibility
gate).

## Reproduce

```bash
pnpm contracts:build
pnpm devnet:up
pnpm s16:run
pnpm s16:verify
pnpm devnet:down
```

## Recorded limitations

- Issuer and settlement operator are the same synthetic account; authority separation and
  reconciliation is S21.
- Proof generation uses the pinned native Noir/bb toolchain offchain; only verification is
  onchain.
- The class codes represent the synthetic screening fixtures, not a real sanctions
  provider.
- The slice runs on the controlled L2 with calldata DA; blob DA and L1 consensus finality
  are NET-01 (S19).
