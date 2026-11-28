# S18 verification: settlement pack export (SET-04)

This record verifies SET-04: an SDK G01 order is settled by the local partner API, its
receipt is opened in the browser replay, the settlement pack is downloaded from the UI and
independently followed to the contract logs. A tampered copy makes the verifier exit
non-zero with the first mismatch.

## Endpoint

`GET /v1/runs/{runId}/evidence` — an investment run is the settlement trace of one accepted
order, so `runId == orderId`. The endpoint returns a versioned `SETTLEMENT-PACK` document
with `content-disposition` for download. It sits beside the existing
`GET /v1/scenario-runs/{runId}/evidence` Policy Lab export.

## Pack contents

- **order** — ids, account, kind, amount, business state, API chain-state field, policy
  epoch and dealing terms.
- **business** — receipt, decline, reason code, journal entries (money movements with
  timestamps), the investor portfolio view and journal balances aggregated per
  account/asset.
- **costs** — time-stamped dealer price, charge ceiling, indicative and authorized NAV
  inputs with their source and policy version.
- **chain** — observed chain status, kept separate from business state: onchain order-id
  projection, user operation hash, transaction hash, log index, L2 transaction block hash
  and number, canonical observation block hash and number, L1 batch reference, policy hash,
  receipt status, contract addresses and per-role/asset balances.
- **manifest** — canonical SHA-256 digests of every section plus a pack digest and the
  external chain-witness digest.

Unknown values are `null` with a reason in `chain.unknowns` / `unknowns`. The chain witness
is attached by the settlement runner as an independent artifact (`CHAIN_WITNESS_PATH`);
the API joins it by order id and exposes its digest. The API does not run a chain reader
yet — that arrives with NET-01.

## Acceptance witness

`pnpm s18:run` boots the API with a fresh database and a chain-witness path, then:

1. Submits the SDK G01 order (`investor-ada`, BUY 200 dEUR of tWETH) and waits for
   `FILLED` with receipt: 0.100000 tWETH, 200 dEUR deployed, EUR 0.05 charge.
2. Produces the chain witness with a real `executeSpot` transaction on the controlled L2
   whose onchain order id is `keccak256(orderId)`; records the `SpotSettled` log index,
   L2 block hash, canonical block hash and investor/dealer/fee/issuer/escrow balances at
   the canonical block.
3. Downloads the pack through the **browser receipt** in the live replay (screenshot
   `docs/media/s18-receipt-download.png`); the downloaded bytes equal the API response.
4. Verifies the pack offline and with chain follow (`verify-settlement-pack --rpc`): the
   transaction receipt, log index, event and L2 block hash match, and the token balances
   at the canonical block match the pack.
5. Matches the chain observations with the business state at the same canonical block:
   investor EUR 799.95 and 0.1 tWETH, dealer movement EUR 200, fee EUR 0.05, issuer and
   escrow EUR 0.
6. Changes one receipt amount in a test copy: the verifier exits **1** with
   `MISMATCH: manifest-section-business …`.

Evidence: `evidence/s18/settlement-pack-run.json` (pack, witness, verification runs,
tamper result, balances, UI download identity). Offline verification:
`pnpm s18:verify` (also in CI and the release-check matrix). Pack verifier:
`pnpm exec tsx scripts/verify-settlement-pack.ts --pack <pack.json> [--rpc <url>]`.

## Reproduce

```bash
pnpm contracts:build
pnpm devnet:up
pnpm s18:run
pnpm s18:verify
pnpm devnet:down
```

## Recorded limitations

- The chain witness is an operator-produced artifact joined by order id; the API has no
  chain reader until NET-01.
- The witness uses the operator settlement lane, so `userOpHash` is null with a reason; the
  sponsored ERC-4337 lane is recorded in S17.
- The calldata development lane has no L1 batch reference for a single transaction, so that
  field is null with a reason.
- Issuer treasury and escrow start at zero on this lane, so their movements and balances
  coincide; the comparison is stated per account.
