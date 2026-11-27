/**
 * Live-mode scenario API tests.
 *
 * The local runtime is replaced by a scripted model port so malformed output,
 * retry, timeout and unavailable behaviour can be asserted deterministically. The
 * same adapter contract and schema validation are used as with the real runtime.
 */
import { describe, expect, it } from "vitest";
import { ScriptedModelPort, type ModelPort } from "@eurorollup/policy-lab";
import { createHarness, type Harness, type HttpResult } from "../src/evidence/harness.js";
import { createApp } from "../src/app.js";
import { createApiConfig } from "../src/config.js";

const VALID_PROPOSAL = JSON.stringify({
  status: "proposed",
  operation: "set_subscription_cutoff",
  asset: "eFUND",
  weekday: "FRI",
  timeUtc: "15:00",
  timezone: "UTC",
  expectedTimeUtc: "16:00",
});

function scriptedPort(
  responses: ConstructorParameters<typeof ScriptedModelPort>[0]["responses"],
): ModelPort {
  return new ScriptedModelPort({
    responses,
    metadata: {
      provider: "scripted",
      model: "scripted-qwen",
      digest: "digest-scripted",
      promptVersion: "test-prompt",
      temperature: 0,
      seed: 0,
      timeoutMs: 15_000,
    },
  });
}

async function createLiveHarness(port: ModelPort): Promise<Harness> {
  return createHarness({ modelPort: port });
}

async function postLiveDraft(harness: Harness, question: string): Promise<HttpResult> {
  return harness.inject("POST", "/v1/scenarios/drafts", {
    payload: { fixtureId: "P01", mode: "live", question },
    headers: { "x-session-id": "session-live" },
  });
}

describe("live model drafting through the scenario API", () => {
  it("creates a live-origin draft and reports the model metadata", async () => {
    const harness = await createLiveHarness(scriptedPort([{ kind: "text", text: VALID_PROPOSAL }]));
    try {
      const response = await postLiveDraft(harness, "What if Friday's cutoff moved from 16:00 to 15:00 UTC?");
      expect(response.status).toBe(201);
      const draft = response.body as {
        origin: string;
        status: string;
        question: string;
        diff: { oldTimeUtc: string; newTimeUtc: string } | null;
        model?: { model: string; promptVersion: string; attempts: number; digest: string | null };
        confirmationDigest: string;
      };
      expect(draft.origin).toBe("live");
      expect(draft.status).toBe("proposed");
      expect(draft.diff).toMatchObject({ oldTimeUtc: "16:00", newTimeUtc: "15:00" });
      expect(draft.model?.model).toBe("scripted-qwen");
      expect(draft.model?.attempts).toBe(1);
      expect(draft.model?.digest).toBe("digest-scripted");
      expect(draft.question).toBe("What if Friday's cutoff moved from 16:00 to 15:00 UTC?");
      expect(draft.confirmationDigest).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await harness.close();
    }
  });

  it("keeps raw free text out of persisted scenario revisions", async () => {
    const harness = await createLiveHarness(scriptedPort([{ kind: "text", text: VALID_PROPOSAL }]));
    try {
      const question = "Please move the Friday cutoff from 16:00 to 15:00 UTC for my synthetic test.";
      const response = await postLiveDraft(harness, question);
      expect(response.status).toBe(201);
      const scenarioId = (response.body as { scenarioId: string }).scenarioId;
      const row = harness.ctx.db
        .prepare("SELECT draft_json FROM scenario_revisions WHERE scenario_id = ?")
        .get(scenarioId) as { draft_json: string };
      expect(row.draft_json).not.toContain("synthetic test");
      const parsed = JSON.parse(row.draft_json) as { question: string | null };
      expect(parsed.question).toBeNull();
    } finally {
      await harness.close();
    }
  });

  it("retries malformed output once with schema feedback", async () => {
    const port = scriptedPort([
      { kind: "text", text: "this is not json" },
      { kind: "text", text: VALID_PROPOSAL },
    ]);
    const harness = await createLiveHarness(port);
    try {
      const response = await postLiveDraft(harness, "Move the Friday cutoff from 16:00 to 15:00 UTC.");
      expect(response.status).toBe(201);
      expect((response.body as { model: { attempts: number } }).model.attempts).toBe(2);
      expect((port as ScriptedModelPort).calls).toBe(2);
    } finally {
      await harness.close();
    }
  });

  it("returns a recoverable error after two malformed attempts", async () => {
    const harness = await createLiveHarness(
      scriptedPort([
        { kind: "text", text: '{"status":"proposed","operation":"set_subscription_cutoff","asset":"eFUND","weekday":"FRI","timeUtc":"15:00","timezone":"UTC","executable":"rm -rf /"}' },
        { kind: "text", text: "not json" },
      ]),
    );
    try {
      const response = await postLiveDraft(harness, "Move the Friday cutoff to 15:00 UTC.");
      expect(response.status).toBe(503);
      expect((response.body as { error: { code: string } }).error.code).toBe("MODEL_OUTPUT_INVALID");
      expect(response.headers["retry-after"]).toBe("30");
    } finally {
      await harness.close();
    }
  });

  it("returns a recoverable timeout without falling back to the preset", async () => {
    const harness = await createLiveHarness(
      scriptedPort([{ kind: "timeout" }, { kind: "timeout" }]),
    );
    try {
      const response = await postLiveDraft(harness, "Move the Friday cutoff to 15:00 UTC.");
      expect(response.status).toBe(503);
      expect((response.body as { error: { code: string } }).error.code).toBe("MODEL_TIMEOUT");
      const list = await harness.inject("GET", "/v1/scenarios/does-not-exist", {
        headers: { "x-session-id": "session-live" },
      });
      expect(list.status).toBe(404);
      // No scenario row was created for a failed draft.
      const count = harness.ctx.db
        .prepare("SELECT COUNT(*) AS count FROM scenarios")
        .get() as { count: number };
      expect(count.count).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it("returns model unavailable when the runtime is down", async () => {
    const harness = await createLiveHarness(
      scriptedPort([{ kind: "unavailable" }]),
    );
    try {
      const response = await postLiveDraft(harness, "Move the Friday cutoff to 15:00 UTC.");
      expect(response.status).toBe(503);
      expect((response.body as { error: { code: string } }).error.code).toBe("MODEL_UNAVAILABLE");
    } finally {
      await harness.close();
    }
  });

  it("rejects an empty live question before calling the model", async () => {
    const port = scriptedPort([]);
    const harness = await createLiveHarness(port);
    try {
      const response = await postLiveDraft(harness, "   ");
      expect(response.status).toBe(422);
      expect((response.body as { error: { code: string } }).error.code).toBe("QUESTION_REQUIRED");
      expect((port as ScriptedModelPort).calls).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it("reports local model status through the API", async () => {
    const harness = await createLiveHarness(scriptedPort([]));
    try {
      const response = await harness.inject("GET", "/v1/model/status");
      expect(response.status).toBe(200);
      const status = response.body as {
        provider: string;
        model: string;
        digest: string | null;
        available: boolean;
        promptVersion: string;
      };
      expect(status.provider).toBe("scripted");
      expect(status.model).toBe("scripted-qwen");
      expect(status.digest).toBe("digest-scripted");
      expect(status.available).toBe(true);
      expect(status.promptVersion).toBe("test-prompt");
    } finally {
      await harness.close();
    }
  });

  it("does not change settlement or policy state when a live draft is created", async () => {
    const harness = await createLiveHarness(scriptedPort([{ kind: "text", text: VALID_PROPOSAL }]));
    try {
      const before = await harness.inject("GET", "/v1/health");
      await postLiveDraft(harness, "Move the Friday cutoff from 16:00 to 15:00 UTC.");
      const after = await harness.inject("GET", "/v1/health");
      expect((after.body as { eventCount: number }).eventCount).toBe(
        (before.body as { eventCount: number }).eventCount,
      );
      expect((after.body as { policyEpoch: string }).policyEpoch).toBe(
        (before.body as { policyEpoch: string }).policyEpoch,
      );
      const orders = await harness.inject("GET", "/v1/orders?accountId=investor-ada");
      expect((orders.body as unknown[]).length).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it("exposes the live-model and scenario paths in the OpenAPI document", async () => {
    const app = await createApp({
      config: createApiConfig({ dbFile: ":memory:", autoWorker: false }),
    });
    try {
      await app.app.ready();
      const spec = app.app.swagger() as { paths: Record<string, unknown> };
      expect(Object.keys(spec.paths)).toEqual(
        expect.arrayContaining(["/v1/model/status", "/v1/scenarios/drafts"]),
      );
    } finally {
      await app.close();
    }
  });
});
