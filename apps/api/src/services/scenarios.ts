/**
 * AI Policy Lab scenario service.
 *
 * Drafting, revisioning, confirmation binding and deterministic comparison runs
 * live here. The service uses the shared `@eurorollup/policy-lab` package, so the
 * browser, the API and the CLI produce the same comparison digest for the same
 * confirmed patch. Scenario storage carries no settlement write credentials: a
 * run replays frozen fixtures through the pure engine only.
 */
import {
  ENGINE_VERSION,
  applyCutoffChange,
  hashJson,
  type CalendarFixture,
  type FundDealingPolicy,
  type P01Scenario,
} from "@eurorollup/dealing";
import {
  POLICY_LAB_VERSION,
  buildDraft,
  buildLiveDraftRequest,
  buildP01ComparisonPack,
  createDraft,
  editDraft,
  policyBaselineRef,
  policyFromFixture,
  runP01BoundaryCases,
  runP01Comparison,
  serializeP01ComparisonPack,
  type P01BoundaryFixture,
  type P01ComparisonPack,
  type RecordedProposalFixture,
  type ReplayDraft,
  type ManualFields,
} from "@eurorollup/policy-lab";
import p01FixtureJson from "../../../../fixtures/p01/scenario.json";
import labUtc1Json from "../../../../fixtures/calendar/LAB-UTC-1.json";
import labUtc2Json from "../../../../fixtures/calendar/LAB-UTC-2.json";
import boundaryFixtureJson from "../../../../fixtures/policy-lab/p01-boundary.json";
import recordedProposalJson from "../../../../fixtures/policy-lab/p01-recorded-proposal.json";
import type { ApiConfig } from "../config.js";
import type { Database } from "../db.js";
import { enqueueOutbox, readClock, transaction } from "../db.js";
import type { ClockService } from "../clock-service.js";
import type { IdFactory } from "../ids.js";
import { ApiProblem, problem } from "../problems.js";
import { PolicyLabError, isPolicyLabError } from "@eurorollup/policy-lab";
import type { ModelService } from "./model-service.js";
import {
  getScenarioRevisionRow,
  getScenarioRow,
  getScenarioRunRow,
  getScenarioRunRowByIdempotencyKey,
  insertScenario,
  insertScenarioRevision,
  insertScenarioRun,
  updateScenarioRevision,
  updateScenarioRun,
  type ScenarioRunRow,
} from "../repository.js";

export const OUTBOX_RUN_SCENARIO = "run-scenario";
export const DEFAULT_SESSION_ID = "local-session";

const fixture = p01FixtureJson as unknown as P01Scenario;
const calendarFixture = labUtc1Json as unknown as CalendarFixture;
const calendar2Fixture = labUtc2Json as unknown as CalendarFixture;
const boundaryFixture = boundaryFixtureJson as unknown as P01BoundaryFixture;
const recordedProposal = recordedProposalJson as unknown as RecordedProposalFixture;

export interface CreateScenarioDraftRequest {
  readonly fixtureId: string;
  readonly mode: "recorded" | "live" | "manual";
  readonly question?: string;
  readonly manualFields?: ManualFields;
}

export interface EditScenarioDraftRequest {
  readonly expectedRevision: number;
  readonly fields?: ManualFields;
  readonly clarificationAnswer?: ManualFields;
}

export interface StartScenarioRunRequest {
  readonly revision: number;
  readonly confirmationDigest: string;
}

export interface ScenarioModelInfo {
  readonly provider: string;
  readonly model: string;
  readonly digest: string | null;
  readonly promptVersion: string;
  readonly attempts: number;
  readonly elapsedMs: number;
}

export interface ScenarioDraftResponse extends ReplayDraft {
  readonly model?: ScenarioModelInfo;
}

export interface ScenarioRunAccepted {
  readonly runId: string;
  readonly scenarioId: string;
  readonly revision: number;
  readonly confirmationDigest: string;
  readonly status: string;
  readonly traceId: string;
  readonly acceptedAt: string;
}

export interface ScenarioRunResponse {
  readonly runId: string;
  readonly scenarioId: string;
  readonly revision: number;
  readonly confirmationDigest: string;
  readonly status: string;
  readonly comparisonDigest: string | null;
  readonly packDigest: string | null;
  readonly evidencePath: string | null;
  readonly result: ScenarioRunResult | null;
  readonly error: { readonly code: string; readonly message: string } | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ScenarioRunResult {
  readonly comparisonDigest: string;
  readonly packDigest: string;
  readonly engineVersion: string;
  readonly policyLabVersion: string;
  readonly baselinePolicyHash: string;
  readonly candidatePolicyHash: string;
  readonly fixtureHash: string;
  readonly affectedOrders: number;
  readonly totalOrders: number;
  readonly extraReservedAtFridayCloseBase: string;
  readonly deltas: P01ComparisonPack["deltas"];
  readonly orderChanges: P01ComparisonPack["orderChanges"];
  readonly branches: {
    readonly baseline: { readonly snapshots: P01ComparisonPack["branches"]["baseline"]["snapshots"]; readonly orders: P01ComparisonPack["branches"]["baseline"]["orders"] };
    readonly candidate: { readonly snapshots: P01ComparisonPack["branches"]["candidate"]["snapshots"]; readonly orders: P01ComparisonPack["branches"]["candidate"]["orders"] };
  };
  readonly boundarySummary: P01ComparisonPack["boundarySummary"];
  readonly checks: readonly string[];
}

export class ScenarioService {
  private readonly db: Database;
  private readonly clock: ClockService;
  private readonly ids: IdFactory;
  private readonly baselinePolicy: FundDealingPolicy;
  private readonly modelService: ModelService | null;

  constructor(
    db: Database,
    _config: ApiConfig,
    clock: ClockService,
    ids: IdFactory,
    modelService?: ModelService,
  ) {
    this.db = db;
    this.clock = clock;
    this.ids = ids;
    this.baselinePolicy = policyFromFixture(fixture.baselinePolicy);
    this.modelService = modelService ?? null;
  }

  private requireSession(scenarioId: string, sessionId: string): void {
    const scenario = getScenarioRow(this.db, scenarioId);
    if (scenario === null) {
      throw problem(404, "SCENARIO_NOT_FOUND", `Unknown scenario ${scenarioId}`, { scenarioId });
    }
    if (scenario.session_id !== sessionId) {
      throw problem(403, "SESSION_MISMATCH", "The scenario belongs to a different local session", {
        scenarioId,
      });
    }
  }

  private loadCurrentDraft(scenarioId: string): ReplayDraft {
    const scenario = getScenarioRow(this.db, scenarioId);
    if (scenario === null) {
      throw problem(404, "SCENARIO_NOT_FOUND", `Unknown scenario ${scenarioId}`, { scenarioId });
    }
    const revision = getScenarioRevisionRow(this.db, scenarioId, scenario.current_revision);
    if (revision === null) {
      throw problem(500, "INTERNAL_ERROR", "Scenario revision projection is missing");
    }
    return JSON.parse(revision.draft_json) as ReplayDraft;
  }

  async createDraft(
    body: CreateScenarioDraftRequest,
    sessionId: string,
  ): Promise<ScenarioDraftResponse> {
    if (body.mode === "live") {
      return this.createLiveDraft(body, sessionId);
    }
    const now = readClock(this.db);
    const draft = createDraft({
      fixture,
      calendarFixture,
      baselinePolicy: this.baselinePolicy,
      input: {
        fixtureId: body.fixtureId,
        mode: body.mode,
        ...(body.question === undefined ? {} : { question: body.question }),
        ...(body.manualFields === undefined ? {} : { manualFields: body.manualFields }),
      },
      recordedProposal,
      createdAt: now,
    });
    const scenarioId = this.ids.scenario();
    const storedDraft: ReplayDraft = { ...draft, scenarioId };
    transaction(this.db, () => {
      insertScenario(this.db, {
        scenarioId,
        sessionId,
        fixtureId: draft.fixture.fixtureId,
        mode: body.mode,
        origin: draft.origin,
        baselinePolicyJson: JSON.stringify(this.baselinePolicy),
        baselinePolicyHash: draft.baseline.policyHash,
        fixtureHash: draft.fixture.fixtureHash,
        policyLabVersion: POLICY_LAB_VERSION,
        currentRevision: draft.revision,
        status: draft.status,
        createdAt: now,
      });
      insertScenarioRevision(this.db, {
        scenario_id: scenarioId,
        revision: draft.revision,
        draft_json: JSON.stringify(storedDraft),
        draft_digest: draft.draftDigest,
        confirmation_digest: draft.confirmationDigest,
        created_at: now,
      });
    });
    return storedDraft;
  }

  private async createLiveDraft(
    body: CreateScenarioDraftRequest,
    sessionId: string,
  ): Promise<ScenarioDraftResponse> {
    if (this.modelService === null) {
      throw problem(503, "MODEL_UNAVAILABLE", "The local model adapter is not configured");
    }
    const question = (body.question ?? "").trim();
    if (question.length === 0) {
      throw problem(422, "QUESTION_REQUIRED", "Live mode requires a short question");
    }
    if (question.length > 500) {
      throw problem(422, "QUESTION_TOO_LONG", "The question must be at most 500 characters");
    }
    const request = buildLiveDraftRequest({
      question,
      baseline: policyBaselineRef(this.baselinePolicy),
    });
    const outcome = await this.modelService.draftLive(request);
    const now = readClock(this.db);
    if (outcome.kind === "error") {
      throw new ApiProblem(503, outcome.code, outcome.message, {
        details: {
          provider: outcome.model.provider,
          model: outcome.model.model,
          attempts: outcome.attempts,
          elapsedMs: outcome.elapsedMs,
        },
        retryAfterSeconds: 30,
      });
    }
    const label = `Live model · ${outcome.model.model} · ${outcome.model.promptVersion}`;
    const draft = buildDraft({
      fixture,
      calendarFixture,
      baselinePolicy: this.baselinePolicy,
      origin: "live",
      label,
      question,
      proposal: outcome.proposal,
      revision: 1,
      parentRevision: null,
      parentDraftDigest: null,
      createdAt: now,
    });
    const scenarioId = this.ids.scenario();
    const sanitized: ReplayDraft = { ...draft, scenarioId, question: null };
    transaction(this.db, () => {
      insertScenario(this.db, {
        scenarioId,
        sessionId,
        fixtureId: draft.fixture.fixtureId,
        mode: "live",
        origin: "live",
        baselinePolicyJson: JSON.stringify(this.baselinePolicy),
        baselinePolicyHash: draft.baseline.policyHash,
        fixtureHash: draft.fixture.fixtureHash,
        policyLabVersion: POLICY_LAB_VERSION,
        currentRevision: draft.revision,
        status: draft.status,
        createdAt: now,
      });
      insertScenarioRevision(this.db, {
        scenario_id: scenarioId,
        revision: draft.revision,
        draft_json: JSON.stringify(sanitized),
        draft_digest: draft.draftDigest,
        confirmation_digest: draft.confirmationDigest,
        created_at: now,
      });
    });
    return {
      ...draft,
      scenarioId,
      model: {
        provider: outcome.model.provider,
        model: outcome.model.model,
        digest: outcome.model.digest,
        promptVersion: outcome.model.promptVersion,
        attempts: outcome.attempts,
        elapsedMs: outcome.elapsedMs,
      },
    };
  }

  editDraft(
    scenarioId: string,
    body: EditScenarioDraftRequest,
    sessionId: string,
  ): ScenarioDraftResponse {
    this.requireSession(scenarioId, sessionId);
    const current = this.loadCurrentDraft(scenarioId);
    const scenario = getScenarioRow(this.db, scenarioId);
    if (scenario === null) {
      throw problem(404, "SCENARIO_NOT_FOUND", `Unknown scenario ${scenarioId}`);
    }
    if (body.expectedRevision !== scenario.current_revision) {
      throw new PolicyLabError(
        "STALE_REVISION",
        `Expected revision ${body.expectedRevision} but the current revision is ${scenario.current_revision}`,
        { expectedRevision: body.expectedRevision, currentRevision: scenario.current_revision },
      );
    }
    const fields = body.fields ?? body.clarificationAnswer;
    if (fields === undefined) {
      throw problem(400, "INVALID_REQUEST", "The edit must provide fields or clarificationAnswer");
    }
    const now = readClock(this.db);
    const edited = editDraft({
      previous: current,
      fixture,
      calendarFixture,
      baselinePolicy: this.baselinePolicy,
      fields,
      createdAt: now,
    });
    const storedDraft: ReplayDraft = { ...edited, scenarioId };
    transaction(this.db, () => {
      insertScenarioRevision(this.db, {
        scenario_id: scenarioId,
        revision: storedDraft.revision,
        draft_json: JSON.stringify(storedDraft),
        draft_digest: storedDraft.draftDigest,
        confirmation_digest: storedDraft.confirmationDigest,
        created_at: now,
      });
      updateScenarioRevision(
        this.db,
        scenarioId,
        storedDraft.revision,
        storedDraft.status,
        storedDraft.origin,
        now,
      );
    });
    return storedDraft;
  }

  startRun(
    scenarioId: string,
    body: StartScenarioRunRequest,
    sessionId: string,
    idempotencyKey: string | undefined,
  ): { accepted: ScenarioRunAccepted; created: boolean } {
    if (idempotencyKey === undefined || idempotencyKey.trim() === "") {
      throw problem(400, "INVALID_REQUEST", "The Idempotency-Key header is required");
    }
    const requestHash = hashJson({
      scenarioId,
      revision: body.revision,
      confirmationDigest: body.confirmationDigest,
    });
    const existing = getScenarioRunRowByIdempotencyKey(this.db, idempotencyKey);
    if (existing !== null) {
      if (existing.request_hash !== requestHash) {
        throw problem(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "This Idempotency-Key was already used with a different run request",
          { runId: existing.run_id },
        );
      }
      return {
        accepted: {
          runId: existing.run_id,
          scenarioId: existing.scenario_id,
          revision: existing.revision,
          confirmationDigest: existing.confirmation_digest,
          status: existing.status.toLowerCase(),
          traceId: existing.run_id,
          acceptedAt: existing.created_at,
        },
        created: false,
      };
    }
    this.requireSession(scenarioId, sessionId);
    const scenario = getScenarioRow(this.db, scenarioId);
    if (scenario === null) {
      throw problem(404, "SCENARIO_NOT_FOUND", `Unknown scenario ${scenarioId}`);
    }
    if (body.revision !== scenario.current_revision) {
      throw new PolicyLabError(
        "STALE_REVISION",
        `Run requested for revision ${body.revision} but the current revision is ${scenario.current_revision}`,
        { requestedRevision: body.revision, currentRevision: scenario.current_revision },
      );
    }
    if (scenario.status !== "proposed") {
      throw new PolicyLabError(
        "INVALID_SCENARIO_STATE",
        `A ${scenario.status} draft cannot be run; confirm a proposed rule change first`,
        { status: scenario.status },
      );
    }
    const revisionRow = getScenarioRevisionRow(this.db, scenarioId, body.revision);
    if (revisionRow === null) {
      throw problem(500, "INTERNAL_ERROR", "Scenario revision projection is missing");
    }
    if (revisionRow.confirmation_digest !== body.confirmationDigest) {
      throw new PolicyLabError(
        "CONFIRMATION_MISMATCH",
        "The confirmation digest does not match the visible revision",
        { expectedDigest: revisionRow.confirmation_digest },
      );
    }
    const now = readClock(this.db);
    const runId = this.ids.run();
    transaction(this.db, () => {
      insertScenarioRun(this.db, {
        runId,
        scenarioId,
        sessionId,
        revision: body.revision,
        confirmationDigest: body.confirmationDigest,
        idempotencyKey,
        requestHash,
        status: "QUEUED",
        createdAt: now,
      });
      enqueueOutbox(this.db, OUTBOX_RUN_SCENARIO, runId, { scenarioId }, now);
    });
    return {
      accepted: {
        runId,
        scenarioId,
        revision: body.revision,
        confirmationDigest: body.confirmationDigest,
        status: "queued",
        traceId: runId,
        acceptedAt: now,
      },
      created: true,
    };
  }

  private requireRun(runId: string, sessionId: string): ScenarioRunRow {
    const run = getScenarioRunRow(this.db, runId);
    if (run === null) {
      throw problem(404, "RUN_NOT_FOUND", `Unknown scenario run ${runId}`, { runId });
    }
    if (run.session_id !== sessionId) {
      throw problem(403, "SESSION_MISMATCH", "The run belongs to a different local session", {
        runId,
      });
    }
    return run;
  }

  getRun(runId: string, sessionId: string): ScenarioRunResponse {
    const run = this.requireRun(runId, sessionId);
    const result =
      run.result_json === null ? null : (JSON.parse(run.result_json) as ScenarioRunResult);
    const error =
      run.error_json === null
        ? null
        : (JSON.parse(run.error_json) as { code: string; message: string });
    return {
      runId: run.run_id,
      scenarioId: run.scenario_id,
      revision: run.revision,
      confirmationDigest: run.confirmation_digest,
      status: run.status.toLowerCase(),
      comparisonDigest: result?.comparisonDigest ?? null,
      packDigest: result?.packDigest ?? null,
      evidencePath: run.status === "SUCCEEDED" ? `/v1/scenario-runs/${run.run_id}/evidence` : null,
      result,
      error,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
    };
  }

  getRunEvidence(runId: string, sessionId: string): { fileName: string; json: string } {
    const run = this.requireRun(runId, sessionId);
    if (run.status !== "SUCCEEDED" || run.evidence_json === null) {
      throw new PolicyLabError(
        "INVALID_SCENARIO_STATE",
        "Evidence is available only for a succeeded comparison run",
        { status: run.status.toLowerCase() },
      );
    }
    return { fileName: `p01-comparison-${run.run_id}.json`, json: run.evidence_json };
  }

  /** Processes one queued run; called by the outbox worker. */
  executeRun(runId: string): void {
    const run = getScenarioRunRow(this.db, runId);
    if (run === null || run.status === "SUCCEEDED") {
      return;
    }
    const now = readClock(this.db);
    updateScenarioRun(this.db, runId, { status: "RUNNING", updatedAt: now });
    const scenario = getScenarioRow(this.db, run.scenario_id);
    const revisionRow = getScenarioRevisionRow(this.db, run.scenario_id, run.revision);
    if (scenario === null || revisionRow === null) {
      updateScenarioRun(this.db, runId, {
        status: "FAILED",
        errorJson: JSON.stringify({
          code: "SCENARIO_PROJECTION_MISSING",
          message: "Scenario or revision projection disappeared before the run",
        }),
        updatedAt: now,
      });
      return;
    }
    try {
      const draft = JSON.parse(revisionRow.draft_json) as ReplayDraft;
      const proposal = draft.proposal;
      if (proposal === null || proposal.status !== "proposed") {
        throw new PolicyLabError("INVALID_SCENARIO_STATE", "The confirmed revision is not runnable");
      }
      const changeResult = applyCutoffChange(this.baselinePolicy, {
        operation: proposal.operation,
        asset: proposal.asset,
        weekday: proposal.weekday,
        timeUtc: proposal.timeUtc,
        timezone: proposal.timezone,
      });
      if (changeResult.kind !== "APPLIED") {
        throw new PolicyLabError(
          "INVALID_SCENARIO_STATE",
          `The confirmed revision produced ${changeResult.kind}`,
        );
      }
      const candidatePolicy = changeResult.policy;
      const comparison = runP01Comparison({
        fixture,
        calendarFixture,
        baselinePolicy: this.baselinePolicy,
        candidatePolicy,
      });
      const boundaryCases = runP01BoundaryCases({
        fixture,
        boundaryFixture,
        calendars: { "LAB-UTC-1": calendarFixture, "LAB-UTC-2": calendar2Fixture },
        baselinePolicy: this.baselinePolicy,
        candidatePolicy,
      });
      const pack = buildP01ComparisonPack({ comparison, boundaryCases, boundaryFixture });
      const result: ScenarioRunResult = {
        comparisonDigest: pack.comparisonDigest,
        packDigest: pack.packDigest,
        engineVersion: ENGINE_VERSION,
        policyLabVersion: POLICY_LAB_VERSION,
        baselinePolicyHash: pack.baselinePolicyHash,
        candidatePolicyHash: pack.candidatePolicyHash,
        fixtureHash: pack.fixtureHash,
        affectedOrders: pack.affectedOrders,
        totalOrders: pack.totalOrders,
        extraReservedAtFridayCloseBase: pack.extraReservedAtFridayCloseBase,
        deltas: pack.deltas,
        orderChanges: pack.orderChanges,
        branches: {
          baseline: { snapshots: pack.branches.baseline.snapshots, orders: pack.branches.baseline.orders },
          candidate: { snapshots: pack.branches.candidate.snapshots, orders: pack.branches.candidate.orders },
        },
        boundarySummary: pack.boundarySummary,
        checks: pack.checks,
      };
      const nowAfter = readClock(this.db);
      updateScenarioRun(this.db, runId, {
        status: "SUCCEEDED",
        resultJson: JSON.stringify(result),
        evidenceJson: serializeP01ComparisonPack(pack),
        errorJson: null,
        updatedAt: nowAfter,
      });
    } catch (error) {
      const code = isPolicyLabError(error) ? error.code : "RUN_FAILED";
      const message = error instanceof Error ? error.message : String(error);
      updateScenarioRun(this.db, runId, {
        status: "FAILED",
        resultJson: null,
        evidenceJson: null,
        errorJson: JSON.stringify({ code, message }),
        updatedAt: readClock(this.db),
      });
    }
  }

  /** Re-queues runs interrupted by a restart so no run stays RUNNING forever. */
  recoverInterruptedRuns(): number {
    const rows = this.db
      .prepare("SELECT run_id, scenario_id FROM scenario_runs WHERE status IN ('RUNNING')")
      .all() as unknown as Array<{ run_id: string; scenario_id: string }>;
    const now = readClock(this.db);
    for (const row of rows) {
      updateScenarioRun(this.db, row.run_id, { status: "QUEUED", updatedAt: now });
      enqueueOutbox(this.db, OUTBOX_RUN_SCENARIO, row.run_id, { scenarioId: row.scenario_id }, now);
    }
    return rows.length;
  }
}
