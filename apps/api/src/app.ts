/**
 * Application factory for the local partner API.
 *
 * Creating the app wires persistence, the event-sourced engine, the services and
 * the outbox worker. Tests and evidence runs build the same app in memory with a
 * deterministic id factory and a manually driven worker.
 */
import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import type { IdFactory } from "./ids.js";
import type { ApiConfig } from "./config.js";
import { createApiConfig, SERVICE_VERSION } from "./config.js";
import type { Database } from "./db.js";
import { ensureSeed, openDatabase, readClock, resetDatabase } from "./db.js";
import { EngineService } from "./engine-service.js";
import { ClockService } from "./clock-service.js";
import { QuoteService } from "./services/quotes.js";
import { OrderService } from "./services/orders.js";
import { PortfolioService } from "./services/portfolio.js";
import { IssuerService } from "./services/issuer.js";
import { OrderWorker } from "./worker.js";
import { ScenarioService } from "./services/scenarios.js";
import { EligibilityService } from "./services/eligibility.js";
import { ModelService } from "./services/model-service.js";
import { registerRoutes } from "./routes.js";
import { problem, toApiProblem } from "./problems.js";
import type { ModelPort } from "@eurorollup/policy-lab";

export interface CreateAppOptions {
  readonly config?: ApiConfig;
  readonly dbFile?: string;
  readonly autoWorker?: boolean;
  readonly ids?: IdFactory;
  readonly logger?: boolean;
  /** Test hook: inject a model port instead of the local Ollama runtime. */
  readonly modelPort?: ModelPort;
}

export interface AppContext {
  readonly app: FastifyInstance;
  readonly config: ApiConfig;
  readonly db: Database;
  readonly ids: IdFactory;
  readonly clock: ClockService;
  readonly engine: EngineService;
  readonly quotes: QuoteService;
  readonly orders: OrderService;
  readonly portfolio: PortfolioService;
  readonly issuer: IssuerService;
  readonly model: ModelService;
  readonly scenarios: ScenarioService;
  readonly eligibility: EligibilityService;
  readonly worker: OrderWorker;
  resetDemo(): void;
  close(): Promise<void>;
}

export async function createApp(options: CreateAppOptions = {}): Promise<AppContext> {
  const config =
    options.config ??
    createApiConfig({
      ...(options.dbFile === undefined ? {} : { dbFile: options.dbFile }),
      ...(options.autoWorker === undefined ? {} : { autoWorker: options.autoWorker }),
      ...(options.ids === undefined ? {} : { ids: options.ids }),
    });
  const db = openDatabase(config.dbFile);
  ensureSeed(db, config);
  const ids = config.ids;
  const clock = new ClockService(db);
  const engine = new EngineService(db, config);
  const quotes = new QuoteService(db, config, engine, clock, ids);
  const orders = new OrderService(db, config, engine, quotes, clock, ids);
  const portfolio = new PortfolioService(db, config, engine, clock);
  const issuer = new IssuerService(db, config, engine, clock);
  const model = new ModelService(config, options.modelPort);
  const scenarios = new ScenarioService(db, config, clock, ids, model);
  const eligibility = new EligibilityService(db, config, clock);
  const worker = new OrderWorker(db, config, engine, clock, {
    scenarioRunner: (runId) => {
      scenarios.executeRun(runId);
    },
  });

  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 1_000_000,
    ajv: {
      customOptions: {
        // Spec: unknown fields must be rejected, not silently stripped.
        removeAdditional: false,
        allErrors: true,
      },
    },
  });

  await app.register(cors, { origin: true });
  // Expensive endpoints (proof generation, live model drafting) opt into a
  // strict per-route limiter; the default is disabled so replay routes stay
  // unaffected.
  await app.register(rateLimit, { global: false });
  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "EuroRollup Settlement Lab partner API",
        description:
          "Local partner API for the synthetic euro settlement sandbox. Amounts are integer base units serialized as strings; timestamps are strict UTC instants. Business state and chain state are separate fields.",
        version: SERVICE_VERSION,
      },
      tags: [
        { name: "partner", description: "Investor and distributor endpoints" },
        { name: "issuer", description: "Issuer authority endpoints (role identity required)" },
        { name: "dev", description: "Local fixture controls; disabled when dev endpoints are off" },
        { name: "system", description: "Health and metadata" },
      ],
    },
  });

  const contextBase = {
    app,
    config,
    db,
    ids,
    clock,
    engine,
    quotes,
    orders,
    portfolio,
    issuer,
    model,
    scenarios,
    eligibility,
    worker,
  };

  scenarios.recoverInterruptedRuns();

  const resetDemo = (): void => {
    resetDatabase(db, config);
    engine.rebuild();
  };

  const ctx: AppContext = {
    ...contextBase,
    resetDemo,
    close: async () => {
      worker.stop();
      await app.close();
      try {
        db.close();
      } catch {
        // Closing an already closed database is harmless in tests.
      }
    },
  };

  registerRoutes(app, ctx);

  app.get(
    "/openapi.json",
    { schema: { tags: ["system"], summary: "OpenAPI 3.1 document" } },
    async () => app.swagger(),
  );

  app.setNotFoundHandler(async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(404).send({
      error: { code: "NOT_FOUND", message: "Unknown route", details: {} },
    });
  });

  app.setErrorHandler(async (error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    if (error.validation !== undefined) {
      const isScenarioRequest = request.url.startsWith("/v1/scenarios");
      return reply.code(isScenarioRequest ? 422 : 400).send({
        error: {
          code: "INVALID_REQUEST",
          message: "The request does not match the documented schema",
          details: { validation: error.validation },
        },
        traceId: request.id,
      });
    }
    const apiProblem = toApiProblem(error);
    if (apiProblem.statusCode >= 500) {
      request.log.error({ err: error }, "unhandled API error");
    }
    if (apiProblem.retryAfterSeconds !== undefined) {
      reply.header("retry-after", String(apiProblem.retryAfterSeconds));
    }
    return reply.code(apiProblem.statusCode).send({
      error: {
        code: apiProblem.code,
        message: apiProblem.message,
        details: apiProblem.details,
      },
      traceId: request.id,
    });
  });

  app.addHook("onClose", async () => {
    worker.stop();
  });

  if (config.autoWorker) {
    worker.start();
  }

  return ctx;
}

/** Convenience helper used by the dev-only reset endpoint and tests. */
export function currentClock(ctx: AppContext): string {
  return readClock(ctx.db);
}

export { problem };
