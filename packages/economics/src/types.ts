/**
 * Shared numeric types for the A07 economics evidence.
 *
 * All monetary values are integers in their smallest unit. Native currency is
 * tracked in wei; euro amounts are tracked in micro-euro (1e-6 EUR) so that the
 * six-decimal dEUR ledger and the 0.05 EUR spot charge can be represented
 * exactly. Values that were not measured are represented as `null` and listed as
 * unavailable; the economics code never substitutes a fabricated number.
 */
export type Wei = bigint;
export type EurMicros = bigint;

export interface RateObservation {
  readonly pair: "EUR/ETH";
  /** Decimal string kept for display only; arithmetic uses `rateMicrosPerEth`. */
  readonly rateEurPerEth: string;
  /** Euro per one ETH scaled by 1e6 (for example 3_200_500_000 = 3200.50 EUR/ETH). */
  readonly rateMicrosPerEth: EurMicros;
  /** Frozen fixture timestamp, not a publication date. */
  readonly observedAt: string;
  readonly source: "demo-fixture" | "recorded";
  readonly maxAgeSeconds: number;
}

export type DataMode = "measured" | "modeled" | "mixed";

export function formatWei(value: Wei): string {
  return value.toString();
}

export function formatEurMicros(value: EurMicros): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / 1_000_000n;
  const fraction = (absolute % 1_000_000n).toString().padStart(6, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${fraction}`;
}
