/**
 * Ollama adapter for the local model runtime.
 *
 * The adapter speaks the local Ollama HTTP API only. It has no signing keys, shell
 * tools, chain RPC methods or portfolio write access. The model identifier is
 * pinned by configuration and the content digest reported by the runtime is
 * recorded in evidence.
 */
import { PROPOSAL_DECODING_SCHEMA } from "../proposal-schema.js";
import {
  DEFAULT_MODEL_TIMEOUT_MS,
  ModelTimeoutError,
  ModelUnavailableError,
  type ModelCompletion,
  type ModelCompletionRequest,
  type ModelMetadata,
  type ModelPort,
} from "./types.js";
import type { ModelMessage } from "./types.js";

export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
export const DEFAULT_OLLAMA_MODEL = "qwen3:4b";
export const DEFAULT_TEMPERATURE = 0;
export const DEFAULT_SEED = 42;
export const DEFAULT_NUM_PREDICT = 120;
export const DEFAULT_NUM_CTX = 4096;

export interface OllamaPortOptions {
  readonly baseUrl?: string;
  readonly model?: string;
  readonly temperature?: number;
  readonly seed?: number;
  readonly numPredict?: number;
  readonly numCtx?: number;
  readonly timeoutMs?: number;
  readonly promptVersion: string;
}

interface OllamaTagsResponse {
  readonly models?: ReadonlyArray<{
    readonly name?: string;
    readonly model?: string;
    readonly digest?: string;
  }>;
}

interface OllamaChatResponse {
  readonly message?: { readonly content?: string };
}

interface OllamaVersionResponse {
  readonly version?: string;
}

async function fetchJson<T>(
  url: string,
  init?: { method?: string; body?: string; timeoutMs?: number },
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, init?.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: init?.method ?? "GET",
      ...(init?.body === undefined ? {} : { body: init.body }),
      headers: init?.body === undefined ? undefined : { "content-type": "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new ModelUnavailableError(`Ollama request failed with status ${response.status}`);
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof ModelUnavailableError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new ModelTimeoutError("Ollama request timed out");
    }
    throw new ModelUnavailableError(
      `Ollama is unreachable: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

export interface OllamaHealth {
  readonly available: boolean;
  readonly version: string | null;
  readonly model: string;
  readonly digest: string | null;
  readonly error: string | null;
}

export class OllamaModelPort implements ModelPort {
  readonly metadata: ModelMetadata;
  private readonly baseUrl: string;
  private readonly numPredict: number;
  private readonly numCtx: number;

  constructor(
    options: OllamaPortOptions & { readonly digest: string | null; readonly promptVersion: string },
  ) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, "");
    this.numPredict = options.numPredict ?? DEFAULT_NUM_PREDICT;
    this.numCtx = options.numCtx ?? DEFAULT_NUM_CTX;
    this.metadata = {
      provider: "ollama",
      model: options.model ?? DEFAULT_OLLAMA_MODEL,
      digest: options.digest,
      promptVersion: options.promptVersion,
      temperature: options.temperature ?? DEFAULT_TEMPERATURE,
      seed: options.seed ?? DEFAULT_SEED,
      timeoutMs: options.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS,
      numCtx: options.numCtx ?? DEFAULT_NUM_CTX,
      numPredict: options.numPredict ?? DEFAULT_NUM_PREDICT,
    };
  }

  /**
   * Loads the model and compiles the structured-output grammar once so the first
   * evaluated prompt is not charged with model or grammar loading latency.
   * Warm-up output is not used.
   */
  async warmUp(): Promise<number> {
    return this.warmUpMessages([
      {
        role: "user",
        content:
          'Move the Friday cutoff to 15:00 UTC. Reply with one JSON object using the documented shape.',
      },
    ]);
  }

  /**
   * Evaluates the exact prompt prefix once so later calls reuse the runtime cache.
   * Warm-up output is ignored.
   */
  async warmUpMessages(messages: readonly ModelMessage[]): Promise<number> {
    const startedAt = Date.now();
    await this.complete({
      messages,
      timeoutMs: 180_000,
      formatJson: true,
      responseSchema: PROPOSAL_DECODING_SCHEMA,
    });
    return Date.now() - startedAt;
  }

  async complete(request: ModelCompletionRequest): Promise<ModelCompletion> {
    const payload = {
      model: this.metadata.model,
      stream: false,
      format: request.responseSchema ?? (request.formatJson ? "json" : undefined),
      keep_alive: "10m",
      ...(this.metadata.model.startsWith("qwen3") ? { think: false } : {}),
      options: {
        temperature: this.metadata.temperature,
        seed: this.metadata.seed,
        num_predict: this.numPredict,
        num_ctx: this.numCtx,
      },
      messages: request.messages.map((message: ModelMessage) => ({
        role: message.role,
        content: message.content,
      })),
    };
    const startedAt = Date.now();
    const response = await fetchJson<OllamaChatResponse>(`${this.baseUrl}/api/chat`, {
      method: "POST",
      body: JSON.stringify(payload),
      timeoutMs: request.timeoutMs,
    });
    const elapsedMs = Date.now() - startedAt;
    const text = response.message?.content;
    if (typeof text !== "string" || text.trim() === "") {
      throw new ModelUnavailableError("Ollama returned an empty message");
    }
    return { text, elapsedMs };
  }
}

export async function checkOllamaHealth(options: {
  baseUrl?: string;
  model?: string;
}): Promise<OllamaHealth> {
  const baseUrl = (options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, "");
  const model = options.model ?? DEFAULT_OLLAMA_MODEL;
  try {
    const version = await fetchJson<OllamaVersionResponse>(`${baseUrl}/api/version`, {
      timeoutMs: 5_000,
    });
    const tags = await fetchJson<OllamaTagsResponse>(`${baseUrl}/api/tags`, {
      timeoutMs: 5_000,
    });
    const entry = tags.models?.find(
      (item) => item.name === model || item.model === model,
    );
    return {
      available: true,
      version: version.version ?? null,
      model,
      digest: entry?.digest ?? null,
      error: entry === undefined ? `Model ${model} is not pulled in the local runtime` : null,
    };
  } catch (error) {
    return {
      available: false,
      version: null,
      model,
      digest: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function createOllamaPort(options: {
  baseUrl?: string;
  model?: string;
  temperature?: number;
  seed?: number;
  numPredict?: number;
  numCtx?: number;
  timeoutMs?: number;
  promptVersion: string;
}): Promise<OllamaModelPort> {
  const health = await checkOllamaHealth(options);
  if (!health.available) {
    throw new ModelUnavailableError(health.error ?? "Ollama is not available");
  }
  if (health.digest === null) {
    throw new ModelUnavailableError(health.error ?? `Model ${options.model ?? DEFAULT_OLLAMA_MODEL} is not pulled`);
  }
  return new OllamaModelPort({ ...options, digest: health.digest });
}
