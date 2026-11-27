/**
 * Fixture runners: build the ordered event log from a frozen scenario, fold it
 * through the settlement engine and capture the named checkpoints.
 */
import type { AssetId } from "./assets.js";
import type { DealingCalendar } from "./calendar.js";
import { validateCalendar, weekdayCodeOfDate } from "./calendar.js";
import type {
  EngineAccounts,
  EngineConfig,
  FundRedemptionState,
  FundSubscriptionState,
  PortfolioSnapshot,
  SettlementEngine as SettlementEngineType,
  SpotOrderState,
} from "./engine.js";
import { SettlementEngine } from "./engine.js";
import type { SettlementEvent } from "./events.js";
import { assignDealingDay } from "./calendar.js";
import type { JournalAccount } from "./journal.js";
import { parseBaseUnits } from "./money.js";
import {
  buildFundReceipt,
  buildRedemptionReceipt,
  buildSpotReceipt,
  type Receipt,
} from "./receipts.js";
import type {
  BoundaryCasesFixture,
  CalendarFixture,
  G01RedemptionScenario,
  G01Scenario,
  P01Scenario,
} from "./scenario-types.js";
import { formatUtcInstant, parseUtcDate } from "./time.js";

export interface InvestorAccounts {
  readonly investor: JournalAccount;
}

export function investorAccount(accountId: string): JournalAccount {
  return { kind: "investor", accountId };
}

export function engineAccountsFromFixture(
  accounts: G01Scenario["accounts"],
): EngineAccounts {
  return {
    dealer: { kind: "dealer", accountId: accounts.dealerInventoryId },
    feeRecipient: { kind: "feeRecipient", accountId: accounts.feeRecipientId },
    issuerTreasury: { kind: "issuerTreasury", accountId: accounts.issuerTreasuryId },
    issuanceControl: { kind: "issuanceControl", accountId: accounts.issuanceControlId },
    fundEscrow: { kind: "fundEscrow", accountId: accounts.fundEscrowId },
  };
}

export function calendarFromFixture(fixture: CalendarFixture): DealingCalendar {
  return validateCalendar({
    calendarId: fixture.calendarId,
    version: fixture.version,
    timezone: fixture.timezone,
    ...(fixture.dealingDays === undefined ? {} : { dealingDays: fixture.dealingDays }),
    ...(fixture.closedDates === undefined ? {} : { closedDates: fixture.closedDates }),
    ...(fixture.description === undefined ? {} : { description: fixture.description }),
  });
}

export function buildG01Engine(
  scenario: G01Scenario,
  calendar: DealingCalendar,
): SettlementEngine {
  const marks: Partial<Record<AssetId, bigint>> = {
    tWETH: parseBaseUnits(scenario.marks.tWETH),
    eFUND: parseBaseUnits(scenario.marks.eFUND),
  };
  const config: EngineConfig = {
    calendar,
    accounts: engineAccountsFromFixture(scenario.accounts),
    marks,
  };
  return new SettlementEngine(config);
}

export function g01Events(scenario: G01Scenario): SettlementEvent[] {
  const investor = investorAccount(scenario.accounts.investorId);
  return [
    {
      type: "account.seeded",
      eventId: "G01-EV-01",
      occurredAt: scenario.seed.occurredAt,
      account: investor,
      assetId: scenario.seed.assetId,
      amountBase: scenario.seed.amountBase,
    },
    {
      type: "spot.quote.issued",
      eventId: "G01-EV-02",
      occurredAt: scenario.spot.quoteIssuedAt,
      orderId: scenario.spot.orderId,
      account: investor,
      side: scenario.spot.side,
      amountBase: scenario.spot.amountBase,
      priceBase: scenario.spot.priceBase,
      priceAsOf: scenario.spot.priceAsOf,
      expiresAt: scenario.spot.expiresAt,
      chargeBase: scenario.spot.chargeBase,
    },
    {
      type: "spot.order.filled",
      eventId: "G01-EV-03",
      occurredAt: scenario.spot.filledAt,
      orderId: scenario.spot.orderId,
    },
    {
      type: "fund.subscription.requested",
      eventId: "G01-EV-04",
      occurredAt: scenario.fund.requestedAt,
      orderId: scenario.fund.orderId,
      account: investor,
      cashBase: scenario.fund.cashBase,
      cutoffTimeUtc: scenario.fund.cutoffTimeUtc,
      indicativeNavBase: scenario.fund.indicativeNavBase,
    },
    {
      type: "nav.observed",
      eventId: "G01-EV-05",
      occurredAt: scenario.fund.nav.sourceTime,
      assetId: "eFUND",
      valuationDate: scenario.fund.nav.valuationDate,
      navBase: scenario.fund.nav.navBase,
      sourceTime: scenario.fund.nav.sourceTime,
      revision: scenario.fund.nav.revision,
      signer: scenario.fund.nav.signer,
    },
    {
      type: "fund.subscription.allocated",
      eventId: "G01-EV-06",
      occurredAt: scenario.fund.allocatedAt,
      orderId: scenario.fund.orderId,
    },
  ];
}

export interface G01Run {
  readonly engine: SettlementEngine;
  readonly checkpoints: readonly PortfolioSnapshot[];
  readonly receipts: readonly Receipt[];
  readonly finalPortfolio: PortfolioSnapshot;
}

/** Runs the G01 scenario and captures the four named checkpoints. */
export function runG01(
  scenario: G01Scenario,
  calendarFixture: CalendarFixture,
): G01Run {
  const calendar = calendarFromFixture(calendarFixture);
  const engine = buildG01Engine(scenario, calendar);
  const investor = investorAccount(scenario.accounts.investorId);
  const events = g01Events(scenario);
  const checkpoints: PortfolioSnapshot[] = [];

  const checkpointByEvent: Record<string, { label: string; at: string }> = {
    "G01-EV-01": { label: scenario.expected.checkpoints[0]?.label ?? "Seed", at: scenario.seed.occurredAt },
    "G01-EV-03": {
      label: scenario.expected.checkpoints[1]?.label ?? "Spot fill",
      at: scenario.spot.filledAt,
    },
    "G01-EV-04": {
      label: scenario.expected.checkpoints[2]?.label ?? "Fund request",
      at: scenario.fund.requestedAt,
    },
    "G01-EV-06": {
      label: scenario.expected.checkpoints[3]?.label ?? "Allocation",
      at: scenario.fund.allocatedAt,
    },
  };

  for (const event of events) {
    engine.apply(event);
    const checkpoint = checkpointByEvent[event.eventId];
    if (checkpoint !== undefined) {
      checkpoints.push(
        engine.portfolioSnapshot({
          investor,
          label: checkpoint.label,
          at: checkpoint.at,
        }),
      );
    }
  }

  const receipts = g01ReceiptsForEngine(
    engine,
    scenario.spot.orderId,
    scenario.fund.orderId,
  );
  const finalPortfolio = engine.portfolioSnapshot({
    investor,
    label: "Closing portfolio at fixture marks",
    at: scenario.fund.allocatedAt,
  });
  return { engine, checkpoints, receipts, finalPortfolio };
}

/** Builds the G01 receipts from a settled engine, shared by CLI and browser. */
export function g01ReceiptsForEngine(
  engine: SettlementEngineType,
  spotOrderId: string,
  fundOrderId: string,
): Receipt[] {
  const spotOrder = engine.order(spotOrderId);
  const fundOrder = engine.order(fundOrderId);
  if (spotOrder.kind !== "spot") {
    throw new Error(`Order ${spotOrderId} is not a spot order`);
  }
  if (fundOrder.kind !== "fund-subscription") {
    throw new Error(`Order ${fundOrderId} is not a fund subscription`);
  }
  return [
    buildSpotReceipt(spotOrder as SpotOrderState),
    buildFundReceipt(fundOrder as FundSubscriptionState),
  ];
}

export interface G01RedemptionRun {
  readonly engine: SettlementEngine;
  readonly receipt: Receipt;
  readonly finalizedPortfolio: PortfolioSnapshot;
  readonly unitsBase: string;
  readonly spendableCashBase: string;
}

/**
 * Appends the separate redemption case to a completed G01 replay. The
 * redemption reserves units before the next applicable NAV, then burns and
 * pays atomically.
 */
export function runG01Redemption(
  scenario: G01RedemptionScenario,
  completedEngine: SettlementEngine,
  investorId: string,
): G01RedemptionRun {
  const engine = completedEngine.clone();
  const investor = investorAccount(investorId);
  const events: SettlementEvent[] = [
    {
      type: "fund.redemption.requested",
      eventId: "G01-R-EV-01",
      occurredAt: scenario.requestedAt,
      orderId: scenario.orderId,
      account: investor,
      unitsBase: scenario.unitsBase,
      cutoffTimeUtc: scenario.cutoffTimeUtc,
    },
    {
      type: "nav.observed",
      eventId: "G01-R-EV-02",
      occurredAt: scenario.nav.sourceTime,
      assetId: "eFUND",
      valuationDate: scenario.nav.valuationDate,
      navBase: scenario.nav.navBase,
      sourceTime: scenario.nav.sourceTime,
      revision: scenario.nav.revision,
      signer: scenario.nav.signer,
    },
    {
      type: "fund.redemption.settled",
      eventId: "G01-R-EV-03",
      occurredAt: scenario.settledAt,
      orderId: scenario.orderId,
    },
  ];
  engine.applyAll(events);
  const order = engine.order(scenario.orderId);
  if (order.kind !== "fund-redemption") {
    throw new Error("Unexpected order kind in redemption replay");
  }
  const finalizedPortfolio = engine.portfolioSnapshot({
    investor,
    label: "After redemption at the next applicable NAV",
    at: scenario.settledAt,
  });
  return {
    engine,
    receipt: buildRedemptionReceipt(order as FundRedemptionState),
    finalizedPortfolio,
    unitsBase: scenario.expected.eFundUnitsBase,
    spendableCashBase: scenario.expected.spendableCashBase,
  };
}

export interface P01OrderAssignment {
  readonly orderId: string;
  readonly requestedAt: string;
  readonly baselineDealingDate: string;
  readonly candidateDealingDate: string;
}

/**
 * Assigns the dealing date for each P01 order under both policy branches.
 * Full two-branch allocation replay lands in step S03; the assignment and unit
 * math are already deterministic here.
 */
export function p01OrderAssignments(
  scenario: P01Scenario,
  calendarFixture: CalendarFixture,
): P01OrderAssignment[] {
  const calendar = calendarFromFixture(calendarFixture);
  return scenario.orders.map((order) => {
    const weekday = weekdayCodeOfDate(order.requestedAt.slice(0, 10));
    const baselineCutoff =
      scenario.baselinePolicy.weekdayCutoffs[weekday] ?? "16:00";
    const candidateCutoff =
      scenario.candidatePolicy.weekdayCutoffs[weekday] ?? "16:00";
    const baseline = assignDealingDay({
      requestedAt: order.requestedAt,
      cutoffTimeUtc: baselineCutoff,
      calendar,
    });
    const candidate = assignDealingDay({
      requestedAt: order.requestedAt,
      cutoffTimeUtc: candidateCutoff,
      calendar,
    });
    return {
      orderId: order.orderId,
      requestedAt: order.requestedAt,
      baselineDealingDate: baseline.dealingDate,
      candidateDealingDate: candidate.dealingDate,
    };
  });
}

export interface BoundaryCaseResult {
  readonly caseId: string;
  readonly description: string;
  readonly calendarId: string;
  readonly requestedAt: string;
  readonly baseline: { dealingDate: string; reason: string };
  readonly candidate: { dealingDate: string; reason: string };
  readonly expected: BoundaryCasesFixture["cases"][number]["expected"];
  readonly pass: boolean;
}

/** Evaluates every A02 boundary dealing case against both cutoff policies. */
export function runBoundaryCases(
  fixture: BoundaryCasesFixture,
  calendars: readonly CalendarFixture[],
): readonly BoundaryCaseResult[] {
  const calendarMap = new Map<string, DealingCalendar>();
  for (const calendarFixture of calendars) {
    calendarMap.set(calendarFixture.calendarId, calendarFromFixture(calendarFixture));
  }
  return fixture.cases.map((boundaryCase) => {
    const calendar = calendarMap.get(boundaryCase.calendarId);
    if (calendar === undefined) {
      throw new Error(`Missing calendar ${boundaryCase.calendarId}`);
    }
    const weekday = weekdayCodeOfDate(boundaryCase.requestedAt.slice(0, 10));
    const baselineCutoff =
      fixture.cutoffs.baseline[weekday] ?? fixture.baselineCutoffTimeUtc;
    const candidateCutoff =
      fixture.cutoffs.candidate[weekday] ?? fixture.candidateCutoffTimeUtc;
    const baseline = assignDealingDay({
      requestedAt: boundaryCase.requestedAt,
      cutoffTimeUtc: baselineCutoff,
      calendar,
    });
    const candidate = assignDealingDay({
      requestedAt: boundaryCase.requestedAt,
      cutoffTimeUtc: candidateCutoff,
      calendar,
    });
    const pass =
      baseline.dealingDate === boundaryCase.expected.baselineDealingDate &&
      candidate.dealingDate === boundaryCase.expected.candidateDealingDate &&
      baseline.reason === boundaryCase.expected.baselineReason &&
      candidate.reason === boundaryCase.expected.candidateReason;
    return {
      caseId: boundaryCase.caseId,
      description: boundaryCase.description,
      calendarId: boundaryCase.calendarId,
      requestedAt: boundaryCase.requestedAt,
      baseline: { dealingDate: baseline.dealingDate, reason: baseline.reason },
      candidate: { dealingDate: candidate.dealingDate, reason: candidate.reason },
      expected: boundaryCase.expected,
      pass,
    };
  });
}

/** Helper used by tests and the evidence builder for fixed comparison dates. */
export function utcDatePlusDays(date: string, days: number): string {
  return formatUtcInstant(parseUtcDate(date) + days * 86_400_000).slice(0, 10);
}
