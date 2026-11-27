import { describe, expect, it } from "vitest";
import {
  DealingError,
  canonicalJson,
  findImbalances,
  hashJson,
  runG01,
  runG01Redemption,
} from "../src/index.js";
import {
  buildG01TestEvidence,
  g01RedemptionScenario,
  g01Scenario,
  labUtc1,
} from "./helpers.js";

describe("G01 golden portfolio", () => {
  const run = runG01(g01Scenario, labUtc1);

  it("matches every frozen checkpoint exactly", () => {
    expect(run.checkpoints).toHaveLength(4);
    const expected = g01Scenario.expected.checkpoints;
    run.checkpoints.forEach((snapshot, index) => {
      const checkpoint = expected[index];
      expect(checkpoint).toBeDefined();
      if (checkpoint === undefined) {
        return;
      }
      expect(snapshot.label).toBe(checkpoint.label);
      expect(snapshot.spendableCashBase).toBe(checkpoint.spendableCashBase);
      expect(snapshot.reservedCashBase).toBe(checkpoint.reservedCashBase);
      const tWeth = snapshot.holdings.find((holding) => holding.assetId === "tWETH");
      const eFund = snapshot.holdings.find((holding) => holding.assetId === "eFUND");
      expect(tWeth?.balanceBase).toBe(checkpoint.tWethBalanceBase);
      expect(eFund?.balanceBase).toBe(checkpoint.eFundBalanceBase);
      expect(snapshot.totalMarkedValueBase).toBe(checkpoint.totalMarkedValueBase);
    });
  });

  it("shows the EUR 200 spot purchase with the EUR 0.05 charge", () => {
    const afterSpot = run.checkpoints[1];
    expect(afterSpot?.spendableCashBase).toBe("799950000");
    const tWeth = afterSpot?.holdings.find((holding) => holding.assetId === "tWETH");
    expect(tWeth?.balanceBase).toBe("100000000000000000");
  });

  it("displays the EUR 300 cash pending exactly once while awaiting NAV", () => {
    const awaitingNav = run.checkpoints[2];
    expect(awaitingNav?.reservedCashBase).toBe("300000000");
    expect(awaitingNav?.spendableCashBase).toBe("499950000");
    expect(awaitingNav?.pendingOrders).toHaveLength(1);
    const eFund = awaitingNav?.holdings.find((holding) => holding.assetId === "eFUND");
    expect(eFund?.balanceBase).toBe("0");
  });

  it("replaces the pending cash with 3.125000 units at NAV 96.00", () => {
    const allocated = run.checkpoints[3];
    expect(allocated?.reservedCashBase).toBe("0");
    expect(allocated?.spendableCashBase).toBe("499950000");
    const eFund = allocated?.holdings.find((holding) => holding.assetId === "eFUND");
    expect(eFund?.balanceBase).toBe("3125000");
    expect(allocated?.totalMarkedValueBase).toBe("999950000");
  });

  it("keeps the closing portfolio value at EUR 999.95", () => {
    expect(run.finalPortfolio.totalMarkedValueBase).toBe("999950000");
  });

  it("emits the receipts described by the specification", () => {
    const fundReceipt = run.receipts.find((receipt) => receipt.orderId === "G01-FUND-01");
    expect(fundReceipt).toMatchObject({
      schemaVersion: "1.0",
      businessState: "ALLOCATED",
      assetId: "eFUND",
      unitsBase: "3125000",
      assetDecimals: 6,
      cashAssetId: "dEUR",
      cashDeployedBase: "300000000",
      cashDecimals: 6,
      navEurPerUnit: "96.00",
      investorChargeBase: "0",
    });
    const spotReceipt = run.receipts.find((receipt) => receipt.orderId === "G01-SPOT-01");
    expect(spotReceipt).toMatchObject({
      businessState: "FILLED",
      assetId: "tWETH",
      unitsBase: "100000000000000000",
      cashDeployedBase: "200000000",
      priceEurPerUnit: "2000.00",
      investorChargeBase: "50000",
    });
  });

  it("balances the journal to zero per asset", () => {
    expect(findImbalances(run.engine.journal)).toEqual([]);
  });

  it("replays the same event log to the same canonical result", () => {
    const second = runG01(g01Scenario, labUtc1);
    expect(canonicalJson(second.engine.steps)).toBe(canonicalJson(run.engine.steps));
    expect(second.finalPortfolio).toEqual(run.finalPortfolio);
  });
});

describe("G01 redemption case", () => {
  it("redeems one unit at NAV 98.00 and pays EUR 98.00", () => {
    const g01 = runG01(g01Scenario, labUtc1);
    const redemption = runG01Redemption(
      g01RedemptionScenario,
      g01.engine,
      g01Scenario.accounts.investorId,
    );
    expect(redemption.finalizedPortfolio.spendableCashBase).toBe("597950000");
    const eFund = redemption.finalizedPortfolio.holdings.find(
      (holding) => holding.assetId === "eFUND",
    );
    expect(eFund?.balanceBase).toBe("2125000");
    expect(redemption.receipt).toMatchObject({
      businessState: "REDEEMED",
      unitsBase: "1000000",
      cashPaidBase: "98000000",
      navEurPerUnit: "98.00",
      investorChargeBase: "0",
    });
  });
});

describe("engine guard rails", () => {
  it("refuses a stale spot price source", () => {
    const engine = runG01(g01Scenario, labUtc1).engine;
    expect(() =>
      engine.apply({
        type: "spot.quote.issued",
        eventId: "late-quote",
        occurredAt: "2026-11-20T18:02:00Z",
        orderId: "late-quote-order",
        account: { kind: "investor", accountId: g01Scenario.accounts.investorId },
        side: "BUY",
        amountBase: "1000000",
        priceBase: "2000000000",
        priceAsOf: "2026-11-20T18:00:00Z",
        expiresAt: "2026-11-20T18:02:30Z",
        chargeBase: "50000",
      }),
    ).toThrowError(DealingError);
  });

  it("refuses a duplicate event id", () => {
    const engine = runG01(g01Scenario, labUtc1).engine;
    expect(() =>
      engine.apply({
        type: "account.seeded",
        eventId: "G01-EV-01",
        occurredAt: "2026-11-20T18:00:00Z",
        account: { kind: "investor", accountId: "investor-ada" },
        assetId: "dEUR",
        amountBase: "1",
      }),
    ).toThrowError(/Duplicate event/);
  });

  it("hashes canonically independent of key order", () => {
    const first = hashJson({ b: 2, a: 1 });
    const second = hashJson({ a: 1, b: 2 });
    expect(first).toBe(second);
  });
});

describe("canonical evidence determinism", () => {
  it("builds identical golden-run bytes on every run", () => {
    const first = buildG01TestEvidence();
    const second = buildG01TestEvidence();
    expect(first.goldenText).toBe(second.goldenText);
    expect(first.run.businessDigest).toBe(second.run.businessDigest);
    expect(first.manifest.businessDigest).toBe(first.run.businessDigest);
  });
});
