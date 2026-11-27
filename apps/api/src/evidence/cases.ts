/**
 * API-level acceptance cases for gates A02 (NAV and dealing) and A06
 * (accounting and replay invariants).
 *
 * Every case builds a fresh in-memory app with a deterministic id factory,
 * advances the fixture clock explicitly and drives the outbox worker by hand, so
 * the produced evidence is byte-reproducible.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJson,
  findImbalances,
  type SettlementEvent,
} from "@eurorollup/dealing";
import type {
  FundReceipt,
  NavPublicationResult,
  Order,
  Portfolio,
  Quote,
  RedemptionReceipt,
  SpotReceipt,
} from "@eurorollup/sdk";
import { countEvents, readEvents } from "../db.js";
import { createHarness, errorCode, type Harness, type HarnessOptions } from "./harness.js";
import { CaseRecorder, type CaseResult } from "./types.js";

const ACCOUNT = "investor-ada";

function quote(result: { status: number; body: unknown }): Quote {
  return result.body as Quote;
}
function order(result: { status: number; body: unknown }): Order {
  return result.body as Order;
}
function portfolio(result: { status: number; body: unknown }): Portfolio {
  return result.body as Portfolio;
}

async function withCase(
  caseId: string,
  title: string,
  fn: (recorder: CaseRecorder, harness: Harness) => Promise<void>,
  options: HarnessOptions = {},
): Promise<CaseResult> {
  const harness = await createHarness(options);
  const recorder = new CaseRecorder(caseId, title);
  try {
    await fn(recorder, harness);
  } catch (error) {
    recorder.check(
      "case completes without unexpected exception",
      error instanceof Error ? error.message : String(error),
      "no exception",
    );
  } finally {
    await harness.close();
  }
  return recorder.finish();
}

/** Spot buy of 200.00 dEUR and a fund subscription of 300.00 dEUR, settled at NAV 96. */
async function settleG01(recorder: CaseRecorder, harness: Harness): Promise<Order> {
  const spotQuote = recorder.http(
    "create spot buy quote",
    "POST",
    "/v1/quotes",
    await harness.createQuote({ accountId: ACCOUNT, assetId: "tWETH", side: "BUY", amountBase: "200000000" }),
  );
  recorder.check("spot quote status", spotQuote.status, 200);
  const spotOrder = recorder.http(
    "place spot buy order",
    "POST",
    "/v1/orders",
    await harness.placeOrder(quote(spotQuote).quoteId, ACCOUNT, "idem-spot-1"),
  );
  recorder.check("spot order accepted", spotOrder.status, 202);
  harness.tick();

  const fundQuote = recorder.http(
    "create fund subscription quote",
    "POST",
    "/v1/quotes",
    await harness.createQuote({ accountId: ACCOUNT, assetId: "eFUND", side: "SUBSCRIBE", amountBase: "300000000" }),
  );
  recorder.check("fund quote status", fundQuote.status, 200);
  const fundOrder = recorder.http(
    "place fund subscription order",
    "POST",
    "/v1/orders",
    await harness.placeOrder(quote(fundQuote).quoteId, ACCOUNT, "idem-fund-1"),
  );
  recorder.check("fund order accepted", fundOrder.status, 202);
  harness.tick();

  recorder.http(
    "advance fixture clock after the valuation",
    "POST",
    "/v1/dev/clock",
    await harness.advanceClock("2026-11-20T17:01:00Z"),
  );
  const nav = recorder.http(
    "publish authorized NAV 96.00",
    "POST",
    "/v1/issuer/nav",
    await harness.publishNav({
      valuationDate: "2026-11-20",
      navBase: "96000000",
      sourceTime: "2026-11-20T17:00:00Z",
    }),
  );
  recorder.check("nav publication status", nav.status, 201);
  harness.tick();
  const settled = recorder.http(
    "read settled fund order",
    "GET",
    `/v1/orders/${order(fundOrder).orderId}`,
    await harness.getOrder(order(fundOrder).orderId),
  );
  return order(settled);
}

export async function runApiDealingCases(): Promise<CaseResult[]> {
  const results: CaseResult[] = [];

  results.push(
    await withCase("A02-API-QUOTE-VALIDATION", "Quote validation and documented error codes", async (recorder, harness) => {
      const unsupported = recorder.http(
        "unsupported asset/side combination",
        "POST",
        "/v1/quotes",
        await harness.createQuote({ accountId: ACCOUNT, assetId: "tWETH", side: "SUBSCRIBE", amountBase: "100000000" }),
      );
      recorder.check("unsupported status", unsupported.status, 422);
      recorder.check("unsupported code", errorCode(unsupported), "UNSUPPORTED_ORDER");

      const zero = recorder.http(
        "zero amount",
        "POST",
        "/v1/quotes",
        await harness.createQuote({ accountId: ACCOUNT, assetId: "tWETH", side: "BUY", amountBase: "0" }),
      );
      recorder.check("zero amount status", zero.status, 400);
      recorder.check("zero amount code", errorCode(zero), "INVALID_AMOUNT");

      const unknownAccount = recorder.http(
        "unknown account",
        "POST",
        "/v1/quotes",
        await harness.createQuote({ accountId: "investor-nobody", assetId: "tWETH", side: "BUY", amountBase: "100000000" }),
      );
      recorder.check("unknown account status", unknownAccount.status, 404);
      recorder.check("unknown account code", errorCode(unknownAccount), "ACCOUNT_NOT_FOUND");

      const malformed = await harness.inject("POST", "/v1/quotes", {
        payload: { accountId: ACCOUNT, assetId: "tWETH", side: "BUY" },
      });
      recorder.check("malformed body status", malformed.status, 400);
      recorder.check("malformed body code", errorCode(malformed), "INVALID_REQUEST");
    }),
  );

  results.push(
    await withCase("A02-API-CUTOFF-BEFORE", "Request one second before the cutoff stays on the same dealing day", async (recorder, harness) => {
      await harness.advanceClock("2026-11-20T15:59:59Z");
      const created = recorder.http(
        "create subscription quote at 15:59:59",
        "POST",
        "/v1/quotes",
        await harness.createQuote({ accountId: ACCOUNT, assetId: "eFUND", side: "SUBSCRIBE", amountBase: "300000000" }),
      );
      recorder.check("quote status", created.status, 200);
      recorder.check("indicative dealing date", quote(created).dealingTerms?.assignedDealingDate, "2026-11-20");
      recorder.check("assignment reason", quote(created).dealingTerms?.assignmentReason, "BEFORE_CUTOFF_SAME_DAY");
      const placed = recorder.http(
        "place order",
        "POST",
        "/v1/orders",
        await harness.placeOrder(quote(created).quoteId, ACCOUNT, "idem-cutoff-before"),
      );
      recorder.check("order accepted", placed.status, 202);
      harness.tick();
      const detail = order(recorder.http("read order", "GET", `/v1/orders/${order(placed).orderId}`, await harness.getOrder(order(placed).orderId)));
      recorder.check("order state", detail.businessState, "AWAITING_NAV");
      recorder.check("accepted dealing date", detail.dealingTerms?.assignedDealingDate, "2026-11-20");
      recorder.check("pending reason", detail.reasonCode, "NAV_MISSING");
    }),
  );

  results.push(
    await withCase("A02-API-CUTOFF-EXACT", "Request exactly at the cutoff advances to the next dealing day", async (recorder, harness) => {
      await harness.advanceClock("2026-11-20T16:00:00Z");
      const created = recorder.http(
        "create subscription quote at 16:00:00",
        "POST",
        "/v1/quotes",
        await harness.createQuote({ accountId: ACCOUNT, assetId: "eFUND", side: "SUBSCRIBE", amountBase: "300000000" }),
      );
      recorder.check("quote status", created.status, 200);
      recorder.check("indicative dealing date", quote(created).dealingTerms?.assignedDealingDate, "2026-11-23");
      recorder.check("assignment reason", quote(created).dealingTerms?.assignmentReason, "AT_OR_AFTER_CUTOFF");
      const placed = recorder.http("place order", "POST", "/v1/orders", await harness.placeOrder(quote(created).quoteId, ACCOUNT, "idem-cutoff-exact"));
      recorder.check("order accepted", placed.status, 202);
      harness.tick();
      const detail = order(recorder.http("read order", "GET", `/v1/orders/${order(placed).orderId}`, await harness.getOrder(order(placed).orderId)));
      recorder.check("accepted dealing date", detail.dealingTerms?.assignedDealingDate, "2026-11-23");
    }),
  );

  results.push(
    await withCase("A02-API-WEEKEND", "Weekend request advances to the next dealing day", async (recorder, harness) => {
      await harness.advanceClock("2026-11-21T12:00:00Z");
      const created = recorder.http(
        "create Saturday subscription quote",
        "POST",
        "/v1/quotes",
        await harness.createQuote({ accountId: ACCOUNT, assetId: "eFUND", side: "SUBSCRIBE", amountBase: "300000000" }),
      );
      recorder.check("dealing date", quote(created).dealingTerms?.assignedDealingDate, "2026-11-23");
      recorder.check("assignment reason", quote(created).dealingTerms?.assignmentReason, "NON_DEALING_DAY");
    }),
  );

  results.push(
    await withCase(
      "A02-API-HOLIDAY",
      "Closed Monday in the alternate calendar advances to Tuesday",
      async (recorder, harness) => {
        await harness.advanceClock("2026-11-23T10:00:00Z");
        const created = recorder.http(
          "create subscription quote on closed Monday",
          "POST",
          "/v1/quotes",
          await harness.createQuote({ accountId: ACCOUNT, assetId: "eFUND", side: "SUBSCRIBE", amountBase: "300000000" }),
        );
        recorder.check("dealing date", quote(created).dealingTerms?.assignedDealingDate, "2026-11-24");
        recorder.check("assignment reason", quote(created).dealingTerms?.assignmentReason, "NON_DEALING_DAY");
        recorder.check("calendar id", quote(created).dealingTerms?.calendarId, "LAB-UTC-2");
      },
      { calendarId: "LAB-UTC-2" },
    ),
  );

  results.push(
    await withCase("A02-API-QUOTE-EXPIRY", "Expired quote is refused before acceptance", async (recorder, harness) => {
      const created = recorder.http("create spot quote", "POST", "/v1/quotes", await harness.createQuote({ accountId: ACCOUNT, assetId: "tWETH", side: "BUY", amountBase: "200000000" }));
      await harness.advanceClock("2026-11-20T15:01:00Z");
      const placed = recorder.http("place order after expiry", "POST", "/v1/orders", await harness.placeOrder(quote(created).quoteId, ACCOUNT, "idem-expired"));
      recorder.check("status", placed.status, 422);
      recorder.check("code", errorCode(placed), "QUOTE_EXPIRED");
    }),
  );

  results.push(
    await withCase("A02-API-STALE-PRICE", "Dealer price source older than 60 seconds is refused", async (recorder, harness) => {
      const configured = recorder.http("simulate stale price source", "POST", "/v1/dev/price-source", await harness.inject("POST", "/v1/dev/price-source", { payload: { staleSeconds: 61 } }));
      recorder.check("configuration status", configured.status, 200);
      const created = recorder.http("create quote against stale price", "POST", "/v1/quotes", await harness.createQuote({ accountId: ACCOUNT, assetId: "tWETH", side: "BUY", amountBase: "200000000" }));
      recorder.check("status", created.status, 422);
      recorder.check("code", errorCode(created), "STALE_PRICE");
    }),
  );

  results.push(
    await withCase("A02-API-PRICE-UNAVAILABLE", "Unavailable price source returns a retry hint", async (recorder, harness) => {
      const configured = await harness.inject("POST", "/v1/dev/price-source", { payload: { unavailable: true } });
      recorder.http("simulate unavailable price source", "POST", "/v1/dev/price-source", configured);
      const created = recorder.http("create quote without a price source", "POST", "/v1/quotes", await harness.createQuote({ accountId: ACCOUNT, assetId: "tWETH", side: "BUY", amountBase: "200000000" }));
      recorder.check("status", created.status, 503);
      recorder.check("code", errorCode(created), "PRICE_SOURCE_UNAVAILABLE");
      recorder.check("retry-after header", created.headers["retry-after"], "5");
    }),
  );

  results.push(
    await withCase("A02-API-INSUFFICIENT-CASH", "Orders beyond the spendable cash are refused before acceptance", async (recorder, harness) => {
      const quoteResult = recorder.http("create oversized subscription quote", "POST", "/v1/quotes", await harness.createQuote({ accountId: ACCOUNT, assetId: "eFUND", side: "SUBSCRIBE", amountBase: "1200000000" }));
      recorder.check("quote status", quoteResult.status, 200);
      const placed = recorder.http("place oversized subscription", "POST", "/v1/orders", await harness.placeOrder(quote(quoteResult).quoteId, ACCOUNT, "idem-oversized"));
      recorder.check("status", placed.status, 422);
      recorder.check("code", errorCode(placed), "INSUFFICIENT_CASH");
    }),
  );

  results.push(
    await withCase("A02-API-SPOT-FILL", "Spot buy settles with the fixed EUR 0.05 charge", async (recorder, harness) => {
      const created = recorder.http("create spot buy quote", "POST", "/v1/quotes", await harness.createQuote({ accountId: ACCOUNT, assetId: "tWETH", side: "BUY", amountBase: "200000000" }));
      const placed = recorder.http("place spot order", "POST", "/v1/orders", await harness.placeOrder(quote(created).quoteId, ACCOUNT, "idem-spot-fill"));
      recorder.check("order accepted", placed.status, 202);
      harness.tick();
      const settled = order(recorder.http("read filled order", "GET", `/v1/orders/${order(placed).orderId}`, await harness.getOrder(order(placed).orderId)));
      recorder.check("business state", settled.businessState, "FILLED");
      recorder.check("chain state", settled.chainState, "NOT_SUBMITTED");
      recorder.check("receipt units", settled.receipt?.unitsBase, "100000000000000000");
      recorder.check("receipt cash deployed", (settled.receipt as SpotReceipt | null)?.cashDeployedBase, "200000000");
      recorder.check("receipt charge", (settled.receipt as { investorChargeBase?: string } | null)?.investorChargeBase, "50000");
      recorder.check("money movements present", settled.moneyMovements.length > 0, true);
      const balances = portfolio(recorder.http("read portfolio", "GET", `/v1/portfolios/${ACCOUNT}`, await harness.getPortfolio(ACCOUNT)));
      recorder.check("spendable cash", balances.balances.dEUR.availableBase, "799950000");
      recorder.check("reserved cash", balances.balances.dEUR.reservedBase, "0");
      recorder.check("tWETH balance", balances.balances.tWETH.availableBase, "100000000000000000");
      recorder.check("marked value", balances.markedValueBase, "999950000");
      recorder.check("block hash unavailable in fixture mode", balances.blockHash, null);
    }),
  );

  results.push(
    await withCase("A02-API-FUND-ALLOCATION", "Fund subscription is reserved then allocated at the authorized NAV", async (recorder, harness) => {
      const created = recorder.http("create subscription quote", "POST", "/v1/quotes", await harness.createQuote({ accountId: ACCOUNT, assetId: "eFUND", side: "SUBSCRIBE", amountBase: "300000000" }));
      const placed = recorder.http("place subscription", "POST", "/v1/orders", await harness.placeOrder(quote(created).quoteId, ACCOUNT, "idem-fund-alloc"));
      harness.tick();
      const pending = order(recorder.http("read pending order", "GET", `/v1/orders/${order(placed).orderId}`, await harness.getOrder(order(placed).orderId)));
      recorder.check("pending state", pending.businessState, "AWAITING_NAV");
      const pendingPortfolio = portfolio(recorder.http("read portfolio while pending", "GET", `/v1/portfolios/${ACCOUNT}`, await harness.getPortfolio(ACCOUNT)));
      recorder.check("reserved cash while pending", pendingPortfolio.balances.dEUR.reservedBase, "300000000");
      recorder.check("spendable cash while pending", pendingPortfolio.balances.dEUR.availableBase, "700000000");
      await harness.advanceClock("2026-11-20T17:01:00Z");
      const nav = recorder.http("publish NAV", "POST", "/v1/issuer/nav", await harness.publishNav({ valuationDate: "2026-11-20", navBase: "96000000", sourceTime: "2026-11-20T17:00:00Z" }));
      recorder.check("nav status", nav.status, 201);
      const navBody = nav.body as NavPublicationResult;
      recorder.check("nav value", navBody.navEurPerUnit, "96.00");
      recorder.check("queued allocation", navBody.queuedOrderIds, [order(placed).orderId]);
      harness.tick();
      const settled = order(recorder.http("read allocated order", "GET", `/v1/orders/${order(placed).orderId}`, await harness.getOrder(order(placed).orderId)));
      recorder.check("business state", settled.businessState, "ALLOCATED");
      recorder.check("reason cleared", settled.reasonCode, null);
      recorder.check("receipt units", settled.receipt?.unitsBase, "3125000");
      recorder.check("receipt nav", (settled.receipt as FundReceipt | null)?.navEurPerUnit, "96.00");
      recorder.check("receipt investor charge", settled.receipt?.investorChargeBase, "0");
      const finalPortfolio = portfolio(recorder.http("read final portfolio", "GET", `/v1/portfolios/${ACCOUNT}`, await harness.getPortfolio(ACCOUNT)));
      recorder.check("spendable cash", finalPortfolio.balances.dEUR.availableBase, "700000000");
      recorder.check("reserved cash", finalPortfolio.balances.dEUR.reservedBase, "0");
      recorder.check("eFUND balance", finalPortfolio.balances.eFUND.availableBase, "3125000");
      recorder.check("marked value", finalPortfolio.markedValueBase, "1000000000");
      const fundMark = finalPortfolio.marks.find((mark) => mark.assetId === "eFUND");
      recorder.check("mark source", fundMark?.source, "authorized-nav");
      recorder.check("mark value", fundMark?.priceBase, "96000000");
    }),
  );

  results.push(
    await withCase("A02-API-DUST", "Rounded-down units return the residual cash", async (recorder, harness) => {
      const created = recorder.http("create dust subscription quote", "POST", "/v1/quotes", await harness.createQuote({ accountId: ACCOUNT, assetId: "eFUND", side: "SUBSCRIBE", amountBase: "100000001" }));
      recorder.check("quote status", created.status, 200);
      const placed = recorder.http("place dust subscription", "POST", "/v1/orders", await harness.placeOrder(quote(created).quoteId, ACCOUNT, "idem-dust"));
      harness.tick();
      await harness.advanceClock("2026-11-20T17:01:00Z");
      await harness.publishNav({ valuationDate: "2026-11-20", navBase: "96000000", sourceTime: "2026-11-20T17:00:00Z" });
      harness.tick();
      const settled = order(recorder.http("read order", "GET", `/v1/orders/${order(placed).orderId}`, await harness.getOrder(order(placed).orderId)));
      recorder.check("business state", settled.businessState, "ALLOCATED");
      recorder.check("units", settled.receipt?.unitsBase, "1041666");
      recorder.check("cash deployed", (settled.receipt as FundReceipt | null)?.cashDeployedBase, "99999936");
      const balances = portfolio(recorder.http("read portfolio", "GET", `/v1/portfolios/${ACCOUNT}`, await harness.getPortfolio(ACCOUNT)));
      recorder.check("spendable cash with dust returned", balances.balances.dEUR.availableBase, "900000064");
      recorder.check("eFUND balance", balances.balances.eFUND.availableBase, "1041666");
    }),
  );

  results.push(
    await withCase("A02-API-MISSING-NAV", "Missing NAV keeps the order pending with cash reserved", async (recorder, harness) => {
      const created = recorder.http("create subscription quote", "POST", "/v1/quotes", await harness.createQuote({ accountId: ACCOUNT, assetId: "eFUND", side: "SUBSCRIBE", amountBase: "300000000" }));
      const placed = recorder.http("place subscription", "POST", "/v1/orders", await harness.placeOrder(quote(created).quoteId, ACCOUNT, "idem-missing-nav"));
      harness.tick();
      await harness.advanceClock("2026-11-20T17:01:00Z");
      harness.tick();
      const pending = order(recorder.http("read pending order", "GET", `/v1/orders/${order(placed).orderId}`, await harness.getOrder(order(placed).orderId)));
      recorder.check("business state", pending.businessState, "AWAITING_NAV");
      recorder.check("reason", pending.reasonCode, "NAV_MISSING");
      recorder.check("no receipt yet", pending.receipt, null);
      const balances = portfolio(recorder.http("read portfolio", "GET", `/v1/portfolios/${ACCOUNT}`, await harness.getPortfolio(ACCOUNT)));
      recorder.check("reserved cash", balances.balances.dEUR.reservedBase, "300000000");
      recorder.check("no units issued", balances.balances.eFUND.availableBase, "0");
    }),
  );

  results.push(
    await withCase("A02-API-CANCEL-BEFORE", "Cancellation before the cutoff releases the reservation", async (recorder, harness) => {
      const created = recorder.http("create subscription quote", "POST", "/v1/quotes", await harness.createQuote({ accountId: ACCOUNT, assetId: "eFUND", side: "SUBSCRIBE", amountBase: "300000000" }));
      const placed = recorder.http("place subscription", "POST", "/v1/orders", await harness.placeOrder(quote(created).quoteId, ACCOUNT, "idem-cancel-before"));
      harness.tick();
      await harness.advanceClock("2026-11-20T15:30:00Z");
      const cancelled = recorder.http("cancel before cutoff", "POST", `/v1/orders/${order(placed).orderId}/cancel`, await harness.cancelOrder(order(placed).orderId, ACCOUNT));
      recorder.check("cancel status", cancelled.status, 200);
      recorder.check("business state", order(cancelled).businessState, "CANCELLED");
      const balances = portfolio(recorder.http("read portfolio", "GET", `/v1/portfolios/${ACCOUNT}`, await harness.getPortfolio(ACCOUNT)));
      recorder.check("spendable cash restored", balances.balances.dEUR.availableBase, "1000000000");
      recorder.check("reserved cash released", balances.balances.dEUR.reservedBase, "0");
      recorder.check("no units issued", balances.balances.eFUND.availableBase, "0");
    }),
  );

  results.push(
    await withCase("A02-API-CANCEL-AFTER", "Cancellation after the cutoff is refused", async (recorder, harness) => {
      await harness.advanceClock("2026-11-20T15:30:00Z");
      const created = recorder.http("create same-day subscription quote", "POST", "/v1/quotes", await harness.createQuote({ accountId: ACCOUNT, assetId: "eFUND", side: "SUBSCRIBE", amountBase: "300000000" }));
      recorder.check("quote dealing date", quote(created).dealingTerms?.assignedDealingDate, "2026-11-20");
      const placed = recorder.http("place subscription", "POST", "/v1/orders", await harness.placeOrder(quote(created).quoteId, ACCOUNT, "idem-cancel-after"));
      harness.tick();
      await harness.advanceClock("2026-11-20T17:00:00Z");
      const cancelled = recorder.http("cancel after cutoff", "POST", `/v1/orders/${order(placed).orderId}/cancel`, await harness.cancelOrder(order(placed).orderId, ACCOUNT));
      recorder.check("status", cancelled.status, 422);
      recorder.check("code", errorCode(cancelled), "CANCELLATION_NOT_ALLOWED");
      const pending = order(recorder.http("read order", "GET", `/v1/orders/${order(placed).orderId}`, await harness.getOrder(order(placed).orderId)));
      recorder.check("order still pending", pending.businessState, "AWAITING_NAV");
    }),
  );

  results.push(
    await withCase("A02-API-ZERO-UNIT-BOUNDARY", "Quotes that would issue zero units are refused", async (recorder, harness) => {
      const created = recorder.http("create one-base-unit subscription quote", "POST", "/v1/quotes", await harness.createQuote({ accountId: ACCOUNT, assetId: "eFUND", side: "SUBSCRIBE", amountBase: "1" }));
      recorder.check("status", created.status, 422);
      recorder.check("code", errorCode(created), "ZERO_UNIT_FILL");
    }),
  );

  results.push(
    await withCase("A02-API-REDEMPTION", "Redemption reserves units and settles at the next applicable NAV", async (recorder, harness) => {
      const settledFund = await settleG01(recorder, harness);
      recorder.check("fund order allocated", settledFund.businessState, "ALLOCATED");
      await harness.advanceClock("2026-11-20T17:05:00Z");
      const redQuote = recorder.http("create redemption quote", "POST", "/v1/quotes", await harness.createQuote({ accountId: ACCOUNT, assetId: "eFUND", side: "REDEEM", amountBase: "1000000" }));
      recorder.check("redemption dealing date", quote(redQuote).dealingTerms?.assignedDealingDate, "2026-11-23");
      const placed = recorder.http("place redemption order", "POST", "/v1/orders", await harness.placeOrder(quote(redQuote).quoteId, ACCOUNT, "idem-redemption"));
      harness.tick();
      const pending = order(recorder.http("read pending redemption", "GET", `/v1/orders/${order(placed).orderId}`, await harness.getOrder(order(placed).orderId)));
      recorder.check("pending state", pending.businessState, "AWAITING_NAV");
      const reservedPortfolio = portfolio(recorder.http("read portfolio with reserved units", "GET", `/v1/portfolios/${ACCOUNT}`, await harness.getPortfolio(ACCOUNT)));
      recorder.check("reserved units", reservedPortfolio.balances.eFUND.reservedBase, "1000000");
      recorder.check("available units", reservedPortfolio.balances.eFUND.availableBase, "2125000");
      await harness.advanceClock("2026-11-23T17:01:00Z");
      await harness.publishNav({ valuationDate: "2026-11-23", navBase: "98000000", sourceTime: "2026-11-23T17:00:00Z" });
      harness.tick();
      const settled = order(recorder.http("read settled redemption", "GET", `/v1/orders/${order(placed).orderId}`, await harness.getOrder(order(placed).orderId)));
      recorder.check("business state", settled.businessState, "REDEEMED");
      recorder.check("cash paid", (settled.receipt as { cashPaidBase?: string } | null)?.cashPaidBase, "98000000");
      recorder.check("nav applied", (settled.receipt as RedemptionReceipt | null)?.navEurPerUnit, "98.00");
      const balances = portfolio(recorder.http("read portfolio after redemption", "GET", `/v1/portfolios/${ACCOUNT}`, await harness.getPortfolio(ACCOUNT)));
      recorder.check("spendable cash", balances.balances.dEUR.availableBase, "597950000");
      recorder.check("eFUND units", balances.balances.eFUND.availableBase, "2125000");
      recorder.check("reserved units released", balances.balances.eFUND.reservedBase, "0");
    }),
  );

  results.push(
    await withCase("A02-API-SPOT-SELL", "Reverse quote sells tWETH with the fixed charge and checks inventory", async (recorder, harness) => {
      const buyQuote = recorder.http("create buy quote", "POST", "/v1/quotes", await harness.createQuote({ accountId: ACCOUNT, assetId: "tWETH", side: "BUY", amountBase: "200000000" }));
      await harness.placeOrder(quote(buyQuote).quoteId, ACCOUNT, "idem-buy-for-sell");
      harness.tick();
      const sellQuote = recorder.http("create sell quote", "POST", "/v1/quotes", await harness.createQuote({ accountId: ACCOUNT, assetId: "tWETH", side: "SELL", amountBase: "50000000000000000" }));
      recorder.check("sell quote status", sellQuote.status, 200);
      const placed = recorder.http("place sell order", "POST", "/v1/orders", await harness.placeOrder(quote(sellQuote).quoteId, ACCOUNT, "idem-sell"));
      harness.tick();
      const settled = order(recorder.http("read sell order", "GET", `/v1/orders/${order(placed).orderId}`, await harness.getOrder(order(placed).orderId)));
      recorder.check("business state", settled.businessState, "FILLED");
      recorder.check("cash received", (settled.receipt as SpotReceipt | null)?.cashDeployedBase, "100000000");
      recorder.check("charge", (settled.receipt as { investorChargeBase?: string } | null)?.investorChargeBase, "50000");
      const balances = portfolio(recorder.http("read portfolio", "GET", `/v1/portfolios/${ACCOUNT}`, await harness.getPortfolio(ACCOUNT)));
      recorder.check("spendable cash after sale", balances.balances.dEUR.availableBase, "899900000");
      recorder.check("tWETH remainder", balances.balances.tWETH.availableBase, "50000000000000000");
    }),
  );

  results.push(
    await withCase("A02-API-G01-MATCH", "G01 reproduced through the API matches the CLI evidence", async (recorder, harness) => {
      const spotQuote = recorder.http("create spot quote", "POST", "/v1/quotes", await harness.createQuote({ accountId: ACCOUNT, assetId: "tWETH", side: "BUY", amountBase: "200000000" }));
      await harness.placeOrder(quote(spotQuote).quoteId, ACCOUNT, "idem-g01-spot");
      harness.tick();
      const fundQuote = recorder.http("create fund quote", "POST", "/v1/quotes", await harness.createQuote({ accountId: ACCOUNT, assetId: "eFUND", side: "SUBSCRIBE", amountBase: "300000000" }));
      await harness.placeOrder(quote(fundQuote).quoteId, ACCOUNT, "idem-g01-fund");
      harness.tick();
      await harness.advanceClock("2026-11-20T17:01:00Z");
      await harness.publishNav({ valuationDate: "2026-11-20", navBase: "96000000", sourceTime: "2026-11-20T17:00:00Z" });
      harness.tick();
      const balances = portfolio(recorder.http("read final portfolio", "GET", `/v1/portfolios/${ACCOUNT}`, await harness.getPortfolio(ACCOUNT)));
      recorder.check("spendable cash", balances.balances.dEUR.availableBase, "499950000");
      recorder.check("reserved cash", balances.balances.dEUR.reservedBase, "0");
      recorder.check("tWETH", balances.balances.tWETH.availableBase, "100000000000000000");
      recorder.check("eFUND", balances.balances.eFUND.availableBase, "3125000");
      recorder.check("marked value", balances.markedValueBase, "999950000");
      const health = await harness.health();
      recorder.check("health status", health.status, 200);
      recorder.check("event count", (health.body as { eventCount: number }).eventCount, 5 + 2 + 1 + 1 + 1);
    }),
  );

  return results;
}

export async function runInvariantCases(): Promise<CaseResult[]> {
  const results: CaseResult[] = [];

  results.push(
    await withCase("A06-IDEMPOTENT-ORDERS", "Same-key retries reuse the order and changed bodies conflict", async (recorder, harness) => {
      const created = recorder.http("create quote", "POST", "/v1/quotes", await harness.createQuote({ accountId: ACCOUNT, assetId: "tWETH", side: "BUY", amountBase: "200000000" }));
      const first = recorder.http("first submission", "POST", "/v1/orders", await harness.placeOrder(quote(created).quoteId, ACCOUNT, "idem-same-key"));
      recorder.check("first status", first.status, 202);
      const second = recorder.http("same key and body retry", "POST", "/v1/orders", await harness.placeOrder(quote(created).quoteId, ACCOUNT, "idem-same-key"));
      recorder.check("retry status", second.status, 202);
      recorder.check("retry returns same order", order(second).orderId, order(first).orderId);
      const orders = await harness.listOrders(ACCOUNT);
      recorder.check("only one order persisted", (orders.body as Order[]).length, 1);
      const otherQuote = recorder.http("create second quote", "POST", "/v1/quotes", await harness.createQuote({ accountId: ACCOUNT, assetId: "tWETH", side: "BUY", amountBase: "100000000" }));
      const conflict = recorder.http("same key with different body", "POST", "/v1/orders", await harness.placeOrder(quote(otherQuote).quoteId, ACCOUNT, "idem-same-key"));
      recorder.check("conflict status", conflict.status, 409);
      recorder.check("conflict code", errorCode(conflict), "IDEMPOTENCY_KEY_REUSED");
      harness.tick();
      const afterTick = await harness.listOrders(ACCOUNT);
      recorder.check("still one order after settlement", (afterTick.body as Order[]).length, 1);
      recorder.check("settled state", order(recorder.http("read order", "GET", `/v1/orders/${order(first).orderId}`, await harness.getOrder(order(first).orderId))).businessState, "FILLED");
      recorder.check("event count", countEvents(harness.ctx.db), 5 + 2);
    }),
  );

  results.push(
    await withCase("A06-CONCURRENT-CASH", "Competing reservations cannot overspend the same cash", async (recorder, harness) => {
      const firstQuote = recorder.http("create first 600 EUR quote", "POST", "/v1/quotes", await harness.createQuote({ accountId: ACCOUNT, assetId: "eFUND", side: "SUBSCRIBE", amountBase: "600000000" }));
      const secondQuote = recorder.http("create second 600 EUR quote", "POST", "/v1/quotes", await harness.createQuote({ accountId: ACCOUNT, assetId: "eFUND", side: "SUBSCRIBE", amountBase: "600000000" }));
      const first = recorder.http("accept first reservation", "POST", "/v1/orders", await harness.placeOrder(quote(firstQuote).quoteId, ACCOUNT, "idem-race-1"));
      const second = recorder.http("accept second reservation", "POST", "/v1/orders", await harness.placeOrder(quote(secondQuote).quoteId, ACCOUNT, "idem-race-2"));
      recorder.check("both accepted for asynchronous settlement", [first.status, second.status], [202, 202]);
      harness.tick();
      const firstOrder = order(recorder.http("read first order", "GET", `/v1/orders/${order(first).orderId}`, await harness.getOrder(order(first).orderId)));
      const secondOrder = order(recorder.http("read second order", "GET", `/v1/orders/${order(second).orderId}`, await harness.getOrder(order(second).orderId)));
      recorder.check("first order reserved", firstOrder.businessState, "AWAITING_NAV");
      recorder.check("second order declined", secondOrder.businessState, "DECLINED");
      recorder.check("second decline reason", secondOrder.reasonCode, "INSUFFICIENT_CASH");
      const balances = portfolio(recorder.http("read portfolio", "GET", `/v1/portfolios/${ACCOUNT}`, await harness.getPortfolio(ACCOUNT)));
      recorder.check("reserved cash limited to one order", balances.balances.dEUR.reservedBase, "600000000");
      recorder.check("spendable cash not negative", balances.balances.dEUR.availableBase, "400000000");
      recorder.check("event count", countEvents(harness.ctx.db), 5 + 1);
    }),
  );

  results.push(
    await withCase("A06-CONSERVATION", "Journal balances to zero per asset across the full lifecycle", async (recorder, harness) => {
      await settleG01(recorder, harness);
      await harness.advanceClock("2026-11-20T17:05:00Z");
      const redQuote = recorder.http("create redemption quote", "POST", "/v1/quotes", await harness.createQuote({ accountId: ACCOUNT, assetId: "eFUND", side: "REDEEM", amountBase: "1000000" }));
      await harness.placeOrder(quote(redQuote).quoteId, ACCOUNT, "idem-conservation-red");
      harness.tick();
      await harness.advanceClock("2026-11-23T17:01:00Z");
      await harness.publishNav({ valuationDate: "2026-11-23", navBase: "98000000", sourceTime: "2026-11-23T17:00:00Z" });
      harness.tick();
      const journal = harness.ctx.engine.state.journal;
      recorder.check("journal imbalances", findImbalances(journal), []);
      const balances = portfolio(recorder.http("read portfolio", "GET", `/v1/portfolios/${ACCOUNT}`, await harness.getPortfolio(ACCOUNT)));
      recorder.check("spendable cash", balances.balances.dEUR.availableBase, "597950000");
      recorder.check("tWETH balance", balances.balances.tWETH.availableBase, "100000000000000000");
      recorder.check("eFUND balance", balances.balances.eFUND.availableBase, "2125000");
      recorder.check("marked value", balances.markedValueBase, "1006200000");
      recorder.check("event count", countEvents(harness.ctx.db), 5 + 2 + 1 + 1 + 1 + 1 + 1 + 1);
    }),
  );

  results.push(
    await withCase("A06-RESTART-RECOVERY", "Projections rebuild from the event log after a restart and pending work resumes", async (recorder) => {
      const dir = mkdtempSync(join(tmpdir(), "eurorollup-api-"));
      const dbFile = join(dir, "api.sqlite");
      let sequence = 0;
      const ids = {
        quote: () => `quote_${(sequence += 1).toString().padStart(4, "0")}`,
        order: () => `order_${(sequence += 1).toString().padStart(4, "0")}`,
        trace: () => `trace_${(sequence += 1).toString().padStart(4, "0")}`,
      };
      try {
        const first = await createHarness({ dbFile, ids });
        await settleG01(recorder, first);
        const beforeOrders = (await first.listOrders(ACCOUNT)).body as Order[];
        const beforePortfolio = (await first.getPortfolio(ACCOUNT)).body as Portfolio;
        const beforeEvents = countEvents(first.ctx.db);
        const beforeJournal = first.ctx.engine.state.journal.length;
        await first.close();

        const second = await createHarness({ dbFile, ids });
        const afterOrders = (await second.listOrders(ACCOUNT)).body as Order[];
        const afterPortfolio = (await second.getPortfolio(ACCOUNT)).body as Portfolio;
        recorder.check("event log survived", countEvents(second.ctx.db), beforeEvents);
        recorder.check("journal rebuilt", second.ctx.engine.state.journal.length, beforeJournal);
        recorder.check("orders equal after restart", canonicalJson(afterOrders) === canonicalJson(beforeOrders), true);
        recorder.check("portfolio equal after restart", canonicalJson(afterPortfolio) === canonicalJson(beforePortfolio), true);

        const quoteResult = await second.createQuote({ accountId: ACCOUNT, assetId: "eFUND", side: "SUBSCRIBE", amountBase: "100000000" });
        const pending = await second.placeOrder(quote(quoteResult).quoteId, ACCOUNT, "idem-after-restart");
        recorder.check("order accepted after restart", pending.status, 202);
        await second.close();

        const third = await createHarness({ dbFile, ids });
        third.tick();
        const resumed = order(recorder.http("read resumed order", "GET", `/v1/orders/${order(pending).orderId}`, await third.getOrder(order(pending).orderId)));
        recorder.check("pending order resumed after restart", resumed.businessState, "AWAITING_NAV");
        recorder.check("no duplicate events", countEvents(third.ctx.db), beforeEvents + 1);
        await third.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  results.push(
    await withCase("A06-REPLAY-EQUALITY", "Identical action sequences produce identical state and canonical digests", async (recorder) => {
      const run = async (): Promise<unknown> => {
        const harness = await createHarness();
        try {
          const spotQuote = await harness.createQuote({ accountId: ACCOUNT, assetId: "tWETH", side: "BUY", amountBase: "200000000" });
          await harness.placeOrder(quote(spotQuote).quoteId, ACCOUNT, "idem-replay-spot");
          harness.tick();
          const fundQuote = await harness.createQuote({ accountId: ACCOUNT, assetId: "eFUND", side: "SUBSCRIBE", amountBase: "300000000" });
          await harness.placeOrder(quote(fundQuote).quoteId, ACCOUNT, "idem-replay-fund");
          harness.tick();
          await harness.advanceClock("2026-11-20T17:01:00Z");
          await harness.publishNav({ valuationDate: "2026-11-20", navBase: "96000000", sourceTime: "2026-11-20T17:00:00Z" });
          harness.tick();
          const orders = (await harness.listOrders(ACCOUNT)).body;
          const portfolioResult = (await harness.getPortfolio(ACCOUNT)).body;
          return {
            orders,
            portfolio: portfolioResult,
            events: countEvents(harness.ctx.db),
            journal: harness.ctx.engine.state.journal,
          };
        } finally {
          await harness.close();
        }
      };
      const first = await run();
      const second = await run();
      recorder.check("identical canonical state", canonicalJson(first) === canonicalJson(second), true);
    }),
  );

  results.push(
    await withCase("A06-DUPLICATE-EVENT", "A duplicate event id cannot create a second business effect", async (recorder, harness) => {
      await settleG01(recorder, harness);
      const events = readEvents(harness.ctx.db);
      const before = countEvents(harness.ctx.db);
      const duplicate = events[0] as SettlementEvent;
      let errorCodeText = "no error";
      try {
        harness.ctx.engine.applyEvents([duplicate]);
      } catch (error) {
        errorCodeText =
          typeof error === "object" && error !== null && "code" in error
            ? String((error as { code: unknown }).code)
            : String(error);
      }
      recorder.check("duplicate rejected", errorCodeText, "DUPLICATE_EVENT");
      recorder.check("event count unchanged", countEvents(harness.ctx.db), before);
      recorder.check("journal still balanced", findImbalances(harness.ctx.engine.state.journal), []);
    }),
  );

  return results;
}
