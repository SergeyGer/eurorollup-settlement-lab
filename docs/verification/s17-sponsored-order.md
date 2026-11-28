# S17 verification: sponsored actual order (SET-03)

This record verifies SET-03: an expiring, target- and method-scoped sponsorship permit
travels through a real ERC-4337 v0.7 bundle on the pinned EntryPoint, pays for the G01
spot fill from the sponsor deposit, and the user account never pays gas. It also records
an included inner revert, pre-submission budget/expiry rejections, and the recovery of an
already-mined user operation after a lost response.

## Components

| Component | Role |
| --- | --- |
| EntryPoint v0.7 (`@account-abstraction/contracts@0.7.0`) | pinned bundler entry point; artifact digest recorded in the evidence |
| SimpleAccountFactory + SimpleAccount proxy | counterfactual user account owned by the synthetic investor EOA, funded only with dEUR |
| `ScopedSponsorshipPaymaster` | verifies the sponsor-signed permit (account, exact target, method selector, chain id, nonce, expiry, max cost), marks it single-use, and lets the EntryPoint charge the sponsor deposit |
| `RetailOrderEntry` | the only settlement operator for the sponsored path; marks each order id settled so a retried request cannot settle twice |
| S15 settlement contracts | dEUR/tWETH escrow and atomic DvP behind the order entry |

## Permits and bundles

The permit digest binds `chainId, paymaster, EntryPoint, account, target, selector,
permitNonce, validUntil, maxCost` and is signed by the sponsor. The permit for the
actual order is scoped to the **order entry** contract and the **submitSpotOrder**
selector; the approval setup permit is scoped to the dEUR contract and the `approve`
selector. Each permit is consumed once; replay is rejected with `PermitAlreadyUsed`.

`pnpm s17:run` submits four bundles and two pre-submission rejections:

| Case | Result |
| --- | --- |
| `sponsored-approval` | success; sponsor pays 305,363,196,155,296 wei; user charge 0 |
| `sponsored-fill` (G01 spot) | success; sponsor pays 401,558,315,471,170 wei; user charge 0 |
| `included-revert` (expired quote) | included with `success=false`, sponsor still pays 264,797,624,225,511 wei, no balances move |
| `budget-rejection` (permit cap below max cost) | rejected during bundler simulation (`AA33` paymaster revert), never submitted |
| `permit-expiry-rejection` (expired permit) | rejected during bundler simulation (`AA33`), never submitted |
| `replay-blocked` (same order id) | included with `success=false`; order stays settled once, balances unchanged |

For every submitted bundle the user account native delta is **0**, the paymaster deposit
delta equals **−actualGasCost**, and the beneficiary delta equals **+actualGasCost**.

## Economic witness

After the sponsored fill: account dEUR 799.95, account tWETH 0.1, account native 0;
dealer dEUR 200 / 0.9 tWETH; fee account dEUR 0.05. The included revert and the replay
attempt leave those balances unchanged.

## Lost-response recovery

The success bundle's `UserOperationEvent` is looked up by `userOpHash` from the EntryPoint
logs. The recovered transaction hash equals the original, the receipt is successful, the
order is settled exactly once, and the balances match the recorded economic effect. A
repeated request for the same order is included as a failed operation and moves no money
(order entry idempotency), so re-sending after a lost response cannot double settle.

Evidence: `evidence/s17/sponsored-order.json`, ABIs for the new contracts under
`contracts/abi/`. Offline verification: `pnpm s17:verify` (also in CI and the release-check
matrix); contract-level tests: `pnpm contracts:test` (27 tests, 10 of them for
sponsorship).

## Reproduce

```bash
pnpm contracts:build
pnpm devnet:up
pnpm s17:run
pnpm s17:verify
pnpm devnet:down
```

## Recorded limitations

- Sponsor, bundler and beneficiary are synthetic lab wallets on the controlled local L2;
  no external bundler network is involved.
- EntryPoint v0.7 does not account for the OP Stack L1 data fee in its gas charge; L1 fee
  accounting belongs to NET-01/OPS-02 on the OP lane.
- The permit scheme is a local domain-separated EIP-191 digest, not a production
  paymaster policy engine; broader authority policy is S21.
- One target/method pair per permit; batch sponsorship is out of scope for this step.
