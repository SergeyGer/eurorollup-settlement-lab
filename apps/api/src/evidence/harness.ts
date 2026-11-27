/**
 * In-process HTTP harness for API evidence and integration tests.
 *
 * The harness builds the real Fastify app against an in-memory SQLite database,
 * uses a deterministic id factory and drives the outbox worker explicitly so a
 * case is reproducible step by step.
 */
import type { FastifyInstance, InjectOptions } from "fastify";
import { createApp, type AppContext } from "../app.js";
import { createApiConfig, type CalendarId } from "../config.js";
import { sequentialIdFactory, type IdFactory } from "../ids.js";
import { readClock } from "../db.js";

export interface HttpResult {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

export interface HarnessOptions {
  readonly calendarId?: CalendarId;
  readonly dbFile?: string;
  readonly ids?: IdFactory;
}

export interface Harness {
  readonly ctx: AppContext;
  readonly app: FastifyInstance;
  inject(
    method: "GET" | "POST",
    url: string,
    options?: { payload?: unknown; headers?: Record<string, string> },
  ): Promise<HttpResult>;
  tick(): number;
  clockNow(): string;
  advanceClock(to: string): Promise<HttpResult>;
  createQuote(input: {
    accountId: string;
    assetId: string;
    side: string;
    amountBase: string;
  }): Promise<HttpResult>;
  placeOrder(quoteId: string, accountId: string, idempotencyKey: string): Promise<HttpResult>;
  getOrder(orderId: string): Promise<HttpResult>;
  listOrders(accountId: string): Promise<HttpResult>;
  cancelOrder(orderId: string, accountId: string): Promise<HttpResult>;
  getPortfolio(accountId: string): Promise<HttpResult>;
  publishNav(input: {
    valuationDate: string;
    navBase: string;
    sourceTime: string;
    revision?: number;
    roleIdentity?: string;
  }): Promise<HttpResult>;
  health(): Promise<HttpResult>;
  close(): Promise<void>;
}

function headerMap(headers: Record<string, string | string[] | number | undefined>): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      result[key] = undefined;
    } else if (Array.isArray(value)) {
      result[key] = String(value[0]);
    } else {
      result[key] = String(value);
    }
  }
  return result;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const config = createApiConfig({
    dbFile: options.dbFile ?? ":memory:",
    autoWorker: false,
    ids: options.ids ?? sequentialIdFactory(),
    ...(options.calendarId === undefined ? {} : { calendarId: options.calendarId }),
  });
  const ctx = await createApp({ config });
  const inject = async (
    method: "GET" | "POST",
    url: string,
    injection: { payload?: unknown; headers?: Record<string, string> } = {},
  ): Promise<HttpResult> => {
    const injectOptions = {
      method,
      url,
      headers: { "content-type": "application/json", ...injection.headers },
      ...(injection.payload === undefined ? {} : { payload: injection.payload }),
    } as InjectOptions;
    const response = await ctx.app.inject(injectOptions);
    let body: unknown = undefined;
    const text = response.body;
    if (text !== undefined && text.trim() !== "") {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    }
    return { status: response.statusCode, body, headers: headerMap(response.headers) };
  };
  return {
    ctx,
    app: ctx.app,
    inject,
    tick: () => ctx.worker.processPendingNow(),
    clockNow: () => readClock(ctx.db),
    advanceClock: (to: string) => inject("POST", "/v1/dev/clock", { payload: { to } }),
    createQuote: (input) => inject("POST", "/v1/quotes", { payload: input }),
    placeOrder: (quoteId, accountId, idempotencyKey) =>
      inject("POST", "/v1/orders", {
        payload: { quoteId, accountId },
        headers: { "idempotency-key": idempotencyKey },
      }),
    getOrder: (orderId) => inject("GET", `/v1/orders/${orderId}`),
    listOrders: (accountId) => inject("GET", `/v1/orders?accountId=${encodeURIComponent(accountId)}`),
    cancelOrder: (orderId, accountId) =>
      inject("POST", `/v1/orders/${orderId}/cancel`, { payload: { accountId } }),
    getPortfolio: (accountId) => inject("GET", `/v1/portfolios/${accountId}`),
    publishNav: (input) =>
      inject("POST", "/v1/issuer/nav", {
        payload: {
          assetId: "eFUND",
          valuationDate: input.valuationDate,
          navBase: input.navBase,
          sourceTime: input.sourceTime,
          revision: input.revision ?? 1,
        },
        headers: { "x-role-identity": input.roleIdentity ?? "issuer-nav-signer" },
      }),
    health: () => inject("GET", "/v1/health"),
    close: async () => {
      await ctx.close();
    },
  };
}

/** Reads a JSON body with a narrow cast for evidence assertions. */
export function bodyAs<T>(result: HttpResult): T {
  return result.body as T;
}

export function errorCode(result: HttpResult): string | undefined {
  const body = result.body as { error?: { code?: string } } | undefined;
  return body?.error?.code;
}
