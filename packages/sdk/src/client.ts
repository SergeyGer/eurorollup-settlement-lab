/**
 * Typed HTTP client for the EuroRollup partner API.
 *
 * The client is intentionally dependency-free: one fetch wrapper, typed
 * requests and a structured error type. Idempotency keys are explicit so a
 * caller can safely retry an accepted order without creating a second effect.
 */
import type {
  ClockState,
  CreateQuoteInput,
  DemoResetResult,
  HealthStatus,
  NavPublicationRequest,
  NavPublicationResult,
  Order,
  PlaceOrderInput,
  PlaceOrderResult,
  Portfolio,
  PortfolioSummary,
  Quote,
} from "./types.js";

export interface PartnerApiErrorOptions {
  readonly status: number;
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly retryAfterSeconds?: number;
}

export class PartnerApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;
  readonly retryAfterSeconds?: number;

  constructor(message: string, options: PartnerApiErrorOptions) {
    super(message);
    this.name = "PartnerApiError";
    this.status = options.status;
    this.code = options.code;
    this.details = options.details ?? {};
    if (options.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = options.retryAfterSeconds;
    }
  }
}

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface SettlementApiClientOptions {
  readonly baseUrl: string;
  readonly fetchImpl?: FetchLike;
  /** Local issuer/operator identity used for restricted endpoints. */
  readonly roleIdentity?: string;
  readonly timeoutMs?: number;
}

export function createIdempotencyKey(): string {
  const globalCrypto = globalThis.crypto;
  if (globalCrypto === undefined || typeof globalCrypto.randomUUID !== "function") {
    throw new Error("A Web Crypto capable runtime is required to generate idempotency keys");
  }
  return `idem_${globalCrypto.randomUUID()}`;
}

interface RequestOptions {
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

export class SettlementApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly roleIdentity?: string;

  constructor(options: SettlementApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    const globalFetch =
      typeof globalThis.fetch === "function"
        ? (globalThis.fetch.bind(globalThis) as unknown as FetchLike)
        : undefined;
    this.fetchImpl =
      options.fetchImpl ??
      globalFetch ??
      (() => {
        throw new Error("No fetch implementation available; pass fetchImpl");
      });
    if (options.roleIdentity !== undefined) {
      this.roleIdentity = options.roleIdentity;
    }
  }

  private async request<T>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(this.roleIdentity === undefined ? {} : { "x-role-identity": this.roleIdentity }),
      ...options.headers,
    };
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    let parsed: unknown = undefined;
    if (text.trim() !== "") {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = undefined;
      }
    }
    if (response.status >= 200 && response.status < 300) {
      return parsed as T;
    }
    const errorBody = parsed as
      | { error?: { code?: string; message?: string; details?: Record<string, unknown> } }
      | undefined;
    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfterSeconds =
      retryAfterHeader === null ? undefined : Number(retryAfterHeader);
    throw new PartnerApiError(
      errorBody?.error?.message ?? `Request failed with status ${response.status}`,
      {
        status: response.status,
        code: errorBody?.error?.code ?? "HTTP_ERROR",
        ...(errorBody?.error?.details === undefined
          ? {}
          : { details: errorBody.error.details }),
        ...(retryAfterSeconds === undefined || Number.isNaN(retryAfterSeconds)
          ? {}
          : { retryAfterSeconds }),
      },
    );
  }

  async getHealth(): Promise<HealthStatus> {
    return this.request<HealthStatus>("GET", "/v1/health");
  }

  async createQuote(input: CreateQuoteInput): Promise<Quote> {
    return this.request<Quote>("POST", "/v1/quotes", { body: input });
  }

  async placeOrder(input: PlaceOrderInput, idempotencyKey: string): Promise<PlaceOrderResult> {
    return this.request<PlaceOrderResult>("POST", "/v1/orders", {
      body: input,
      headers: { "idempotency-key": idempotencyKey },
    });
  }

  async getOrder(orderId: string): Promise<Order> {
    return this.request<Order>("GET", `/v1/orders/${encodeURIComponent(orderId)}`);
  }

  async listOrders(accountId: string): Promise<Order[]> {
    return this.request<Order[]>(
      "GET",
      `/v1/orders?accountId=${encodeURIComponent(accountId)}`,
    );
  }

  async cancelOrder(orderId: string, accountId: string): Promise<Order> {
    return this.request<Order>(
      "POST",
      `/v1/orders/${encodeURIComponent(orderId)}/cancel`,
      { body: { accountId } },
    );
  }

  async getPortfolio(accountId: string): Promise<Portfolio> {
    return this.request<Portfolio>(
      "GET",
      `/v1/portfolios/${encodeURIComponent(accountId)}`,
    );
  }

  async listPortfolios(): Promise<PortfolioSummary[]> {
    return this.request<PortfolioSummary[]>("GET", "/v1/portfolios");
  }

  async publishNav(input: NavPublicationRequest): Promise<NavPublicationResult> {
    return this.request<NavPublicationResult>("POST", "/v1/issuer/nav", { body: input });
  }

  async advanceClock(to: string): Promise<ClockState> {
    return this.request<ClockState>("POST", "/v1/dev/clock", { body: { to } });
  }

  async resetDemo(): Promise<DemoResetResult> {
    return this.request<DemoResetResult>("POST", "/v1/dev/reset", { body: {} });
  }

  async getOpenApi(): Promise<unknown> {
    return this.request<unknown>("GET", "/openapi.json");
  }

  async getClock(): Promise<ClockState> {
    return this.request<ClockState>("GET", "/v1/dev/clock");
  }
}
