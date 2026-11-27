/**
 * Deterministic two-branch replay for fixture P01 (the Friday cutoff experiment).
 *
 * Both branches replay the same ordered intents and external observations
 * through the same pure dealing engine. The only variable is the confirmed
 * policy patch. Each branch runs in isolated engine state and records its policy
 * hash, event-log hash and per-order results.
 */
import {
  ENGINE_VERSION,
  SettlementEngine,
  assignDealingDay,
  calendarFromFixture,
  hashJson,
  parseBaseUnits,
  policyDigest,
  weekdayCodeOfDate,
  DEFAULT_CUTOFF_TIME_UTC,
  type CalendarFixture,
  type DealingCalendar,
  type EngineAccounts,
  type FundDealingPolicy,
  type FundSubscriptionState,
  type JournalAccount,
  type NavFixture,
  type P01OrderFixture,
  type P01Scenario,
  type PolicyWeekday,
  type SettlementEvent,
} from "@eurorollup/dealing";
import { POLICY_LAB_VERSION } from "./version.js";
import type {
  BranchOrderResult,
  BranchResult,
  BranchSnapshot,
  OrderChange,
  P01BoundaryCaseFixture,
  P01BoundaryFixture,
  P01Comparison,
  BoundaryCaseResult,
} from "./types.js";

export const P01_GENESIS_AT = "2026-11-19T00:00:00Z";
export const P01_FRIDAY_CLOSE = "2026-11-20T17:01:00Z";
export const P01_MONDAY_CLOSE = "2026-11-23T17:01:00Z";

const P01_ENGINE_ACCOUNTS: EngineAccounts = {
  dealer: { kind: "dealer", accountId: "dealer-inventory" },
  feeRecipient: { kind: "feeRecipient", accountId: "fee-recipient" },
  issuerTreasury: { kind: "issuerTreasury", accountId: "issuer-treasury" },
  issuanceControl: { kind: "issuanceControl", accountId: "issuance-control" },
  fundEscrow: { kind: "fundEscrow", accountId: "fund-escrow" },
};

function investorAccount(accountId: string): JournalAccount {
  return { kind: "investor", accountId };
}

export function policyFromFixture(
  fixturePolicy: P01Scenario["baselinePolicy"] | P01Scenario["candidatePolicy"],
): FundDealingPolicy {
  const cutoffs: Record<PolicyWeekday, string> = {
    MON: fixturePolicy.weekdayCutoffs["MON"] ?? DEFAULT_CUTOFF_TIME_UTC,
    TUE: fixturePolicy.weekdayCutoffs["TUE"] ?? DEFAULT_CUTOFF_TIME_UTC,
    WED: fixturePolicy.weekdayCutoffs["WED"] ?? DEFAULT_CUTOFF_TIME_UTC,
    THU: fixturePolicy.weekdayCutoffs["THU"] ?? DEFAULT_CUTOFF_TIME_UTC,
    FRI: fixturePolicy.weekdayCutoffs["FRI"] ?? DEFAULT_CUTOFF_TIME_UTC,
  };
  return {
    policyId: "eFUND-dealing",
    assetId: "eFUND",
    version: fixturePolicy.version,
    weekdayCutoffs: cutoffs,
  };
}

/** Cutoff that governs a request instant (weekdays use the policy map). */
export function cutoffForRequestInstant(policy: FundDealingPolicy, requestedAt: string): string {
  const weekday = weekdayCodeOfDate(requestedAt.slice(0, 10));
  if (weekday === "SAT" || weekday === "SUN") {
    return DEFAULT_CUTOFF_TIME_UTC;
  }
  return policy.weekdayCutoffs[weekday];
}

export interface P01ReplaySpec {
  readonly fixture: P01Scenario;
  readonly calendar: DealingCalendar;
  readonly policy: FundDealingPolicy;
  readonly orders: readonly P01OrderFixture[];
  readonly navs: readonly NavFixture[];
  readonly snapshotPoints: readonly { readonly label: string; readonly at: string }[];
}

/**
 * Builds the ordered event plan for one branch: seeds, intents, NAV observations
 * and the allocations that are possible once an authorized NAV exists for the
 * assigned dealing day.
 */
export function buildP01ReplayEvents(spec: P01ReplaySpec): SettlementEvent[] {
  const events: Array<{ event: SettlementEvent; rank: number }> = [];
  const investorIds = Object.keys(spec.fixture.initialBalances).sort();
  for (const investorId of investorIds) {
    const balances = spec.fixture.initialBalances[investorId];
    const cashBase = balances?.["dEUR"];
    if (cashBase === undefined) {
      continue;
    }
    events.push({
      rank: 0,
      event: {
        type: "account.seeded",
        eventId: `P01-SEED-${investorId}`,
        occurredAt: P01_GENESIS_AT,
        account: investorAccount(investorId),
        assetId: "dEUR",
        amountBase: cashBase,
      },
    });
  }
  for (const order of spec.orders) {
    events.push({
      rank: 1,
      event: {
        type: "fund.subscription.requested",
        eventId: `P01-REQ-${order.orderId}`,
        occurredAt: order.requestedAt,
        orderId: order.orderId,
        account: investorAccount(order.investorId),
        cashBase: order.cashBase,
        cutoffTimeUtc: cutoffForRequestInstant(spec.policy, order.requestedAt),
        indicativeNavBase: "100000000",
      },
    });
  }
  for (const nav of spec.navs) {
    events.push({
      rank: 2,
      event: {
        type: "nav.observed",
        eventId: `P01-NAV-eFUND-${nav.valuationDate}`,
        occurredAt: nav.sourceTime,
        assetId: "eFUND",
        valuationDate: nav.valuationDate,
        navBase: nav.navBase,
        sourceTime: nav.sourceTime,
        revision: nav.revision,
        signer: nav.signer,
      },
    });
  }
  for (const order of spec.orders) {
    const cutoff = cutoffForRequestInstant(spec.policy, order.requestedAt);
    const assignment = assignDealingDay({
      requestedAt: order.requestedAt,
      cutoffTimeUtc: cutoff,
      calendar: spec.calendar,
    });
    const nav = spec.navs.find((item) => item.valuationDate === assignment.dealingDate);
    if (nav === undefined) {
      continue;
    }
    const allocationAt = `${assignment.dealingDate}T17:01:00Z`;
    if (allocationAt < nav.sourceTime) {
      continue;
    }
    events.push({
      rank: 3,
      event: {
        type: "fund.subscription.allocated",
        eventId: `P01-ALLOC-${order.orderId}`,
        occurredAt: allocationAt,
        orderId: order.orderId,
      },
    });
  }
  events.sort((left, right) => {
    if (left.event.occurredAt !== right.event.occurredAt) {
      return left.event.occurredAt < right.event.occurredAt ? -1 : 1;
    }
    if (left.rank !== right.rank) {
      return left.rank - right.rank;
    }
    return left.event.eventId < right.event.eventId ? -1 : 1;
  });
  return events.map((item) => item.event);
}

function aggregateSnapshot(engine: SettlementEngine, investorIds: readonly string[]): BranchSnapshot {
  let spendableBase = 0n;
  let reservedBase = 0n;
  let unitsBase = 0n;
  for (const investorId of investorIds) {
    spendableBase += engine.balanceOf(investorAccount(investorId), "dEUR");
    unitsBase += engine.balanceOf(investorAccount(investorId), "eFUND");
  }
  for (const order of engine.orders()) {
    if (order.kind === "fund-subscription" && order.status === "AWAITING_NAV") {
      reservedBase += order.reservedCashBase;
    }
  }
  return {
    spendableBase: spendableBase.toString(),
    reservedBase: reservedBase.toString(),
    unitsBase: unitsBase.toString(),
  };
}

function reservedCashByOrder(
  engine: SettlementEngine,
  orders: readonly P01OrderFixture[],
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const order of orders) {
    const state = engine.order(order.orderId);
    if (state.kind === "fund-subscription" && state.status === "AWAITING_NAV") {
      result[order.orderId] = state.reservedCashBase.toString();
    } else {
      result[order.orderId] = "0";
    }
  }
  return result;
}

/** Replays one policy branch and returns its results and branch identifiers. */
export function replayP01Branch(spec: P01ReplaySpec, branchId: "baseline" | "candidate"): BranchResult {
  const engine = new SettlementEngine({
    calendar: spec.calendar,
    accounts: P01_ENGINE_ACCOUNTS,
    marks: { tWETH: 2_000_000_000n, eFUND: 100_000_000n },
  });
  const events = buildP01ReplayEvents(spec);
  const investorIds = Object.keys(spec.fixture.initialBalances).sort();
  const captured: Record<string, { snapshot: BranchSnapshot; reserved: Record<string, string> }> = {};
  let index = 0;
  for (const point of spec.snapshotPoints) {
    while (index < events.length && events[index]!.occurredAt <= point.at) {
      engine.apply(events[index]!);
      index += 1;
    }
    captured[point.label] = {
      snapshot: aggregateSnapshot(engine, investorIds),
      reserved: reservedCashByOrder(engine, spec.orders),
    };
  }
  while (index < events.length) {
    engine.apply(events[index]!);
    index += 1;
  }
  const fridayReserved = captured["fridayClose"]?.reserved ?? {};
  const orders: BranchOrderResult[] = spec.orders.map((order) => {
    const state = engine.order(order.orderId);
    if (state.kind !== "fund-subscription") {
      throw new Error(`Order ${order.orderId} is not a fund subscription in the replay`);
    }
    const subscription = state as FundSubscriptionState;
    return {
      orderId: order.orderId,
      investorId: order.investorId,
      requestedAt: order.requestedAt,
      dealingDate: subscription.dealingDate,
      dealingReason: subscription.dealingReason,
      unitsBase: subscription.allocation === undefined ? null : subscription.allocation.unitsBase.toString(),
      navBase: subscription.allocation === undefined ? null : subscription.allocation.navBase.toString(),
      pending: subscription.status === "AWAITING_NAV",
      reservedAtFridayCloseBase: fridayReserved[order.orderId] ?? "0",
    };
  });
  const snapshots: Record<string, BranchSnapshot> = {};
  for (const [label, entry] of Object.entries(captured)) {
    snapshots[label] = entry.snapshot;
  }
  return {
    branchId,
    policy: spec.policy,
    policyHash: policyDigest(spec.policy),
    eventLogHash: hashJson(events),
    orders,
    snapshots,
  };
}

export interface RunP01ComparisonParams {
  readonly fixture: P01Scenario;
  readonly calendarFixture: CalendarFixture;
  readonly baselinePolicy: FundDealingPolicy;
  readonly candidatePolicy: FundDealingPolicy;
}

/** Runs the P01 Friday cutoff comparison across both policy branches. */
export function runP01Comparison(params: RunP01ComparisonParams): P01Comparison {
  const calendar = calendarFromFixture(params.calendarFixture);
  const snapshotPoints = [
    { label: "fridayClose", at: P01_FRIDAY_CLOSE },
    { label: "mondayClose", at: P01_MONDAY_CLOSE },
  ];
  const baseSpec: P01ReplaySpec = {
    fixture: params.fixture,
    calendar,
    policy: params.baselinePolicy,
    orders: params.fixture.orders,
    navs: params.fixture.navs,
    snapshotPoints,
  };
  const baseline = replayP01Branch(baseSpec, "baseline");
  const candidate = replayP01Branch(
    { ...baseSpec, policy: params.candidatePolicy },
    "candidate",
  );

  const orderChanges: OrderChange[] = params.fixture.orders.map((order) => {
    const baseOrder = baseline.orders.find((item) => item.orderId === order.orderId);
    const candidateOrder = candidate.orders.find((item) => item.orderId === order.orderId);
    if (baseOrder === undefined || candidateOrder === undefined) {
      throw new Error(`Order ${order.orderId} missing from the branch replay`);
    }
    const changesDealingDate = baseOrder.dealingDate !== candidateOrder.dealingDate;
    const baselineUnits = baseOrder.unitsBase;
    const candidateUnits = candidateOrder.unitsBase;
    const unitsDelta =
      baselineUnits === null || candidateUnits === null
        ? null
        : (BigInt(candidateUnits) - BigInt(baselineUnits)).toString();
    const reason = changesDealingDate
      ? `Misses the proposed ${params.candidatePolicy.weekdayCutoffs.FRI} UTC Friday cutoff; moves to ${candidateOrder.dealingDate}`
      : `Settles on ${baseOrder.dealingDate} under both policies`;
    return {
      orderId: order.orderId,
      requestedAt: order.requestedAt,
      baselineDealingDate: baseOrder.dealingDate,
      candidateDealingDate: candidateOrder.dealingDate,
      baselineUnitsBase: baselineUnits,
      candidateUnitsBase: candidateUnits,
      unitsDeltaBase: unitsDelta,
      reservedAtFridayCloseBase: candidateOrder.reservedAtFridayCloseBase,
      changesDealingDate,
      reason,
    };
  });

  const affectedOrders = orderChanges.filter((change) => change.changesDealingDate).length;
  const fridayBase = baseline.snapshots["fridayClose"]?.reservedBase ?? "0";
  const fridayCandidate = candidate.snapshots["fridayClose"]?.reservedBase ?? "0";
  const extraReservedAtFridayCloseBase = (
    parseBaseUnits(fridayCandidate) - parseBaseUnits(fridayBase)
  ).toString();

  const unitDeltaByOrder: Record<string, string | null> = {};
  const changedOrderIds: string[] = [];
  for (const change of orderChanges) {
    unitDeltaByOrder[change.orderId] = change.unitsDeltaBase;
    if (change.changesDealingDate) {
      changedOrderIds.push(change.orderId);
    }
  }

  const digestPayload = {
    schemaVersion: "1.0.0",
    fixtureId: params.fixture.fixtureId,
    fixtureVersion: params.fixture.fixtureVersion,
    fixtureHash: hashJson(params.fixture),
    calendarHash: hashJson(params.calendarFixture),
    engineVersion: ENGINE_VERSION,
    policyLabVersion: POLICY_LAB_VERSION,
    baseline: {
      policy: baseline.policy,
      policyHash: baseline.policyHash,
      eventLogHash: baseline.eventLogHash,
      orders: baseline.orders,
      snapshots: baseline.snapshots,
    },
    candidate: {
      policy: candidate.policy,
      policyHash: candidate.policyHash,
      eventLogHash: candidate.eventLogHash,
      orders: candidate.orders,
      snapshots: candidate.snapshots,
    },
    orderChanges,
    affectedOrders,
    totalOrders: params.fixture.orders.length,
    extraReservedAtFridayCloseBase,
  };

  return {
    schemaVersion: "1.0.0",
    fixtureId: params.fixture.fixtureId,
    fixtureVersion: params.fixture.fixtureVersion,
    engineVersion: ENGINE_VERSION,
    policyLabVersion: POLICY_LAB_VERSION,
    fixtureHash: digestPayload.fixtureHash,
    calendarHash: digestPayload.calendarHash,
    baseline,
    candidate,
    orderChanges,
    affectedOrders,
    totalOrders: params.fixture.orders.length,
    extraReservedAtFridayCloseBase,
    deltas: {
      changedOrderIds,
      unitDeltaByOrder,
      extraReservedAtFridayCloseBase,
    },
    comparisonDigest: hashJson(digestPayload),
  };
}

export interface RunP01BoundaryParams {
  readonly fixture: P01Scenario;
  readonly boundaryFixture: P01BoundaryFixture;
  readonly calendars: Readonly<Record<string, CalendarFixture>>;
  readonly baselinePolicy: FundDealingPolicy;
  readonly candidatePolicy: FundDealingPolicy;
  /** Optional NAV values for synthetic dates (defaults to 99.00 for the Tuesday case). */
  readonly navValueBaseByDate?: Readonly<Record<string, string>>;
}

const DEFAULT_EXTRA_NAV_VALUES: Record<string, string> = {
  "2026-11-24": "99000000",
};

/** Evaluates the P01 boundary and exception replay cases. */
export function runP01BoundaryCases(params: RunP01BoundaryParams): BoundaryCaseResult[] {
  const investorId = Object.keys(params.fixture.initialBalances).sort()[0];
  if (investorId === undefined) {
    throw new Error("P01 fixture has no investor accounts");
  }
  return params.boundaryFixture.cases.map((caseFixture: P01BoundaryCaseFixture) => {
    const calendarFixture = params.calendars[caseFixture.calendarId];
    if (calendarFixture === undefined) {
      throw new Error(`Unknown calendar ${caseFixture.calendarId} in the boundary case`);
    }
    const calendar = calendarFromFixture(calendarFixture);
    const order: P01OrderFixture = {
      orderId: `P01-BORDER-${caseFixture.caseId}`,
      investorId,
      cashBase: "300000000",
      requestedAt: caseFixture.requestedAt,
    };
    const navs: NavFixture[] = caseFixture.publishNavDates.map((date) => {
      const fixtureNav = params.fixture.navs.find((nav) => nav.valuationDate === date);
      if (fixtureNav !== undefined) {
        return fixtureNav;
      }
      const extraValue =
        params.navValueBaseByDate?.[date] ?? DEFAULT_EXTRA_NAV_VALUES[date];
      if (extraValue === undefined) {
        throw new Error(`No NAV value available for ${date} in boundary case ${caseFixture.caseId}`);
      }
      return {
        valuationDate: date,
        navBase: extraValue,
        sourceTime: `${date}T17:00:00Z`,
        revision: 1,
        signer: "issuer-nav-signer",
      };
    });
    const evaluate = (policy: FundDealingPolicy): BranchResult =>
      replayP01Branch(
        {
          fixture: params.fixture,
          calendar,
          policy,
          orders: [order],
          navs,
          snapshotPoints: [],
        },
        "baseline",
      );
    const baselineOrder = evaluate(params.baselinePolicy).orders[0];
    const candidateOrder = evaluate(params.candidatePolicy).orders[0];
    if (baselineOrder === undefined || candidateOrder === undefined) {
      throw new Error(`Boundary case ${caseFixture.caseId} produced no order result`);
    }
    const expected = caseFixture.expected;
    const pass =
      baselineOrder.dealingDate === expected.baselineDealingDate &&
      candidateOrder.dealingDate === expected.candidateDealingDate &&
      (expected.baselineUnitsBase === undefined ||
        baselineOrder.unitsBase === expected.baselineUnitsBase) &&
      (expected.candidateUnitsBase === undefined ||
        candidateOrder.unitsBase === expected.candidateUnitsBase) &&
      (expected.candidatePending === undefined ||
        candidateOrder.pending === expected.candidatePending);
    return {
      caseId: caseFixture.caseId,
      description: caseFixture.description,
      requestedAt: caseFixture.requestedAt,
      calendarId: caseFixture.calendarId,
      baseline: {
        dealingDate: baselineOrder.dealingDate,
        unitsBase: baselineOrder.unitsBase,
        pending: baselineOrder.pending,
      },
      candidate: {
        dealingDate: candidateOrder.dealingDate,
        unitsBase: candidateOrder.unitsBase,
        pending: candidateOrder.pending,
        reservedCashBase: candidateOrder.pending ? order.cashBase : "0",
      },
      expected,
      pass,
    };
  });
}
