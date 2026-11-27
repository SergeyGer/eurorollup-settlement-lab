/**
 * AI Policy Lab scenario API tests: drafting, revisions, confirmation binding,
 * queueing and evidence parity with the CLI pack.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../src/evidence/harness.js";
import { repositoryRoot } from "../src/config.js";

interface DraftResponse {
  scenarioId: string;
  revision: number;
  status: string;
  origin: string;
  diff: { weekday: string; oldTimeUtc: string; newTimeUtc: string } | null;
  clarify: { question: string; missingFields: string[] } | null;
  confirmationDigest: string;
  draftDigest: string;
  parentRevision: number | null;
}

interface RunAccepted {
  runId: string;
  scenarioId: string;
  status: string;
  revision: number;
}

interface RunResponse {
  runId: string;
  status: string;
  comparisonDigest: string | null;
  packDigest: string | null;
  evidencePath: string | null;
  result: {
    affectedOrders: number;
    totalOrders: number;
    extraReservedAtFridayCloseBase: string;
    boundarySummary: { total: number; passed: number; failed: number };
  } | null;
  error: { code: string; message: string } | null;
}

async function createRecordedDraft(harness: Harness, sessionId = "session-a"): Promise<DraftResponse> {
  const response = await harness.inject("POST", "/v1/scenarios/drafts", {
    payload: { fixtureId: "P01", mode: "recorded" },
    headers: { "x-session-id": sessionId },
  });
  expect(response.status).toBe(201);
  return response.body as DraftResponse;
}

async function startRun(
  harness: Harness,
  draft: DraftResponse,
  key: string,
  sessionId = "session-a",
): Promise<{ status: number; body: RunAccepted }> {
  const response = await harness.inject("POST", `/v1/scenarios/${draft.scenarioId}/runs`, {
    payload: { revision: draft.revision, confirmationDigest: draft.confirmationDigest },
    headers: { "x-session-id": sessionId, "idempotency-key": key },
  });
  return { status: response.status, body: response.body as RunAccepted };
}

describe("Policy Lab drafts", () => {
  it("creates the recorded Friday 16:00 to 15:00 draft as revision 1", async () => {
    const harness = await createHarness();
    try {
      const draft = await createRecordedDraft(harness);
      expect(draft.status).toBe("proposed");
      expect(draft.origin).toBe("recorded");
      expect(draft.revision).toBe(1);
      expect(draft.diff).toMatchObject({
        asset: "eFUND",
        orderType: "FUND_SUBSCRIPTION",
        weekday: "FRI",
        oldTimeUtc: "16:00",
        newTimeUtc: "15:00",
        timezone: "UTC",
      });
      expect(draft.confirmationDigest).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await harness.close();
    }
  });

  it("creates a manual draft, clarifies and edits revisions", async () => {
    const harness = await createHarness();
    try {
      const clarifyResponse = await harness.inject("POST", "/v1/scenarios/drafts", {
        payload: {
          fixtureId: "P01",
          mode: "manual",
          manualFields: { weekday: "FRI" },
        },
        headers: { "x-session-id": "session-a" },
      });
      expect(clarifyResponse.status).toBe(201);
      const clarified = clarifyResponse.body as DraftResponse;
      expect(clarified.status).toBe("clarify");
      expect(clarified.clarify?.missingFields).toEqual(["timeUtc", "timezone"]);

      const editResponse = await harness.inject(
        "PATCH",
        `/v1/scenarios/${clarified.scenarioId}/draft`,
        {
          payload: {
            expectedRevision: clarified.revision,
            clarificationAnswer: { weekday: "FRI", timeUtc: "15:00", timezone: "UTC" },
          },
          headers: { "x-session-id": "session-a" },
        },
      );
      expect(editResponse.status).toBe(200);
      const edited = editResponse.body as DraftResponse;
      expect(edited.status).toBe("proposed");
      expect(edited.revision).toBe(2);
      expect(edited.parentRevision).toBe(1);
      expect(edited.diff?.newTimeUtc).toBe("15:00");
      expect(edited.confirmationDigest).not.toBe(clarified.confirmationDigest);
    } finally {
      await harness.close();
    }
  });

  it("rejects stale revisions and unknown fields", async () => {
    const harness = await createHarness();
    try {
      const draft = await createRecordedDraft(harness);
      const stale = await harness.inject("PATCH", `/v1/scenarios/${draft.scenarioId}/draft`, {
        payload: { expectedRevision: 99, fields: { weekday: "FRI", timeUtc: "15:30", timezone: "UTC" } },
        headers: { "x-session-id": "session-a" },
      });
      expect(stale.status).toBe(409);
      expect((stale.body as { error: { code: string } }).error.code).toBe("STALE_REVISION");

      const unknown = await harness.inject("PATCH", `/v1/scenarios/${draft.scenarioId}/draft`, {
        payload: { expectedRevision: 1, fields: { weekday: "FRI", timeUtc: "15:30", timezone: "UTC" }, unknown: true },
        headers: { "x-session-id": "session-a" },
      });
      expect(unknown.status).toBe(422);
      expect((unknown.body as { error: { code: string } }).error.code).toBe("INVALID_REQUEST");
    } finally {
      await harness.close();
    }
  });

  it("refuses live mode until the model adapter is configured", async () => {
    const harness = await createHarness();
    try {
      const response = await harness.inject("POST", "/v1/scenarios/drafts", {
        payload: { fixtureId: "P01", mode: "live", question: "What if the Friday cutoff moved to 15:00?" },
        headers: { "x-session-id": "session-a" },
      });
      expect(response.status).toBe(503);
      expect((response.body as { error: { code: string } }).error.code).toBe("LIVE_MODEL_NOT_CONFIGURED");
      expect(response.headers["retry-after"]).toBe("30");
    } finally {
      await harness.close();
    }
  });

  it("rejects a stated prior time that disagrees with the baseline", async () => {
    const harness = await createHarness();
    try {
      const response = await harness.inject("POST", "/v1/scenarios/drafts", {
        payload: {
          fixtureId: "P01",
          mode: "manual",
          manualFields: { weekday: "FRI", timeUtc: "15:00", timezone: "UTC", expectedTimeUtc: "14:00" },
        },
        headers: { "x-session-id": "session-a" },
      });
      expect(response.status).toBe(422);
      expect((response.body as { error: { code: string } }).error.code).toBe("PRIOR_TIME_MISMATCH");
    } finally {
      await harness.close();
    }
  });

  it("restricts scenarios to the owning session", async () => {
    const harness = await createHarness();
    try {
      const draft = await createRecordedDraft(harness, "session-a");
      const otherEdit = await harness.inject("PATCH", `/v1/scenarios/${draft.scenarioId}/draft`, {
        payload: { expectedRevision: 1, fields: { weekday: "FRI", timeUtc: "15:30", timezone: "UTC" } },
        headers: { "x-session-id": "session-b" },
      });
      expect(otherEdit.status).toBe(403);
      expect((otherEdit.body as { error: { code: string } }).error.code).toBe("SESSION_MISMATCH");
    } finally {
      await harness.close();
    }
  });

  it("refuses a no-change draft before queueing", async () => {
    const harness = await createHarness();
    try {
      const response = await harness.inject("POST", "/v1/scenarios/drafts", {
        payload: {
          fixtureId: "P01",
          mode: "manual",
          manualFields: { weekday: "FRI", timeUtc: "16:00", timezone: "UTC" },
        },
        headers: { "x-session-id": "session-a" },
      });
      const draft = response.body as DraftResponse;
      expect(draft.status).toBe("no_change");
      const run = await startRun(harness, draft, "run-no-change");
      expect(run.status).toBe(422);
      expect((run.body as unknown as { error: { code: string } }).error.code).toBe(
        "INVALID_SCENARIO_STATE",
      );
    } finally {
      await harness.close();
    }
  });
});

describe("Policy Lab comparison runs", () => {
  it("queues, computes and publishes the deterministic comparison", async () => {
    const harness = await createHarness();
    try {
      const draft = await createRecordedDraft(harness);
      const accepted = await startRun(harness, draft, "run-key-a");
      expect(accepted.status).toBe(202);
      expect(accepted.body.status).toBe("queued");

      const queued = await harness.inject("GET", `/v1/scenario-runs/${accepted.body.runId}`, {
        headers: { "x-session-id": "session-a" },
      });
      expect(queued.status).toBe(200);
      expect((queued.body as RunResponse).status).toBe("queued");
      expect((queued.body as RunResponse).result).toBeNull();

      harness.tick();

      const succeeded = await harness.inject("GET", `/v1/scenario-runs/${accepted.body.runId}`, {
        headers: { "x-session-id": "session-a" },
      });
      expect(succeeded.status).toBe(200);
      const run = succeeded.body as RunResponse;
      expect(run.status).toBe("succeeded");
      expect(run.result?.affectedOrders).toBe(1);
      expect(run.result?.totalOrders).toBe(2);
      expect(run.result?.extraReservedAtFridayCloseBase).toBe("300000000");
      expect(run.result?.boundarySummary).toEqual({ total: 6, passed: 6, failed: 0 });
      expect(run.comparisonDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(run.evidencePath).toBe(`/v1/scenario-runs/${accepted.body.runId}/evidence`);
    } finally {
      await harness.close();
    }
  });

  it("reproduces the committed CLI pack byte for byte", async () => {
    const harness = await createHarness();
    try {
      const draft = await createRecordedDraft(harness);
      const accepted = await startRun(harness, draft, "run-key-parity");
      harness.tick();
      const evidence = await harness.inject(
        "GET",
        `/v1/scenario-runs/${accepted.body.runId}/evidence`,
        { headers: { "x-session-id": "session-a" } },
      );
      expect(evidence.status).toBe(200);
      expect(String(evidence.headers["content-disposition"])).toContain("p01-comparison-");
      const committed = readFileSync(`${repositoryRoot()}evidence/policy-lab/p01-comparison.json`, "utf8");
      const serialized = `${JSON.stringify(evidence.body, null, 2)}\n`;
      expect(serialized).toBe(committed);
    } finally {
      await harness.close();
    }
  });

  it("makes same-key run retries idempotent and rejects changed bodies", async () => {
    const harness = await createHarness();
    try {
      const draft = await createRecordedDraft(harness);
      const first = await startRun(harness, draft, "run-key-idem");
      expect(first.status).toBe(202);
      const retry = await startRun(harness, draft, "run-key-idem");
      expect(retry.status).toBe(202);
      expect(retry.body.runId).toBe(first.body.runId);
      harness.tick();
      const afterSettlement = await startRun(harness, draft, "run-key-idem");
      expect(afterSettlement.body.runId).toBe(first.body.runId);

      const conflicting = await harness.inject(
        "POST",
        `/v1/scenarios/${draft.scenarioId}/runs`,
        {
          payload: { revision: draft.revision, confirmationDigest: "0".repeat(64) },
          headers: { "x-session-id": "session-a", "idempotency-key": "run-key-idem" },
        },
      );
      expect(conflicting.status).toBe(409);
      expect((conflicting.body as { error: { code: string } }).error.code).toBe(
        "IDEMPOTENCY_KEY_REUSED",
      );
    } finally {
      await harness.close();
    }
  });

  it("rejects mismatched confirmation digests and stale revisions", async () => {
    const harness = await createHarness();
    try {
      const draft = await createRecordedDraft(harness);
      const mismatched = await harness.inject(
        "POST",
        `/v1/scenarios/${draft.scenarioId}/runs`,
        {
          payload: { revision: draft.revision, confirmationDigest: "a".repeat(64) },
          headers: { "x-session-id": "session-a", "idempotency-key": "run-key-bad-digest" },
        },
      );
      expect(mismatched.status).toBe(409);
      expect((mismatched.body as { error: { code: string } }).error.code).toBe(
        "CONFIRMATION_MISMATCH",
      );

      const stale = await harness.inject("POST", `/v1/scenarios/${draft.scenarioId}/runs`, {
        payload: { revision: 99, confirmationDigest: draft.confirmationDigest },
        headers: { "x-session-id": "session-a", "idempotency-key": "run-key-stale" },
      });
      expect(stale.status).toBe(409);
      expect((stale.body as { error: { code: string } }).error.code).toBe("STALE_REVISION");
    } finally {
      await harness.close();
    }
  });

  it("serves evidence only for succeeded runs", async () => {
    const harness = await createHarness();
    try {
      const draft = await createRecordedDraft(harness);
      const accepted = await startRun(harness, draft, "run-key-early");
      const evidence = await harness.inject(
        "GET",
        `/v1/scenario-runs/${accepted.body.runId}/evidence`,
        { headers: { "x-session-id": "session-a" } },
      );
      expect(evidence.status).toBe(422);
      expect((evidence.body as { error: { code: string } }).error.code).toBe(
        "INVALID_SCENARIO_STATE",
      );
    } finally {
      await harness.close();
    }
  });

  it("rejects edits from a stale revision after the draft changed", async () => {
    const harness = await createHarness();
    try {
      const draft = await createRecordedDraft(harness);
      const edited = await harness.inject("PATCH", `/v1/scenarios/${draft.scenarioId}/draft`, {
        payload: { expectedRevision: 1, fields: { weekday: "FRI", timeUtc: "15:30", timezone: "UTC" } },
        headers: { "x-session-id": "session-a" },
      });
      expect(edited.status).toBe(200);
      const staleEdit = await harness.inject("PATCH", `/v1/scenarios/${draft.scenarioId}/draft`, {
        payload: { expectedRevision: 1, fields: { weekday: "FRI", timeUtc: "15:45", timezone: "UTC" } },
        headers: { "x-session-id": "session-a" },
      });
      expect(staleEdit.status).toBe(409);
      const newDraft = edited.body as DraftResponse;
      const runStale = await harness.inject("POST", `/v1/scenarios/${draft.scenarioId}/runs`, {
        payload: { revision: 1, confirmationDigest: draft.confirmationDigest },
        headers: { "x-session-id": "session-a", "idempotency-key": "run-key-old-rev" },
      });
      expect(runStale.status).toBe(409);
      expect(newDraft.revision).toBe(2);
    } finally {
      await harness.close();
    }
  });

  it("adds the scenario and run endpoints to the OpenAPI document", async () => {
    const harness = await createHarness();
    try {
      const spec = (await harness.inject("GET", "/openapi.json")).body as {
        paths: Record<string, unknown>;
      };
      expect(Object.keys(spec.paths)).toEqual(
        expect.arrayContaining([
          "/v1/scenarios/drafts",
          "/v1/scenarios/{scenarioId}/draft",
          "/v1/scenarios/{scenarioId}/runs",
          "/v1/scenario-runs/{runId}",
          "/v1/scenario-runs/{runId}/evidence",
        ]),
      );
    } finally {
      await harness.close();
    }
  });
});
