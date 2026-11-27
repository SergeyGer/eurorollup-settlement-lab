/**
 * Engine features added in the settlement-core step: reverse quotes with minimum
 * proceeds, and explicit cancellation of pending fund requests.
 */
import { describe, expect, it } from "vitest";
import {
  DealingError,
  SettlementEngine,
  calendarFromFixture,
  findImbalances,
  parseBaseUnits,
  type AssetId,
  type CalendarFixture,
  type JournalAccount,
} from "../src/index.js";
import labUtc1Json from "../../../fixtures/calendar/LAB-UTC-1.json";
import type { EngineAccounts } from "../src/engine.js";

const labUtc1 = labUtc1Json as unknown as CalendarFixture;
const calendar = calendarFromFixture(labUtc1);

const investor: JournalAccount = { kind: "investor", accountId: "investor-ada" };
const escrow: JournalAccount = { kind: "fundEscrow", accountId: "fund-escrow" };
const issuance: JournalAccount = { kind: "issuanceControl", accountId: "issuance-control" };

function accounts(): EngineAccounts {
  return {
    dealer: { kind: "dealer", accountId: "dealer-inventory" },
    feeRecipient: { kind: "feeRecipient", accountId: "fee-recipient" },
    issuerTreasury: { kind: "issuerTreasury", accountId: "issuer-treasury" },
    issuanceControl: issuance,
    fundEscrow: escrow,
  };
}

function createEngine(): SettlementEngine {
  return new SettlementEngine({
    calendar,
    accounts: accounts(),
    marks: { tWETH: 2_000_000_000n, eFUND: 100_000_000n },
  });
}

function seed(engine: SettlementEngine, account: JournalAccount, assetId: AssetId, amountBase: string, eventId: string): void {
  engine.apply({ type: "account.seeded", eventId, occurredAt: "2026-11-19T00:00:00Z", account, assetId, amountBase });
}

describe("reverse spot quotes", () => {
  it("settles a sell against dealer cash and charges the fixed fee", () => {
    const engine = createEngine();
    seed(engine, investor, "tWETH", "1000000000000000000", "S-1");
    seed(engine, accounts().dealer, "dEUR", "1000000000", "S-2");
    seed(engine, investor, "dEUR", "1000000000", "S-3");
    engine.apply({
      type: "spot.quote.issued",
      eventId: "Q-1",
      occurredAt: "2026-11-20T14:00:00Z",
      orderId: "SELL-1",
      account: investor,
      side: "SELL",
      amountBase: "100000000000000000",
      priceBase: "2000000000",
      priceAsOf: "2026-11-20T14:00:00Z",
      expiresAt: "2026-11-20T14:00:30Z",
      chargeBase: "50000",
      minProceedsBase: "200000000",
    });
    const step = engine.apply({
      type: "spot.order.filled",
      eventId: "F-1",
      occurredAt: "2026-11-20T14:00:02Z",
      orderId: "SELL-1",
    });
    expect(step.title).toBe("Reverse spot order filled");
    expect(engine.balanceOf(investor, "dEUR")).toBe(parseBaseUnits("1000000000") + 200_000_000n - 50_000n);
    expect(engine.balanceOf(investor, "tWETH")).toBe(900_000_000_000_000_000n);
    expect(findImbalances(engine.journal)).toEqual([]);
  });

  it("refuses a fill below the stated minimum proceeds", () => {
    const engine = createEngine();
    seed(engine, investor, "tWETH", "1000000000000000000", "S-1");
    seed(engine, accounts().dealer, "dEUR", "1000000000", "S-2");
    engine.apply({
      type: "spot.quote.issued",
      eventId: "Q-1",
      occurredAt: "2026-11-20T14:00:00Z",
      orderId: "SELL-2",
      account: investor,
      side: "SELL",
      amountBase: "100000000000000000",
      priceBase: "2000000000",
      priceAsOf: "2026-11-20T14:00:00Z",
      expiresAt: "2026-11-20T14:00:30Z",
      chargeBase: "50000",
      minProceedsBase: "200000001",
    });
    expect(() =>
      engine.apply({
        type: "spot.order.filled",
        eventId: "F-1",
        occurredAt: "2026-11-20T14:00:02Z",
        orderId: "SELL-2",
      }),
    ).toThrowError(DealingError);
  });
});

describe("fund cancellations", () => {
  it("releases reserved cash when a subscription is cancelled", () => {
    const engine = createEngine();
    seed(engine, investor, "dEUR", "1000000000", "S-1");
    engine.apply({
      type: "fund.subscription.requested",
      eventId: "FQ-1",
      occurredAt: "2026-11-20T15:00:00Z",
      orderId: "FUND-1",
      account: investor,
      cashBase: "300000000",
      cutoffTimeUtc: "16:00",
      indicativeNavBase: "100000000",
    });
    expect(engine.balanceOf(investor, "dEUR")).toBe(700_000_000n);
    expect(engine.balanceOf(escrow, "dEUR")).toBe(300_000_000n);
    engine.apply({
      type: "fund.subscription.cancelled",
      eventId: "FC-1",
      occurredAt: "2026-11-20T15:30:00Z",
      orderId: "FUND-1",
      reason: "investor_cancellation",
    });
    expect(engine.balanceOf(investor, "dEUR")).toBe(1_000_000_000n);
    expect(engine.balanceOf(escrow, "dEUR")).toBe(0n);
    expect(engine.order("FUND-1").status).toBe("CANCELLED");
    expect(findImbalances(engine.journal)).toEqual([]);
  });

  it("returns reserved units when a redemption is cancelled", () => {
    const engine = createEngine();
    seed(engine, investor, "dEUR", "1000000000", "S-1");
    engine.apply({
      type: "fund.subscription.requested",
      eventId: "FQ-1",
      occurredAt: "2026-11-20T15:00:00Z",
      orderId: "FUND-1",
      account: investor,
      cashBase: "300000000",
      cutoffTimeUtc: "16:00",
      indicativeNavBase: "100000000",
    });
    engine.apply({
      type: "nav.observed",
      eventId: "NAV-1",
      occurredAt: "2026-11-20T17:00:00Z",
      assetId: "eFUND",
      valuationDate: "2026-11-20",
      navBase: "96000000",
      sourceTime: "2026-11-20T17:00:00Z",
      revision: 1,
      signer: "issuer-nav-signer",
    });
    engine.apply({
      type: "fund.subscription.allocated",
      eventId: "FA-1",
      occurredAt: "2026-11-20T17:01:00Z",
      orderId: "FUND-1",
    });
    expect(engine.balanceOf(investor, "eFUND")).toBe(3_125_000n);
    engine.apply({
      type: "fund.redemption.requested",
      eventId: "RQ-1",
      occurredAt: "2026-11-20T17:05:00Z",
      orderId: "RED-1",
      account: investor,
      unitsBase: "1000000",
      cutoffTimeUtc: "16:00",
    });
    expect(engine.balanceOf(escrow, "eFUND")).toBe(1_000_000n);
    engine.apply({
      type: "fund.redemption.cancelled",
      eventId: "RC-1",
      occurredAt: "2026-11-23T10:00:00Z",
      orderId: "RED-1",
      reason: "investor_cancellation",
    });
    expect(engine.balanceOf(investor, "eFUND")).toBe(3_125_000n);
    expect(engine.balanceOf(escrow, "eFUND")).toBe(0n);
    expect(findImbalances(engine.journal)).toEqual([]);
  });

  it("refuses a second cancellation of the same order", () => {
    const engine = createEngine();
    seed(engine, investor, "dEUR", "1000000000", "S-1");
    engine.apply({
      type: "fund.subscription.requested",
      eventId: "FQ-1",
      occurredAt: "2026-11-20T15:00:00Z",
      orderId: "FUND-1",
      account: investor,
      cashBase: "300000000",
      cutoffTimeUtc: "16:00",
      indicativeNavBase: "100000000",
    });
    engine.apply({
      type: "fund.subscription.cancelled",
      eventId: "FC-1",
      occurredAt: "2026-11-20T15:30:00Z",
      orderId: "FUND-1",
    });
    expect(() =>
      engine.apply({
        type: "fund.subscription.cancelled",
        eventId: "FC-2",
        occurredAt: "2026-11-20T15:31:00Z",
        orderId: "FUND-1",
      }),
    ).toThrowError(DealingError);
  });
});
