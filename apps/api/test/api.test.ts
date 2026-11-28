/**
 * API integration tests: routes, error mapping, roles, OpenAPI and the worker.
 */
import { describe, expect, it } from "vitest";
import type { NavPublicationResult, Order, Portfolio, Quote } from "@eurorollup/sdk";
import { createApiConfig } from "../src/config.js";
import { createApp } from "../src/app.js";
import { createHarness, errorCode } from "../src/evidence/harness.js";
import { createApiConfig as loadConfig } from "../src/config.js";

describe("partner API routes", () => {
  it("exposes fixture metadata on the health endpoint", async () => {
    const harness = await createHarness();
    try {
      const health = await harness.health();
      expect(health.status).toBe(200);
      const body = health.body as {
        status: string;
        calendarId: string;
        policyId: string;
        clock: string;
        engineVersion: string;
        eventCount: number;
      };
      expect(body.status).toBe("ok");
      expect(body.calendarId).toBe("LAB-UTC-1");
      expect(body.policyId).toBe("eFUND-dealing");
      expect(body.clock).toBe("2026-11-20T15:00:00Z");
      expect(body.engineVersion).toBe("0.2.1");
      expect(body.eventCount).toBe(5);
    } finally {
      await harness.close();
    }
  });

  it("accepts a spot order and settles it asynchronously", async () => {
    const harness = await createHarness();
    try {
      const quoteResult = await harness.createQuote({
        accountId: "investor-ada",
        assetId: "tWETH",
        side: "BUY",
        amountBase: "200000000",
      });
      expect(quoteResult.status).toBe(200);
      const orderResult = await harness.placeOrder(
        (quoteResult.body as Quote).quoteId,
        "investor-ada",
        "idem-test-1",
      );
      expect(orderResult.status).toBe(202);
      const accepted = orderResult.body as Order;
      expect(accepted.businessState).toBe("SUBMITTED");
      expect(accepted.chainState).toBe("NOT_SUBMITTED");
      harness.tick();
      const read = await harness.getOrder(accepted.orderId);
      expect((read.body as Order).businessState).toBe("FILLED");
    } finally {
      await harness.close();
    }
  });

  it("requires the Idempotency-Key header", async () => {
    const harness = await createHarness();
    try {
      const quoteResult = await harness.createQuote({
        accountId: "investor-ada",
        assetId: "tWETH",
        side: "BUY",
        amountBase: "200000000",
      });
      const withoutKey = await harness.inject("POST", "/v1/orders", {
        payload: { quoteId: (quoteResult.body as Quote).quoteId, accountId: "investor-ada" },
      });
      expect(withoutKey.status).toBe(400);
      expect(errorCode(withoutKey)).toBe("INVALID_REQUEST");
    } finally {
      await harness.close();
    }
  });

  it("lists synthetic accounts and their portfolios", async () => {
    const harness = await createHarness();
    try {
      const accounts = await harness.inject("GET", "/v1/portfolios");
      expect(accounts.status).toBe(200);
      const list = accounts.body as Array<{ accountId: string; persona: string }>;
      expect(list).toHaveLength(4);
      expect(list.map((item) => item.accountId)).toContain("investor-ada");
      const portfolioResult = await harness.getPortfolio("investor-ada");
      expect(portfolioResult.status).toBe(200);
      const portfolio = portfolioResult.body as Portfolio;
      expect(portfolio.balances.dEUR.availableBase).toBe("1000000000");
      expect(portfolio.dataMode).toBe("local-fixture");
      const unknown = await harness.getPortfolio("investor-nobody");
      expect(unknown.status).toBe(404);
    } finally {
      await harness.close();
    }
  });

  it("enforces the issuer role identity for NAV publication", async () => {
    const harness = await createHarness();
    try {
      await harness.advanceClock("2026-11-20T17:01:00Z");
      const rejected = await harness.publishNav({
        valuationDate: "2026-11-20",
        navBase: "96000000",
        sourceTime: "2026-11-20T17:00:00Z",
        roleIdentity: "investor-ada",
      });
      expect(rejected.status).toBe(403);
      expect(errorCode(rejected)).toBe("ROLE_NOT_AUTHORIZED");
      const accepted = await harness.publishNav({
        valuationDate: "2026-11-20",
        navBase: "96000000",
        sourceTime: "2026-11-20T17:00:00Z",
      });
      expect(accepted.status).toBe(201);
      const nav = accepted.body as NavPublicationResult;
      expect(nav.navEurPerUnit).toBe("96.00");
      expect(nav.signer).toBe("issuer-nav-signer");
      const duplicate = await harness.publishNav({
        valuationDate: "2026-11-20",
        navBase: "97000000",
        sourceTime: "2026-11-20T17:00:00Z",
        revision: 1,
      });
      expect(duplicate.status).toBe(409);
      expect(errorCode(duplicate)).toBe("NAV_REVISION_NOT_NEWER");
      const corrected = await harness.publishNav({
        valuationDate: "2026-11-20",
        navBase: "97000000",
        sourceTime: "2026-11-20T17:00:00Z",
        revision: 2,
      });
      expect(corrected.status).toBe(201);
    } finally {
      await harness.close();
    }
  });

  it("refuses cancellation of a spot order", async () => {
    const harness = await createHarness();
    try {
      const quoteResult = await harness.createQuote({
        accountId: "investor-ada",
        assetId: "tWETH",
        side: "BUY",
        amountBase: "200000000",
      });
      const orderResult = await harness.placeOrder(
        (quoteResult.body as Quote).quoteId,
        "investor-ada",
        "idem-cancel-spot",
      );
      const cancel = await harness.cancelOrder(
        (orderResult.body as Order).orderId,
        "investor-ada",
      );
      expect(cancel.status).toBe(409);
      expect(errorCode(cancel)).toBe("INVALID_STATE");
    } finally {
      await harness.close();
    }
  });

  it("serves the OpenAPI document with every documented path", async () => {
    const harness = await createHarness();
    try {
      const response = await harness.inject("GET", "/openapi.json");
      expect(response.status).toBe(200);
      const spec = response.body as { openapi: string; paths: Record<string, unknown> };
      expect(spec.openapi).toBe("3.1.0");
      const paths = Object.keys(spec.paths);
      for (const path of [
        "/v1/quotes",
        "/v1/orders",
        "/v1/orders/{orderId}",
        "/v1/orders/{orderId}/cancel",
        "/v1/portfolios/{accountId}",
        "/v1/issuer/nav",
      ]) {
        expect(paths).toContain(path);
      }
    } finally {
      await harness.close();
    }
  });

  it("hides dev endpoints when the config disables them", async () => {
    const app = await createApp({
      config: createApiConfig({ dbFile: ":memory:", autoWorker: false, devEndpoints: false }),
    });
    try {
      const response = await app.app.inject({ method: "GET", url: "/v1/dev/clock" });
      expect(response.statusCode).toBe(404);
      expect((JSON.parse(response.body) as { error: { code: string } }).error.code).toBe("NOT_FOUND");
    } finally {
      await app.close();
    }
  });

  it("resets the demo deterministically", async () => {
    const harness = await createHarness();
    try {
      const quoteResult = await harness.createQuote({
        accountId: "investor-ada",
        assetId: "tWETH",
        side: "BUY",
        amountBase: "200000000",
      });
      await harness.placeOrder((quoteResult.body as Quote).quoteId, "investor-ada", "idem-reset");
      harness.tick();
      const reset = await harness.inject("POST", "/v1/dev/reset", { payload: {} });
      expect(reset.status).toBe(200);
      expect((reset.body as { clock: string }).clock).toBe("2026-11-20T15:00:00Z");
      const portfolioResult = await harness.getPortfolio("investor-ada");
      expect((portfolioResult.body as Portfolio).balances.dEUR.availableBase).toBe("1000000000");
      const orders = await harness.listOrders("investor-ada");
      expect((orders.body as Order[]).length).toBe(0);
      const health = await harness.health();
      expect((health.body as { eventCount: number }).eventCount).toBe(5);
    } finally {
      await harness.close();
    }
  });

  it("keeps chain state separate from business state", async () => {
    const harness = await createHarness();
    try {
      const quoteResult = await harness.createQuote({
        accountId: "investor-ada",
        assetId: "tWETH",
        side: "BUY",
        amountBase: "200000000",
      });
      const accepted = (
        await harness.placeOrder((quoteResult.body as Quote).quoteId, "investor-ada", "idem-chain")
      ).body as Order;
      harness.tick();
      const settled = (await harness.getOrder(accepted.orderId)).body as Order;
      expect(settled.businessState).toBe("FILLED");
      expect(settled.chainState).toBe("NOT_SUBMITTED");
      expect(settled.policyEpoch).toMatch(/^[0-9a-f]{64}$/);
      expect(settled.traceId).toMatch(/^trace_/);
    } finally {
      await harness.close();
    }
  });
});

describe("configuration", () => {
  it("loads both fixture calendars by id", () => {
    expect(loadConfig({ calendarId: "LAB-UTC-2" }).calendar.calendarId).toBe("LAB-UTC-2");
    expect(loadConfig({ calendarId: "LAB-UTC-1", dbFile: ":memory:" }).dbFile).toBe(":memory:");
  });
});
