/**
 * Economics and operations API tests.
 */
import { describe, expect, it } from "vitest";
import { createHarness } from "../src/evidence/harness.js";

describe("economics and operations endpoints", () => {
  it("serves the observed bundle reconciliation", async () => {
    const harness = await createHarness();
    try {
      const response = await harness.inject("GET", "/v1/economics/observed");
      expect(response.status).toBe(200);
      const body = response.body as Record<string, any>;
      expect(body.bundle.outerStatus).toBe(1);
      expect(BigInt(body.bundle.sponsorPaidWei)).toBeGreaterThan(0n);
      expect(body.reconciliation.invariants.allocationsPlusResidualEqualsTotal).toBe(true);
      expect(body.charges.investorChargeEurMicros).toBe("50000");
    } finally {
      await harness.close();
    }
  });

  it("evaluates an explicit scenario and reports unavailable inputs", async () => {
    const harness = await createHarness();
    try {
      const response = await harness.inject("POST", "/v1/economics/scenario", {
        payload: {
          dailyOrders: 500,
          eligibleSponsorShareBps: 4000,
          daPriceWeiPerByte: null,
          batchUtilizationBps: 8000,
          investorChargeEurMicros: "50000",
          dailyBudgetEurMicros: "2500000",
          rateAgeSeconds: 10,
        },
      });
      expect(response.status).toBe(200);
      const body = response.body as Record<string, any>;
      expect(body.result.perOrderSponsorCostWei).toBeNull();
      expect(body.result.unavailable).toContain("daPriceWeiPerByte");
      expect(body.dataMode).toBe("scenario");
    } finally {
      await harness.close();
    }
  });

  it("rejects invalid scenario fields", async () => {
    const harness = await createHarness();
    try {
      const response = await harness.inject("POST", "/v1/economics/scenario", {
        payload: {
          dailyOrders: -5,
          eligibleSponsorShareBps: 40_000,
          daPriceWeiPerByte: null,
          batchUtilizationBps: 8000,
          investorChargeEurMicros: "50000",
          dailyBudgetEurMicros: null,
          rateAgeSeconds: 10,
        },
      });
      expect(response.status).toBe(400);
    } finally {
      await harness.close();
    }
  });

  it("serves the operating dashboard snapshot with no-samples handling", async () => {
    const harness = await createHarness();
    try {
      const response = await harness.inject("GET", "/v1/operations/dashboard");
      expect(response.status).toBe(200);
      const body = response.body as Record<string, any>;
      expect(body.panels.rpcLatency.samples).toBeGreaterThan(0);
      expect(body.panels.emptyIntervalExample.noSamples).toBe(true);
      expect(typeof body.dataMode).toBe("string");
    } finally {
      await harness.close();
    }
  });
});
