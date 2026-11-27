# Partner API

The local partner API exposes the same settlement journeys as the browser: place
spot and fund orders against typed quotes, read business and chain state, read
portfolio buckets with price provenance, and download reproducible evidence. The
AI Policy Lab scenario endpoints turn a typed rule change into a confirmed,
two-branch deterministic comparison.

The API is a local development service on a deterministic fixture clock. It uses
synthetic balances, prices and identities only.

## Run it

```bash
pnpm install
pnpm api        # http://127.0.0.1:3000
pnpm dev        # browser UI; switch to the "Local API lab" view
```

The OpenAPI 3.1 document is served at `/openapi.json` and committed at
[`docs/api/openapi.json`](openapi.json). Regenerate and check it with:

```bash
pnpm api:openapi
pnpm api:openapi -- --check
```

A runnable SDK example places the G01 orders over real HTTP and verifies the
portfolio:

```bash
pnpm demo:partner
```

## Conventions

- Amounts are integer base units serialized as decimal strings (`"300000000"`).
- Timestamps are strict UTC instants (`"2026-11-20T17:00:00Z"`).
- Business state and chain state are independent fields. In this local mode chain
  state is always `NOT_SUBMITTED`; the pinned rollup arrives in step S06.
- Errors use a stable shape:

```json
{
  "error": {
    "code": "INSUFFICIENT_CASH",
    "message": "Spendable cash does not cover the order",
    "details": { "requiredBase": "1200000000", "availableBase": "1000000000" }
  },
  "traceId": "req-1"
}
```

## Authority and roles

| Surface | Authority | Requirement |
| --- | --- | --- |
| Quotes, orders, portfolios | Investor/distributor session | Account must exist in the synthetic account list |
| `POST /v1/issuer/nav` | Issuer | `x-role-identity: issuer-nav-signer` header |
| Policy Lab scenario endpoints | Local scenario session | `x-session-id` header (defaults to `local-session`) |
| `/v1/dev/*` | Local operator | Only registered when dev endpoints are enabled (default for local use) |

## Endpoints

### `GET /v1/health`

Returns service metadata, fixture clock, calendar and policy identity, event count
and pending outbox count.

### `GET /v1/portfolios`

Lists synthetic accounts with persona and spendable cash.

### `POST /v1/quotes`

Creates a pre-acceptance quote. Nothing is reserved.

```json
{
  "accountId": "investor-ada",
  "assetId": "eFUND",
  "side": "SUBSCRIBE",
  "amountBase": "300000000"
}
```

Supported `assetId`/`side` pairs in release 1.0:

| Asset | Side | `amountBase` meaning |
| --- | --- | --- |
| `tWETH` | `BUY` | cash to spend (dEUR base units) |
| `tWETH` | `SELL` | tWETH units to sell (18 decimals) |
| `eFUND` | `SUBSCRIBE` | cash to reserve (dEUR base units) |
| `eFUND` | `REDEEM` | eFUND units to redeem (6 decimals) |

Spot quotes carry the fixture dealer price (2,000.00 EUR per tWETH), a price
as-of time, a 30-second lifetime and a EUR 0.05 charge ceiling. Fund quotes carry
an indicative NAV (100.00 EUR), the policy epoch and dealing terms: calendar,
cutoff, assigned dealing date and assignment reason.

A quote is refused with:

- `STALE_PRICE` (422) when the price source is older than 60 seconds at quote time;
- `PRICE_SOURCE_UNAVAILABLE` (503) with `Retry-After` when the dealer source is down;
- `ZERO_UNIT_FILL` (422) when the amount would issue or pay zero units;
- `INSUFFICIENT_INVENTORY` (422) for a sell/redeem without the holding.

### `POST /v1/orders`

Accepts an order against a quote. Requires an `Idempotency-Key` header.

Headers:

```text
Idempotency-Key: 9f0c...
Content-Type: application/json
```

Body:

```json
{ "quoteId": "quote_...", "accountId": "investor-ada" }
```

Returns `202` with `{ orderId, quoteId, accountId, kind, businessState, chainState, traceId }`.
Accepted orders settle asynchronously through the outbox worker.

- Same key and same body: returns the existing order.
- Same key and a different body: `409 IDEMPOTENCY_KEY_REUSED`.
- Expired quote: `422 QUOTE_EXPIRED`.
- Insufficient cash: `422 INSUFFICIENT_CASH` before acceptance.

### `GET /v1/orders/{orderId}`

Returns the business state, chain state, reason code, policy epoch, trace id,
dealing terms, receipt, money movements and decline details.

Business states used in this step:

| Kind | States |
| --- | --- |
| Spot order | `SUBMITTED` → `FILLED`, or `DECLINED` |
| Fund subscription | `RESERVED` → `AWAITING_NAV` → `ALLOCATED`, or `CANCELLED` / `DECLINED` |
| Fund redemption | `RESERVED` → `AWAITING_NAV` → `REDEEMED`, or `CANCELLED` / `DECLINED` |

`AWAITING_NAV` carries reason `NAV_MISSING` while cash stays reserved.

### `GET /v1/orders?accountId=...`

Lists orders for one synthetic account in acceptance order.

### `POST /v1/orders/{orderId}/cancel`

Cancels an eligible pending fund order before the cutoff of its assigned dealing
day and releases the reservation. After the cutoff the API returns
`422 CANCELLATION_NOT_ALLOWED` with the `allowedUntil` instant.

Body: `{ "accountId": "investor-ada" }`.

### `GET /v1/portfolios/{accountId}`

Returns per-asset buckets (`availableBase`, `reservedBase`), marked value, mark
provenance (source, as-of time, stale flag), excluded holdings and pending orders.
`blockHash` is `null` in fixture mode; the pinned rollup supplies it in step S06.

### `POST /v1/issuer/nav`

Publishes an authorized synthetic eFUND NAV observation and queues settlement for
every order assigned to that valuation date. Requires the issuer role header.

```json
{
  "assetId": "eFUND",
  "valuationDate": "2026-11-20",
  "navBase": "96000000",
  "sourceTime": "2026-11-20T17:00:00Z",
  "revision": 1
}
```

A revision must be newer than the stored one (`409 NAV_REVISION_NOT_NEWER`
otherwise), and the source time cannot be in the future relative to the fixture
clock.

## AI Policy Lab scenario endpoints

The deterministic Policy Lab flow: create a draft, review and edit it into a new
revision, confirm the visible diff, queue the two-branch comparison and download
the evidence pack. Scenario endpoints use the `x-session-id` header (defaults to
`local-session`) and restrict access to the owning session.

### `POST /v1/scenarios/drafts`

Creates revision 1. `mode` selects the proposal source:

- `recorded` — loads the bundled recorded proposal preset;
- `manual` — takes `manualFields` (`weekday`, `timeUtc`, `timezone`,
  optional `expectedTimeUtc`);
- `live` — drafts the proposal with the local model adapter from a required
  `question` (at most 500 characters). Malformed model output is retried once
  with schema feedback; a second failure, a 15-second attempt deadline or an
  unavailable runtime returns `503 MODEL_OUTPUT_INVALID`, `MODEL_TIMEOUT` or
  `MODEL_UNAVAILABLE` with `Retry-After`. A failed call never falls back to the
  recorded preset.

```json
{
  "fixtureId": "P01",
  "mode": "recorded"
}
```

Returns `201` with the draft: `scenarioId`, `revision`, `origin`, `status`
(`proposed`, `clarify`, `unsupported` or `no_change`), the typed `proposal`, the
structured `diff` (asset, order type, weekday, old/new UTC cutoff), `baseline`
policy version/hash, `fixture` digest, `draftDigest` and `confirmationDigest`.

A stated prior time that disagrees with the baseline is rejected with `422
PRIOR_TIME_MISMATCH`. A proposal equal to the current rule returns `no_change`.

### `PATCH /v1/scenarios/{scenarioId}/draft`

Accepts an edit or clarification answer with `expectedRevision`. A new revision
and confirmation digest are issued; the previous revision is recorded as the
parent. Stale revisions return `409 STALE_REVISION`, unknown fields `422
INVALID_REQUEST`, and other sessions `403 SESSION_MISMATCH`.

### `POST /v1/scenarios/{scenarioId}/runs`

Requires `revision`, `confirmationDigest` and an `Idempotency-Key` header.
Returns `202` with `{ runId, status: "queued" }`. Same-key/same-body retries
return the existing run; a changed body returns `409 IDEMPOTENCY_KEY_REUSED`. A
revision or digest that is no longer current returns `409`, and a draft that is
not `proposed` cannot run (`422 INVALID_SCENARIO_STATE`).

### `GET /v1/scenario-runs/{runId}`

Returns `queued`, `running`, `succeeded` or `failed`. On success it includes the
two branches, per-order changes, deltas, policy hashes and the comparison digest.
A failed run has no published partial result.

### `GET /v1/model/status`

Reports the local model adapter status: provider, pinned model identifier,
content digest, prompt version and availability. The adapter has one capability
(drafting a typed scenario) and no access to signing keys, shell tools, chain RPC
methods or portfolio writes.

### `GET /v1/scenario-runs/{runId}/evidence`

Downloads the versioned P01 comparison pack (`application/json` attachment) with
the branch hashes, boundary replay cases and the pack digest. Available only for
a succeeded run.

## Local fixture controls

Registered only when dev endpoints are enabled:

| Endpoint | Purpose |
| --- | --- |
| `GET /v1/dev/clock` | Read the fixture clock |
| `POST /v1/dev/clock` | Advance the clock forward (`{ "to": "..." }`) |
| `POST /v1/dev/price-source` | Simulate a stale (`staleSeconds`) or unavailable dealer price source |
| `POST /v1/dev/tick` | Process pending outbox tasks synchronously |
| `POST /v1/dev/reset` | Reset the demo to deterministic genesis |

## Error status contract

| Status | Use |
| --- | --- |
| `400` | Malformed request, invalid amount or timestamp |
| `403` | Missing or wrong authority identity |
| `404` | Unknown account, quote, order or route |
| `409` | Idempotency conflict, stale state transition, NAV revision conflict |
| `422` | Business refusal (stale price, insufficient cash/inventory, cancellation window closed) |
| `503` | Dependency unavailable before acceptance, with `Retry-After` |

## Determinism and evidence

- The API replays the durable event log on startup; the journal, order projection
  and outbox are projections over that log.
- A fixture clock supplies every observation time; no wall-clock value affects a
  result.
- `pnpm scenario:api` produces `evidence/a02/api-dealing-cases.json` (19 cases)
  and `evidence/a06/invariants.json` (6 cases) with canonical business digests.
- `pnpm scenario:api -- --check` must reproduce the committed bytes.
- `pnpm demo:partner` verifies the G01 golden portfolio through the SDK over HTTP.

## Known limitations in this step

- No chain reader yet: `chainState` is a business-side placeholder and
  `blockHash` is `null`.
- Eligibility personas are stored but not enforced until step S05.
- The live model adapter requires a local Ollama runtime with the pinned model
  pulled; when it is unavailable the recorded preset and manual editor remain
  usable.
