/**
 * Structured API problems.
 *
 * Every failure the partner sees is a stable machine-readable code with an HTTP
 * status and, where applicable, a Retry-After hint. Domain errors from the pure
 * dealing engine are mapped here; raw engine errors never surface.
 */
import { DealingError, isDealingError } from "@eurorollup/dealing";
import { PolicyLabError, isPolicyLabError } from "@eurorollup/policy-lab";

export interface ApiProblemOptions {
  readonly details?: Readonly<Record<string, unknown>>;
  readonly retryAfterSeconds?: number;
}

export class ApiProblem extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly retryAfterSeconds?: number;

  constructor(statusCode: number, code: string, message: string, options: ApiProblemOptions = {}) {
    super(message);
    this.name = "ApiProblem";
    this.statusCode = statusCode;
    this.code = code;
    this.details = options.details ?? {};
    if (options.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = options.retryAfterSeconds;
    }
  }
}

export function problem(
  statusCode: number,
  code: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): ApiProblem {
  return new ApiProblem(statusCode, code, message, { details });
}

export function unauthorizedRole(requiredRole: string): ApiProblem {
  return problem(403, "ROLE_NOT_AUTHORIZED", `This endpoint requires the ${requiredRole} identity`, {
    requiredRole,
  });
}

const DEALING_STATUS: Readonly<Record<string, number>> = {
  INVALID_AMOUNT: 400,
  PRECISION_EXCEEDED: 400,
  NEGATIVE_AMOUNT: 400,
  QUOTE_EXPIRED: 422,
  STALE_PRICE: 422,
  INSUFFICIENT_INVENTORY: 422,
  MINIMUM_PROCEEDS_NOT_MET: 422,
  INSUFFICIENT_CASH: 422,
  ZERO_UNIT_FILL: 422,
  DUST_BELOW_MINIMUM: 422,
  NAV_MISSING: 409,
  NAV_STALE: 409,
  NAV_DATE_MISMATCH: 422,
  INSUFFICIENT_LIQUIDITY: 422,
  ORDER_NOT_FOUND: 404,
  ORDER_ALREADY_APPLIED: 409,
  INVALID_ORDER_STATE: 409,
  CANCELLATION_NOT_ALLOWED: 422,
  DUPLICATE_EVENT: 409,
  INVALID_EVENT: 422,
  INVALID_TIMESTAMP: 400,
  INVALID_CALENDAR: 500,
  INVALID_POLICY_CHANGE: 422,
  JOURNAL_IMBALANCE: 500,
  HASH_INPUT_UNSUPPORTED: 500,
  CUTOFF_OUT_OF_RANGE: 422,
  WEEKDAY_NOT_SUPPORTED: 422,
};

export function problemFromDealingError(error: DealingError): ApiProblem {
  const statusCode = DEALING_STATUS[error.code] ?? 422;
  return new ApiProblem(statusCode, error.code, error.message, { details: error.details });
}

const POLICY_LAB_STATUS: Readonly<Record<string, number>> = {
  LIVE_MODEL_NOT_CONFIGURED: 503,
  PRIOR_TIME_MISMATCH: 422,
  UNSUPPORTED_FIXTURE: 422,
  RECORDED_PROPOSAL_MISSING: 500,
  INVALID_RECORDED_PROPOSAL: 422,
  INVALID_PROPOSAL: 422,
  INVALID_DRAFT_STATE: 409,
  STALE_REVISION: 409,
  CONFIRMATION_MISMATCH: 409,
  INVALID_SCENARIO_STATE: 422,
  RECORDED_PROPOSAL_FIXTURE_MISMATCH: 500,
};

export function problemFromPolicyLabError(error: PolicyLabError): ApiProblem {
  const statusCode = POLICY_LAB_STATUS[error.code] ?? 422;
  const apiProblem = new ApiProblem(statusCode, error.code, error.message, {
    details: error.details,
  });
  if (error.code === "LIVE_MODEL_NOT_CONFIGURED") {
    return new ApiProblem(statusCode, error.code, error.message, {
      details: error.details,
      retryAfterSeconds: 30,
    });
  }
  return apiProblem;
}

export function toApiProblem(error: unknown): ApiProblem {
  if (error instanceof ApiProblem) {
    return error;
  }
  if (isDealingError(error)) {
    return problemFromDealingError(error);
  }
  if (isPolicyLabError(error)) {
    return problemFromPolicyLabError(error);
  }
  if (error instanceof Error) {
    return problem(500, "INTERNAL_ERROR", error.message);
  }
  return problem(500, "INTERNAL_ERROR", "Unknown error");
}
