/**
 * Scripted model port for deterministic adapter, fallback and evaluation tests.
 *
 * It is not a model: each call returns the next scripted response or error. It
 * exists so timeout, malformed-output and retry behaviour can be tested without
 * a runtime.
 */
import {
  DEFAULT_MODEL_TIMEOUT_MS,
  ModelTimeoutError,
  ModelUnavailableError,
  type ModelCompletion,
  type ModelCompletionRequest,
  type ModelMetadata,
  type ModelPort,
} from "./types.js";

export type ScriptedResponse =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "timeout" }
  | { readonly kind: "unavailable" };

export interface ScriptedPortOptions {
  readonly metadata?: Partial<ModelMetadata>;
  readonly responses: readonly ScriptedResponse[];
  /** Optional per-call latency reported in the completion. */
  readonly elapsedMs?: number;
}

export class ScriptedModelPort implements ModelPort {
  readonly metadata: ModelMetadata;
  private readonly responses: readonly ScriptedResponse[];
  private readonly elapsedMs: number;
  private index = 0;

  constructor(options: ScriptedPortOptions) {
    this.responses = options.responses;
    this.elapsedMs = options.elapsedMs ?? 5;
    this.metadata = {
      provider: "scripted",
      model: options.metadata?.model ?? "scripted-model",
      digest: options.metadata?.digest ?? null,
      promptVersion: options.metadata?.promptVersion ?? "test-prompt",
      temperature: options.metadata?.temperature ?? 0,
      seed: options.metadata?.seed ?? 0,
      timeoutMs: options.metadata?.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS,
    };
  }

  get calls(): number {
    return this.index;
  }

  async complete(_request: ModelCompletionRequest): Promise<ModelCompletion> {
    const scripted = this.responses[this.index] ?? {
      kind: "text" as const,
      text: '{"status":"unsupported","reasonCode":"UNSUPPORTED_OPERATION"}',
    };
    this.index += 1;
    if (scripted.kind === "timeout") {
      throw new ModelTimeoutError("scripted timeout");
    }
    if (scripted.kind === "unavailable") {
      throw new ModelUnavailableError("scripted unavailable");
    }
    return { text: scripted.text, elapsedMs: this.elapsedMs };
  }
}

/** Convenience helper: a port that always returns the given text. */
export function createScriptedPort(
  responses: readonly ScriptedResponse[],
  metadata?: Partial<ModelMetadata>,
): ScriptedModelPort {
  return new ScriptedModelPort({ responses, ...(metadata === undefined ? {} : { metadata }) });
}
