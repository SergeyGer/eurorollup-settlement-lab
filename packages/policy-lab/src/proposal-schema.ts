/**
 * Discriminated proposal schema and validation.
 *
 * The schema is published in the specification for the model contract
 * (`additionalProperties: false`, documented enums, 500-character text limit).
 * Validation is hand-rolled so the same code runs in the browser, the API and
 * the evaluation harness without an extra validator dependency.
 */
import { MIN_CUTOFF_TIME_UTC, MAX_CUTOFF_TIME_UTC, SUPPORTED_POLICY_WEEKDAYS, validateCutoffTimeUtc } from "@eurorollup/dealing";
import type { Proposal, UnsupportedReasonCode } from "./types.js";
import { POLICY_LAB_VERSION } from "./version.js";

export const MAX_PROPOSAL_TEXT_LENGTH = 500;

export const UNSUPPORTED_REASON_CODES: readonly UnsupportedReasonCode[] = [
  "UNSUPPORTED_OPERATION",
  "UNSUPPORTED_ASSET",
  "UNSUPPORTED_WEEKDAY",
  "OUT_OF_RANGE",
  "MULTIPLE_CHANGES",
];

/** Documented JSON Schema for the model-facing proposal. */
export const PROPOSAL_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://github.com/SergeyGer/eurorollup-settlement-lab/schemas/policy-proposal.schema.json",
  title: "AI Policy Lab proposal",
  description: `Discriminated proposal schema, version ${POLICY_LAB_VERSION}. Numeric outcomes are not part of a proposal.`,
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: { type: "string", enum: ["proposed", "clarify", "unsupported"] },
  },
  oneOf: [
    {
      title: "proposed",
      type: "object",
      additionalProperties: false,
      required: ["status", "operation", "asset", "weekday", "timeUtc", "timezone"],
      properties: {
        status: { const: "proposed" },
        operation: { const: "set_subscription_cutoff" },
        asset: { const: "eFUND" },
        weekday: { type: "string", enum: ["MON", "TUE", "WED", "THU", "FRI"] },
        timeUtc: {
          type: "string",
          pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$",
          description: `Whole-minute UTC cutoff between ${MIN_CUTOFF_TIME_UTC} and ${MAX_CUTOFF_TIME_UTC}.`,
        },
        timezone: { const: "UTC" },
        expectedTimeUtc: { type: "string", pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$" },
      },
    },
    {
      title: "clarify",
      type: "object",
      additionalProperties: false,
      required: ["status", "question", "missingFields"],
      properties: {
        status: { const: "clarify" },
        question: { type: "string", minLength: 1, maxLength: MAX_PROPOSAL_TEXT_LENGTH },
        missingFields: {
          type: "array",
          minItems: 1,
          items: { type: "string", enum: ["asset", "weekday", "timeUtc", "timezone"] },
        },
      },
    },
    {
      title: "unsupported",
      type: "object",
      additionalProperties: false,
      required: ["status", "reasonCode"],
      properties: {
        status: { const: "unsupported" },
        reasonCode: { type: "string", enum: UNSUPPORTED_REASON_CODES },
      },
    },
  ],
} as const;

export interface ProposalValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

/** Validates a proposal object against the documented contract. */
export function validateProposal(value: unknown): ProposalValidation {
  if (!isRecord(value)) {
    return { valid: false, errors: ["Proposal must be a JSON object"] };
  }
  const status = value["status"];
  if (status === "proposed") {
    const errors: string[] = [];
    const allowed = ["status", "operation", "asset", "weekday", "timeUtc", "timezone", "expectedTimeUtc"];
    if (!hasOnlyKeys(value, allowed)) {
      errors.push("Proposed status does not allow additional properties");
    }
    if (value["operation"] !== "set_subscription_cutoff") {
      errors.push("Only set_subscription_cutoff is supported in release 1.0");
    }
    if (value["asset"] !== "eFUND") {
      errors.push("Only the eFUND asset is supported in release 1.0");
    }
    if (!SUPPORTED_POLICY_WEEKDAYS.includes(value["weekday"] as never)) {
      errors.push(`weekday must be one of ${SUPPORTED_POLICY_WEEKDAYS.join(", ")}`);
    }
    if (value["timezone"] !== "UTC") {
      errors.push("timezone must be UTC");
    }
    if (typeof value["timeUtc"] === "string") {
      errors.push(...validateCutoffTimeUtc(value["timeUtc"]));
    } else {
      errors.push("timeUtc is required");
    }
    if (value["expectedTimeUtc"] !== undefined) {
      if (typeof value["expectedTimeUtc"] !== "string") {
        errors.push("expectedTimeUtc must be a string");
      }
    }
    return { valid: errors.length === 0, errors };
  }
  if (status === "clarify") {
    const errors: string[] = [];
    if (!hasOnlyKeys(value, ["status", "question", "missingFields"])) {
      errors.push("Clarify status does not allow additional properties");
    }
    const question = value["question"];
    if (typeof question !== "string" || question.trim().length === 0) {
      errors.push("clarify.question is required");
    } else if (question.length > MAX_PROPOSAL_TEXT_LENGTH) {
      errors.push(`clarify.question exceeds ${MAX_PROPOSAL_TEXT_LENGTH} characters`);
    }
    const missingFields = value["missingFields"];
    if (!Array.isArray(missingFields) || missingFields.length === 0) {
      errors.push("clarify.missingFields must be a non-empty array");
    }
    return { valid: errors.length === 0, errors };
  }
  if (status === "unsupported") {
    const errors: string[] = [];
    if (!hasOnlyKeys(value, ["status", "reasonCode"])) {
      errors.push("Unsupported status does not allow additional properties");
    }
    if (!UNSUPPORTED_REASON_CODES.includes(value["reasonCode"] as never)) {
      errors.push(`reasonCode must be one of ${UNSUPPORTED_REASON_CODES.join(", ")}`);
    }
    return { valid: errors.length === 0, errors };
  }
  return { valid: false, errors: ["Proposal status must be proposed, clarify or unsupported"] };
}

/** Type guard used after validation. */
export function isProposal(value: unknown): value is Proposal {
  return validateProposal(value).valid;
}
