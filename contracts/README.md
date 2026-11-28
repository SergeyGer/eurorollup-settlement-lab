# Settlement slice contracts

Synthetic Solidity contracts for the SET-01 vertical slice. They are deliberately small,
lab-grade contracts: they are **not** audited production protocol code.

| Contract | Purpose |
| --- | --- |
| `Token.sol` | Minimal integer ERC-20 used for dEUR (6 decimals) and tWETH (18 decimals); owner mint/burn. |
| `RestrictedShare.sol` | eFUND (6 decimals) restricted fund-share instrument: transfers only between eligible holders; issuer controls eligibility and the minters (the DvP settlement contract). |
| `Escrow.sol` | Reserved dEUR for pending subscriptions; the settlement contract is the only operator and can only release to the issuer treasury. |
| `DvPSettlement.sol` | Atomic one-step settlement calls: spot delivery-versus-payment, escrow-funded allocation, and redemption (burn shares, pay cash). |
| `EligibilityRegistry.sol` | Issuer roots per epoch/policy version, onchain UltraHonk verification and cached per-gate approvals with expiry. |
| `verifier/HonkVerifier.sol` | Generated EVM-target Solidity verifier for the committed eligibility circuit (VK hash committed in the contract). |
| `ScopedSponsorshipPaymaster.sol` | ERC-4337 v0.7 paymaster that validates one target/method-scoped, expiring, sponsor-signed permit per operation. |
| `RetailOrderEntry.sol` | Settlement operator gateway for sponsored account orders; order ids are single-use. |

## Build and test

```bash
pnpm contracts:build   # forge build --root contracts
pnpm contracts:test    # forge test --root contracts (31 tests)
```

ABIs for the evidence pack are committed under `contracts/abi/`; compiled artifacts stay
out of git (`contracts/out/`).

## Deployment and the G01 witness

`pnpm s15:run` deploys the five contracts to the controlled local OP Stack L2 (chain id
16584) from deterministic synthetic accounts, wires the roles, and executes G01 through
allocation plus the redemption case. Balances are read at one canonical block and compared
with the frozen fixture amounts. The run writes `evidence/s15/settlement-slice.json`;
`pnpm s15:verify` checks it offline.

`pnpm s16:run` adds the generated verifier and the eligibility registry: it builds
wallet-bound trees over the synthetic accounts, generates real EVM-target UltraHonk
proofs, caches approvals, exercises every enforcement point and the root-rotation recovery
on the same devnet. It writes `evidence/s16/eligibility-onchain.json` and
`evidence/s16/eligibility-fixtures.json`; `pnpm s16:verify` checks them offline.

`pnpm s17:run` deploys the pinned ERC-4337 v0.7 EntryPoint, the scoped sponsorship
paymaster and the order entry gateway, then submits sponsored user operations for the G01
spot fill on the same devnet, covering included revert, pre-submission budget/expiry
rejection and lost-response recovery. It writes `evidence/s17/sponsored-order.json`;
`pnpm s17:verify` checks it offline.

## Scope boundaries

- This slice proves the asset and money movements on the L2 execution layer. L1
  consensus finality, blob data availability and a deriving verifier are NET-01 (S19).
- Eligibility is enforced by the onchain UltraHonk verifier and the registry (S16); the
  class codes are still synthetic screening fixtures.
- The operation is not yet sponsored through ERC-4337; that is SET-03 (S17).
