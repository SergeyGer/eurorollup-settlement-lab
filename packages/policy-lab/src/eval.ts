/**
 * A09 evaluation harness.
 *
 * Runs the 40 versioned prompts through the live local model adapter and records
 * the expected normalized fields or disposition against the observed outcome.
 * Deterministic replay correctness is evaluated separately; this report measures
 * only model drafting accuracy.
 */
import { hashJson, type FundDealingPolicy } from "@eurorollup/dealing";
import { policyBaselineRef } from "./draft.js";
import { LIVE_PROMPT_VERSION } from "./live/prompt.js";
import { draftWithLiveModel } from "./live/live-draft.js";
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MODEL_TIMEOUT_MS,
  type LiveDraftErrorCode,
  type LiveDraftRequest,
  type ModelMetadata,
  type ModelPort,
} from "./live/types.js";
import type { PolicyBaselineRef, Proposal } from "./types.js";

export type EvalCategory = "valid" | "ambiguous" | "unsupported";

export interface EvalExpected {
  readonly status: "proposed" | "clarify" | "unsupported";
  readonly operation?: string;
  readonly asset?: string;
  readonly weekday?: string;
  readonly timeUtc?: string;
  readonly timezone?: string;
  readonly expectedTimeUtc?: string;
  readonly missingFields?: readonly string[];
  readonly acceptableReasonCodes?: readonly string[];
}

export interface EvalPromptFixture {
  readonly promptId: string;
  readonly category: EvalCategory;
  readonly question: string;
  readonly expected: EvalExpected;
}

export interface EvalPromptFixtureFile {
  readonly fixtureId: string;
  readonly fixtureVersion: string;
  readonly description: string;
  readonly baseline: {
    readonly policyId: string;
    readonly version: number;
    readonly weekdayCutoffs: Readonly<Record<string, string>>;
  };
  readonly prompts: readonly EvalPromptFixture[];
}

export interface EvalPromptResult {
  readonly promptId: string;
  readonly category: EvalCategory;
  readonly question: string;
  readonly expected: EvalExpected;
  readonly observedStatus: string | null;
  readonly observedProposal: Proposal | null;
  readonly failure: { readonly code: LiveDraftErrorCode; readonly message: string } | null;
  readonly attempts: number;
  readonly elapsedMs: number;
  readonly pass: boolean;
  readonly failureReason: string | null;
}

export interface EvalThresholds {
  readonly validExactMin: number;
  readonly clarifyMin: number;
  readonly unsupportedMin: number;
}

export const DEFAULT_EVAL_THRESHOLDS: EvalThresholds = {
  validExactMin: 18,
  clarifyMin: 10,
  unsupportedMin: 10,
};

export interface EvalSummary {
  readonly validExact: number;
  readonly validTotal: number;
  readonly clarifyPassed: number;
  readonly clarifyTotal: number;
  readonly unsupportedNonExecutable: number;
  readonly unsupportedTotal: number;
  readonly modelErrors: number;
  readonly thresholds: EvalThresholds;
  readonly thresholdsMet: boolean;
  readonly passed: boolean;
}

export interface EvalReport {
  readonly schemaVersion: "1.0.0";
  readonly reportId: "A09-live-model-eval";
  readonly fixtureId: string;
  readonly fixtureVersion: string;
  readonly generatedBy: string;
  readonly model: ModelMetadata;
  readonly settings: {
    readonly promptVersion: string;
    readonly temperature: number;
    readonly seed: number;
    readonly timeoutMs: number;
    readonly maxAttempts: number;
    readonly numCtx: number | null;
    readonly numPredict: number | null;
    /** Exactness definition: required normalized fields must match; the optional stated-prior-time field is checked for consistency when present. */
    readonly exactness: "required-fields-with-optional-prior-time";
  };
  readonly prompts: readonly EvalPromptResult[];
  readonly summary: EvalSummary;
}

export function buildLiveDraftRequest(params: {
  question: string;
  baseline: PolicyBaselineRef;
}): LiveDraftRequest {
  return {
    question: params.question,
    baseline: params.baseline,
    fixture: {
      fixtureId: "P01",
      fixtureVersion: "1.0.0",
      calendarId: "LAB-UTC-1",
      orders:
        "Two fund subscriptions of EUR 300.00 each: F-1450 received Friday 14:50 UTC and F-1530 received Friday 15:30 UTC.",
      navObservations:
        "Friday NAV 96.00 EUR and Monday NAV 100.00 EUR, each authorized at 17:00 UTC.",
    },
    supportedRule: {
      operation: "set_subscription_cutoff",
      asset: "eFUND",
      weekdays: ["MON", "TUE", "WED", "THU", "FRI"],
      minTimeUtc: "00:01",
      maxTimeUtc: "16:59",
      timezone: "UTC",
      fixedRules: [
        "redemption deadlines",
        "NAV sources",
        "fees",
        "eligibility rules",
      ],
    },
  };
}

function proposedFields(proposal: Proposal): Record<string, unknown> | null {
  if (proposal.status !== "proposed") {
    return null;
  }
  return {
    status: "proposed",
    operation: proposal.operation,
    asset: proposal.asset,
    weekday: proposal.weekday,
    timeUtc: proposal.timeUtc,
    timezone: proposal.timezone,
  };
}

function expectedFields(expected: EvalExpected): Record<string, unknown> {
  return {
    status: "proposed",
    operation: expected.operation,
    asset: expected.asset,
    weekday: expected.weekday,
    timeUtc: expected.timeUtc,
    timezone: expected.timezone,
  };
}

function expectedTimeConsistent(params: {
  fixture: EvalPromptFixture;
  proposal: Proposal;
}): boolean {
  if (params.proposal.status !== "proposed" || params.proposal.expectedTimeUtc === undefined) {
    return true;
  }
  const expectedPrior =
    params.fixture.expected.expectedTimeUtc === undefined
      ? "16:00"
      : params.fixture.expected.expectedTimeUtc;
  return params.proposal.expectedTimeUtc === expectedPrior;
}

function classify(params: {
  fixture: EvalPromptFixture;
  proposal: Proposal;
}): { pass: boolean; failureReason: string | null } {
  const { fixture, proposal } = params;
  if (fixture.category === "valid") {
    const observed = proposedFields(proposal);
    if (observed === null) {
      return {
        pass: false,
        failureReason: `expected proposed, observed ${proposal.status}`,
      };
    }
    const same = hashJson(observed) === hashJson(expectedFields(fixture.expected));
    if (!same) {
      return {
        pass: false,
        failureReason: "normalized fields differ from the expected proposal",
      };
    }
    if (!expectedTimeConsistent({ fixture, proposal })) {
      return {
        pass: false,
        failureReason: "expectedTimeUtc disagrees with the stated prior cutoff",
      };
    }
    return { pass: true, failureReason: null };
  }
  if (fixture.category === "ambiguous") {
    const pass = proposal.status === "clarify";
    return {
      pass,
      failureReason: pass ? null : `expected clarify, observed ${proposal.status}`,
    };
  }
  if (proposal.status !== "unsupported") {
    return {
      pass: false,
      failureReason: `expected unsupported, observed ${proposal.status}`,
    };
  }
  const acceptable = fixture.expected.acceptableReasonCodes;
  if (
    acceptable !== undefined &&
    acceptable.length > 0 &&
    !acceptable.includes(proposal.reasonCode)
  ) {
    return {
      pass: false,
      failureReason: `reasonCode ${proposal.reasonCode} is not in the acceptable set ${acceptable.join(", ")}`,
    };
  }
  return { pass: true, failureReason: null };
}

export interface RunEvaluationParams {
  readonly promptsFixture: EvalPromptFixtureFile;
  readonly baselinePolicy: FundDealingPolicy;
  readonly port: ModelPort;
  readonly portForPrompt?: (prompt: EvalPromptFixture) => ModelPort;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly thresholds?: EvalThresholds;
  readonly generatedBy?: string;
}

export async function runEvaluation(params: RunEvaluationParams): Promise<EvalReport> {
  const baseline = policyBaselineRef(params.baselinePolicy);
  const timeoutMs = params.timeoutMs ?? DEFAULT_MODEL_TIMEOUT_MS;
  const maxAttempts = params.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const thresholds = params.thresholds ?? DEFAULT_EVAL_THRESHOLDS;
  const results: EvalPromptResult[] = [];
  const model = params.port.metadata;

  for (const fixture of params.promptsFixture.prompts) {
    const port = params.portForPrompt?.(fixture) ?? params.port;
    const request = buildLiveDraftRequest({ question: fixture.question, baseline });
    const outcome = await draftWithLiveModel({ request, port, options: { timeoutMs, maxAttempts } });
    if (outcome.kind === "error") {
      results.push({
        promptId: fixture.promptId,
        category: fixture.category,
        question: fixture.question,
        expected: fixture.expected,
        observedStatus: null,
        observedProposal: null,
        failure: { code: outcome.code, message: outcome.message },
        attempts: outcome.attempts,
        elapsedMs: outcome.elapsedMs,
        pass: false,
        failureReason: outcome.message,
      });
      continue;
    }
    const classification = classify({ fixture, proposal: outcome.proposal });
    results.push({
      promptId: fixture.promptId,
      category: fixture.category,
      question: fixture.question,
      expected: fixture.expected,
      observedStatus: outcome.proposal.status,
      observedProposal: outcome.proposal,
      failure: null,
      attempts: outcome.attempts,
      elapsedMs: outcome.elapsedMs,
      pass: classification.pass,
      failureReason: classification.failureReason,
    });
  }

  const valid = results.filter((item) => item.category === "valid");
  const clarify = results.filter((item) => item.category === "ambiguous");
  const unsupported = results.filter((item) => item.category === "unsupported");
  const validExact = valid.filter((item) => item.pass).length;
  const clarifyPassed = clarify.filter((item) => item.pass).length;
  const unsupportedNonExecutable = unsupported.filter((item) => item.pass).length;
  const modelErrors = results.filter((item) => item.failure !== null).length;
  const thresholdsMet =
    validExact >= thresholds.validExactMin &&
    clarifyPassed >= thresholds.clarifyMin &&
    unsupportedNonExecutable >= thresholds.unsupportedMin;
  return {
    schemaVersion: "1.0.0",
    reportId: "A09-live-model-eval",
    fixtureId: params.promptsFixture.fixtureId,
    fixtureVersion: params.promptsFixture.fixtureVersion,
    generatedBy: params.generatedBy ?? "pnpm policy:eval",
    model,
    settings: {
      promptVersion: LIVE_PROMPT_VERSION,
      temperature: model.temperature,
      seed: model.seed,
      timeoutMs,
      maxAttempts,
      numCtx: model.numCtx ?? null,
      numPredict: model.numPredict ?? null,
      exactness: "required-fields-with-optional-prior-time",
    },
    prompts: results,
    summary: {
      validExact,
      validTotal: valid.length,
      clarifyPassed,
      clarifyTotal: clarify.length,
      unsupportedNonExecutable,
      unsupportedTotal: unsupported.length,
      modelErrors,
      thresholds,
      thresholdsMet,
      passed: thresholdsMet,
    },
  };
}

export interface EvaluationVerification {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

/** Structural verification of a committed evaluation report (no model needed). */
export function verifyEvaluationReport(
  report: EvalReport,
  promptsFixture: EvalPromptFixtureFile,
): EvaluationVerification {
  const errors: string[] = [];
  if (report.reportId !== "A09-live-model-eval") {
    errors.push("reportId must be A09-live-model-eval");
  }
  if (report.schemaVersion !== "1.0.0") {
    errors.push("schemaVersion must be 1.0.0");
  }
  if (report.model.provider !== "ollama") {
    errors.push("the committed evaluation must come from the live Ollama adapter");
  }
  if (report.model.model.trim() === "") {
    errors.push("model identifier is required");
  }
  if (report.model.digest === null || report.model.digest.trim() === "") {
    errors.push("pinned model digest is required for the committed evaluation");
  }
  if (report.model.promptVersion !== LIVE_PROMPT_VERSION) {
    errors.push(`prompt version must be ${LIVE_PROMPT_VERSION}`);
  }
  const fixtureIds = promptsFixture.prompts.map((prompt) => prompt.promptId).sort();
  const reportIds = report.prompts.map((prompt) => prompt.promptId).sort();
  if (JSON.stringify(fixtureIds) !== JSON.stringify(reportIds)) {
    errors.push("report prompts do not match the versioned prompt fixture");
  }
  const categories = { valid: 0, ambiguous: 0, unsupported: 0 };
  for (const prompt of report.prompts) {
    categories[prompt.category] += 1;
  }
  if (categories.valid !== 20 || categories.ambiguous !== 10 || categories.unsupported !== 10) {
    errors.push(
      `prompt mix must be 20 valid / 10 ambiguous / 10 unsupported, observed ${categories.valid}/${categories.ambiguous}/${categories.unsupported}`,
    );
  }
  const { summary } = report;
  if (summary.validTotal !== 20 || summary.clarifyTotal !== 10 || summary.unsupportedTotal !== 10) {
    errors.push("summary totals do not match the required prompt mix");
  }
  if (summary.validExact !== report.prompts.filter((item) => item.category === "valid" && item.pass).length) {
    errors.push("validExact does not match the prompt results");
  }
  if (summary.clarifyPassed !== report.prompts.filter((item) => item.category === "ambiguous" && item.pass).length) {
    errors.push("clarifyPassed does not match the prompt results");
  }
  if (
    summary.unsupportedNonExecutable !==
    report.prompts.filter((item) => item.category === "unsupported" && item.pass).length
  ) {
    errors.push("unsupportedNonExecutable does not match the prompt results");
  }
  if (!summary.thresholdsMet) {
    errors.push("the committed evaluation does not meet the A09 thresholds");
  }
  if (!summary.passed) {
    errors.push("the committed evaluation is marked as failed");
  }
  if (summary.validExact < summary.thresholds.validExactMin) {
    errors.push("valid exact drafts below the required threshold");
  }
  if (summary.clarifyPassed < summary.thresholds.clarifyMin) {
    errors.push("clarification responses below the required threshold");
  }
  if (summary.unsupportedNonExecutable < summary.thresholds.unsupportedMin) {
    errors.push("non-executable unsupported responses below the required threshold");
  }
  return { valid: errors.length === 0, errors };
}
