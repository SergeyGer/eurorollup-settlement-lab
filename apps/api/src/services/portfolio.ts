/**
 * Portfolio projection.
 *
 * Balances are derived from the replayable engine state, not from a separate
 * mutable account table. Cash reserved for pending fund orders is displayed in
 * its own bucket, and marks carry their provenance so stale or indicative
 * prices are explicit.
 */
import {
  formatBaseAsDecimal,
  instantDifferenceMs,
  isFresh,
  parseBaseUnits,
  quoteCash,
  type AssetId,
  type JournalAccount,
  type PortfolioSnapshot,
} from "@eurorollup/dealing";
import type {
  AssetBalanceBucket,
  BusinessState,
  MarkProvenance,
  OrderKind,
  PendingPortfolioOrder,
  Portfolio,
  PortfolioSummary,
} from "@eurorollup/sdk";
import type { ApiConfig } from "../config.js";
import type { Database } from "../db.js";
import { getAccount, readAccounts, readClock, readPriceSource, type AccountRow } from "../db.js";
import type { EngineService } from "../engine-service.js";
import { investorAccount } from "../engine-service.js";
import type { ClockService } from "../clock-service.js";
import { problem } from "../problems.js";

const SPOT_PRICE_MAX_AGE_MS = 60_000;
const NAV_MAX_AGE_MS = 15 * 60_000;

export class PortfolioService {
  private readonly db: Database;
  private readonly config: ApiConfig;
  private readonly engine: EngineService;
  private readonly clock: ClockService;

  constructor(db: Database, config: ApiConfig, engine: EngineService, clock: ClockService) {
    this.db = db;
    this.config = config;
    this.engine = engine;
    this.clock = clock;
  }

  listPortfolios(): PortfolioSummary[] {
    const now = readClock(this.db);
    const accounts = readAccounts(this.db);
    return accounts.map((account) => ({
      accountId: account.account_id,
      displayName: account.display_name,
      persona: account.persona,
      cashBase: this.engine
        .balanceOf(investorAccount(account.account_id), "dEUR")
        .toString(),
    }));
  }

  getPortfolio(accountId: string): Portfolio {
    const account = getAccount(this.db, accountId);
    if (account === null) {
      throw problem(404, "ACCOUNT_NOT_FOUND", `Unknown account ${accountId}`, { accountId });
    }
    const now = readClock(this.db);
    const investor = investorAccount(accountId);
    const spendableCashBase = this.engine.balanceOf(investor, "dEUR");
    const tWethBalanceBase = this.engine.balanceOf(investor, "tWETH");
    const eFundBalanceBase = this.engine.balanceOf(investor, "eFUND");

    let reservedCashBase = 0n;
    let reservedUnitsBase = 0n;
    const pendingOrders: PendingPortfolioOrder[] = [];
    for (const order of this.engine.state.orders()) {
      if (order.account.accountId !== accountId) {
        continue;
      }
      if (order.status !== "AWAITING_NAV") {
        continue;
      }
      const dealingDate =
        "dealingDate" in order ? order.dealingDate : null;
      if (order.kind === "fund-subscription") {
        reservedCashBase += order.reservedCashBase;
        pendingOrders.push({
          orderId: order.orderId,
          kind: "FUND_SUBSCRIPTION",
          businessState: order.status as BusinessState,
          reasonCode: null,
          dealingDate,
          reservedCashBase: order.reservedCashBase.toString(),
          reservedUnitsBase: "0",
        });
      } else if (order.kind === "fund-redemption") {
        reservedUnitsBase += order.reservedUnitsBase;
        pendingOrders.push({
          orderId: order.orderId,
          kind: "FUND_REDEMPTION",
          businessState: order.status as BusinessState,
          reasonCode: null,
          dealingDate,
          reservedCashBase: "0",
          reservedUnitsBase: order.reservedUnitsBase.toString(),
        });
      }
    }

    const marks = this.marks(now);
    const tWethMark = marks.find((mark) => mark.assetId === "tWETH");
    const eFundMark = marks.find((mark) => mark.assetId === "eFUND");
    const tWethValue = quoteCash({
      unitsBase: tWethBalanceBase,
      unitDecimals: 18,
      priceBase: parseBaseUnits(tWethMark?.priceBase ?? "0"),
      priceDecimals: 6,
      cashDecimals: 6,
    });
    const eFundValue = quoteCash({
      unitsBase: eFundBalanceBase + reservedUnitsBase,
      unitDecimals: 6,
      priceBase: parseBaseUnits(eFundMark?.priceBase ?? "0"),
      priceDecimals: 6,
      cashDecimals: 6,
    });
    const markedValueBase = spendableCashBase + reservedCashBase + tWethValue + eFundValue;

    const balances: Record<AssetId, AssetBalanceBucket> = {
      dEUR: {
        availableBase: spendableCashBase.toString(),
        reservedBase: reservedCashBase.toString(),
      },
      tWETH: { availableBase: tWethBalanceBase.toString(), reservedBase: "0" },
      eFUND: {
        availableBase: eFundBalanceBase.toString(),
        reservedBase: reservedUnitsBase.toString(),
      },
    };

    return {
      accountId,
      displayName: account.display_name,
      persona: account.persona,
      asOf: now,
      dataMode: this.config.dataMode,
      blockHash: null,
      balances,
      markedValueBase: markedValueBase.toString(),
      marks,
      excludedHoldings: [],
      pendingOrders: pendingOrders.sort((a, b) => (a.orderId < b.orderId ? -1 : 1)),
    } satisfies Portfolio;
  }

  private marks(now: string): MarkProvenance[] {
    const priceSource = readPriceSource(this.db);
    const spotAsOf = priceSource.asOf ?? now;
    const spotAgeMs = instantDifferenceMs(now, spotAsOf);
    const spotStale = priceSource.unavailable || spotAgeMs < 0 || spotAgeMs > SPOT_PRICE_MAX_AGE_MS;
    const latestNav = [...this.engine.state.navs()].sort((a, b) =>
      a.sourceTime < b.sourceTime ? 1 : -1,
    )[0];
    const fundMark: MarkProvenance =
      latestNav === undefined
        ? {
            assetId: "eFUND",
            priceBase: this.config.indicativeNavBase.toString(),
            source: "indicative-fixture-nav",
            asOf: now,
            stale: false,
          }
        : {
            assetId: "eFUND",
            priceBase: latestNav.navBase.toString(),
            source: "authorized-nav",
            asOf: latestNav.sourceTime,
            stale: !isFresh(latestNav.sourceTime, now, NAV_MAX_AGE_MS),
          };
    return [
      {
        assetId: "tWETH",
        priceBase: this.config.dealerSpotPriceBase.toString(),
        source: "dealer-fixture-quote",
        asOf: spotAsOf,
        stale: spotStale,
      },
      fundMark,
    ];
  }
}

/** Formats a portfolio snapshot cash amount for the operator-facing summary. */
export function formatCash(base: bigint): string {
  return formatBaseAsDecimal(base, 6);
}

export type { JournalAccount, PortfolioSnapshot };
