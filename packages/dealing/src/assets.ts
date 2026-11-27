/** Instrument registry. All amounts are integer base units. */

export type AssetId = "dEUR" | "tWETH" | "eFUND";

export type AssetKind = "cash" | "spot" | "fund";

export interface AssetDefinition {
  readonly assetId: AssetId;
  readonly symbol: string;
  readonly displayName: string;
  readonly decimals: number;
  readonly kind: AssetKind;
}

export const ASSETS: Readonly<Record<AssetId, AssetDefinition>> = Object.freeze({
  dEUR: {
    assetId: "dEUR",
    symbol: "dEUR",
    displayName: "Demo euro cash",
    decimals: 6,
    kind: "cash",
  },
  tWETH: {
    assetId: "tWETH",
    symbol: "tWETH",
    displayName: "Test wrapped ETH",
    decimals: 18,
    kind: "spot",
  },
  eFUND: {
    assetId: "eFUND",
    symbol: "eFUND",
    displayName: "Fictional euro short-duration bond fund unit",
    decimals: 6,
    kind: "fund",
  },
});

export const CASH_ASSET_ID: AssetId = "dEUR";
export const SPOT_ASSET_ID: AssetId = "tWETH";
export const FUND_ASSET_ID: AssetId = "eFUND";

export function assetDefinition(assetId: AssetId): AssetDefinition {
  const definition = ASSETS[assetId];
  if (definition === undefined) {
    throw new Error(`Unknown asset: ${String(assetId)}`);
  }
  return definition;
}

export function decimalsOf(assetId: AssetId): number {
  return assetDefinition(assetId).decimals;
}
