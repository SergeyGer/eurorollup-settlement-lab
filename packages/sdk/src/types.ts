/**
 * Typed partner API contract.
 *
 * These types mirror the local HTTP API described in `docs/api/partner-api.md`.
 * Amounts are integer base units serialized as decimal strings; timestamps are
 * strict UTC instants (`YYYY-MM-DDTHH:mm:ssZ`).
 */

export type AssetId = "dEUR" | "tWETH" | "eFUND";

export type OrderSide = "BUY" | "SELL" | "SUBSCRIBE" | "REDEEM";

export type QuoteKind = "SPOT" | "FUND";

export type OrderKind =
  | "SPOT_BUY"
  | "SPOT_SELL"
  | "FUND_SUBSCRIPTION"
  | "FUND_REDEMPTION";

export type BusinessState =
  | "SUBMITTED"
  | "FILLED"
  | "RESERVED"
  | "AWAITING_NAV"
  | "ALLOCATED"
  | "REDEEMED"
  | "CANCELLED"
  | "DECLINED"
  | "EXPIRED";

/** Chain state is tracked independently of business state. */
export type ChainState = "NOT_SUBMITTED";

export type ReasonCode =
  | "QUOTE_EXPIRED"
  | "STALE_PRICE"
  | "PRICE_SOURCE_UNAVAILABLE"
  | "INSUFFICIENT_CASH"
  | "INSUFFICIENT_INVENTORY"
  | "INSUFFICIENT_LIQUIDITY"
  | "MINIMUM_PROCEEDS_NOT_MET"
  | "ZERO_UNIT_FILL"
  | "NAV_MISSING"
  | "NAV_STALE"
  | "CANCELLATION_NOT_ALLOWED"
  | "IDEMPOTENCY_KEY_REUSED"
  | "ACCOUNT_MISMATCH"
  | "QUOTE_NOT_FOUND"
  | "ORDER_NOT_FOUND"
  | "ACCOUNT_NOT_FOUND"
  | "UNSUPPORTED_ORDER"
  | "INVALID_REQUEST"
  | "INVALID_AMOUNT"
  | "ROLE_NOT_AUTHORIZED"
  | "INVALID_STATE";

export type DealingAssignmentReason =
  | "BEFORE_CUTOFF_SAME_DAY"
  | "AT_OR_AFTER_CUTOFF"
  | "NON_DEALING_DAY";

export interface DealingTerms {
  readonly calendarId: string;
  readonly calendarVersion: string;
  readonly cutoffTimeUtc: string;
  readonly assignedDealingDate: string;
  readonly assignmentReason: DealingAssignmentReason;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly policyEpoch: string;
  readonly indicativeNavAsOf: string;
}

export interface Quote {
  readonly quoteId: string;
  readonly kind: QuoteKind;
  readonly accountId: string;
  readonly assetId: AssetId;
  readonly side: OrderSide;
  /** Cash base units for BUY/SUBSCRIBE, asset base units for SELL/REDEEM. */
  readonly amountBase: string;
  readonly priceBase?: string;
  readonly priceAsOf?: string;
  readonly expiresAt: string;
  readonly chargeCeilingBase: string;
  readonly indicativeNavBase?: string;
  readonly dealingTerms?: DealingTerms;
  readonly createdAt: string;
}

export interface CreateQuoteInput {
  readonly accountId: string;
  readonly assetId: AssetId;
  readonly side: OrderSide;
  readonly amountBase: string;
}

export interface PlaceOrderInput {
  readonly quoteId: string;
  readonly accountId: string;
}

export interface PlaceOrderResult {
  readonly orderId: string;
  readonly quoteId: string;
  readonly accountId: string;
  readonly kind: OrderKind;
  readonly businessState: BusinessState;
  readonly chainState: ChainState;
  readonly traceId: string;
}

export interface MoneyPosting {
  readonly accountKind: string;
  readonly accountId: string;
  readonly assetId: AssetId;
  readonly amountBase: string;
}

export interface MoneyMovement {
  readonly entryId: string;
  readonly occurredAt: string;
  readonly description: string;
  readonly postings: readonly MoneyPosting[];
}

export interface FundReceipt {
  readonly schemaVersion: "1.0";
  readonly orderId: string;
  readonly businessState: "ALLOCATED";
  readonly assetId: "eFUND";
  readonly unitsBase: string;
  readonly assetDecimals: 6;
  readonly cashAssetId: "dEUR";
  readonly cashDeployedBase: string;
  readonly cashDecimals: 6;
  readonly navEurPerUnit: string;
  readonly investorChargeBase: "0";
}

export interface SpotReceipt {
  readonly schemaVersion: "1.0";
  readonly orderId: string;
  readonly businessState: "FILLED";
  readonly assetId: "tWETH";
  readonly unitsBase: string;
  readonly assetDecimals: 18;
  readonly cashAssetId: "dEUR";
  readonly cashDeployedBase: string;
  readonly cashDecimals: 6;
  readonly priceEurPerUnit: string;
  readonly investorChargeBase: string;
}

export interface RedemptionReceipt {
  readonly schemaVersion: "1.0";
  readonly orderId: string;
  readonly businessState: "REDEEMED";
  readonly assetId: "eFUND";
  readonly unitsBase: string;
  readonly assetDecimals: 6;
  readonly cashAssetId: "dEUR";
  readonly cashPaidBase: string;
  readonly cashDecimals: 6;
  readonly navEurPerUnit: string;
  readonly investorChargeBase: "0";
}

export type OrderReceipt = FundReceipt | SpotReceipt | RedemptionReceipt;

export interface Order {
  readonly orderId: string;
  readonly quoteId: string;
  readonly accountId: string;
  readonly kind: OrderKind;
  readonly assetId: AssetId;
  readonly side: OrderSide;
  readonly amountBase: string;
  readonly businessState: BusinessState;
  readonly chainState: ChainState;
  readonly reasonCode: string | null;
  readonly policyEpoch: string;
  readonly traceId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly dealingTerms: DealingTerms | null;
  readonly receipt: OrderReceipt | null;
  readonly moneyMovements: readonly MoneyMovement[];
  readonly decline: { readonly code: string; readonly message: string } | null;
}

export interface AssetBalanceBucket {
  /** Spendable amount for cash; available amount for instruments. */
  readonly availableBase: string;
  /** Amount committed to pending orders in the same asset. */
  readonly reservedBase: string;
}

export interface MarkProvenance {
  readonly assetId: AssetId;
  readonly priceBase: string;
  readonly source: string;
  readonly asOf: string;
  readonly stale: boolean;
}

export interface PendingPortfolioOrder {
  readonly orderId: string;
  readonly kind: OrderKind;
  readonly businessState: BusinessState;
  readonly reasonCode: string | null;
  readonly dealingDate: string | null;
  readonly reservedCashBase: string;
  readonly reservedUnitsBase: string;
}

export interface Portfolio {
  readonly accountId: string;
  readonly displayName: string;
  readonly persona: string;
  readonly asOf: string;
  readonly dataMode: string;
  /** Reserved for the pinned rollup: no chain reader is attached in this mode. */
  readonly blockHash: string | null;
  readonly balances: Readonly<Record<AssetId, AssetBalanceBucket>>;
  readonly markedValueBase: string;
  readonly marks: readonly MarkProvenance[];
  readonly excludedHoldings: readonly string[];
  readonly pendingOrders: readonly PendingPortfolioOrder[];
}

export interface PortfolioSummary {
  readonly accountId: string;
  readonly displayName: string;
  readonly persona: string;
  readonly cashBase: string;
}

export interface NavPublicationRequest {
  readonly assetId: "eFUND";
  readonly valuationDate: string;
  readonly navBase: string;
  readonly sourceTime: string;
  readonly revision: number;
}

export interface NavPublicationResult {
  readonly assetId: "eFUND";
  readonly valuationDate: string;
  readonly navBase: string;
  readonly navEurPerUnit: string;
  readonly sourceTime: string;
  readonly revision: number;
  readonly signer: string;
  readonly observedAt: string;
  readonly queuedOrderIds: readonly string[];
}

export interface ClockState {
  readonly now: string;
  readonly previous?: string;
}

export interface HealthStatus {
  readonly status: "ok";
  readonly service: string;
  readonly mode: string;
  readonly serviceVersion: string;
  readonly engineVersion: string;
  readonly calendarId: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly policyEpoch: string;
  readonly clock: string;
  readonly eventCount: number;
  readonly pendingOutbox: number;
}

export interface DemoResetResult {
  readonly status: "reset";
  readonly clock: string;
}

export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
  readonly traceId?: string;
}
