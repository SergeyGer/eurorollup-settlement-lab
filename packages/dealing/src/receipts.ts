/**
 * Receipt builders. A receipt exposes the economic outcome first: what cash was
 * deployed, how many units were issued or burned and which charge was applied.
 */
import { ASSETS, CASH_ASSET_ID, FUND_ASSET_ID, SPOT_ASSET_ID } from "./assets.js";
import type {
  FundRedemptionState,
  FundSubscriptionState,
  SpotOrderState,
} from "./engine.js";
import { formatDisplayAmount } from "./money.js";
import { RECEIPT_SCHEMA_VERSION } from "./version.js";

export interface FundReceipt {
  readonly schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
  readonly orderId: string;
  readonly businessState: "ALLOCATED";
  readonly assetId: "eFUND";
  readonly unitsBase: string;
  readonly assetDecimals: number;
  readonly cashAssetId: "dEUR";
  readonly cashDeployedBase: string;
  readonly cashDecimals: number;
  readonly navEurPerUnit: string;
  readonly investorChargeBase: "0";
}

export interface SpotReceipt {
  readonly schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
  readonly orderId: string;
  readonly businessState: "FILLED";
  readonly assetId: "tWETH";
  readonly unitsBase: string;
  readonly assetDecimals: number;
  readonly cashAssetId: "dEUR";
  readonly cashDeployedBase: string;
  readonly cashDecimals: number;
  readonly priceEurPerUnit: string;
  readonly investorChargeBase: string;
}

export interface RedemptionReceipt {
  readonly schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
  readonly orderId: string;
  readonly businessState: "REDEEMED";
  readonly assetId: "eFUND";
  readonly unitsBase: string;
  readonly assetDecimals: number;
  readonly cashAssetId: "dEUR";
  readonly cashPaidBase: string;
  readonly cashDecimals: number;
  readonly navEurPerUnit: string;
  readonly investorChargeBase: "0";
}

export type Receipt = FundReceipt | SpotReceipt | RedemptionReceipt;

const cashDecimals = ASSETS[CASH_ASSET_ID].decimals;

export function buildFundReceipt(order: FundSubscriptionState): FundReceipt {
  const allocation = order.allocation;
  if (allocation === undefined) {
    throw new Error(`Order ${order.orderId} has no allocation yet`);
  }
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    orderId: order.orderId,
    businessState: "ALLOCATED",
    assetId: "eFUND",
    unitsBase: allocation.unitsBase.toString(),
    assetDecimals: ASSETS[FUND_ASSET_ID].decimals,
    cashAssetId: "dEUR",
    cashDeployedBase: allocation.cashConsumedBase.toString(),
    cashDecimals,
    navEurPerUnit: formatDisplayAmount(allocation.navBase, 6, 2),
    investorChargeBase: "0",
  };
}

export function buildSpotReceipt(order: SpotOrderState): SpotReceipt {
  if (order.assetBase === undefined || order.cashBase === undefined) {
    throw new Error(`Order ${order.orderId} has not filled yet`);
  }
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    orderId: order.orderId,
    businessState: "FILLED",
    assetId: "tWETH",
    unitsBase: order.assetBase.toString(),
    assetDecimals: ASSETS[SPOT_ASSET_ID].decimals,
    cashAssetId: "dEUR",
    cashDeployedBase: order.cashBase.toString(),
    cashDecimals,
    priceEurPerUnit: formatDisplayAmount(order.priceBase, 6, 2),
    investorChargeBase: order.chargeBase.toString(),
  };
}

export function buildRedemptionReceipt(order: FundRedemptionState): RedemptionReceipt {
  const redemption = order.redemption;
  if (redemption === undefined) {
    throw new Error(`Order ${order.orderId} has not settled yet`);
  }
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    orderId: order.orderId,
    businessState: "REDEEMED",
    assetId: "eFUND",
    unitsBase: redemption.unitsBase.toString(),
    assetDecimals: ASSETS[FUND_ASSET_ID].decimals,
    cashAssetId: "dEUR",
    cashPaidBase: redemption.proceedsBase.toString(),
    cashDecimals,
    navEurPerUnit: formatDisplayAmount(redemption.navBase, 6, 2),
    investorChargeBase: "0",
  };
}
