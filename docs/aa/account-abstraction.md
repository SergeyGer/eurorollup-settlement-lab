# Account abstraction and sponsorship

The A04 evidence demonstrates three real sponsored UserOperations against the
pinned ERC-4337 EntryPoint v0.7.0 on a local Anvil chain. The scenario is
reproducible from the pinned npm artifacts without compiling Solidity.

## Contracts

- `@account-abstraction/contracts@0.7.0` `EntryPoint` — the pinned EntryPoint.
- `SimpleAccountFactory` and `SimpleAccount` — the smart account and its factory.
- `VerifyingPaymaster` — the sponsor. The off-chain sponsor signs a permit over the
  normalised UserOperation hash, the paymaster address, the chain id and the
  validity window; the paymaster holds its native deposit at the EntryPoint.

## Permit

The scenario builds a `PackedUserOperation` with the account signature over the
EntryPoint `userOpHash` and a paymaster permit over
`VerifyingPaymaster.getHash(userOp, validUntil, validAfter)` signed by the
sponsor signer. The permit is expiring (`validUntil` = block timestamp + 1 hour)
and covers sender, nonce, target call data, gas limits, fees, chain and
paymaster. The paymaster validation reverts when the EntryPoint deposit is below
the required prefund, which is the exhausted-sponsor case.

## Observed cases

`pnpm aa:scenario` starts Anvil, deploys the contracts, funds the sponsor deposit,
then records `evidence/a04/aa-receipts.json`:

| Case | Kind | Observation |
| --- | --- | --- |
| A04-C01 | sponsored success | `UserOperationEvent success=true`, sponsor deposit decreases by exactly `actualGasCost`, user charge 0 |
| A04-C02 | included failure | inner call reverts, `UserOperationEvent success=false`, sponsor still pays `actualGasCost`, user charge 0 |
| A04-C03 | exhausted sponsor | bundle transaction status 0, no `UserOperationEvent`, `FailedOp(0, AA31 paymaster deposit too low)`, deposit delta 0 |

The script also records the userOp hash, outer transaction hash, inclusion block,
gas used, permit validity window and the verifying signer for every case.

## Offline verification

CI cannot start a chain, so `pnpm aa:verify` verifies the committed receipts:

- three observed cases with the expected dispositions;
- hash presence matches inclusion (success and included failure emit an event, the
  exhausted sponsor does not);
- the sponsor deposit delta equals the negative actual gas cost for included
  operations and is zero for the exhausted sponsor;
- the user charge is zero for every sponsored operation;
- permits expire and are signed by the recorded sponsor signer;
- contract addresses are valid and the pinned artifact versions are recorded.

## Reproduce locally

```bash
# Foundry provides anvil; the ERC-4337 artifacts come from the pinned npm package.
pnpm aa:scenario
pnpm aa:verify
```

The local chain is ephemeral: addresses and receipts come from the deterministic
Anvil mnemonic and deployment nonce order, so a local re-run reproduces the same
contract addresses and the same pass/fail dispositions (gas costs and block
timestamps depend on the local machine).

## Gas economics

The scenario records `actualGasCost` in wei for both included cases. Gas is paid
from the sponsor deposit held at the EntryPoint; the user account balance is
unchanged, which is what "sponsored" means in the release. The measured
economics of the euro charge versus the native cost are part of the S07 evidence.
