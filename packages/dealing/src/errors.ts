/**
 * Domain errors for the deterministic dealing engine.
 *
 * Every error carries a stable machine-readable code so that API responses,
 * receipts and evidence packs can attribute a decline without parsing prose.
 */
export const DEALING_ERROR_CODES = [
  "INVALID_AMOUNT",
  "PRECISION_EXCEEDED",
  "NEGATIVE_AMOUNT",
  "QUOTE_EXPIRED",
  "STALE_PRICE",
  "INSUFFICIENT_INVENTORY",
  "MINIMUM_PROCEEDS_NOT_MET",
  "INSUFFICIENT_CASH",
  "ZERO_UNIT_FILL",
  "DUST_BELOW_MINIMUM",
  "NAV_MISSING",
  "NAV_STALE",
  "NAV_DATE_MISMATCH",
  "INSUFFICIENT_LIQUIDITY",
  "ORDER_NOT_FOUND",
  "ORDER_ALREADY_APPLIED",
  "INVALID_ORDER_STATE",
  "CANCELLATION_NOT_ALLOWED",
  "INVALID_EVENT",
  "DUPLICATE_EVENT",
  "CUTOFF_OUT_OF_RANGE",
  "WEEKDAY_NOT_SUPPORTED",
  "INVALID_POLICY_CHANGE",
  "INVALID_TIMESTAMP",
  "INVALID_CALENDAR",
  "JOURNAL_IMBALANCE",
  "HASH_INPUT_UNSUPPORTED",
] as const;

export type DealingErrorCode = (typeof DEALING_ERROR_CODES)[number];

export class DealingError extends Error {
  readonly code: DealingErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: DealingErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "DealingError";
    this.code = code;
    this.details = details;
  }
}

export function isDealingError(error: unknown): error is DealingError {
  return error instanceof DealingError;
}
