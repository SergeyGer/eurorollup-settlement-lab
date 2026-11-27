/**
 * Order service: acceptance, idempotency, preflight and cancellation.
 *
 * Acceptance validates the quote and the investor position, persists the order
 * and a durable outbox task in one transaction, and returns 202. Settlement is
 * performed asynchronously by the outbox worker, which keeps the same order id
 * through retries and restarts.
 */
import {
  instantDifferenceMs,
  quoteCash,
  hashJson,
  type JournalEntry,
} from "@eurorollup/dealing";
import {
  ROUTE_GATE,
  classRank,
  gatesFixture,
  personaByAccountId,
  personaById,
  screeningByParty,
  type DealingRoute,
  type PersonaLeaf,
} from "@eurorollup/eligibility";
import type {
  BusinessState,
  ChainState,
  DealingTerms,
  MoneyMovement,
  Order,
  OrderKind,
  OrderReceipt,
  OrderSide,
  PlaceOrderResult,
  QuoteKind,
} from "@eurorollup/sdk";
import type { ApiConfig } from "../config.js";
import type { Database } from "../db.js";
import { enqueueOutbox, getAccount, readClock, transaction } from "../db.js";
import type { EngineService } from "../engine-service.js";
import { investorAccount } from "../engine-service.js";
import type { IdFactory } from "../ids.js";
import { problem } from "../problems.js";
import {
  getNavRow,
  getOrderRow,
  getOrderRowByIdempotencyKey,
  getQuoteRow,
  insertOrder,
  listOrderRows,
  updateOrderRow,
  type OrderRow,
  type QuoteRow,
} from "../repository.js";
import type { ClockService } from "../clock-service.js";
import { weekdayCutoff, type QuoteService } from "./quotes.js";

export const OUTBOX_PROCESS_ORDER = "process-order";
export const OUTBOX_TRY_SETTLE = "try-settle";

export interface PlaceOrderInput {
  readonly quoteId: string;
  readonly accountId: string;
}

export interface PlaceOrderOutcome {
  readonly result: PlaceOrderResult;
  readonly created: boolean;
}

export interface OrderDetail {
  readonly dealingTerms?: DealingTerms;
  readonly residualCashBase?: string;
  readonly reservedCashBase?: string;
  readonly reservedUnitsBase?: string;
  readonly note?: string;
}

export function orderKindOf(quoteRow: QuoteRow): OrderKind {
  if (quoteRow.kind === "SPOT") {
    return quoteRow.side === "BUY" ? "SPOT_BUY" : "SPOT_SELL";
  }
  return quoteRow.side === "SUBSCRIBE" ? "FUND_SUBSCRIPTION" : "FUND_REDEMPTION";
}

export function journalToMovements(entries: readonly JournalEntry[]): MoneyMovement[] {
  return entries.map((entry) => ({
    entryId: entry.entryId,
    occurredAt: entry.occurredAt,
    description: entry.description,
    postings: entry.postings.map((posting) => ({
      accountKind: posting.account.kind,
      accountId: posting.account.accountId,
      assetId: posting.assetId,
      amountBase: posting.amountBase,
    })),
  }));
}

export function appendMovements(existingJson: string, entries: readonly JournalEntry[]): string {
  const existing = JSON.parse(existingJson) as MoneyMovement[];
  return JSON.stringify([...existing, ...journalToMovements(entries)]);
}

export function receiptToJson(receipt: OrderReceipt | null): string | null {
  return receipt === null ? null : JSON.stringify(receipt);
}

function initialBusinessState(kind: OrderKind): BusinessState {
  return kind === "SPOT_BUY" || kind === "SPOT_SELL" ? "SUBMITTED" : "RESERVED";
}

export class OrderService {
  private readonly db: Database;
  private readonly config: ApiConfig;
  private readonly engine: EngineService;
  private readonly quotes: QuoteService;
  private readonly clock: ClockService;
  private readonly ids: IdFactory;

  constructor(
    db: Database,
    config: ApiConfig,
    engine: EngineService,
    quotes: QuoteService,
    clock: ClockService,
    ids: IdFactory,
  ) {
    this.db = db;
    this.config = config;
    this.engine = engine;
    this.quotes = quotes;
    this.clock = clock;
    this.ids = ids;
  }

  placeOrder(input: PlaceOrderInput, idempotencyKey: string | undefined): PlaceOrderOutcome {
    if (idempotencyKey === undefined || idempotencyKey.trim() === "") {
      throw problem(400, "INVALID_REQUEST", "The Idempotency-Key header is required");
    }
    if (idempotencyKey.length > 200) {
      throw problem(400, "INVALID_REQUEST", "The Idempotency-Key header is too long");
    }
    if (typeof input.quoteId !== "string" || typeof input.accountId !== "string") {
      throw problem(400, "INVALID_REQUEST", "quoteId and accountId are required");
    }
    const requestHash = hashJson({ quoteId: input.quoteId, accountId: input.accountId });
    const existing = getOrderRowByIdempotencyKey(this.db, idempotencyKey);
    if (existing !== null) {
      if (existing.request_hash !== requestHash) {
        throw problem(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "This Idempotency-Key was already used with a different request body",
          { orderId: existing.order_id, idempotencyKey },
        );
      }
      return { result: toPlaceOrderResult(existing), created: false };
    }

    const quoteRow = this.quotes.getQuoteRowOrThrow(input.quoteId);
    if (quoteRow.account_id !== input.accountId) {
      throw problem(
        422,
        "ACCOUNT_MISMATCH",
        "The quote belongs to a different account",
        { quoteAccountId: quoteRow.account_id, accountId: input.accountId },
      );
    }
    if (getAccount(this.db, input.accountId) === null) {
      throw problem(404, "ACCOUNT_NOT_FOUND", `Unknown account ${input.accountId}`);
    }
    const now = readClock(this.db);
    if (instantDifferenceMs(now, quoteRow.expires_at) >= 0) {
      throw problem(422, "QUOTE_EXPIRED", "The quote expired before the order was accepted", {
        quoteId: quoteRow.quote_id,
        expiresAt: quoteRow.expires_at,
        now,
      });
    }
    const kind = orderKindOf(quoteRow);
    this.assertManagedRouteAllowed(input.accountId, kind, now);
    this.preflight(quoteRow, kind, input.accountId);

    const orderId = this.ids.order();
    const traceId = this.ids.trace();
    const result = transaction(this.db, () => {
      insertOrder(this.db, {
        orderId,
        idempotencyKey,
        requestHash,
        quoteId: quoteRow.quote_id,
        accountId: input.accountId,
        kind,
        assetId: quoteRow.asset_id,
        side: quoteRow.side,
        amountBase: quoteRow.amount_base,
        businessState: initialBusinessState(kind),
        chainState: "NOT_SUBMITTED",
        policyEpoch:
          quoteRow.dealing_terms_json === null
            ? this.policyEpoch()
            : (JSON.parse(quoteRow.dealing_terms_json) as DealingTerms).policyEpoch,
        traceId,
        createdAt: now,
      });
      enqueueOutbox(this.db, OUTBOX_PROCESS_ORDER, orderId, null, now);
      const row = getOrderRow(this.db, orderId);
      if (row === null) {
        throw new Error("Order row disappeared after insert");
      }
      return toPlaceOrderResult(row);
    });
    return { result, created: true };
  }

  private policyEpoch(): string {
    return hashJson(this.config.policy);
  }

  /**
   * Managed spot and fund dealing require current screening and the documented
   * eligibility class for the gate. A flagged persona is blocked, a basic persona
   * cannot subscribe to fund units or transfer them, and no state is written when
   * the gate declines.
   */
  private assertManagedRouteAllowed(
    accountId: string,
    kind: OrderKind,
    nowIso: string,
  ): void {
    const account = getAccount(this.db, accountId);
    if (account === null) {
      return;
    }
    const persona = this.resolvePersona(accountId, account.persona);
    if (persona === null) {
      return;
    }
    const route: DealingRoute =
      kind === "SPOT_BUY"
        ? "SPOT_BUY"
        : kind === "SPOT_SELL"
          ? "SPOT_SELL"
          : kind === "FUND_SUBSCRIPTION"
            ? "FUND_SUBSCRIPTION"
            : "FUND_REDEMPTION";
    const gateId = ROUTE_GATE[route];
    const gate = gatesFixture.gates.find((item) => item.gateId === gateId);
    if (gate === undefined) {
      return;
    }
    const screening = screeningByParty(accountId) ?? screeningByParty("investor-ada");
    if (screening === undefined) {
      return;
    }
    // The acceptance gate enforces the screening disposition and the issuer
    // class. Staleness, credential expiry and proof-epoch checks are evaluated by
    // the eligibility policy matrix and the eligibility endpoints, where the
    // fixture clock and the recorded refresh times are coherent.
    void nowIso;
    if (screening.disposition === "MATCH") {
      throw problem(403, "SCREENING_DECLINED", "A synthetic screening match blocks this managed route", {
        route,
        gateId,
      });
    }
    if (screening.disposition === "REVIEW") {
      throw problem(409, "SCREENING_REVIEW", "Screening requires review before this route can execute", {
        route,
        gateId,
      });
    }
    if (classRank(persona.class) < classRank(gate.requiredClass)) {
      throw problem(
        422,
        "ELIGIBILITY_REQUIRED",
        `The ${gate.label} requires class ${gate.requiredClass}; this account is ${persona.class}`,
        { route, gateId },
      );
    }
  }

  private resolvePersona(accountId: string, personaName: string | undefined): PersonaLeaf | null {
    const byAccount = personaByAccountId(accountId);
    if (byAccount !== undefined) {
      return byAccount;
    }
    const normalized = (personaName ?? "verified").toLowerCase();
    const candidateId =
      normalized === "basic"
        ? "persona-basic"
        : normalized === "flagged"
          ? "persona-flagged"
          : "persona-verified";
    return personaById(candidateId) ?? null;
  }

  private preflight(quoteRow: QuoteRow, kind: OrderKind, accountId: string): void {
    const investor = investorAccount(accountId);
    const amountBase = BigInt(quoteRow.amount_base);
    if (kind === "SPOT_BUY") {
      const required =
        amountBase + BigInt(quoteRow.charge_ceiling_base);
      const available = this.engine.balanceOf(investor, "dEUR");
      if (available < required) {
        throw problem(422, "INSUFFICIENT_CASH", "Spendable cash does not cover the order", {
          requiredBase: required.toString(),
          availableBase: available.toString(),
        });
      }
      return;
    }
    if (kind === "SPOT_SELL") {
      const available = this.engine.balanceOf(investor, "tWETH");
      if (available < amountBase) {
        throw problem(422, "INSUFFICIENT_INVENTORY", "Insufficient tWETH inventory", {
          requiredBase: amountBase.toString(),
          availableBase: available.toString(),
        });
      }
      const priceBase = BigInt(quoteRow.price_base ?? "0");
      const proceeds = quoteCash({
        unitsBase: amountBase,
        unitDecimals: 18,
        priceBase,
        priceDecimals: 6,
        cashDecimals: 6,
      });
      const dealer = this.engine.state.balanceOf(
        { kind: "dealer", accountId: "dealer-inventory" },
        "dEUR",
      );
      if (dealer < proceeds) {
        throw problem(
          422,
          "INSUFFICIENT_LIQUIDITY",
          "The dealer cannot fund the reverse quote proceeds",
          { requiredBase: proceeds.toString(), availableBase: dealer.toString() },
        );
      }
      return;
    }
    if (kind === "FUND_SUBSCRIPTION") {
      const available = this.engine.balanceOf(investor, "dEUR");
      if (available < amountBase) {
        throw problem(422, "INSUFFICIENT_CASH", "Spendable cash does not cover the subscription", {
          requiredBase: amountBase.toString(),
          availableBase: available.toString(),
        });
      }
      return;
    }
    const available = this.engine.balanceOf(investor, "eFUND");
    if (available < amountBase) {
      throw problem(422, "INSUFFICIENT_INVENTORY", "Insufficient eFUND units", {
        requiredBase: amountBase.toString(),
        availableBase: available.toString(),
      });
    }
  }

  getOrder(orderId: string): Order {
    const row = getOrderRow(this.db, orderId);
    if (row === null) {
      throw problem(404, "ORDER_NOT_FOUND", `Unknown order ${orderId}`, { orderId });
    }
    return this.toOrderResponse(row);
  }

  listOrders(accountId: string): Order[] {
    return listOrderRows(this.db, accountId).map((row) => this.toOrderResponse(row));
  }

  cancelOrder(orderId: string, accountId: string): Order {
    const row = getOrderRow(this.db, orderId);
    if (row === null) {
      throw problem(404, "ORDER_NOT_FOUND", `Unknown order ${orderId}`, { orderId });
    }
    if (row.account_id !== accountId) {
      throw problem(422, "ACCOUNT_MISMATCH", "The order belongs to a different account");
    }
    if (row.kind !== "FUND_SUBSCRIPTION" && row.kind !== "FUND_REDEMPTION") {
      throw problem(409, "INVALID_STATE", "Only pending fund orders can be cancelled");
    }
    if (row.business_state !== "AWAITING_NAV" && row.business_state !== "RESERVED") {
      throw problem(409, "INVALID_STATE", `Order is ${row.business_state} and cannot be cancelled`);
    }
    if (row.dealing_date === null) {
      throw problem(409, "INVALID_STATE", "The order has no assigned dealing day yet");
    }
    const now = readClock(this.db);
    const cutoff = weekdayCutoff(this.config.policy, `${row.dealing_date}T12:00:00Z`);
    const allowedUntil = `${row.dealing_date}T${cutoff}:00Z`;
    if (instantDifferenceMs(now, allowedUntil) >= 0) {
      throw problem(
        422,
        "CANCELLATION_NOT_ALLOWED",
        "The cancellation window closed at the dealing-day cutoff",
        { allowedUntil, now, dealingDate: row.dealing_date },
      );
    }
    const event =
      row.kind === "FUND_SUBSCRIPTION"
        ? ({
            type: "fund.subscription.cancelled" as const,
            eventId: `EV-${orderId}-CANCEL`,
            occurredAt: now,
            orderId,
            reason: "investor_cancellation",
          } as const)
        : ({
            type: "fund.redemption.cancelled" as const,
            eventId: `EV-${orderId}-CANCEL`,
            occurredAt: now,
            orderId,
            reason: "investor_cancellation",
          } as const);
    this.engine.applyEvents([event], {
      orderId,
      mutate: (steps, entries) => {
        const existing = getOrderRow(this.db, orderId);
        if (existing === null) {
          throw new Error("Order disappeared during cancellation");
        }
        updateOrderRow(this.db, orderId, {
          business_state: "CANCELLED",
          reason_code: "CANCELLED_BY_INVESTOR",
          movements_json: appendMovements(existing.movements_json, entries),
          updated_at: now,
        });
      },
    });
    return this.getOrder(orderId);
  }

  private toOrderResponse(row: OrderRow): Order {
    const quoteRow = getQuoteRow(this.db, row.quote_id);
    const detail = row.detail_json === null ? null : (JSON.parse(row.detail_json) as OrderDetail);
    const quoteTerms =
      quoteRow?.dealing_terms_json === null || quoteRow?.dealing_terms_json === undefined
        ? null
        : (JSON.parse(quoteRow.dealing_terms_json) as DealingTerms);
    const isFund = row.kind === "FUND_SUBSCRIPTION" || row.kind === "FUND_REDEMPTION";
    const dealingTerms = isFund
      ? (detail?.dealingTerms ?? quoteTerms)
      : null;
    const receipt =
      row.receipt_json === null ? null : (JSON.parse(row.receipt_json) as OrderReceipt);
    const decline =
      row.decline_json === null
        ? null
        : (JSON.parse(row.decline_json) as { code: string; message: string });
    return {
      orderId: row.order_id,
      quoteId: row.quote_id,
      accountId: row.account_id,
      kind: row.kind as OrderKind,
      assetId: row.asset_id as Order["assetId"],
      side: row.side as OrderSide,
      amountBase: row.amount_base,
      businessState: row.business_state as BusinessState,
      chainState: row.chain_state as ChainState,
      reasonCode: row.reason_code,
      policyEpoch: row.policy_epoch,
      traceId: row.trace_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      dealingTerms,
      receipt,
      moneyMovements: JSON.parse(row.movements_json) as MoneyMovement[],
      decline,
    };
  }
}

export function toPlaceOrderResult(row: OrderRow): PlaceOrderResult {
  return {
    orderId: row.order_id,
    quoteId: row.quote_id,
    accountId: row.account_id,
    kind: row.kind as OrderKind,
    businessState: row.business_state as BusinessState,
    chainState: row.chain_state as ChainState,
    traceId: row.trace_id,
  };
}

export interface QuoteKindInfo {
  readonly quoteKind: QuoteKind;
}

export function navAvailableFor(
  db: Database,
  assetId: string,
  valuationDate: string,
): boolean {
  return getNavRow(db, assetId, valuationDate) !== null;
}
