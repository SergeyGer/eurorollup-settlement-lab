/**
 * Fund dealing policy for the supported release-1.0 rule change.
 *
 * Supported: one change to the weekly eFUND subscription cutoff for one named
 * dealing weekday (Monday to Friday), whole-minute UTC times from 00:01 to
 * 16:59. Redemption deadlines, NAV sources, fees and eligibility rules stay
 * fixed (specification, section 04).
 */
import { DealingError } from "./errors.js";
import { hashJson } from "./hash.js";
import { minutesOfUtcTime } from "./time.js";
import type { SupportedDealingWeekday } from "./calendar.js";

export type PolicyWeekday = SupportedDealingWeekday;

export const SUPPORTED_POLICY_WEEKDAYS: readonly PolicyWeekday[] = [
  "MON",
  "TUE",
  "WED",
  "THU",
  "FRI",
];

export const DEFAULT_CUTOFF_TIME_UTC = "16:00";
export const MIN_CUTOFF_TIME_UTC = "00:01";
export const MAX_CUTOFF_TIME_UTC = "16:59";

export type PolicyOperation = "set_subscription_cutoff";

export interface FundDealingPolicy {
  readonly policyId: "eFUND-dealing";
  readonly assetId: "eFUND";
  readonly version: number;
  readonly weekdayCutoffs: Readonly<Record<PolicyWeekday, string>>;
}

export interface CutoffChange {
  readonly operation: PolicyOperation;
  readonly asset: "eFUND";
  readonly weekday: PolicyWeekday;
  readonly timeUtc: string;
  readonly timezone: "UTC";
}

export type PolicyChangeResult =
  | { readonly kind: "APPLIED"; readonly policy: FundDealingPolicy }
  | { readonly kind: "NO_CHANGE"; readonly policy: FundDealingPolicy }
  | { readonly kind: "REJECTED"; readonly errors: readonly string[] };

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Returns validation errors for a UTC cutoff time; empty when valid. */
export function validateCutoffTimeUtc(timeUtc: string): string[] {
  if (!TIME_RE.test(timeUtc)) {
    return [
      `Cutoff time must be a whole-minute UTC time of the form HH:MM, received ${JSON.stringify(timeUtc)}`,
    ];
  }
  const minutes = minutesOfUtcTime(timeUtc);
  const min = minutesOfUtcTime(MIN_CUTOFF_TIME_UTC);
  const max = minutesOfUtcTime(MAX_CUTOFF_TIME_UTC);
  if (minutes < min || minutes > max) {
    return [
      `Cutoff time must be between ${MIN_CUTOFF_TIME_UTC} and ${MAX_CUTOFF_TIME_UTC} UTC so every eligible order precedes the 17:00 valuation`,
    ];
  }
  return [];
}

/** Returns validation errors for a cutoff change request; empty when valid. */
export function validateCutoffChange(change: CutoffChange): string[] {
  const errors: string[] = [];
  if (change.operation !== "set_subscription_cutoff") {
    errors.push(`Unsupported operation: ${String(change.operation)}`);
  }
  if (change.asset !== "eFUND") {
    errors.push(`Unsupported asset: ${String(change.asset)}`);
  }
  if (change.timezone !== "UTC") {
    errors.push(`Only UTC is supported, received ${String(change.timezone)}`);
  }
  if (!SUPPORTED_POLICY_WEEKDAYS.includes(change.weekday)) {
    errors.push(
      `Weekday must be one of ${SUPPORTED_POLICY_WEEKDAYS.join(", ")}, received ${String(change.weekday)}`,
    );
  }
  errors.push(...validateCutoffTimeUtc(change.timeUtc));
  return errors;
}

export function createBaselinePolicy(
  overrides: Partial<Record<PolicyWeekday, string>> = {},
): FundDealingPolicy {
  const cutoffs: Record<PolicyWeekday, string> = {
    MON: DEFAULT_CUTOFF_TIME_UTC,
    TUE: DEFAULT_CUTOFF_TIME_UTC,
    WED: DEFAULT_CUTOFF_TIME_UTC,
    THU: DEFAULT_CUTOFF_TIME_UTC,
    FRI: DEFAULT_CUTOFF_TIME_UTC,
  };
  for (const weekday of SUPPORTED_POLICY_WEEKDAYS) {
    const override = overrides[weekday];
    if (override !== undefined) {
      const errors = validateCutoffTimeUtc(override);
      if (errors.length > 0) {
        throw new DealingError("INVALID_POLICY_CHANGE", errors.join("; "));
      }
      cutoffs[weekday] = override;
    }
  }
  return {
    policyId: "eFUND-dealing",
    assetId: "eFUND",
    version: 1,
    weekdayCutoffs: cutoffs,
  };
}

export function cutoffForWeekday(
  policy: FundDealingPolicy,
  weekday: PolicyWeekday,
): string {
  return policy.weekdayCutoffs[weekday];
}

/** Applies a validated cutoff change, producing a new policy revision. */
export function applyCutoffChange(
  policy: FundDealingPolicy,
  change: CutoffChange,
): PolicyChangeResult {
  const errors = validateCutoffChange(change);
  if (errors.length > 0) {
    return { kind: "REJECTED", errors };
  }
  const current = cutoffForWeekday(policy, change.weekday);
  if (current === change.timeUtc) {
    return { kind: "NO_CHANGE", policy };
  }
  const nextCutoffs: Record<PolicyWeekday, string> = { ...policy.weekdayCutoffs };
  nextCutoffs[change.weekday] = change.timeUtc;
  return {
    kind: "APPLIED",
    policy: {
      policyId: policy.policyId,
      assetId: policy.assetId,
      version: policy.version + 1,
      weekdayCutoffs: nextCutoffs,
    },
  };
}

/** Stable policy digest included in confirmation and evidence records. */
export function policyDigest(policy: FundDealingPolicy): string {
  return hashJson(policy);
}

/** Human-readable one-line diff used by the Policy Lab review screen. */
export function describePolicyChange(
  baseline: FundDealingPolicy,
  candidate: FundDealingPolicy,
): string[] {
  const changes: string[] = [];
  for (const weekday of SUPPORTED_POLICY_WEEKDAYS) {
    const before = baseline.weekdayCutoffs[weekday];
    const after = candidate.weekdayCutoffs[weekday];
    if (before !== after) {
      changes.push(`eFUND weekly subscription cutoff ${weekday} ${before} -> ${after} UTC`);
    }
  }
  return changes;
}
