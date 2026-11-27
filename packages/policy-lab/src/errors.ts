/** Stable Policy Lab error codes shared by the API, the browser and the CLI. */
export type PolicyLabErrorCode =
  | "LIVE_MODEL_NOT_CONFIGURED"
  | "PRIOR_TIME_MISMATCH"
  | "UNSUPPORTED_FIXTURE"
  | "RECORDED_PROPOSAL_MISSING"
  | "INVALID_RECORDED_PROPOSAL"
  | "INVALID_PROPOSAL"
  | "INVALID_DRAFT_STATE"
  | "STALE_REVISION"
  | "CONFIRMATION_MISMATCH"
  | "INVALID_SCENARIO_STATE"
  | "RECORDED_PROPOSAL_FIXTURE_MISMATCH";

export class PolicyLabError extends Error {
  readonly code: PolicyLabErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: PolicyLabErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "PolicyLabError";
    this.code = code;
    this.details = details;
  }
}

export function isPolicyLabError(error: unknown): error is PolicyLabError {
  return error instanceof PolicyLabError;
}
