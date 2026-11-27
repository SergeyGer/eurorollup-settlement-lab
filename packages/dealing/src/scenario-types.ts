/** Frozen fixture shapes. The JSON files under fixtures/ are the source of truth. */

import type { AssetId } from "./assets.js";

export interface CalendarFixture {
  readonly calendarId: string;
  readonly version: string;
  readonly timezone: "UTC";
  readonly description?: string;
  readonly dealingDays?: readonly string[];
  readonly closedDates?: readonly string[];
}

export interface InstrumentsFixture {
  readonly schemaVersion: string;
  readonly description: string;
  readonly assets: ReadonlyArray<{
    readonly assetId: AssetId;
    readonly symbol: string;
    readonly decimals: number;
    readonly kind: "cash" | "spot" | "fund";
    readonly priceDecimals?: number;
    readonly notes?: string;
  }>;
}

export interface AccountsFixture {
  readonly investorId: string;
  readonly dealerInventoryId: string;
  readonly feeRecipientId: string;
  readonly issuerTreasuryId: string;
  readonly issuanceControlId: string;
  readonly fundEscrowId: string;
}

export interface G01SpotFixture {
  readonly orderId: string;
  readonly side: "BUY";
  readonly amountBase: string;
  readonly priceBase: string;
  readonly priceAsOf: string;
  readonly expiresAt: string;
  readonly chargeBase: string;
  readonly quoteIssuedAt: string;
  readonly filledAt: string;
}

export interface G01FundFixture {
  readonly orderId: string;
  readonly cashBase: string;
  readonly indicativeNavBase: string;
  readonly requestedAt: string;
  readonly cutoffTimeUtc: string;
  readonly nav: NavFixture;
  readonly allocatedAt: string;
}

export interface NavFixture {
  readonly valuationDate: string;
  readonly navBase: string;
  readonly sourceTime: string;
  readonly revision: number;
  readonly signer: string;
}

export interface G01ExpectedCheckpoint {
  readonly label: string;
  readonly spendableCashBase: string;
  readonly reservedCashBase: string;
  readonly tWethBalanceBase: string;
  readonly eFundBalanceBase: string;
  readonly totalMarkedValueBase: string;
}

export interface G01Scenario {
  readonly fixtureId: "G01";
  readonly fixtureVersion: string;
  readonly description: string;
  readonly calendarId: string;
  readonly accounts: AccountsFixture;
  readonly marks: Readonly<Record<"tWETH" | "eFUND", string>>;
  readonly seed: {
    readonly assetId: "dEUR";
    readonly amountBase: string;
    readonly occurredAt: string;
  };
  readonly spot: G01SpotFixture;
  readonly fund: G01FundFixture;
  readonly expected: {
    readonly checkpoints: readonly G01ExpectedCheckpoint[];
    readonly finalPortfolioValueBase: string;
    readonly spendableCashBase: string;
    readonly reservedCashBase: string;
    readonly tWethBalanceBase: string;
    readonly eFundBalanceBase: string;
  };
}

export interface G01RedemptionScenario {
  readonly fixtureId: "G01-R";
  readonly fixtureVersion: string;
  readonly description: string;
  readonly orderId: string;
  readonly investorId: string;
  readonly unitsBase: string;
  readonly requestedAt: string;
  readonly cutoffTimeUtc: string;
  readonly nav: NavFixture;
  readonly settledAt: string;
  readonly expected: {
    readonly spendableCashBase: string;
    readonly eFundUnitsBase: string;
  };
}

export interface P01OrderFixture {
  readonly orderId: string;
  readonly investorId: string;
  readonly cashBase: string;
  readonly requestedAt: string;
}

export interface P01Scenario {
  readonly fixtureId: "P01";
  readonly fixtureVersion: string;
  readonly description: string;
  readonly calendarId: string;
  readonly baselinePolicy: {
    readonly policyId: "eFUND-dealing";
    readonly version: number;
    readonly weekdayCutoffs: Readonly<Record<string, string>>;
  };
  readonly candidatePolicy: {
    readonly policyId: "eFUND-dealing";
    readonly version: number;
    readonly weekdayCutoffs: Readonly<Record<string, string>>;
  };
  readonly initialBalances: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly orders: readonly P01OrderFixture[];
  readonly navs: readonly NavFixture[];
  readonly snapshots: readonly { readonly label: string; readonly at: string }[];
  readonly expected: {
    readonly affectedOrders: number;
    readonly totalOrders: number;
    readonly extraReservedAtFridayCloseBase: string;
    readonly unitsByBranch: Readonly<
      Record<string, Readonly<Record<string, string>>>
    >;
    readonly fridaySnapshot: Readonly<Record<string, unknown>>;
    readonly mondaySnapshot: Readonly<Record<string, unknown>>;
  };
}

export interface BoundaryCaseFixture {
  readonly caseId: string;
  readonly description: string;
  readonly calendarId: string;
  readonly requestedAt: string;
  readonly expected: {
    readonly baselineDealingDate: string;
    readonly candidateDealingDate: string;
    readonly baselineReason: string;
    readonly candidateReason: string;
  };
}

export interface BoundaryCasesFixture {
  readonly fixtureId: string;
  readonly fixtureVersion: string;
  readonly description: string;
  readonly calendarId: string;
  readonly baselineCutoffTimeUtc: string;
  readonly candidateCutoffTimeUtc: string;
  readonly cutoffs: {
    readonly baseline: Readonly<Record<string, string>>;
    readonly candidate: Readonly<Record<string, string>>;
  };
  readonly cases: readonly BoundaryCaseFixture[];
}
