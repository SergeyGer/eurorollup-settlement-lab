/**
 * Sponsorship funding and stale-price guard.
 *
 * Rule order matters and is asserted by tests: stale rate, per-operation cap,
 * daily budget (including outstanding reservations) and native deposit reserve.
 * Rejections preserve outstanding reservations; existing fund escrow stays visible
 * during a sponsorship pause.
 */
import type { Wei } from "./types.js";

export type PermitDecision = "approve" | "reject";

export type PermitRejectionReason =
  | "stale-rate"
  | "per-operation-cap-exceeded"
  | "daily-budget-exceeded"
  | "deposit-below-reserve";

export interface PermitRequest {
  readonly amountWei: Wei;
  readonly perOperationCapWei: Wei;
  readonly dailyBudgetWei: Wei;
  readonly alreadySpentTodayWei: Wei;
  readonly outstandingReservationsWei: Wei;
  readonly nativeDepositWei: Wei;
  readonly configuredReserveWei: Wei;
  readonly rateAgeSeconds: number;
  readonly maxRateAgeSeconds: number;
  readonly fundEscrowWei: Wei;
}

export interface PermitEvaluation {
  readonly decision: PermitDecision;
  readonly reason: PermitRejectionReason | null;
  readonly checks: readonly { readonly check: string; readonly passed: boolean; readonly detail: string }[];
  readonly reservationWei: Wei | null;
  readonly outstandingReservationsPreservedWei: Wei;
  readonly fundEscrowVisibleWei: Wei;
  readonly sponsorshipPaused: boolean;
}

export function evaluatePermit(request: PermitRequest): PermitEvaluation {
  const checks: { check: string; passed: boolean; detail: string }[] = [];
  const push = (check: string, passed: boolean, detail: string): void => {
    checks.push({ check, passed, detail });
  };

  push("rate freshness", request.rateAgeSeconds <= request.maxRateAgeSeconds, `${request.rateAgeSeconds.toString()}s old, limit ${request.maxRateAgeSeconds.toString()}s`);
  push("per-operation cap", request.amountWei <= request.perOperationCapWei, `${request.amountWei.toString()} wei requested, cap ${request.perOperationCapWei.toString()} wei`);
  const committed = request.alreadySpentTodayWei + request.outstandingReservationsWei + request.amountWei;
  push("daily budget", committed <= request.dailyBudgetWei, `${committed.toString()} wei committed including reservations, budget ${request.dailyBudgetWei.toString()} wei`);
  const depositAfter = request.nativeDepositWei - request.amountWei;
  push("native deposit reserve", depositAfter >= request.configuredReserveWei, `${depositAfter.toString()} wei left, reserve ${request.configuredReserveWei.toString()} wei`);

  const failed = checks.find((check) => !check.passed);
  const reason: PermitRejectionReason | null =
    failed === undefined
      ? null
      : failed.check === "rate freshness"
        ? "stale-rate"
        : failed.check === "per-operation cap"
          ? "per-operation-cap-exceeded"
          : failed.check === "daily budget"
            ? "daily-budget-exceeded"
            : "deposit-below-reserve";

  return {
    decision: reason === null ? "approve" : "reject",
    reason,
    checks,
    reservationWei: reason === null ? request.amountWei : null,
    outstandingReservationsPreservedWei: request.outstandingReservationsWei,
    fundEscrowVisibleWei: request.fundEscrowWei,
    sponsorshipPaused: reason !== null,
  };
}
