# S15 verification: contract-backed settlement vertical slice (SET-01)

This record verifies SET-01: the asset, escrow and atomic delivery-versus-payment
contracts deployed on the private L2, and one G01 order traced from the seed through
allocation plus the independent redemption case.

## Contracts

| Contract | Asset / role |
| --- | --- |
| `Token` | dEUR 6 decimals and tWETH 18 decimals, integer base units, owner mint/burn |
| `RestrictedShare` | eFUND 6 decimals; transfers only between eligible holders; issuer-controlled minters |
| `Escrow` | reserved dEUR for pending subscriptions; settlement contract is the only operator |
| `DvPSettlement` | atomic spot DvP, escrow-funded allocation and redemption |

Seven Foundry tests cover the spot fill, allocation, full lifecycle, restricted transfers,
escrow operator gating, expired quotes and atomic failure rollback (`pnpm contracts:test`).

## G01 on the controlled L2

`pnpm s15:run` deploys five contracts to the controlled local OP Stack L2 (chain id 16584,
L1 anchor 11155111) from deterministic synthetic accounts and executes:

| Stage | Business step | Expected → observed |
| --- | --- | --- |
| seed | dEUR 1,000 to the investor, EUR 500 to the issuer treasury, 1 tWETH to the dealer | exact |
| spot | `executeSpot(G01-SPOT-01)`: EUR 200 + EUR 0.05 fee, 0.1 tWETH delivered | investor €799.95, 0.1 tWETH; fee €0.05 |
| reserved | `reserveFund(G01-FUND-01)`: EUR 300 held in escrow | investor €499.95; escrow €300 |
| allocated | `allocateFund(G01-FUND-01)`: escrow → issuer, 3.125000 eFUND minted | investor €499.95; escrow €0; units 3.125000 |
| redeemed | `redeemFund(G01-RED-01)`: 1.000000 eFUND burned, EUR 98 paid | investor €597.95, 2.125000 eFUND |

Balances are read at one canonical L2 block for the investor, dealer, fee recipient,
issuer treasury, escrow and eFUND total supply. The evidence records the deployment
transactions, code hashes, ABI digests, chain ids, every settlement transaction and the
canonical block hash/number.

Evidence: `evidence/s15/settlement-slice.json`, ABIs under `contracts/abi/`.
Offline verification: `pnpm s15:verify` (also in the release-check matrix and CI).

## Reproduce

```bash
pnpm contracts:build
pnpm devnet:up          # controlled local OP Stack devnet (chain id 16584)
pnpm s15:run
pnpm s15:verify
pnpm devnet:down
```

## Recorded limitations

- This is the L2 execution slice: L1 consensus finality, blob DA and a separate deriving
  verifier are NET-01 (S19).
- Eligibility is an issuer allowlist here; the onchain Noir proof with expiry and root
  rotation is SET-02 (S16).
- The order is not yet sponsored through ERC-4337; SET-03 (S17) adds it.
- The contracts are synthetic lab contracts, not audited production protocol code.
