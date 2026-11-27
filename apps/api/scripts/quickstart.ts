#!/usr/bin/env node
/**
 * Runnable partner quickstart.
 *
 * Starts the local API in-process, then places the two G01 investment orders
 * through the typed SDK over real HTTP: buy EUR 200 of test wrapped ETH and
 * subscribe EUR 300 to the fund, publish the authorized NAV and verify the
 * resulting portfolio against the golden fixture.
 *
 * Run with: pnpm demo:partner
 */
import {
  SettlementApiClient,
  createIdempotencyKey,
  type Order,
  type Portfolio,
} from "@eurorollup/sdk";
import { createApp } from "../src/app.js";
import { createApiConfig } from "../src/config.js";
import { createIdFactoryForDemo } from "./demo-ids.js";

const ACCOUNT_ID = "investor-ada";
const EXPECTED = {
  spendableCashBase: "499950000",
  reservedCashBase: "0",
  tWethBase: "100000000000000000",
  eFundBase: "3125000",
  markedValueBase: "999950000",
};

async function waitForOrder(
  client: SettlementApiClient,
  orderId: string,
  predicate: (order: Order) => boolean,
  timeoutMs = 5000,
): Promise<Order> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const order = await client.getOrder(orderId);
    if (predicate(order)) {
      return order;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Order ${orderId} did not reach the expected state in time`);
}

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(26)} ${value}`);
}

async function main(): Promise<void> {
  const config = createApiConfig({ dbFile: ":memory:", autoWorker: true, ids: createIdFactoryForDemo() });
  const ctx = await createApp({ config });
  await ctx.app.listen({ host: "127.0.0.1", port: 0 });
  const address = ctx.app.server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("The API did not expose a TCP address");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const partner = new SettlementApiClient({ baseUrl });
  const operator = new SettlementApiClient({ baseUrl });
  const issuer = new SettlementApiClient({ baseUrl, roleIdentity: "issuer-nav-signer" });

  try {
    const health = await partner.getHealth();
    console.log("EuroRollup partner quickstart");
    line("API", baseUrl);
    line("Fixture clock", health.clock);
    line("Calendar", health.calendarId);
    line("Event count", String(health.eventCount));
    console.log("");

    const spotQuote = await partner.createQuote({
      accountId: ACCOUNT_ID,
      assetId: "tWETH",
      side: "BUY",
      amountBase: "200000000",
    });
    console.log("1. Spot quote");
    line("quote id", spotQuote.quoteId);
    line("price", `${spotQuote.priceBase} base units per tWETH`);
    line("charge ceiling", `${spotQuote.chargeCeilingBase} base units`);

    const spotOrder = await partner.placeOrder(
      { quoteId: spotQuote.quoteId, accountId: ACCOUNT_ID },
      createIdempotencyKey(),
    );
    const filled = await waitForOrder(partner, spotOrder.orderId, (order) => order.businessState === "FILLED");
    console.log("2. Spot order");
    line("order id", filled.orderId);
    line("business state", filled.businessState);
    line("receipt units", filled.receipt?.unitsBase ?? "n/a");
    line("receipt charge", (filled.receipt as { investorChargeBase?: string } | null)?.investorChargeBase ?? "n/a");

    const fundQuote = await partner.createQuote({
      accountId: ACCOUNT_ID,
      assetId: "eFUND",
      side: "SUBSCRIBE",
      amountBase: "300000000",
    });
    console.log("3. Fund quote");
    line("quote id", fundQuote.quoteId);
    line("indicative NAV", `${fundQuote.indicativeNavBase ?? "n/a"} base units`);
    line("dealing date", fundQuote.dealingTerms?.assignedDealingDate ?? "n/a");
    line("cutoff", `${fundQuote.dealingTerms?.cutoffTimeUtc ?? "n/a"} UTC`);

    const fundOrder = await partner.placeOrder(
      { quoteId: fundQuote.quoteId, accountId: ACCOUNT_ID },
      createIdempotencyKey(),
    );
    const pending = await waitForOrder(partner, fundOrder.orderId, (order) => order.businessState === "AWAITING_NAV");
    console.log("4. Fund order accepted");
    line("order id", pending.orderId);
    line("business state", pending.businessState);

    const pendingPortfolio = await partner.getPortfolio(ACCOUNT_ID);
    line("pending reserved cash", pendingPortfolio.balances.dEUR.reservedBase);
    line("spendable cash", pendingPortfolio.balances.dEUR.availableBase);

    await operator.advanceClock("2026-11-20T17:01:00Z");
    const nav = await issuer.publishNav({
      assetId: "eFUND",
      valuationDate: "2026-11-20",
      navBase: "96000000",
      sourceTime: "2026-11-20T17:00:00Z",
      revision: 1,
    });
    console.log("5. Authorized NAV published");
    line("valuation date", nav.valuationDate);
    line("NAV", `${nav.navEurPerUnit} EUR per unit`);
    line("allocations queued", nav.queuedOrderIds.join(", "));

    const allocated = await waitForOrder(partner, fundOrder.orderId, (order) => order.businessState === "ALLOCATED");
    const finalPortfolio: Portfolio = await partner.getPortfolio(ACCOUNT_ID);
    console.log("6. Allocation and portfolio");
    line("order state", allocated.businessState);
    line("units issued", allocated.receipt?.unitsBase ?? "n/a");
    line("spendable cash", finalPortfolio.balances.dEUR.availableBase);
    line("reserved cash", finalPortfolio.balances.dEUR.reservedBase);
    line("tWETH", finalPortfolio.balances.tWETH.availableBase);
    line("eFUND", finalPortfolio.balances.eFUND.availableBase);
    line("marked value", finalPortfolio.markedValueBase);

    const checks: Array<[string, boolean]> = [
      ["spendable cash 499.95", finalPortfolio.balances.dEUR.availableBase === EXPECTED.spendableCashBase],
      ["reserved cash cleared", finalPortfolio.balances.dEUR.reservedBase === EXPECTED.reservedCashBase],
      ["0.100000 tWETH", finalPortfolio.balances.tWETH.availableBase === EXPECTED.tWethBase],
      ["3.125000 eFUND", finalPortfolio.balances.eFUND.availableBase === EXPECTED.eFundBase],
      ["marked value 999.95", finalPortfolio.markedValueBase === EXPECTED.markedValueBase],
    ];
    console.log("");
    let failed = false;
    for (const [label, pass] of checks) {
      console.log(`  ${pass ? "OK  " : "FAIL"} ${label}`);
      if (!pass) {
        failed = true;
      }
    }
    console.log("");
    console.log(
      failed
        ? "Quickstart finished with mismatches; the deterministic replay and the API disagree."
        : "Quickstart finished: the API reproduced the G01 golden portfolio.",
    );
    process.exitCode = failed ? 1 : 0;
  } finally {
    await ctx.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
