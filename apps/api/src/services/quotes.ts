/**
 * Quote service.
 *
 * A quote is a pre-acceptance offer: spot quotes carry the fixture dealer price
 * and a 30 second lifetime; fund quotes carry the indicative NAV and the
 * dealing terms derived from the versioned calendar and policy. Nothing is
 * reserved until an order is accepted.
 */
import {
  DEFAULT_CUTOFF_TIME_UTC,
  SPOT_INVESTOR_CHARGE_BASE,
  allocateCashToUnits,
  assignDealingDay,
  formatUtcInstant,
  instantDifferenceMs,
  parseBaseUnits,
  parseUtcInstant,
  policyDigest,
  quoteCash,
  quoteUnits,
  weekdayCodeOfDate,
  type AssetId,
  type DealingCalendar,
  type FundDealingPolicy,
} from "@eurorollup/dealing";
import type {
  DealingAssignmentReason,
  DealingTerms,
  OrderKind,
  OrderSide,
  Quote,
  QuoteKind,
  ReasonCode,
} from "@eurorollup/sdk";
import type { ApiConfig } from "../config.js";
import type { Database } from "../db.js";
import { getAccount, readPriceSource } from "../db.js";
import type { ClockService } from "../clock-service.js";
import type { EngineService } from "../engine-service.js";
import { investorAccount } from "../engine-service.js";
import type { IdFactory } from "../ids.js";
import { ApiProblem, problem } from "../problems.js";
import { getQuoteRow, insertQuote, type QuoteRow } from "../repository.js";

export const SPOT_QUOTE_TTL_MS = 30_000;
export const FUND_QUOTE_TTL_MS = 15 * 60_000;
export const SPOT_PRICE_MAX_AGE_MS = 60_000;

export interface CreateQuoteInput {
  readonly accountId: string;
  readonly assetId: AssetId;
  readonly side: OrderSide;
  readonly amountBase: string;
}

interface ResolvedKind {
  readonly quoteKind: QuoteKind;
  readonly orderKind: OrderKind;
}

function resolveKind(assetId: AssetId, side: OrderSide): ResolvedKind {
  if (assetId === "tWETH" && side === "BUY") {
    return { quoteKind: "SPOT", orderKind: "SPOT_BUY" };
  }
  if (assetId === "tWETH" && side === "SELL") {
    return { quoteKind: "SPOT", orderKind: "SPOT_SELL" };
  }
  if (assetId === "eFUND" && side === "SUBSCRIBE") {
    return { quoteKind: "FUND", orderKind: "FUND_SUBSCRIPTION" };
  }
  if (assetId === "eFUND" && side === "REDEEM") {
    return { quoteKind: "FUND", orderKind: "FUND_REDEMPTION" };
  }
  throw problem(
    422,
    "UNSUPPORTED_ORDER",
    "Release 1.0 supports tWETH BUY/SELL and eFUND SUBSCRIBE/REDEEM",
    { assetId, side },
  );
}

export function weekdayCutoff(policy: FundDealingPolicy, requestedAt: string): string {
  const weekday = weekdayCodeOfDate(parseUtcInstant(requestedAt).date);
  if (weekday === "SAT" || weekday === "SUN") {
    return DEFAULT_CUTOFF_TIME_UTC;
  }
  return policy.weekdayCutoffs[weekday];
}

function dealingTermsFor(params: {
  config: ApiConfig;
  requestedAt: string;
  policyEpoch: string;
}): DealingTerms {
  const policy = params.config.policy;
  const cutoffTimeUtc = weekdayCutoff(policy, params.requestedAt);
  const assignment = assignDealingDay({
    requestedAt: params.requestedAt,
    cutoffTimeUtc,
    calendar: params.config.calendar,
  });
  return {
    calendarId: params.config.calendar.calendarId,
    calendarVersion: params.config.calendar.version,
    cutoffTimeUtc,
    assignedDealingDate: assignment.dealingDate,
    assignmentReason: assignment.reason as DealingAssignmentReason,
    policyId: policy.policyId,
    policyVersion: policy.version,
    policyEpoch: params.policyEpoch,
    indicativeNavAsOf: params.requestedAt,
  };
}

export class QuoteService {
  private readonly db: Database;
  private readonly config: ApiConfig;
  private readonly engine: EngineService;
  private readonly clock: ClockService;
  private readonly ids: IdFactory;

  constructor(
    db: Database,
    config: ApiConfig,
    engine: EngineService,
    clock: ClockService,
    ids: IdFactory,
  ) {
    this.db = db;
    this.config = config;
    this.engine = engine;
    this.clock = clock;
    this.ids = ids;
  }

  createQuote(input: CreateQuoteInput): Quote {
    const account = getAccount(this.db, input.accountId);
    if (account === null) {
      throw problem(404, "ACCOUNT_NOT_FOUND", `Unknown account ${input.accountId}`, {
        accountId: input.accountId,
      });
    }
    const amountBase = parseBaseUnits(input.amountBase);
    if (amountBase <= 0n) {
      throw problem(400, "INVALID_AMOUNT", "Amount must be positive base units", {
        amountBase: input.amountBase,
      });
    }
    const { quoteKind, orderKind } = resolveKind(input.assetId, input.side);
    void orderKind;
    const now = this.clock.getNow();
    const policyEpoch = policyDigest(this.config.policy);
    const quoteId = this.ids.quote();
    const calendar = this.config.calendar;

    if (quoteKind === "SPOT") {
      const priceSource = readPriceSource(this.db);
      if (priceSource.unavailable) {
        throw new ApiProblem(
          503,
          "PRICE_SOURCE_UNAVAILABLE",
          "The dealer price source is unavailable; retry later",
          { details: { priceSourceId: "dealer-tWETH-fixture" }, retryAfterSeconds: 5 },
        );
      }
      const priceAsOf = priceSource.asOf ?? now;
      const priceAgeMs = instantDifferenceMs(now, priceAsOf);
      if (priceAgeMs < 0 || priceAgeMs > SPOT_PRICE_MAX_AGE_MS) {
        throw problem(
          422,
          "STALE_PRICE",
          `The dealer price source is ${Math.round(priceAgeMs / 1000)} seconds old at quote time`,
          { now, priceAsOf, maxAgeSeconds: SPOT_PRICE_MAX_AGE_MS / 1000 },
        );
      }
      const priceBase = this.config.dealerSpotPriceBase;
      const expiresAt = formatUtcInstant(parseUtcInstant(now).epochMs + SPOT_QUOTE_TTL_MS);
      if (input.side === "BUY") {
        const units = quoteUnits({
          amountBase,
          amountDecimals: 6,
          priceBase,
          priceDecimals: 6,
          resultDecimals: 18,
        });
        if (units === 0n) {
          throw problem(422, "ZERO_UNIT_FILL", "The cash amount would buy zero tWETH units", {
            amountBase: amountBase.toString(),
          });
        }
      } else if (input.side === "SELL") {
        const proceeds = quoteCash({
          unitsBase: amountBase,
          unitDecimals: 18,
          priceBase,
          priceDecimals: 6,
          cashDecimals: 6,
        });
        if (proceeds === 0n) {
          throw problem(422, "ZERO_UNIT_FILL", "The sale amount would pay zero cash", {
            amountBase: amountBase.toString(),
          });
        }
        const investorUnits = this.engine.balanceOf(
          investorAccount(input.accountId),
          "tWETH",
        );
        if (investorUnits < amountBase) {
          throw problem(
            422,
            "INSUFFICIENT_INVENTORY",
            "The investor does not hold enough tWETH to sell",
            { requestedBase: amountBase.toString(), availableBase: investorUnits.toString() },
          );
        }
        if (priceSource.asOf !== null) {
          // A pinned as-of time is a fixture override: no extra inventory model applies.
          void priceSource.asOf;
        }
      }
      const row: QuoteRow = {
        quote_id: quoteId,
        kind: "SPOT",
        account_id: input.accountId,
        asset_id: input.assetId,
        side: input.side,
        amount_base: amountBase.toString(),
        price_base: priceBase.toString(),
        price_as_of: priceAsOf,
        expires_at: expiresAt,
        charge_ceiling_base: SPOT_INVESTOR_CHARGE_BASE.toString(),
        indicative_nav_base: null,
        dealing_terms_json: null,
        created_at: now,
      };
      insertQuote(this.db, row);
      return toQuoteResponse(row);
    }

    const indicativeNavBase = this.config.indicativeNavBase;
    if (input.side === "SUBSCRIBE") {
      const allocation = allocateCashToUnits({
        cashBase: amountBase,
        cashDecimals: 6,
        navBase: indicativeNavBase,
        navDecimals: 6,
        unitDecimals: 6,
      });
      if (allocation.unitsBase === 0n) {
        throw problem(422, "ZERO_UNIT_FILL", "The cash amount would issue zero fund units", {
          amountBase: amountBase.toString(),
        });
      }
    } else {
      const investorUnits = this.engine.balanceOf(
        investorAccount(input.accountId),
        "eFUND",
      );
      if (investorUnits < amountBase) {
        throw problem(
          422,
          "INSUFFICIENT_INVENTORY",
          "The investor does not hold enough eFUND units to redeem",
          { requestedBase: amountBase.toString(), availableBase: investorUnits.toString() },
        );
      }
    }
    const dealingTerms = dealingTermsFor({ config: this.config, requestedAt: now, policyEpoch });
    const row: QuoteRow = {
      quote_id: quoteId,
      kind: "FUND",
      account_id: input.accountId,
      asset_id: input.assetId,
      side: input.side,
      amount_base: amountBase.toString(),
      price_base: null,
      price_as_of: null,
      expires_at: formatUtcInstant(parseUtcInstant(now).epochMs + FUND_QUOTE_TTL_MS),
      charge_ceiling_base: "0",
      indicative_nav_base: indicativeNavBase.toString(),
      dealing_terms_json: JSON.stringify(dealingTerms),
      created_at: now,
    };
    insertQuote(this.db, row);
    return toQuoteResponse(row);
  }

  getQuoteRowOrThrow(quoteId: string): QuoteRow {
    const row = getQuoteRow(this.db, quoteId);
    if (row === null) {
      throw problem(404, "QUOTE_NOT_FOUND", `Unknown quote ${quoteId}`, { quoteId });
    }
    return row;
  }
}

export function toQuoteResponse(row: QuoteRow): Quote {
  const base = {
    quoteId: row.quote_id,
    kind: row.kind as QuoteKind,
    accountId: row.account_id,
    assetId: row.asset_id as AssetId,
    side: row.side as OrderSide,
    amountBase: row.amount_base,
    expiresAt: row.expires_at,
    chargeCeilingBase: row.charge_ceiling_base,
    createdAt: row.created_at,
  } as const;
  if (row.kind === "SPOT") {
    return {
      ...base,
      ...(row.price_base === null ? {} : { priceBase: row.price_base }),
      ...(row.price_as_of === null ? {} : { priceAsOf: row.price_as_of }),
    };
  }
  return {
    ...base,
    ...(row.indicative_nav_base === null
      ? {}
      : { indicativeNavBase: row.indicative_nav_base }),
    ...(row.dealing_terms_json === null
      ? {}
      : { dealingTerms: JSON.parse(row.dealing_terms_json) as DealingTerms }),
  } satisfies Quote;
}

export function calendarFor(config: ApiConfig): DealingCalendar {
  return config.calendar;
}

export type { ReasonCode };
