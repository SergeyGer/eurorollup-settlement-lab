# Partner SDK

Typed, dependency-free TypeScript client for the EuroRollup partner API.

```ts
import { SettlementApiClient, createIdempotencyKey } from "@eurorollup/sdk";

const client = new SettlementApiClient({ baseUrl: "http://127.0.0.1:3000" });

const quote = await client.createQuote({
  accountId: "investor-ada",
  assetId: "eFUND",
  side: "SUBSCRIBE",
  amountBase: "300000000",
});

const order = await client.placeOrder(
  { quoteId: quote.quoteId, accountId: "investor-ada" },
  createIdempotencyKey(),
);

const portfolio = await client.getPortfolio("investor-ada");
```

## What it covers

- `getHealth`, `getClock`
- `createQuote`, `placeOrder`, `getOrder`, `listOrders`, `cancelOrder`
- `getPortfolio`, `listPortfolios`
- `publishNav` with a role identity for the issuer surface
- dev-only `advanceClock`, `resetDemo` and `getOpenApi`

Amounts are integer base units serialized as decimal strings; timestamps are
strict UTC instants. Transaction errors are thrown as `PartnerApiError` with the
HTTP status, stable `code`, `details` and `retryAfterSeconds` when present.

## Runnable example

`pnpm demo:partner` (in the repository root) starts the local API, places the
G01 orders through this client over HTTP, publishes the NAV and verifies the
golden portfolio.

## Contract

The types mirror the OpenAPI 3.1 document served at `/openapi.json` and
documented in [`docs/api/partner-api.md`](../../docs/api/partner-api.md).
