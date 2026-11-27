/**
 * Local model service for the AI Policy Lab.
 *
 * Wraps the Ollama adapter from `@eurorollup/policy-lab`. The adapter process has
 * one capability (drafting a typed scenario) and no access to signing keys, shell
 * tools, chain RPC methods or portfolio writes. A failed model call is reported
 * as a recoverable error; it is never silently replaced by the recorded preset.
 */
import {
  LIVE_PROMPT_VERSION,
  OllamaModelPort,
  buildInitialMessages,
  checkOllamaHealth,
  createOllamaPort,
  draftWithLiveModel,
  type LiveDraftOutcome,
  type LiveDraftRequest,
  type ModelMetadata,
  type ModelPort,
} from "@eurorollup/policy-lab";
import type { ApiConfig } from "../config.js";

export interface ModelServiceStatus {
  readonly provider: string;
  readonly model: string;
  readonly digest: string | null;
  readonly available: boolean;
  readonly promptVersion: string;
  readonly error: string | null;
}

export class ModelService {
  private readonly config: ApiConfig;
  private injectedPort: ModelPort | null;
  private cachedPort: ModelPort | null = null;
  private warmedUp = false;

  constructor(config: ApiConfig, injectedPort?: ModelPort) {
    this.config = config;
    this.injectedPort = injectedPort ?? null;
  }

  private async resolvePort(): Promise<ModelPort> {
    if (this.injectedPort !== null) {
      return this.injectedPort;
    }
    if (this.cachedPort !== null) {
      return this.cachedPort;
    }
    const port = await createOllamaPort({
      baseUrl: this.config.ollamaBaseUrl,
      model: this.config.ollamaModel,
      temperature: this.config.modelTemperature,
      seed: this.config.modelSeed,
      timeoutMs: this.config.modelTimeoutMs,
      promptVersion: LIVE_PROMPT_VERSION,
    });
    this.cachedPort = port;
    return port;
  }

  async status(): Promise<ModelServiceStatus> {
    if (this.injectedPort !== null) {
      const metadata = this.injectedPort.metadata;
      return {
        provider: metadata.provider,
        model: metadata.model,
        digest: metadata.digest,
        available: true,
        promptVersion: metadata.promptVersion,
        error: null,
      };
    }
    const health = await checkOllamaHealth({
      baseUrl: this.config.ollamaBaseUrl,
      model: this.config.ollamaModel,
    });
    return {
      provider: "ollama",
      model: health.model,
      digest: health.digest,
      available: health.available && health.digest !== null,
      promptVersion: LIVE_PROMPT_VERSION,
      error: health.error,
    };
  }

  async draftLive(request: LiveDraftRequest): Promise<LiveDraftOutcome> {
    let port: ModelPort;
    try {
      port = await this.resolvePort();
      if (!this.warmedUp && port instanceof OllamaModelPort) {
        // First live request pays the model and prompt-prefix load time. The
        // 15-second attempt deadline applies to drafting attempts, not to this
        // one-time warm-up.
        await port.warmUpMessages(buildInitialMessages(request));
        this.warmedUp = true;
      }
    } catch (error) {
      const metadata: ModelMetadata = {
        provider: "ollama",
        model: this.config.ollamaModel,
        digest: null,
        promptVersion: LIVE_PROMPT_VERSION,
        temperature: this.config.modelTemperature,
        seed: this.config.modelSeed,
        timeoutMs: this.config.modelTimeoutMs,
      };
      return {
        kind: "error",
        code: "MODEL_UNAVAILABLE",
        message: error instanceof Error ? error.message : String(error),
        attempts: 0,
        elapsedMs: 0,
        model: metadata,
      };
    }
    return draftWithLiveModel({
      request,
      port,
      options: { timeoutMs: this.config.modelTimeoutMs, maxAttempts: 2 },
    });
  }

  /** Resets a cached runtime connection (used after a runtime restart). */
  resetPort(): void {
    this.cachedPort = null;
    this.warmedUp = false;
  }

  /** Test hook: replace the injected port. */
  setPort(port: ModelPort | null): void {
    this.injectedPort = port;
    this.cachedPort = null;
    this.warmedUp = port !== null;
  }
}

export type { OllamaModelPort };
