# Verification — step S05 (eligibility and account abstraction)

This page records the verification evidence for development step S05: the Noir
eligibility circuit, the three-persona policy matrix, the sponsored
UserOperations, browser proving and the managed-order eligibility gate. Results
are attached to the GitHub release `v0.5.0`.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm scenario:golden -- --check
pnpm scenario:boundary -- --check
pnpm scenario:api -- --check
pnpm api:openapi -- --check
pnpm policy:replay -- --check
pnpm policy:verify
pnpm policy:eval -- --adapter mock
pnpm policy:eval -- --verify-only
pnpm eligibility:matrix -- --check
pnpm eligibility:verify
pnpm aa:verify
pnpm verify
```

Toolchain-dependent regeneration commands (not required for CI):

```bash
noirup -v 1.0.0 && bbup -v 6.1.0
pnpm eligibility:fixtures
pnpm eligibility:artifacts
pnpm eligibility:proofs
ANVIL_BIN=~/.foundry/bin/anvil pnpm aa:scenario
```

## A03 — eligibility

| Artifact | Content |
| --- | --- |
| `packages/eligibility/artifacts/` | committed UltraHonk circuit, verification key, verifier metadata (circuit sha256, vk sha256, vk hash, Noir/bb versions, public inputs) |
| `evidence/a03/policy-matrix.json` | 19 decisions (8 allow, 4 hold, 7 decline) and 9 assertions, all passing |
| `evidence/a03/proof-vectors.json` | 3/3 positive proofs verified, 5/5 negative vectors rejected |
| `evidence/a03/browser-proving.json` | cold/warm browser proving and verification times |

Policy matrix assertions:

- the verified investor is allowed on every supported route;
- the basic investor is refused fund subscription before reserving cash (no cash
  reserved, no units minted) and refused share transfer;
- the flagged persona is declined on every managed route;
- stale screening, a review disposition, a missing proof and an expired
  credential all hold the movement with a reason;
- a root rotation between request and allocation holds the reserved cash, mints
  no units and exposes `POLICY_CHANGED` with refund and revalidation actions;
- a sponsorship limit is declined independently and leaves holdings untouched.

Proof vectors: three positive proofs against the epoch-1 root verify; negative
vectors cover the epoch-2 root, a flipped proof byte, a rotated-out persona, a
wrong gate binding and an expired credential. `pnpm eligibility:verify`
re-verifies every committed positive proof and checks the circuit and
verification-key hashes against the committed artifacts.

Browser measurement (headless Chromium, release build, recorded hardware): cold
proving 20,530 ms including backend initialisation, warm proving 3,334 ms and
3,285 ms, verification about 1.3 s. Warm proving is below the 5-second target.

## A04 — account abstraction

`evidence/a04/aa-receipts.json` records three observed sponsored UserOperations
against the pinned EntryPoint v0.7.0 on a local Anvil chain:

| Case | Kind | Result |
| --- | --- | --- |
| A04-C01 | sponsored success | status 1, `UserOperationEvent success=true`, sponsor pays `actualGasCost`, user charge 0 |
| A04-C02 | included failure | status 1, `UserOperationEvent success=false`, sponsor still pays, user charge 0 |
| A04-C03 | exhausted sponsor | status 0, no `UserOperationEvent`, `FailedOp(0, AA31 paymaster deposit too low)`, deposit unchanged |

The offline verifier `pnpm aa:verify` checks the receipts are internally
consistent: hash presence matches inclusion, the sponsor deposit moves exactly by
the negative actual gas cost for included operations, the user charge is zero,
permits expire and are signed by the recorded sponsor signer, and the pinned
artifact versions are recorded.

## API surface

New endpoints (25 documented paths in total):

- `GET /v1/eligibility/policy`
- `GET /v1/eligibility/accounts/{accountId}?epoch=`
- `POST /v1/eligibility/proofs`
- `POST /v1/eligibility/proofs/verify`
- `GET /v1/sponsorship/status`
- `GET /v1/account-abstraction/receipts`

Managed order acceptance now enforces the documented gate before any state is
written: a basic persona's fund subscription returns `422 ELIGIBILITY_REQUIRED`
with no cash reserved, a flagged persona's managed route returns
`403 SCREENING_DECLINED`, and verified investors are unaffected. The API tests
cover all three.

## Browser view

The "Eligibility &amp; sponsorship" view computes the policy matrix locally,
shows the two issuer roots and the circuit verification-key hash, proves
membership in the browser (lazy-loaded prover), demonstrates the root-rotation
hold and the independent sponsorship limit, and displays the committed A04
receipts. Screenshot: `docs/media/s05-eligibility.jpg`.

## Test inventory

181 tests, including 14 eligibility package tests (policy matrix, rotation,
receipt binding and committed evidence/proof verification) and 10 API tests for
eligibility endpoints, proof generation/verification, sponsorship, A04 receipts
and managed-order enforcement.

## Known limitations

- The demo witness is synthetic and shipped with the repository; it is loaded only
  for the in-browser demonstration and is discarded after proving.
- The API acceptance gate enforces screening disposition and issuer class;
  staleness, credential expiry and proof-epoch checks are evaluated by the
  eligibility policy matrix and endpoints, where the fixture clock and refresh
  times are coherent.
- The local chain is ephemeral and single-node; the pinned two-layer devnet,
  batch publication and bridge withdrawal arrive in S06.
- The warm proving samples are the S05 measurement; the full 30-sample
  distribution is part of the S07/S08 performance evidence.
