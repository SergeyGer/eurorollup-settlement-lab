# Settlement slice contracts

Synthetic Solidity contracts for the SET-01 vertical slice. They are deliberately small,
lab-grade contracts: they are **not** audited production protocol code.

| Contract | Purpose |
| --- | --- |
| `Token.sol` | Minimal integer ERC-20 used for dEUR (6 decimals) and tWETH (18 decimals); owner mint/burn. |
| `RestrictedShare.sol` | eFUND (6 decimals) restricted fund-share instrument: transfers only between eligible holders; issuer controls eligibility and the minters (the DvP settlement contract). |
| `Escrow.sol` | Reserved dEUR for pending subscriptions; the settlement contract is the only operator and can only release to the issuer treasury. |
| `DvPSettlement.sol` | Atomic one-step settlement calls: spot delivery-versus-payment, escrow-funded allocation, and redemption (burn shares, pay cash). |

## Build and test

```bash
pnpm contracts:build   # forge build --root contracts
pnpm contracts:test    # forge test --root contracts (7 tests)
```

ABIs for the evidence pack are committed under `contracts/abi/`; compiled artifacts stay
out of git (`contracts/out/`).

## Deployment and the G01 witness

`pnpm s15:run` deploys the five contracts to the controlled local OP Stack L2 (chain id
16584) from deterministic synthetic accounts, wires the roles, and executes G01 through
allocation plus the redemption case. Balances are read at one canonical block and compared
with the frozen fixture amounts. The run writes `evidence/s15/settlement-slice.json`;
`pnpm s15:verify` checks it offline.

## Scope boundaries

- This slice proves the asset and money movements on the L2 execution layer. L1
  consensus finality, blob data availability and a deriving verifier are NET-01 (S19).
- Eligibility is a simple allowlist here; the onchain Noir proof with expiry and root
  rotation is SET-02 (S16).
- The operation is not yet sponsored through ERC-4337; that is SET-03 (S17).
