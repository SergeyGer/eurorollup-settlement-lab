/**
 * Outbox worker: the only component that appends settlement events.
 *
 * The worker claims pending outbox tasks in id order, applies the domain events
 * through the pure engine, and updates order projections in the same SQLite
 * transaction. A crash before commit leaves the task pending; a crash after
 * commit leaves the task done. Either way the event log and projections stay
 * consistent, and the order keeps its id.
 */
import {
  buildFundReceipt,
  buildRedemptionReceipt,
  buildSpotReceipt,
  instantDifferenceMs,
  isDealingError,
  quoteCash,
  type AppliedStep,
  type FundRedemptionState,
  type FundSubscriptionState,
  type SettlementEvent,
  type SpotOrderState,
} from "@eurorollup/dealing";
import type {
  DealingTerms,
  MoneyMovement,
  OrderReceipt,
} from "@eurorollup/sdk";
import type { ApiConfig } from "./config.js";
import type { Database } from "./db.js";
import {
  enqueueOutbox,
  listPendingOutbox,
  readClock,
  transaction,
  type OutboxRow,
} from "./db.js";
import type { ClockService } from "./clock-service.js";
import type { EngineService } from "./engine-service.js";
import { investorAccount } from "./engine-service.js";
import {
  OUTBOX_PROCESS_ORDER,
  OUTBOX_TRY_SETTLE,
  appendMovements,
  type OrderDetail,
} from "./services/orders.js";
import {
  getNavRow,
  getOrderRow,
  getQuoteRow,
  markOutboxDone,
  retryOutboxRow,
  updateOrderRow,
  type OrderRow,
  type QuoteRow,
} from "./repository.js";
import { OUTBOX_RUN_SCENARIO } from "./services/scenarios.js";

export interface OrderWorkerOptions {
  /** Executes one queued Policy Lab comparison run by id. */
  readonly scenarioRunner?: (runId: string) => void;
}

export class OrderWorker {
  private readonly db: Database;
  private readonly config: ApiConfig;
  private readonly engine: EngineService;
  private readonly clock: ClockService;
  private readonly options: OrderWorkerOptions;
  private timer: NodeJS.Timeout | null = null;
  private processing = false;

  constructor(
    db: Database,
    config: ApiConfig,
    engine: EngineService,
    clock: ClockService,
    options: OrderWorkerOptions = {},
  ) {
    this.db = db;
    this.config = config;
    this.engine = engine;
    this.clock = clock;
    this.options = options;
  }

  start(intervalMs = 20): void {
    if (this.timer !== null) {
      return;
    }
    this.timer = setInterval(() => {
      this.processPendingNow();
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Processes pending tasks synchronously; used by tests and evidence runs. */
  processPendingNow(maxTasks = 200): number {
    if (this.processing) {
      return 0;
    }
    this.processing = true;
    let processed = 0;
    try {
      for (let iteration = 0; iteration < maxTasks; iteration += 1) {
        const pending = listPendingOutbox(this.db)[0];
        if (pending === undefined) {
          break;
        }
        try {
          this.processTask(pending);
          markOutboxDone(this.db, pending.id);
          processed += 1;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          retryOutboxRow(this.db, pending.id, message);
          // Do not spin on a failing task; the next tick retries it.
          processed += 1;
          break;
        }
      }
    } finally {
      this.processing = false;
    }
    return processed;
  }

  private processTask(task: OutboxRow): void {
    if (task.task === OUTBOX_PROCESS_ORDER) {
      this.processOrder(task.order_id);
      return;
    }
    if (task.task === OUTBOX_TRY_SETTLE) {
      this.trySettle(task.order_id);
      return;
    }
    if (task.task === OUTBOX_RUN_SCENARIO) {
      if (this.options.scenarioRunner === undefined) {
        throw new Error("No scenario runner is configured for the API worker");
      }
      this.options.scenarioRunner(task.order_id);
      return;
    }
    throw new Error(`Unknown outbox task ${task.task}`);
  }

  private occurredAtFor(requested: string): string {
    const steps = this.engine.state.steps;
    const last = steps[steps.length - 1];
    if (last === undefined) {
      return requested;
    }
    return instantDifferenceMs(requested, last.occurredAt) >= 0 ? requested : last.occurredAt;
  }

  private processOrder(orderId: string): void {
    const order = getOrderRow(this.db, orderId);
    if (order === null) {
      return;
    }
    if (order.business_state !== "SUBMITTED" && order.business_state !== "RESERVED") {
      return;
    }
    const quote = getQuoteRow(this.db, order.quote_id);
    if (quote === null) {
      this.declineOrder(orderId, "QUOTE_NOT_FOUND", "The quote for this order is missing");
      return;
    }
    const now = readClock(this.db);
    const occurredAt = this.occurredAtFor(order.created_at);
    try {
      if (order.kind === "SPOT_BUY" || order.kind === "SPOT_SELL") {
        this.settleSpot(order, quote, occurredAt, now);
        return;
      }
      if (order.kind === "FUND_SUBSCRIPTION") {
        this.reserveSubscription(order, quote, occurredAt, now);
        return;
      }
      if (order.kind === "FUND_REDEMPTION") {
        this.reserveRedemption(order, quote, occurredAt, now);
        return;
      }
      this.declineOrder(orderId, "UNSUPPORTED_ORDER", `Unsupported order kind ${order.kind}`);
    } catch (error) {
      if (isDealingError(error)) {
        this.declineOrder(orderId, error.code, error.message);
        return;
      }
      throw error;
    }
  }

  private settleSpot(order: OrderRow, quote: QuoteRow, occurredAt: string, now: string): void {
    const side = order.side === "BUY" ? "BUY" : "SELL";
    const priceBase = BigInt(quote.price_base ?? "0");
    const minProceedsBase =
      side === "SELL"
        ? quoteCash({
            unitsBase: BigInt(quote.amount_base),
            unitDecimals: 18,
            priceBase,
            priceDecimals: 6,
            cashDecimals: 6,
          }).toString()
        : undefined;
    const events: SettlementEvent[] = [
      {
        type: "spot.quote.issued",
        eventId: `EV-${order.order_id}-QUOTE`,
        occurredAt,
        orderId: order.order_id,
        account: investorAccount(order.account_id),
        side,
        amountBase: quote.amount_base,
        priceBase: quote.price_base ?? "0",
        priceAsOf: quote.price_as_of ?? occurredAt,
        expiresAt: quote.expires_at,
        chargeBase: quote.charge_ceiling_base,
        ...(minProceedsBase === undefined ? {} : { minProceedsBase }),
      },
      {
        type: "spot.order.filled",
        eventId: `EV-${order.order_id}-FILL`,
        occurredAt,
        orderId: order.order_id,
      },
    ];
    this.engine.applyEvents(events, {
      orderId: order.order_id,
      mutate: (steps, entries, draft) => {
        const engineOrder = draft.order(order.order_id);
        if (engineOrder.kind !== "spot" || engineOrder.status !== "FILLED") {
          throw new Error("Spot order did not reach FILLED in the engine");
        }
        const receipt = buildSpotReceipt(engineOrder as SpotOrderState);
        updateOrderRow(this.db, order.order_id, {
          business_state: "FILLED",
          reason_code: null,
          receipt_json: JSON.stringify(receipt),
          movements_json: appendMovements(order.movements_json, entries),
          updated_at: now,
        });
        void steps;
      },
    });
  }

  private reserveSubscription(
    order: OrderRow,
    quote: QuoteRow,
    occurredAt: string,
    now: string,
  ): void {
    const quoteTerms = JSON.parse(quote.dealing_terms_json ?? "{}") as DealingTerms;
    const event: SettlementEvent = {
      type: "fund.subscription.requested",
      eventId: `EV-${order.order_id}-REQUEST`,
      occurredAt,
      orderId: order.order_id,
      account: investorAccount(order.account_id),
      cashBase: quote.amount_base,
      cutoffTimeUtc: quoteTerms.cutoffTimeUtc,
      indicativeNavBase: quote.indicative_nav_base ?? this.config.indicativeNavBase.toString(),
    };
    this.engine.applyEvents([event], {
      orderId: order.order_id,
      mutate: (steps, entries, draft) => {
        const engineOrder = draft.order(order.order_id);
        if (engineOrder.kind !== "fund-subscription") {
          throw new Error("Fund subscription did not reserve in the engine");
        }
        const subscription = engineOrder as FundSubscriptionState;
        const dealingTerms: DealingTerms = {
          ...quoteTerms,
          cutoffTimeUtc: subscription.cutoffTimeUtc,
          assignedDealingDate: subscription.dealingDate,
          assignmentReason: subscription.dealingReason,
        };
        const navRow = getNavRow(this.db, "eFUND", subscription.dealingDate);
        const detail: OrderDetail = {
          dealingTerms,
          reservedCashBase: subscription.reservedCashBase.toString(),
        };
        updateOrderRow(this.db, order.order_id, {
          business_state: "AWAITING_NAV",
          reason_code: navRow === null ? "NAV_MISSING" : null,
          dealing_date: subscription.dealingDate,
          detail_json: JSON.stringify(detail),
          movements_json: appendMovements(order.movements_json, entries),
          updated_at: now,
        });
        if (navRow !== null && instantDifferenceMs(now, navRow.source_time) >= 0) {
          enqueueOutbox(this.db, OUTBOX_TRY_SETTLE, order.order_id, null, now);
        }
        void steps;
      },
    });
  }

  private reserveRedemption(
    order: OrderRow,
    quote: QuoteRow,
    occurredAt: string,
    now: string,
  ): void {
    const quoteTerms = JSON.parse(quote.dealing_terms_json ?? "{}") as DealingTerms;
    const event: SettlementEvent = {
      type: "fund.redemption.requested",
      eventId: `EV-${order.order_id}-REQUEST`,
      occurredAt,
      orderId: order.order_id,
      account: investorAccount(order.account_id),
      unitsBase: quote.amount_base,
      cutoffTimeUtc: quoteTerms.cutoffTimeUtc,
    };
    this.engine.applyEvents([event], {
      orderId: order.order_id,
      mutate: (steps, entries, draft) => {
        const engineOrder = draft.order(order.order_id);
        if (engineOrder.kind !== "fund-redemption") {
          throw new Error("Redemption did not reserve in the engine");
        }
        const redemption = engineOrder as FundRedemptionState;
        const dealingTerms: DealingTerms = {
          ...quoteTerms,
          cutoffTimeUtc: redemption.cutoffTimeUtc,
          assignedDealingDate: redemption.dealingDate,
          assignmentReason: redemption.dealingReason,
        };
        const navRow = getNavRow(this.db, "eFUND", redemption.dealingDate);
        const detail: OrderDetail = {
          dealingTerms,
          reservedUnitsBase: redemption.reservedUnitsBase.toString(),
        };
        updateOrderRow(this.db, order.order_id, {
          business_state: "AWAITING_NAV",
          reason_code: navRow === null ? "NAV_MISSING" : null,
          dealing_date: redemption.dealingDate,
          detail_json: JSON.stringify(detail),
          movements_json: appendMovements(order.movements_json, entries),
          updated_at: now,
        });
        if (navRow !== null && instantDifferenceMs(now, navRow.source_time) >= 0) {
          enqueueOutbox(this.db, OUTBOX_TRY_SETTLE, order.order_id, null, now);
        }
        void steps;
      },
    });
  }

  private trySettle(orderId: string): void {
    const order = getOrderRow(this.db, orderId);
    if (order === null || order.business_state !== "AWAITING_NAV") {
      return;
    }
    if (order.dealing_date === null) {
      return;
    }
    const navRow = getNavRow(this.db, "eFUND", order.dealing_date);
    const now = readClock(this.db);
    if (navRow === null) {
      updateOrderRow(this.db, orderId, { reason_code: "NAV_MISSING", updated_at: now });
      return;
    }
    if (instantDifferenceMs(now, navRow.source_time) < 0) {
      updateOrderRow(this.db, orderId, { reason_code: "NAV_MISSING", updated_at: now });
      return;
    }
    try {
      if (order.kind === "FUND_SUBSCRIPTION") {
        this.allocateSubscription(order, now);
        return;
      }
      if (order.kind === "FUND_REDEMPTION") {
        this.settleRedemption(order, now);
        return;
      }
      updateOrderRow(this.db, orderId, { business_state: "DECLINED", reason_code: "INVALID_STATE" });
    } catch (error) {
      if (isDealingError(error) && (error.code === "NAV_MISSING" || error.code === "NAV_STALE")) {
        updateOrderRow(this.db, orderId, { reason_code: error.code, updated_at: now });
        return;
      }
      if (isDealingError(error)) {
        this.declineOrder(orderId, error.code, error.message);
        return;
      }
      throw error;
    }
  }

  private allocateSubscription(order: OrderRow, now: string): void {
    const event: SettlementEvent = {
      type: "fund.subscription.allocated",
      eventId: `EV-${order.order_id}-ALLOC`,
      occurredAt: now,
      orderId: order.order_id,
    };
    this.engine.applyEvents([event], {
      orderId: order.order_id,
      mutate: (steps, entries, draft) => {
        const engineOrder = draft.order(order.order_id);
        if (engineOrder.kind !== "fund-subscription" || engineOrder.status !== "ALLOCATED") {
          throw new Error("Subscription did not allocate in the engine");
        }
        const subscription = engineOrder as FundSubscriptionState;
        const receipt = buildFundReceipt(subscription);
        const existingDetail = parseDetail(order.detail_json);
        const detail: OrderDetail = {
          ...existingDetail,
          reservedCashBase: "0",
          residualCashBase: subscription.allocation?.residualCashBase.toString() ?? "0",
        };
        updateOrderRow(this.db, order.order_id, {
          business_state: "ALLOCATED",
          reason_code: null,
          receipt_json: JSON.stringify(receipt),
          detail_json: JSON.stringify(detail),
          movements_json: appendMovements(order.movements_json, entries),
          updated_at: now,
        });
        void steps;
      },
    });
  }

  private settleRedemption(order: OrderRow, now: string): void {
    const event: SettlementEvent = {
      type: "fund.redemption.settled",
      eventId: `EV-${order.order_id}-SETTLE`,
      occurredAt: now,
      orderId: order.order_id,
    };
    this.engine.applyEvents([event], {
      orderId: order.order_id,
      mutate: (steps, entries, draft) => {
        const engineOrder = draft.order(order.order_id);
        if (engineOrder.kind !== "fund-redemption" || engineOrder.status !== "REDEEMED") {
          throw new Error("Redemption did not settle in the engine");
        }
        const redemption = engineOrder as FundRedemptionState;
        const receipt = buildRedemptionReceipt(redemption);
        const existingDetail = parseDetail(order.detail_json);
        const detail: OrderDetail = { ...existingDetail, reservedUnitsBase: "0" };
        updateOrderRow(this.db, order.order_id, {
          business_state: "REDEEMED",
          reason_code: null,
          receipt_json: JSON.stringify(receipt),
          detail_json: JSON.stringify(detail),
          movements_json: appendMovements(order.movements_json, entries),
          updated_at: now,
        });
        void steps;
      },
    });
  }

  private declineOrder(orderId: string, code: string, message: string): void {
    const now = readClock(this.db);
    updateOrderRow(this.db, orderId, {
      business_state: "DECLINED",
      chain_state: "NOT_SUBMITTED",
      reason_code: code,
      decline_json: JSON.stringify({ code, message }),
      updated_at: now,
    });
  }
}

function parseDetail(json: string | null): OrderDetail {
  if (json === null) {
    return {};
  }
  return JSON.parse(json) as OrderDetail;
}

export function movementSummary(movements: readonly MoneyMovement[]): string {
  return movements
    .flatMap((movement) =>
      movement.postings.map(
        (posting) => `${posting.accountKind}:${posting.assetId}:${posting.amountBase}`,
      ),
    )
    .join(",");
}

export type { OrderReceipt, transaction };
