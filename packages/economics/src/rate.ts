/** Freshness and conversion rules for the timestamped demo EUR/ETH rate. */
import type { EurMicros, RateObservation, Wei } from "./types.js";

export interface RateFreshness {
  readonly usable: boolean;
  readonly ageSeconds: number;
  readonly reason: string | null;
}

/**
 * A rate observation is usable only when it is not older than its configured
 * maximum age. The age is computed against the supplied observation time, so the
 * check is deterministic and testable.
 */
export function checkRateFreshness(rate: RateObservation, nowEpochSeconds: number): RateFreshness {
  const observed = Math.floor(Date.parse(rate.observedAt) / 1000);
  if (!Number.isFinite(observed)) {
    return { usable: false, ageSeconds: -1, reason: "rate observation timestamp is invalid" };
  }
  const ageSeconds = nowEpochSeconds - observed;
  if (ageSeconds < 0) {
    return { usable: false, ageSeconds, reason: "rate observation is in the future" };
  }
  if (ageSeconds > rate.maxAgeSeconds) {
    return { usable: false, ageSeconds, reason: `rate is older than ${rate.maxAgeSeconds.toString()} seconds` };
  }
  if (rate.rateMicrosPerEth <= 0n) {
    return { usable: false, ageSeconds, reason: "rate must be positive" };
  }
  return { usable: true, ageSeconds, reason: null };
}

/** Convert a wei amount to micro-euro with integer floor division. */
export function ethToEurMicros(amountWei: Wei, rateMicrosPerEth: EurMicros): EurMicros {
  if (amountWei < 0n) throw new Error("wei amount must not be negative");
  return (amountWei * rateMicrosPerEth) / 10n ** 18n;
}
