/** HTTP routes for the partner API, issuer authority and local dev controls. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ENGINE_VERSION, formatUtcInstant, hashJson, parseUtcInstant } from "@eurorollup/dealing";
import type {
  CreateQuoteInput,
  NavPublicationRequest,
  PlaceOrderInput,
} from "@eurorollup/sdk";
import type { AppContext } from "./app.js";
import {
  DEFAULT_SESSION_ID,
  type CreateScenarioDraftRequest,
  type EditScenarioDraftRequest,
  type StartScenarioRunRequest,
} from "./services/scenarios.js";
import { countEvents, pendingOutboxCount, readClock, readPriceSource, writePriceSource } from "./db.js";
import { problem } from "./problems.js";
import {
  accountIdParamsSchema,
  accountQuerySchema,
  cancelOrderBodySchema,
  clockBodySchema,
  createQuoteBodySchema,
  emptyBodySchema,
  idempotencyHeadersSchema,
  navBodySchema,
  orderIdParamsSchema,
  placeOrderBodySchema,
  priceSourceBodySchema,
  roleHeaderSchema,
  runIdParamsSchema,
  scenarioDraftBodySchema,
  scenarioEditBodySchema,
  scenarioIdParamsSchema,
  scenarioRunHeadersSchema,
  sessionHeadersSchema,
  startScenarioRunBodySchema,
} from "./schemas.js";

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

export function registerRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { config } = ctx;

  app.get(
    "/v1/health",
    { schema: { tags: ["system"], summary: "Health and fixture metadata" } },
    async () => ({
      status: "ok" as const,
      service: "eurorollup-api",
      mode: config.dataMode,
      serviceVersion: config.serviceVersion,
      engineVersion: ENGINE_VERSION,
      calendarId: config.calendar.calendarId,
      calendarVersion: config.calendar.version,
      policyId: config.policy.policyId,
      policyVersion: config.policy.version,
      policyEpoch: hashJson(config.policy),
      clock: readClock(ctx.db),
      eventCount: countEvents(ctx.db),
      pendingOutbox: pendingOutboxCount(ctx.db),
    }),
  );

  app.get(
    "/v1/model/status",
    {
      schema: {
        tags: ["system"],
        summary: "Local model adapter status, pinned model and prompt version",
      },
    },
    async () => ctx.model.status(),
  );

  app.post(
    "/v1/quotes",
    {
      schema: {
        tags: ["partner"],
        summary: "Create a spot or fund quote with indicative dealing terms",
        body: createQuoteBodySchema,
      },
    },
    async (request: FastifyRequest) => {
      const body = request.body as CreateQuoteInput;
      return ctx.quotes.createQuote(body);
    },
  );

  app.post(
    "/v1/orders",
    {
      schema: {
        tags: ["partner"],
        summary: "Accept an order against a quote",
        headers: idempotencyHeadersSchema,
        body: placeOrderBodySchema,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as PlaceOrderInput;
      const idempotencyKey = headerValue(request.headers["idempotency-key"]);
      const outcome = ctx.orders.placeOrder(body, idempotencyKey);
      return reply.code(202).send(outcome.result);
    },
  );

  app.get(
    "/v1/orders",
    {
      schema: {
        tags: ["partner"],
        summary: "List orders for one account",
        querystring: accountQuerySchema,
      },
    },
    async (request: FastifyRequest) => {
      const { accountId } = request.query as { accountId: string };
      return ctx.orders.listOrders(accountId);
    },
  );

  app.get(
    "/v1/orders/:orderId",
    {
      schema: {
        tags: ["partner"],
        summary: "Read business state, receipts and money movements for an order",
        params: orderIdParamsSchema,
      },
    },
    async (request: FastifyRequest) => {
      const { orderId } = request.params as { orderId: string };
      return ctx.orders.getOrder(orderId);
    },
  );

  app.post(
    "/v1/orders/:orderId/cancel",
    {
      schema: {
        tags: ["partner"],
        summary: "Cancel an eligible pending fund order before its cutoff",
        params: orderIdParamsSchema,
        body: cancelOrderBodySchema,
      },
    },
    async (request: FastifyRequest) => {
      const { orderId } = request.params as { orderId: string };
      const { accountId } = request.body as { accountId: string };
      return ctx.orders.cancelOrder(orderId, accountId);
    },
  );

  app.get(
    "/v1/portfolios",
    { schema: { tags: ["partner"], summary: "List synthetic accounts with their cash" } },
    async () => ctx.portfolio.listPortfolios(),
  );

  app.get(
    "/v1/portfolios/:accountId",
    {
      schema: {
        tags: ["partner"],
        summary: "Read spendable, reserved and marked balances with price provenance",
        params: accountIdParamsSchema,
      },
    },
    async (request: FastifyRequest) => {
      const { accountId } = request.params as { accountId: string };
      return ctx.portfolio.getPortfolio(accountId);
    },
  );

  app.post(
    "/v1/issuer/nav",
    {
      schema: {
        tags: ["issuer"],
        summary: "Publish an authorized synthetic eFUND NAV observation",
        headers: roleHeaderSchema,
        body: navBodySchema,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = request.body as NavPublicationRequest;
      const role = headerValue(request.headers["x-role-identity"]);
      const result = ctx.issuer.publishNav(body, role);
      return reply.code(201).send(result);
    },
  );

  app.post(
    "/v1/scenarios/drafts",
    {
      schema: {
        tags: ["policy-lab"],
        summary: "Create a Policy Lab draft from the recorded preset or manual fields",
        headers: sessionHeadersSchema,
        body: scenarioDraftBodySchema,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const sessionId = headerValue(request.headers["x-session-id"]) ?? DEFAULT_SESSION_ID;
      const draft = await ctx.scenarios.createDraft(
        request.body as CreateScenarioDraftRequest,
        sessionId,
      );
      return reply.code(201).send(draft);
    },
  );

  app.patch(
    "/v1/scenarios/:scenarioId/draft",
    {
      schema: {
        tags: ["policy-lab"],
        summary: "Edit a draft, producing a new revision and confirmation digest",
        headers: sessionHeadersSchema,
        params: scenarioIdParamsSchema,
        body: scenarioEditBodySchema,
      },
    },
    async (request: FastifyRequest) => {
      const sessionId = headerValue(request.headers["x-session-id"]) ?? DEFAULT_SESSION_ID;
      const { scenarioId } = request.params as { scenarioId: string };
      return ctx.scenarios.editDraft(
        scenarioId,
        request.body as EditScenarioDraftRequest,
        sessionId,
      );
    },
  );

  app.post(
    "/v1/scenarios/:scenarioId/runs",
    {
      schema: {
        tags: ["policy-lab"],
        summary: "Confirm a revision and queue the two-branch comparison",
        headers: scenarioRunHeadersSchema,
        params: scenarioIdParamsSchema,
        body: startScenarioRunBodySchema,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const sessionId = headerValue(request.headers["x-session-id"]) ?? DEFAULT_SESSION_ID;
      const { scenarioId } = request.params as { scenarioId: string };
      const idempotencyKey = headerValue(request.headers["idempotency-key"]);
      const outcome = ctx.scenarios.startRun(
        scenarioId,
        request.body as StartScenarioRunRequest,
        sessionId,
        idempotencyKey,
      );
      return reply.code(202).send(outcome.accepted);
    },
  );

  app.get(
    "/v1/scenario-runs/:runId",
    {
      schema: {
        tags: ["policy-lab"],
        summary: "Read queued, running, succeeded or failed comparison status",
        headers: sessionHeadersSchema,
        params: runIdParamsSchema,
      },
    },
    async (request: FastifyRequest) => {
      const sessionId = headerValue(request.headers["x-session-id"]) ?? DEFAULT_SESSION_ID;
      const { runId } = request.params as { runId: string };
      return ctx.scenarios.getRun(runId, sessionId);
    },
  );

  app.get(
    "/v1/scenario-runs/:runId/evidence",
    {
      schema: {
        tags: ["policy-lab"],
        summary: "Download the versioned P01 comparison pack for a succeeded run",
        headers: sessionHeadersSchema,
        params: runIdParamsSchema,
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const sessionId = headerValue(request.headers["x-session-id"]) ?? DEFAULT_SESSION_ID;
      const { runId } = request.params as { runId: string };
      const evidence = ctx.scenarios.getRunEvidence(runId, sessionId);
      return reply
        .header("content-disposition", `attachment; filename="${evidence.fileName}"`)
        .type("application/json")
        .send(evidence.json);
    },
  );

  if (!config.devEndpoints) {
    return;
  }

  app.get(
    "/v1/dev/clock",
    { schema: { tags: ["dev"], summary: "Read the fixture clock" } },
    async () => ({ now: ctx.clock.getNow() }),
  );

  app.post(
    "/v1/dev/clock",
    {
      schema: {
        tags: ["dev"],
        summary: "Advance the fixture clock forward",
        body: clockBodySchema,
      },
    },
    async (request: FastifyRequest) => {
      const { to } = request.body as { to: string };
      return ctx.clock.advance(to);
    },
  );

  app.post(
    "/v1/dev/price-source",
    {
      schema: {
        tags: ["dev"],
        summary: "Simulate a stale or unavailable dealer price source",
        body: priceSourceBodySchema,
      },
    },
    async (request: FastifyRequest) => {
      const body = request.body as { staleSeconds?: number; unavailable?: boolean };
      const now = readClock(ctx.db);
      const existing = readPriceSource(ctx.db);
      const staleSeconds = body.staleSeconds ?? 0;
      const asOf =
        staleSeconds > 0
          ? formatUtcInstant(parseUtcInstant(now).epochMs - staleSeconds * 1000)
          : existing.asOf;
      writePriceSource(ctx.db, {
        asOf,
        staleSeconds,
        unavailable: body.unavailable ?? false,
      });
      const updated = readPriceSource(ctx.db);
      return {
        asOf: updated.asOf,
        staleSeconds: updated.staleSeconds,
        unavailable: updated.unavailable,
      };
    },
  );

  app.post(
    "/v1/dev/tick",
    { schema: { tags: ["dev"], summary: "Process pending outbox tasks synchronously" } },
    async () => ({ processed: ctx.worker.processPendingNow() }),
  );

  app.post(
    "/v1/dev/reset",
    { schema: { tags: ["dev"], summary: "Reset the demo to deterministic genesis", body: emptyBodySchema } },
    async (request: FastifyRequest) => {
      const body = request.body as Record<string, unknown> | undefined;
      if (body !== undefined && Object.keys(body).length > 0) {
        throw problem(400, "INVALID_REQUEST", "Reset takes no request fields");
      }
      ctx.resetDemo();
      return { status: "reset" as const, clock: ctx.clock.getNow() };
    },
  );
}
