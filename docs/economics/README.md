# Economics and operations

This section covers the A07 evidence for the economics of the settlement lane and
the operating drills around it.

## Measured bundle reconciliation

`pnpm a07:economics` starts a local Anvil chain, deploys the pinned ERC-4337
EntryPoint v0.7.0, the SimpleAccount factory and the VerifyingPaymaster sample, and
submits **one real `handleOps` transaction containing two sponsored
UserOperations**: one successful call and one included failure. The measured
inputs are:

- the outer transaction receipt: status, gas used, effective gas price, block hash
  and block timestamp;
- one `UserOperationEvent` per operation: success flag, actual gas used, actual
  gas cost and user charge;
- the paymaster native deposit movement and the beneficiary (bundler) balance
  movement, read at explicit block tags so the deltas are deterministic;
- the explicit investor charge leg (0.05 dEUR from the spot-fill fixture);
- a timestamped demo EUR/ETH conversion fixture stamped at the measurement block
  time.

Unavailable values are not guessed: the plain local chain does not expose an
OP-stack L1 data fee or operator fee, so both are recorded as `null` and listed as
unavailable. The evidence file is `evidence/a07/bundle-reconciliation.json` and
`pnpm a07:verify` re-checks every invariant offline.

### Allocation rule

The measured bundle total is the sponsor payment (the paymaster deposit decrease).
It is allocated by measured per-operation gas with floor division:

- successful operations keep their own allocation;
- failed or unattributable operations keep a separate bucket;
- the remainder is an explicit residual bucket.

Allocations plus residual reproduce the bundle total in wei exactly. Reconciliation
differences (known network cost versus sponsor payment, sponsor payment versus
bundler revenue) are recorded as named items instead of being hidden in the total.

## Interactive cost experiment

`benchmarks/cost-experiment.json` contains the observed run and five scenarios:

| Scenario | What changes |
| --- | --- |
| `observed-default` | Measured execution gas and gas price, synthetic DA price and batch utilization |
| `cheap-da` | DA price halved |
| `low-utilization` | Batch utilization drops to 30% |
| `lower-investor-fee` | Investor charge halves to 0.025 EUR |
| `higher-volume` | Daily order count doubles |

Each scenario reports the sponsor cost per order, the sponsor contribution per
successful order, the daily sponsorship need, the remaining budget, the first
daily order count that exhausts the budget and the break-even investor charge.
Missing inputs produce `null` results plus an `unavailable` entry; they are never
replaced by zero.

The deterministic model lives in `packages/economics` and is covered by unit
tests. The explicit inputs are frozen in `fixtures/economics/`; the execution gas
and gas price in the default scenario are measured, while DA price, utilization,
order volume and budget are scenario inputs and are labelled as such in the
evidence.

## Funding guard

`packages/economics` also implements the permit rule order: a rate older than 60
seconds, a per-operation cap breach, a daily budget breach (including outstanding
reservations) and a native deposit below its configured reserve all block new
permits. Rejections preserve outstanding reservations and keep the fund escrow
visible while sponsorship is paused.

## Commands

```bash
pnpm a07:economics   # measure the bundle and regenerate the economics evidence
pnpm a07:verify      # offline verification (also run in CI)
```

## Recorded limitations

- The local Anvil chain has no L1 data fee or operator fee; both are recorded as
  unavailable in the measured reconciliation rather than modeled as measured data.
- The EUR/ETH conversion is a frozen demo fixture stamped at measurement time, not
  a live market rate.
- The operations drills, dashboard, provider evaluation and incident report are
  the remaining S07 work and get their own evidence under `benchmarks/` and
  `docs/operations/`.
