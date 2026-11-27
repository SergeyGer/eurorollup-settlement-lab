/**
 * Live local model adapter contract.
 *
 * The adapter has one capability: drafting a typed scenario from synthetic rule
 * metadata and a short question. It has no signing keys, shell tools, chain RPC
 * methods or portfolio write access. Its output is validated against the
 * proposal schema before it can reach the confirmation step, and a failed call is
 * never silently replaced by the recorded preset.
 */
import type { PolicyBaselineRef, Proposal } from "../types.js";

export type ModelProvider = "ollama" | "scripted";

export interface ModelMetadata {
  readonly provider: ModelProvider;
  /** Pinned model identifier, e.g. `qwen2.5:1.5b`. */
  readonly model: string;
  /** Content digest reported by the local runtime, when available. */
  readonly digest: string | null;
  readonly promptVersion: string;
  readonly temperature: number;
  readonly seed: number;
  readonly timeoutMs: number;
  readonly numCtx?: number;
  readonly numPredict?: number;
}

export interface ModelMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface ModelCompletionRequest {
  readonly messages: readonly ModelMessage[];
  readonly timeoutMs: number;
  readonly formatJson: boolean;
  /** Optional JSON Schema for grammar-constrained output. */
  readonly responseSchema?: Readonly<Record<string, unknown>>;
}

export interface ModelCompletion {
  readonly text: string;
  readonly elapsedMs: number;
}

export interface ModelPort {
  readonly metadata: ModelMetadata;
  complete(request: ModelCompletionRequest): Promise<ModelCompletion>;
}

export class ModelTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelTimeoutError";
  }
}

export class ModelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelUnavailableError";
  }
}

export type LiveDraftErrorCode = "MODEL_TIMEOUT" | "MODEL_OUTPUT_INVALID" | "MODEL_UNAVAILABLE";

export interface LiveDraftRequest {
  readonly question: string;
  readonly baseline: PolicyBaselineRef;
  readonly fixture: {
    readonly fixtureId: string;
    readonly fixtureVersion: string;
    readonly calendarId: string;
    readonly orders: string;
    readonly navObservations: string;
  };
  readonly supportedRule: {
    readonly operation: "set_subscription_cutoff";
    readonly asset: "eFUND";
    readonly weekdays: readonly string[];
    readonly minTimeUtc: string;
    readonly maxTimeUtc: string;
    readonly timezone: "UTC";
    readonly fixedRules: readonly string[];
  };
}

export interface LiveDraftSuccess {
  readonly kind: "draft";
  readonly proposal: Proposal;
  readonly attempts: number;
  readonly elapsedMs: number;
  readonly rawOutput: string;
  readonly model: ModelMetadata;
}

export interface LiveDraftFailure {
  readonly kind: "error";
  readonly code: LiveDraftErrorCode;
  readonly message: string;
  readonly attempts: number;
  readonly elapsedMs: number;
  readonly model: ModelMetadata;
  readonly rawOutput?: string;
  readonly validationErrors?: readonly string[];
}

export type LiveDraftOutcome = LiveDraftSuccess | LiveDraftFailure;

export interface LiveDraftOptions {
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
}

export const DEFAULT_MODEL_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_ATTEMPTS = 2;
