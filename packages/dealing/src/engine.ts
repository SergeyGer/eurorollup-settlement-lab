/**
 * Deterministic settlement engine.
 *
 * The engine folds ordered domain events into balances, business state, NAV
 * observations and a double-entry journal. It is pure with respect to the
 * fixture clock: every observation time comes from the event, so replaying the
 * same event log always produces the same numbers and the same journal.
 *
 * The engine is shared by the CLI replay, the browser replay (step S01) and
 * later the order worker and the policy-lab simulation worker.
 */
import { ASSETS, CASH_ASSET_ID, FUND_ASSET_ID, SPOT_ASSET_ID } from "./assets.js";
import type { AssetId } from "./assets.js";
import {
  assignDealingDay,
  type DealingAssignmentReason,
  type DealingCalendar,
} from "./calendar.js";
import { DealingError } from "./errors.js";
import type { SettlementEvent } from "./events.js";
import {
  accountKey,
  makeJournalEntry,
  makePosting,
  type JournalAccount,
  type JournalEntry,
  type Posting,
} from "./journal.js";
import {
  SPOT_INVESTOR_CHARGE_BASE,
  allocateCashToUnits,
  formatDisplayAmount,
  parseBaseUnits,
  quoteCash,
  quoteUnits,
} from "./money.js";
import { isBeforeInstant, isFresh, instantDifferenceMs, parseUtcInstant } from "./time.js";

export const SPOT_PRICE_MAX_AGE_MS = 60_000;
export const SPOT_QUOTE_TTL_MS = 30_000;
export const NAV_MAX_AGE_MS = 15 * 60_000;

export interface EngineAccounts {
  readonly dealer: JournalAccount;
  readonly feeRecipient: JournalAccount;
  readonly issuerTreasury: JournalAccount;
  readonly issuanceControl: JournalAccount;
  readonly fundEscrow: JournalAccount;
}

export interface EngineConfig {
  readonly calendar: DealingCalendar;
  readonly accounts: EngineAccounts;
  readonly marks: Partial<Record<AssetId, bigint>>;
}

export interface NavObservation {
  readonly assetId: AssetId;
  readonly valuationDate: string;
  readonly navBase: bigint;
  readonly sourceTime: string;
  readonly revision: number;
  readonly signer: string;
}

export interface SpotOrderState {
  readonly kind: "spot";
  readonly orderId: string;
  readonly account: JournalAccount;
  readonly status: "QUOTED" | "FILLED";
  readonly side: "BUY" | "SELL";
  /** Quote input amount: cash for BUY, asset units for SELL. */
  readonly amountBase: bigint;
  readonly priceBase: bigint;
  readonly priceAsOf: string;
  readonly expiresAt: string;
  readonly chargeBase: bigint;
  readonly quotedAt: string;
  readonly filledAt?: string;
  readonly assetBase?: bigint;
  readonly cashBase?: bigint;
}

export interface AllocationRecord {
  readonly unitsBase: bigint;
  readonly cashConsumedBase: bigint;
  readonly residualCashBase: bigint;
  readonly navBase: bigint;
  readonly navSourceTime: string;
  readonly navRevision: number;
  readonly allocatedAt: string;
}

export interface FundSubscriptionState {
  readonly kind: "fund-subscription";
  readonly orderId: string;
  readonly account: JournalAccount;
  readonly status: "AWAITING_NAV" | "ALLOCATED";
  readonly cashBase: bigint;
  readonly reservedCashBase: bigint;
  readonly indicativeNavBase: bigint;
  readonly requestedAt: string;
  readonly cutoffTimeUtc: string;
  readonly dealingDate: string;
  readonly dealingReason: DealingAssignmentReason;
  readonly requestedDate: string;
  readonly allocation?: AllocationRecord;
}

export interface RedemptionRecord {
  readonly unitsBase: bigint;
  readonly proceedsBase: bigint;
  readonly navBase: bigint;
  readonly navSourceTime: string;
  readonly navRevision: number;
  readonly settledAt: string;
}

export interface FundRedemptionState {
  readonly kind: "fund-redemption";
  readonly orderId: string;
  readonly account: JournalAccount;
  readonly status: "AWAITING_NAV" | "REDEEMED";
  readonly reservedUnitsBase: bigint;
  readonly requestedAt: string;
  readonly cutoffTimeUtc: string;
  readonly dealingDate: string;
  readonly dealingReason: DealingAssignmentReason;
  readonly requestedDate: string;
  readonly redemption?: RedemptionRecord;
}

export type BusinessOrderState =
  | SpotOrderState
  | FundSubscriptionState
  | FundRedemptionState;

export interface AppliedStep {
  readonly stepId: string;
  readonly eventType: SettlementEvent["type"];
  readonly title: string;
  readonly description: string;
  readonly occurredAt: string;
  readonly businessEffects: readonly string[];
  readonly journal: readonly JournalEntry[];
}

export interface PortfolioHolding {
  readonly assetId: AssetId;
  readonly balanceBase: string;
  readonly reservedBase: string;
  readonly markPriceBase: string;
  readonly markedValueBase: string;
  readonly displayDecimals: number;
}

export interface PendingOrderSummary {
  readonly orderId: string;
  readonly kind: "spot" | "fund-subscription" | "fund-redemption";
  readonly status: string;
  readonly dealingDate?: string;
  readonly reason?: string;
}

export interface PortfolioSnapshot {
  readonly label: string;
  readonly investorId: string;
  readonly at: string;
  readonly spendableCashBase: string;
  readonly reservedCashBase: string;
  readonly holdings: readonly PortfolioHolding[];
  readonly totalMarkedValueBase: string;
  readonly pendingOrders: readonly PendingOrderSummary[];
}

interface EngineState {
  balances: Map<string, Map<AssetId, bigint>>;
  orders: Map<string, BusinessOrderState>;
  navs: Map<string, NavObservation>;
  appliedEventIds: Set<string>;
  steps: AppliedStep[];
  journal: JournalEntry[];
  marks: Map<AssetId, bigint>;
}

interface EventApplication {
  title: string;
  description: string;
  businessEffects: string[];
  postings: Posting[];
}

function formatAsset(amount: bigint, assetId: AssetId): string {
  const asset = ASSETS[assetId];
  return `${formatDisplayAmount(amount, asset.decimals, asset.decimals === 18 ? 6 : 2)} ${asset.symbol}`;
}

function formatSigned(amount: bigint, assetId: AssetId): string {
  const prefix = amount >= 0n ? "+" : "-";
  const absolute = amount < 0n ? -amount : amount;
  const asset = ASSETS[assetId];
  return `${prefix}${formatDisplayAmount(absolute, asset.decimals, asset.decimals === 18 ? 6 : 2)} ${asset.symbol}`;
}

function navKey(assetId: AssetId, valuationDate: string): string {
  return `${assetId}:${valuationDate}`;
}

function createEmptyState(config: EngineConfig): EngineState {
  const marks = new Map<AssetId, bigint>();
  for (const [assetId, price] of Object.entries(config.marks)) {
    if (price !== undefined) {
      marks.set(assetId as AssetId, price);
    }
  }
  return {
    balances: new Map(),
    orders: new Map(),
    navs: new Map(),
    appliedEventIds: new Set(),
    steps: [],
    journal: [],
    marks,
  };
}

export class SettlementEngine {
  private readonly config: EngineConfig;
  private state: EngineState;

  constructor(config: EngineConfig) {
    this.config = config;
    this.state = createEmptyState(config);
  }

  /** Deep clone for isolated simulation branches. */
  clone(): SettlementEngine {
    const engine = new SettlementEngine(this.config);
    engine.state = structuredClone(this.state);
    return engine;
  }

  get calendar(): DealingCalendar {
    return this.config.calendar;
  }

  get steps(): readonly AppliedStep[] {
    return this.state.steps;
  }

  get journal(): readonly JournalEntry[] {
    return this.state.journal;
  }

  order(orderId: string): BusinessOrderState {
    const found = this.state.orders.get(orderId);
    if (found === undefined) {
      throw new DealingError("ORDER_NOT_FOUND", `Unknown order ${orderId}`, { orderId });
    }
    return found;
  }

  orders(): readonly BusinessOrderState[] {
    return [...this.state.orders.values()];
  }

  nav(assetId: AssetId, valuationDate: string): NavObservation | undefined {
    return this.state.navs.get(navKey(assetId, valuationDate));
  }

  navs(): readonly NavObservation[] {
    return [...this.state.navs.values()];
  }

  balanceOf(account: JournalAccount, assetId: AssetId): bigint {
    return this.state.balances.get(accountKey(account))?.get(assetId) ?? 0n;
  }

  markOf(assetId: AssetId): bigint {
    const mark = this.state.marks.get(assetId);
    if (mark === undefined) {
      throw new DealingError("INVALID_EVENT", `No mark configured for ${assetId}`);
    }
    return mark;
  }

  /** Applies one ordered event and returns the resulting replay step. */
  apply(event: SettlementEvent): AppliedStep {
    if (this.state.appliedEventIds.has(event.eventId)) {
      throw new DealingError("DUPLICATE_EVENT", `Duplicate event ${event.eventId}`, {
        eventId: event.eventId,
      });
    }
    if (event.occurredAt === undefined || event.eventId === undefined) {
      throw new DealingError("INVALID_EVENT", "Event id and observation time are required");
    }
    parseUtcInstant(event.occurredAt);
    const lastStep = this.state.steps[this.state.steps.length - 1];
    if (lastStep !== undefined && isBeforeInstant(event.occurredAt, lastStep.occurredAt)) {
      throw new DealingError(
        "INVALID_EVENT",
        `Event ${event.eventId} at ${event.occurredAt} is earlier than the previous step at ${lastStep.occurredAt}`,
      );
    }

    const application = this.dispatch(event);
    const journalEntries: JournalEntry[] = [];
    if (application.postings.length > 0) {
      const entry = makeJournalEntry({
        entryId: `${event.eventId}-JE`,
        stepId: event.eventId,
        ...("orderId" in event ? { orderId: event.orderId } : {}),
        occurredAt: event.occurredAt,
        eventType: event.type,
        description: application.description,
        postings: application.postings,
      });
      this.assertEventBalanced(event.eventId, application.postings);
      journalEntries.push(entry);
    }

    const step: AppliedStep = Object.freeze({
      stepId: event.eventId,
      eventType: event.type,
      title: application.title,
      description: application.description,
      occurredAt: event.occurredAt,
      businessEffects: Object.freeze([...application.businessEffects]),
      journal: Object.freeze(journalEntries),
    });

    this.state.steps.push(step);
    this.state.journal.push(...journalEntries);
    this.state.appliedEventIds.add(event.eventId);
    return step;
  }

  applyAll(events: readonly SettlementEvent[]): readonly AppliedStep[] {
    return events.map((event) => this.apply(event));
  }

  /** Projects the investor portfolio for a checkpoint. */
  portfolioSnapshot(params: {
    investor: JournalAccount;
    label: string;
    at: string;
  }): PortfolioSnapshot {
    const investorBalances = this.state.balances.get(accountKey(params.investor));
    const spendableCashBase = investorBalances?.get(CASH_ASSET_ID) ?? 0n;
    const spotBalance = investorBalances?.get(SPOT_ASSET_ID) ?? 0n;
    const fundBalance = investorBalances?.get(FUND_ASSET_ID) ?? 0n;

    let reservedCashBase = 0n;
    let reservedUnitsBase = 0n;
    const pendingOrders: PendingOrderSummary[] = [];
    for (const order of this.state.orders.values()) {
      if (accountKey(order.account) !== accountKey(params.investor)) {
        continue;
      }
      if (order.kind === "fund-subscription" && order.status === "AWAITING_NAV") {
        reservedCashBase += order.reservedCashBase;
        pendingOrders.push({
          orderId: order.orderId,
          kind: order.kind,
          status: order.status,
          dealingDate: order.dealingDate,
          reason: "AWAITING_AUTHORIZED_NAV",
        });
      }
      if (order.kind === "fund-redemption" && order.status === "AWAITING_NAV") {
        reservedUnitsBase += order.reservedUnitsBase;
        pendingOrders.push({
          orderId: order.orderId,
          kind: order.kind,
          status: order.status,
          dealingDate: order.dealingDate,
          reason: "AWAITING_AUTHORIZED_NAV",
        });
      }
      if (order.kind === "spot" && order.status === "QUOTED") {
        pendingOrders.push({ orderId: order.orderId, kind: order.kind, status: order.status });
      }
    }

    const holdings: PortfolioHolding[] = [];
    let markedValueTotal = spendableCashBase + reservedCashBase;
    for (const [assetId, balance] of [
      [SPOT_ASSET_ID, spotBalance] as const,
      [FUND_ASSET_ID, fundBalance] as const,
    ]) {
      const asset = ASSETS[assetId];
      const reserved = assetId === FUND_ASSET_ID ? reservedUnitsBase : 0n;
      const markPrice = this.markOf(assetId);
      const markedValue = quoteCash({
        unitsBase: balance + reserved,
        unitDecimals: asset.decimals,
        priceBase: markPrice,
        priceDecimals: 6,
        cashDecimals: ASSETS[CASH_ASSET_ID].decimals,
      });
      markedValueTotal += markedValue;
      holdings.push({
        assetId,
        balanceBase: balance.toString(),
        reservedBase: reserved.toString(),
        markPriceBase: markPrice.toString(),
        markedValueBase: markedValue.toString(),
        displayDecimals: asset.decimals === 18 ? 6 : 6,
      });
    }

    return {
      label: params.label,
      investorId: params.investor.accountId,
      at: params.at,
      spendableCashBase: spendableCashBase.toString(),
      reservedCashBase: reservedCashBase.toString(),
      holdings,
      totalMarkedValueBase: markedValueTotal.toString(),
      pendingOrders,
    };
  }

  private assertEventBalanced(eventId: string, postings: readonly Posting[]): void {
    const sums = new Map<AssetId, bigint>();
    for (const posting of postings) {
      sums.set(
        posting.assetId,
        (sums.get(posting.assetId) ?? 0n) + parseBaseUnits(posting.amountBase),
      );
    }
    for (const [assetId, sum] of sums) {
      if (sum !== 0n) {
        throw new DealingError(
          "JOURNAL_IMBALANCE",
          `Event ${eventId} does not balance for ${assetId}`,
          { eventId, assetId, sumBase: sum.toString() },
        );
      }
    }
  }

  private dispatch(event: SettlementEvent): EventApplication {
    switch (event.type) {
      case "account.seeded":
        return this.applySeed(event);
      case "spot.quote.issued":
        return this.applySpotQuote(event);
      case "spot.order.filled":
        return this.applySpotFill(event);
      case "fund.subscription.requested":
        return this.applyFundRequest(event);
      case "nav.observed":
        return this.applyNav(event);
      case "fund.subscription.allocated":
        return this.applyFundAllocation(event);
      case "fund.redemption.requested":
        return this.applyRedemptionRequest(event);
      case "fund.redemption.settled":
        return this.applyRedemptionSettlement(event);
      default: {
        const exhaustive: never = event;
        throw new DealingError(
          "INVALID_EVENT",
          `Unsupported event ${JSON.stringify(exhaustive)}`,
        );
      }
    }
  }

  private adjustBalance(account: JournalAccount, assetId: AssetId, delta: bigint): void {
    const key = accountKey(account);
    let accountBalances = this.state.balances.get(key);
    if (accountBalances === undefined) {
      accountBalances = new Map<AssetId, bigint>();
      this.state.balances.set(key, accountBalances);
    }
    accountBalances.set(assetId, (accountBalances.get(assetId) ?? 0n) + delta);
  }

  private post(
    account: JournalAccount,
    assetId: AssetId,
    delta: bigint,
  ): Posting {
    this.adjustBalance(account, assetId, delta);
    return makePosting(account, assetId, delta);
  }

  private applySeed(
    event: Extract<SettlementEvent, { type: "account.seeded" }>,
  ): EventApplication {
    const amount = parseBaseUnits(event.amountBase);
    if (amount <= 0n) {
      throw new DealingError("NEGATIVE_AMOUNT", "Seeded amount must be positive");
    }
    const issuance = this.config.accounts.issuanceControl;
    const postings = [
      this.post(issuance, event.assetId, -amount),
      this.post(event.account, event.assetId, amount),
    ];
    return {
      title: "Synthetic account seeded",
      description: `Seeded ${formatAsset(amount, event.assetId)} into ${event.account.accountId}`,
      businessEffects: [
        `Investor ${event.assetId}: ${formatSigned(amount, event.assetId)}`,
        `Issuance control ${event.assetId}: ${formatSigned(-amount, event.assetId)}`,
      ],
      postings,
    };
  }

  private applySpotQuote(
    event: Extract<SettlementEvent, { type: "spot.quote.issued" }>,
  ): EventApplication {
    if (this.state.orders.has(event.orderId)) {
      throw new DealingError("ORDER_ALREADY_APPLIED", `Order ${event.orderId} already exists`);
    }
    const amount = parseBaseUnits(event.amountBase);
    const price = parseBaseUnits(event.priceBase);
    const charge = parseBaseUnits(event.chargeBase);
    if (amount <= 0n) {
      throw new DealingError("NEGATIVE_AMOUNT", "Quote amount must be positive");
    }
    if (price <= 0n) {
      throw new DealingError("NEGATIVE_AMOUNT", "Quote price must be positive");
    }
    if (charge < 0n) {
      throw new DealingError("NEGATIVE_AMOUNT", "Quote charge must not be negative");
    }
    if (!isFresh(event.priceAsOf, event.occurredAt, SPOT_PRICE_MAX_AGE_MS)) {
      throw new DealingError(
        "STALE_PRICE",
        `Quote priced at ${event.priceAsOf} is stale at ${event.occurredAt} for order ${event.orderId}`,
        { orderId: event.orderId, priceAsOf: event.priceAsOf },
      );
    }
    if (instantDifferenceMs(event.expiresAt, event.occurredAt) <= 0) {
      throw new DealingError("QUOTE_EXPIRED", `Quote ${event.orderId} already expired`);
    }
    if (instantDifferenceMs(event.expiresAt, event.occurredAt) > SPOT_QUOTE_TTL_MS) {
      throw new DealingError(
        "INVALID_EVENT",
        `Quote ${event.orderId} lifetime exceeds 30 seconds`,
      );
    }
    const order: SpotOrderState = {
      kind: "spot",
      orderId: event.orderId,
      account: event.account,
      status: "QUOTED",
      side: event.side,
      amountBase: amount,
      priceBase: price,
      priceAsOf: event.priceAsOf,
      expiresAt: event.expiresAt,
      chargeBase: charge,
      quotedAt: event.occurredAt,
    };
    this.state.orders.set(event.orderId, order);
    return {
      title: "Spot quote issued",
      description: `Spot quote ${event.orderId}: ${event.side} ${formatAsset(amount, event.side === "BUY" ? CASH_ASSET_ID : SPOT_ASSET_ID)} at ${formatDisplayAmount(price, 6, 2)} EUR per tWETH, fixed charge ${formatAsset(charge, CASH_ASSET_ID)}, expires ${event.expiresAt}`,
      businessEffects: [
        `Order ${event.orderId} is quoted`,
        "No cash or asset movement before settlement",
      ],
      postings: [],
    };
  }

  private applySpotFill(
    event: Extract<SettlementEvent, { type: "spot.order.filled" }>,
  ): EventApplication {
    const order = this.state.orders.get(event.orderId);
    if (order === undefined) {
      throw new DealingError("ORDER_NOT_FOUND", `Unknown order ${event.orderId}`);
    }
    if (order.kind !== "spot") {
      throw new DealingError("INVALID_ORDER_STATE", `Order ${event.orderId} is not a spot order`);
    }
    if (order.status !== "QUOTED") {
      throw new DealingError("INVALID_ORDER_STATE", `Order ${event.orderId} is not quoted`);
    }
    if (!isBeforeInstant(event.occurredAt, order.expiresAt)) {
      throw new DealingError(
        "QUOTE_EXPIRED",
        `Quote ${event.orderId} expired at ${order.expiresAt}`,
      );
    }
    const dealer = this.config.accounts.dealer;
    const feeRecipient = this.config.accounts.feeRecipient;
    let assetBase: bigint;
    let cashBase: bigint;
    let postings: Posting[];

    if (order.side === "BUY") {
      cashBase = order.amountBase;
      assetBase = quoteUnits({
        amountBase: cashBase,
        amountDecimals: ASSETS[CASH_ASSET_ID].decimals,
        priceBase: order.priceBase,
        priceDecimals: 6,
        resultDecimals: ASSETS[SPOT_ASSET_ID].decimals,
      });
      if (assetBase <= 0n) {
        throw new DealingError("ZERO_UNIT_FILL", "Spot buy would deliver zero units");
      }
      const totalCash = cashBase + order.chargeBase;
      if (this.balanceOf(order.account, CASH_ASSET_ID) < totalCash) {
        throw new DealingError("INSUFFICIENT_CASH", "Investor has insufficient spendable cash");
      }
      postings = [
        this.post(order.account, CASH_ASSET_ID, -cashBase),
        this.post(dealer, CASH_ASSET_ID, cashBase),
        this.post(order.account, CASH_ASSET_ID, -order.chargeBase),
        this.post(feeRecipient, CASH_ASSET_ID, order.chargeBase),
        this.post(dealer, SPOT_ASSET_ID, -assetBase),
        this.post(order.account, SPOT_ASSET_ID, assetBase),
      ];
    } else {
      assetBase = order.amountBase;
      cashBase = quoteCash({
        unitsBase: assetBase,
        unitDecimals: ASSETS[SPOT_ASSET_ID].decimals,
        priceBase: order.priceBase,
        priceDecimals: 6,
        cashDecimals: ASSETS[CASH_ASSET_ID].decimals,
      });
      if (this.balanceOf(order.account, SPOT_ASSET_ID) < assetBase) {
        throw new DealingError(
          "INSUFFICIENT_INVENTORY",
          "Investor has insufficient tWETH to sell",
        );
      }
      if (this.balanceOf(dealer, CASH_ASSET_ID) < cashBase) {
        throw new DealingError(
          "INSUFFICIENT_LIQUIDITY",
          "Dealer has insufficient cash inventory for the reverse quote",
        );
      }
      postings = [
        this.post(order.account, SPOT_ASSET_ID, -assetBase),
        this.post(dealer, SPOT_ASSET_ID, assetBase),
        this.post(dealer, CASH_ASSET_ID, -cashBase),
        this.post(order.account, CASH_ASSET_ID, cashBase),
        this.post(order.account, CASH_ASSET_ID, -order.chargeBase),
        this.post(feeRecipient, CASH_ASSET_ID, order.chargeBase),
      ];
    }

    const filled: SpotOrderState = {
      ...order,
      status: "FILLED",
      filledAt: event.occurredAt,
      assetBase,
      cashBase,
    };
    this.state.orders.set(event.orderId, filled);
    const cashLeg = order.side === "BUY" ? -cashBase : cashBase;
    return {
      title: order.side === "BUY" ? "Spot order filled" : "Reverse spot order filled",
      description:
        order.side === "BUY"
          ? `Bought ${formatAsset(assetBase, SPOT_ASSET_ID)} for ${formatAsset(cashBase, CASH_ASSET_ID)} plus ${formatAsset(order.chargeBase, CASH_ASSET_ID)} fixed charge`
          : `Sold ${formatAsset(assetBase, SPOT_ASSET_ID)} for ${formatAsset(cashBase, CASH_ASSET_ID)} less ${formatAsset(order.chargeBase, CASH_ASSET_ID)} fixed charge`,
      businessEffects: [
        `Investor spendable cash: ${formatSigned(cashLeg - order.chargeBase, CASH_ASSET_ID)}`,
        `Investor ${SPOT_ASSET_ID}: ${formatSigned(order.side === "BUY" ? assetBase : -assetBase, SPOT_ASSET_ID)}`,
        `Investor charge: ${formatAsset(order.chargeBase, CASH_ASSET_ID)}`,
        `Dealer cash: ${formatSigned(-cashLeg, CASH_ASSET_ID)}`,
        `Fee recipient: ${formatAsset(order.chargeBase, CASH_ASSET_ID)}`,
      ],
      postings,
    };
  }

  private applyFundRequest(
    event: Extract<SettlementEvent, { type: "fund.subscription.requested" }>,
  ): EventApplication {
    if (this.state.orders.has(event.orderId)) {
      throw new DealingError("ORDER_ALREADY_APPLIED", `Order ${event.orderId} already exists`);
    }
    const cashBase = parseBaseUnits(event.cashBase);
    if (cashBase <= 0n) {
      throw new DealingError("NEGATIVE_AMOUNT", "Subscription cash must be positive");
    }
    if (this.balanceOf(event.account, CASH_ASSET_ID) < cashBase) {
      throw new DealingError("INSUFFICIENT_CASH", "Investor has insufficient spendable cash");
    }
    const assignment = assignDealingDay({
      requestedAt: event.occurredAt,
      cutoffTimeUtc: event.cutoffTimeUtc,
      calendar: this.config.calendar,
    });
    const escrow = this.config.accounts.fundEscrow;
    const postings = [
      this.post(event.account, CASH_ASSET_ID, -cashBase),
      this.post(escrow, CASH_ASSET_ID, cashBase),
    ];
    const order: FundSubscriptionState = {
      kind: "fund-subscription",
      orderId: event.orderId,
      account: event.account,
      status: "AWAITING_NAV",
      cashBase,
      reservedCashBase: cashBase,
      indicativeNavBase: parseBaseUnits(event.indicativeNavBase),
      requestedAt: event.occurredAt,
      cutoffTimeUtc: event.cutoffTimeUtc,
      dealingDate: assignment.dealingDate,
      dealingReason: assignment.reason,
      requestedDate: assignment.requestedDate,
    };
    this.state.orders.set(event.orderId, order);
    return {
      title: "Fund subscription reserved",
      description: `Reserved ${formatAsset(cashBase, CASH_ASSET_ID)} for eFUND; dealing day ${assignment.dealingDate} assigned because the request at ${event.occurredAt} was ${describeAssignmentReason(assignment.reason)}`,
      businessEffects: [
        `Investor spendable cash: ${formatSigned(-cashBase, CASH_ASSET_ID)}`,
        `Fund escrow: ${formatSigned(cashBase, CASH_ASSET_ID)}`,
        `Pending cash reserved: ${formatAsset(cashBase, CASH_ASSET_ID)}`,
        `Assigned dealing day: ${assignment.dealingDate}`,
        "No units issued before the authorized NAV",
      ],
      postings,
    };
  }

  private applyNav(
    event: Extract<SettlementEvent, { type: "nav.observed" }>,
  ): EventApplication {
    const navBase = parseBaseUnits(event.navBase);
    if (navBase <= 0n) {
      throw new DealingError("NEGATIVE_AMOUNT", "NAV must be positive");
    }
    parseUtcInstant(event.valuationDate + "T00:00:00Z");
    if (event.revision < 1) {
      throw new DealingError("NAV_DATE_MISMATCH", "NAV revision must be positive");
    }
    if (instantDifferenceMs(event.occurredAt, event.sourceTime) < 0) {
      throw new DealingError(
        "NAV_DATE_MISMATCH",
        `NAV observation ${event.eventId} is earlier than its source time`,
      );
    }
    const key = navKey(event.assetId, event.valuationDate);
    const existing = this.state.navs.get(key);
    if (existing !== undefined && existing.revision >= event.revision) {
      throw new DealingError(
        "DUPLICATE_EVENT",
        `NAV revision ${event.revision} for ${event.assetId} ${event.valuationDate} is not newer than ${existing.revision}`,
      );
    }
    this.state.navs.set(key, {
      assetId: event.assetId,
      valuationDate: event.valuationDate,
      navBase,
      sourceTime: event.sourceTime,
      revision: event.revision,
      signer: event.signer,
    });
    this.state.marks.set(event.assetId, navBase);
    return {
      title: "NAV observation recorded",
      description: `Authorized NAV for ${event.assetId} on ${event.valuationDate}: ${formatDisplayAmount(navBase, 6, 2)} EUR per unit (revision ${event.revision}, signer ${event.signer}, source ${event.sourceTime})`,
      businessEffects: [
        `NAV ${event.assetId} ${event.valuationDate}: ${formatDisplayAmount(navBase, 6, 2)} EUR per unit`,
        `Revision ${event.revision} accepted from ${event.signer}`,
      ],
      postings: [],
    };
  }

  private applyFundAllocation(
    event: Extract<SettlementEvent, { type: "fund.subscription.allocated" }>,
  ): EventApplication {
    const order = this.state.orders.get(event.orderId);
    if (order === undefined) {
      throw new DealingError("ORDER_NOT_FOUND", `Unknown order ${event.orderId}`);
    }
    if (order.kind !== "fund-subscription") {
      throw new DealingError(
        "INVALID_ORDER_STATE",
        `Order ${event.orderId} is not a fund subscription`,
      );
    }
    if (order.status !== "AWAITING_NAV") {
      throw new DealingError("INVALID_ORDER_STATE", `Order ${event.orderId} is not awaiting NAV`);
    }
    const nav = this.state.navs.get(navKey(FUND_ASSET_ID, order.dealingDate));
    if (nav === undefined) {
      throw new DealingError(
        "NAV_MISSING",
        `No authorized NAV for eFUND ${order.dealingDate}; cash stays reserved`,
        { orderId: order.orderId, dealingDate: order.dealingDate },
      );
    }
    if (!isFresh(nav.sourceTime, event.occurredAt, NAV_MAX_AGE_MS)) {
      throw new DealingError(
        "NAV_STALE",
        `NAV for ${order.dealingDate} is stale at ${event.occurredAt}`,
        { orderId: order.orderId, sourceTime: nav.sourceTime },
      );
    }
    const allocation = allocateCashToUnits({
      cashBase: order.reservedCashBase,
      cashDecimals: ASSETS[CASH_ASSET_ID].decimals,
      navBase: nav.navBase,
      navDecimals: 6,
      unitDecimals: ASSETS[FUND_ASSET_ID].decimals,
    });
    const escrow = this.config.accounts.fundEscrow;
    const treasury = this.config.accounts.issuerTreasury;
    const issuance = this.config.accounts.issuanceControl;
    const postings: Posting[] = [
      this.post(escrow, CASH_ASSET_ID, -allocation.cashConsumedBase),
      this.post(treasury, CASH_ASSET_ID, allocation.cashConsumedBase),
      this.post(issuance, FUND_ASSET_ID, -allocation.unitsBase),
      this.post(order.account, FUND_ASSET_ID, allocation.unitsBase),
    ];
    if (allocation.residualCashBase > 0n) {
      postings.push(this.post(escrow, CASH_ASSET_ID, -allocation.residualCashBase));
      postings.push(this.post(order.account, CASH_ASSET_ID, allocation.residualCashBase));
    }
    const allocated: FundSubscriptionState = {
      ...order,
      status: "ALLOCATED",
      allocation: {
        unitsBase: allocation.unitsBase,
        cashConsumedBase: allocation.cashConsumedBase,
        residualCashBase: allocation.residualCashBase,
        navBase: nav.navBase,
        navSourceTime: nav.sourceTime,
        navRevision: nav.revision,
        allocatedAt: event.occurredAt,
      },
    };
    this.state.orders.set(order.orderId, allocated);
    return {
      title: "Fund units allocated",
      description: `Allocated ${formatDisplayAmount(allocation.unitsBase, ASSETS[FUND_ASSET_ID].decimals, 6)} eFUND units to ${order.account.accountId} at ${formatDisplayAmount(nav.navBase, 6, 2)} EUR per unit; ${formatAsset(allocation.cashConsumedBase, CASH_ASSET_ID)} moved to the issuer treasury and ${formatAsset(allocation.residualCashBase, CASH_ASSET_ID)} residual returned`,
      businessEffects: [
        `Reserved cash released: ${formatAsset(allocation.cashConsumedBase, CASH_ASSET_ID)}`,
        `Investor eFUND: ${formatSigned(allocation.unitsBase, FUND_ASSET_ID)}`,
        `Investor residual cash: ${formatSigned(allocation.residualCashBase, CASH_ASSET_ID)}`,
        `Applied NAV: ${formatDisplayAmount(nav.navBase, 6, 2)} EUR per unit`,
      ],
      postings,
    };
  }

  private applyRedemptionRequest(
    event: Extract<SettlementEvent, { type: "fund.redemption.requested" }>,
  ): EventApplication {
    if (this.state.orders.has(event.orderId)) {
      throw new DealingError("ORDER_ALREADY_APPLIED", `Order ${event.orderId} already exists`);
    }
    const unitsBase = parseBaseUnits(event.unitsBase);
    if (unitsBase <= 0n) {
      throw new DealingError("NEGATIVE_AMOUNT", "Redeemed units must be positive");
    }
    if (this.balanceOf(event.account, FUND_ASSET_ID) < unitsBase) {
      throw new DealingError(
        "INSUFFICIENT_INVENTORY",
        "Investor has insufficient eFUND units to redeem",
      );
    }
    const assignment = assignDealingDay({
      requestedAt: event.occurredAt,
      cutoffTimeUtc: event.cutoffTimeUtc,
      calendar: this.config.calendar,
    });
    const escrow = this.config.accounts.fundEscrow;
    const postings = [
      this.post(event.account, FUND_ASSET_ID, -unitsBase),
      this.post(escrow, FUND_ASSET_ID, unitsBase),
    ];
    const order: FundRedemptionState = {
      kind: "fund-redemption",
      orderId: event.orderId,
      account: event.account,
      status: "AWAITING_NAV",
      reservedUnitsBase: unitsBase,
      requestedAt: event.occurredAt,
      cutoffTimeUtc: event.cutoffTimeUtc,
      dealingDate: assignment.dealingDate,
      dealingReason: assignment.reason,
      requestedDate: assignment.requestedDate,
    };
    this.state.orders.set(event.orderId, order);
    return {
      title: "Redemption request reserved",
      description: `Reserved ${formatDisplayAmount(unitsBase, ASSETS[FUND_ASSET_ID].decimals, 6)} eFUND units for redemption; dealing day ${assignment.dealingDate} assigned`,
      businessEffects: [
        `Investor eFUND: ${formatSigned(-unitsBase, FUND_ASSET_ID)}`,
        `Fund escrow eFUND: ${formatSigned(unitsBase, FUND_ASSET_ID)}`,
        `Assigned dealing day: ${assignment.dealingDate}`,
      ],
      postings,
    };
  }

  private applyRedemptionSettlement(
    event: Extract<SettlementEvent, { type: "fund.redemption.settled" }>,
  ): EventApplication {
    const order = this.state.orders.get(event.orderId);
    if (order === undefined) {
      throw new DealingError("ORDER_NOT_FOUND", `Unknown order ${event.orderId}`);
    }
    if (order.kind !== "fund-redemption") {
      throw new DealingError(
        "INVALID_ORDER_STATE",
        `Order ${event.orderId} is not a redemption order`,
      );
    }
    if (order.status !== "AWAITING_NAV") {
      throw new DealingError("INVALID_ORDER_STATE", `Order ${event.orderId} is not awaiting NAV`);
    }
    const nav = this.state.navs.get(navKey(FUND_ASSET_ID, order.dealingDate));
    if (nav === undefined) {
      throw new DealingError(
        "NAV_MISSING",
        `No authorized NAV for eFUND ${order.dealingDate}; units stay reserved`,
        { orderId: order.orderId, dealingDate: order.dealingDate },
      );
    }
    if (!isFresh(nav.sourceTime, event.occurredAt, NAV_MAX_AGE_MS)) {
      throw new DealingError(
        "NAV_STALE",
        `NAV for ${order.dealingDate} is stale at ${event.occurredAt}`,
      );
    }
    const proceedsBase = quoteCash({
      unitsBase: order.reservedUnitsBase,
      unitDecimals: ASSETS[FUND_ASSET_ID].decimals,
      priceBase: nav.navBase,
      priceDecimals: 6,
      cashDecimals: ASSETS[CASH_ASSET_ID].decimals,
    });
    if (proceedsBase <= 0n) {
      throw new DealingError("ZERO_UNIT_FILL", "Redemption would pay zero cash");
    }
    const escrow = this.config.accounts.fundEscrow;
    const issuance = this.config.accounts.issuanceControl;
    const treasury = this.config.accounts.issuerTreasury;
    if (this.balanceOf(treasury, CASH_ASSET_ID) < proceedsBase) {
      throw new DealingError("INSUFFICIENT_LIQUIDITY", "Issuer treasury cannot fund redemption");
    }
    const postings = [
      this.post(escrow, FUND_ASSET_ID, -order.reservedUnitsBase),
      this.post(issuance, FUND_ASSET_ID, order.reservedUnitsBase),
      this.post(treasury, CASH_ASSET_ID, -proceedsBase),
      this.post(order.account, CASH_ASSET_ID, proceedsBase),
    ];
    const redeemed: FundRedemptionState = {
      ...order,
      status: "REDEEMED",
      redemption: {
        unitsBase: order.reservedUnitsBase,
        proceedsBase,
        navBase: nav.navBase,
        navSourceTime: nav.sourceTime,
        navRevision: nav.revision,
        settledAt: event.occurredAt,
      },
    };
    this.state.orders.set(order.orderId, redeemed);
    return {
      title: "Redemption settled",
      description: `Burned ${formatDisplayAmount(order.reservedUnitsBase, ASSETS[FUND_ASSET_ID].decimals, 6)} eFUND units and paid ${formatAsset(proceedsBase, CASH_ASSET_ID)} at ${formatDisplayAmount(nav.navBase, 6, 2)} EUR per unit`,
      businessEffects: [
        `Investor cash: ${formatSigned(proceedsBase, CASH_ASSET_ID)}`,
        `Investor eFUND burned: ${formatSigned(-order.reservedUnitsBase, FUND_ASSET_ID)}`,
        `Issuer treasury cash: ${formatSigned(-proceedsBase, CASH_ASSET_ID)}`,
      ],
      postings,
    };
  }
}

function describeAssignmentReason(reason: DealingAssignmentReason): string {
  switch (reason) {
    case "BEFORE_CUTOFF_SAME_DAY":
      return "before the cutoff on a dealing day";
    case "AT_OR_AFTER_CUTOFF":
      return "at or after the cutoff";
    case "NON_DEALING_DAY":
      return "on a non-dealing day";
  }
}

export function navObservationToJson(nav: NavObservation): Record<string, unknown> {
  return {
    assetId: nav.assetId,
    valuationDate: nav.valuationDate,
    navBase: nav.navBase.toString(),
    sourceTime: nav.sourceTime,
    revision: nav.revision,
    signer: nav.signer,
  };
}

export function spotMaxAgeMs(): number {
  return SPOT_PRICE_MAX_AGE_MS;
}

export function spotChargeBase(): bigint {
  return SPOT_INVESTOR_CHARGE_BASE;
}
