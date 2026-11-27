/**
 * One-attempt-plus-retry live drafting pipeline.
 *
 * The pipeline validates every model output against the proposal contract before
 * it can become a draft. Malformed output is retried once with schema feedback; a
 * second failure, a timeout or an unavailable runtime returns a recoverable error.
 * A failed free-text request is never silently replaced by the recorded preset.
 */
import { PolicyLabError } from "../errors.js";
import { PROPOSAL_DECODING_SCHEMA, validateProposal } from "../proposal-schema.js";
import type { Proposal } from "../types.js";
import { buildInitialMessages, buildRetryMessages } from "./prompt.js";
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MODEL_TIMEOUT_MS,
  ModelTimeoutError,
  ModelUnavailableError,
  type LiveDraftFailure,
  type LiveDraftOptions,
  type LiveDraftOutcome,
  type LiveDraftRequest,
  type LiveDraftSuccess,
  type ModelPort,
} from "./types.js";

interface ParsedProposal {
  readonly ok: boolean;
  readonly proposal?: Proposal;
  readonly errors: readonly string[];
  readonly raw: string;
}

/** Parses raw model text into a validated proposal. */
export function parseProposalText(text: string): ParsedProposal {
  const trimmed = text.trim();
  let candidate = trimmed;
  // Tolerate a single code fence even though the prompt forbids it.
  const fenceMatch = /^```(?:json)?\s*([\s\S]*?)```$/u.exec(trimmed);
  if (fenceMatch !== null && fenceMatch[1] !== undefined) {
    candidate = fenceMatch[1].trim();
  }
  const objectStart = candidate.indexOf("{");
  const objectEnd = candidate.lastIndexOf("}");
  if (objectStart === -1 || objectEnd === -1 || objectEnd <= objectStart) {
    return { ok: false, errors: ["Response does not contain a JSON object"], raw: text };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.slice(objectStart, objectEnd + 1)) as unknown;
  } catch (error) {
    return {
      ok: false,
      errors: [`Response is not valid JSON: ${error instanceof Error ? error.message : String(error)}`],
      raw: text,
    };
  }
  // The reasoning field is decoding assistance only; the typed proposal that can
  // reach confirmation never carries it.
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    delete (parsed as Record<string, unknown>)["reason"];
  }
  const validation = validateProposal(parsed);
  if (!validation.valid) {
    return { ok: false, errors: validation.errors, raw: text };
  }
  return { ok: true, proposal: parsed as Proposal, errors: [], raw: text };
}

export interface DraftWithLiveModelParams {
  readonly request: LiveDraftRequest;
  readonly port: ModelPort;
  readonly options?: LiveDraftOptions;
}

export async function draftWithLiveModel(
  params: DraftWithLiveModelParams,
): Promise<LiveDraftOutcome> {
  const timeoutMs = params.options?.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS;
  const maxAttempts = params.options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const model = params.port.metadata;
  let attempts = 0;
  let elapsedMs = 0;
  let rawOutput: string | undefined;
  let validationErrors: readonly string[] = [];
  let lastErrorCode: "MODEL_TIMEOUT" | "MODEL_OUTPUT_INVALID" = "MODEL_OUTPUT_INVALID";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt;
    const messages =
      attempt === 1
        ? buildInitialMessages(params.request)
        : buildRetryMessages({
            request: params.request,
            previousRaw: rawOutput ?? "",
            errors: validationErrors,
          });
    try {
      const completion = await params.port.complete({
        messages,
        timeoutMs,
        formatJson: true,
        responseSchema: PROPOSAL_DECODING_SCHEMA,
      });
      elapsedMs += completion.elapsedMs;
      rawOutput = completion.text;
      const parsed = parseProposalText(completion.text);
      if (parsed.ok && parsed.proposal !== undefined) {
        const success: LiveDraftSuccess = {
          kind: "draft",
          proposal: parsed.proposal,
          attempts,
          elapsedMs,
          rawOutput: completion.text,
          model,
        };
        return success;
      }
      validationErrors = parsed.errors;
      lastErrorCode = "MODEL_OUTPUT_INVALID";
    } catch (error) {
      if (error instanceof ModelTimeoutError) {
        elapsedMs += timeoutMs;
        validationErrors = ["The model did not answer within the configured deadline"];
        lastErrorCode = "MODEL_TIMEOUT";
        continue;
      }
      if (error instanceof ModelUnavailableError) {
        const failure: LiveDraftFailure = {
          kind: "error",
          code: "MODEL_UNAVAILABLE",
          message: error.message,
          attempts,
          elapsedMs,
          model,
        };
        return failure;
      }
      const failure: LiveDraftFailure = {
        kind: "error",
        code: "MODEL_OUTPUT_INVALID",
        message: error instanceof Error ? error.message : String(error),
        attempts,
        elapsedMs,
        model,
        ...(rawOutput === undefined ? {} : { rawOutput }),
      };
      return failure;
    }
  }

  const failure: LiveDraftFailure = {
    kind: "error",
    code: lastErrorCode,
    message:
      lastErrorCode === "MODEL_TIMEOUT"
        ? `The model did not answer within ${timeoutMs} ms on ${attempts} attempts`
        : `The model did not return a valid proposal after ${attempts} attempts`,
    attempts,
    elapsedMs,
    model,
    ...(rawOutput === undefined ? {} : { rawOutput }),
    ...(validationErrors.length === 0 ? {} : { validationErrors }),
  };
  return failure;
}

/** Builds a draft for a live proposal; kept here to share the error contract. */
export function assertLiveProposal(proposal: Proposal | undefined): Proposal {
  if (proposal === undefined) {
    throw new PolicyLabError("INVALID_PROPOSAL", "Live model returned no proposal");
  }
  return proposal;
}
