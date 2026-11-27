/**
 * Request schemas for the partner API.
 *
 * Fastify validates requests against these JSON Schemas and exposes them in the
 * generated OpenAPI document at `/openapi.json`. Response bodies are serialized
 * as typed objects from the SDK contract; response schemas are intentionally
 * omitted here so no documented field can be silently dropped.
 */

export const createQuoteBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["accountId", "assetId", "side", "amountBase"],
  properties: {
    accountId: { type: "string", minLength: 1 },
    assetId: { type: "string", enum: ["tWETH", "eFUND"] },
    side: { type: "string", enum: ["BUY", "SELL", "SUBSCRIBE", "REDEEM"] },
    amountBase: {
      type: "string",
      pattern: "^[0-9]+$",
      description:
        "Positive integer base units. For BUY/SUBSCRIBE this is the cash amount; for SELL/REDEEM it is the asset quantity.",
    },
  },
} as const;

export const placeOrderBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["quoteId", "accountId"],
  properties: {
    quoteId: { type: "string", minLength: 1 },
    accountId: { type: "string", minLength: 1 },
  },
} as const;

export const idempotencyHeadersSchema = {
  type: "object",
  required: ["idempotency-key"],
  properties: {
    "idempotency-key": {
      type: "string",
      minLength: 1,
      maxLength: 200,
      description:
        "Client-generated unique key. A same-key, same-body retry returns the existing order; a different body returns 409.",
    },
  },
} as const;

export const orderIdParamsSchema = {
  type: "object",
  required: ["orderId"],
  properties: { orderId: { type: "string", minLength: 1 } },
} as const;

export const accountIdParamsSchema = {
  type: "object",
  required: ["accountId"],
  properties: { accountId: { type: "string", minLength: 1 } },
} as const;

export const accountQuerySchema = {
  type: "object",
  required: ["accountId"],
  properties: { accountId: { type: "string", minLength: 1 } },
} as const;

export const cancelOrderBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["accountId"],
  properties: { accountId: { type: "string", minLength: 1 } },
} as const;

export const navBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["assetId", "valuationDate", "navBase", "sourceTime", "revision"],
  properties: {
    assetId: { type: "string", enum: ["eFUND"] },
    valuationDate: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
    navBase: { type: "string", pattern: "^[0-9]+$" },
    sourceTime: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$" },
    revision: { type: "integer", minimum: 1 },
  },
} as const;

export const roleHeaderSchema = {
  type: "object",
  required: ["x-role-identity"],
  properties: {
    "x-role-identity": {
      type: "string",
      description: "Local role identity. NAV publication requires the issuer signer identity.",
    },
  },
} as const;

export const clockBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["to"],
  properties: {
    to: {
      type: "string",
      pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$",
      description: "Target UTC instant. The fixture clock only moves forward.",
    },
  },
} as const;

export const priceSourceBodySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    staleSeconds: { type: "integer", minimum: 0, maximum: 86_400 },
    unavailable: { type: "boolean" },
  },
} as const;

export const emptyBodySchema = { type: "object", additionalProperties: false } as const;

const manualFieldsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    weekday: { type: "string" },
    timeUtc: { type: "string" },
    timezone: { type: "string" },
    expectedTimeUtc: { type: "string" },
  },
} as const;

export const sessionHeadersSchema = {
  type: "object",
  properties: {
    "x-session-id": {
      type: "string",
      minLength: 1,
      maxLength: 120,
      description: "Local scenario session. Defaults to local-session when omitted.",
    },
  },
} as const;

export const scenarioDraftBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["fixtureId", "mode"],
  properties: {
    fixtureId: { type: "string", enum: ["P01"] },
    mode: {
      type: "string",
      enum: ["recorded", "live", "manual"],
      description:
        "recorded loads the bundled recorded proposal, manual takes typed fields, live requires the local model adapter (step S04).",
    },
    question: { type: "string", maxLength: 500 },
    manualFields: manualFieldsSchema,
  },
} as const;

export const scenarioEditBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["expectedRevision"],
  properties: {
    expectedRevision: { type: "integer", minimum: 1 },
    fields: manualFieldsSchema,
    clarificationAnswer: manualFieldsSchema,
  },
} as const;

export const scenarioIdParamsSchema = {
  type: "object",
  required: ["scenarioId"],
  properties: { scenarioId: { type: "string", minLength: 1 } },
} as const;

export const runIdParamsSchema = {
  type: "object",
  required: ["runId"],
  properties: { runId: { type: "string", minLength: 1 } },
} as const;

export const startScenarioRunBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["revision", "confirmationDigest"],
  properties: {
    revision: { type: "integer", minimum: 1 },
    confirmationDigest: { type: "string", pattern: "^[0-9a-f]{64}$" },
  },
} as const;

export const scenarioRunHeadersSchema = {
  type: "object",
  required: ["idempotency-key"],
  properties: {
    "idempotency-key": {
      type: "string",
      minLength: 1,
      maxLength: 200,
      description:
        "Client-generated run key. A same-key same-body retry returns the existing run; a changed body returns 409.",
    },
    "x-session-id": {
      type: "string",
      minLength: 1,
      maxLength: 120,
      description: "Local scenario session. Defaults to local-session when omitted.",
    },
  },
} as const;
