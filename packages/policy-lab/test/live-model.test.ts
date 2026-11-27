/**
 * Live adapter contract tests: structured output, one retry with schema feedback,
 * timeout/unavailable fallback behaviour and the A09 evaluation harness.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createBaselinePolicy } from "@eurorollup/dealing";
import {
  LIVE_PROMPT_VERSION,
  ScriptedModelPort,
  buildLiveDraftRequest,
  draftWithLiveModel,
  parseProposalText,
  policyBaselineRef,
  runEvaluation,
  verifyEvaluationReport,
  type EvalPromptFixture,
  type EvalPromptFixtureFile,
  type EvalReport,
  type ModelPort,
} from "../src/index.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const promptsFixture = JSON.parse(
  readFileSync(`${repoRoot}fixtures/policy-lab/eval-prompts.json`, "utf8"),
) as EvalPromptFixtureFile;
const baselinePolicy = createBaselinePolicy();

const VALID = JSON.stringify({
  status: "proposed",
  operation: "set_subscription_cutoff",
  asset: "eFUND",
  weekday: "FRI",
  timeUtc: "15:00",
  timezone: "UTC",
});

function scriptedPort(responses: ConstructorParameters<typeof ScriptedModelPort>[0]["responses"]): ScriptedModelPort {
  return new ScriptedModelPort({
    responses,
    metadata: {
      provider: "scripted",
      model: "scripted-small-model",
      digest: "scripted-digest",
      promptVersion: "test-prompt",
      temperature: 0,
      seed: 42,
      timeoutMs: 15_000,
    },
  });
}

function request(question = "Move the Friday cutoff to 15:00 UTC.") {
  return buildLiveDraftRequest({
    question,
    baseline: policyBaselineRef(baselinePolicy),
  });
}

describe("proposal text parsing", () => {
  it("parses plain JSON and removes the reasoning field", () => {
    const withReason = '{"reason":"Because the user asked for Friday 15:00.","status":"proposed","operation":"set_subscription_cutoff","asset":"eFUND","weekday":"FRI","timeUtc":"15:00","timezone":"UTC"}';
    const parsed = parseProposalText(withReason);
    expect(parsed.ok).toBe(true);
    expect(parsed.proposal).toEqual({
      status: "proposed",
      operation: "set_subscription_cutoff",
      asset: "eFUND",
      weekday: "FRI",
      timeUtc: "15:00",
      timezone: "UTC",
    });
  });

  it("tolerates a code fence but rejects extra properties", () => {
    const fenced = `\`\`\`json\n${VALID}\n\`\`\``;
    expect(parseProposalText(fenced).ok).toBe(true);
    const extra = parseProposalText(
      '{"status":"proposed","operation":"set_subscription_cutoff","asset":"eFUND","weekday":"FRI","timeUtc":"15:00","timezone":"UTC","executable":"rm -rf /"}',
    );
    expect(extra.ok).toBe(false);
  });

  it("rejects prose without a JSON object", () => {
    expect(parseProposalText("I think the cutoff should move to 15:00.").ok).toBe(false);
  });
});

describe("draftWithLiveModel", () => {
  it("returns a valid proposal on the first attempt", async () => {
    const port = scriptedPort([{ kind: "text", text: VALID }]);
    const outcome = await draftWithLiveModel({ request: request(), port });
    expect(outcome.kind).toBe("draft");
    if (outcome.kind === "draft") {
      expect(outcome.attempts).toBe(1);
      expect(outcome.proposal.status).toBe("proposed");
      expect(outcome.model.model).toBe("scripted-small-model");
    }
  });

  it("retries malformed output once with schema feedback", async () => {
    const port = scriptedPort([
      { kind: "text", text: '{"status":"proposed","asset":"eFUND"}' },
      { kind: "text", text: VALID },
    ]);
    const outcome = await draftWithLiveModel({ request: request(), port });
    expect(outcome.kind).toBe("draft");
    if (outcome.kind === "draft") {
      expect(outcome.attempts).toBe(2);
    }
    expect(port.calls).toBe(2);
  });

  it("returns MODEL_OUTPUT_INVALID after two malformed attempts", async () => {
    const port = scriptedPort([
      { kind: "text", text: "not json" },
      { kind: "text", text: '{"status":"proposed"}' },
    ]);
    const outcome = await draftWithLiveModel({ request: request(), port });
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.code).toBe("MODEL_OUTPUT_INVALID");
      expect(outcome.validationErrors?.length ?? 0).toBeGreaterThan(0);
      expect(outcome.rawOutput).toBeDefined();
    }
  });

  it("retries a timeout once and then reports MODEL_TIMEOUT", async () => {
    const port = scriptedPort([{ kind: "timeout" }, { kind: "timeout" }]);
    const outcome = await draftWithLiveModel({ request: request(), port });
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.code).toBe("MODEL_TIMEOUT");
      expect(outcome.attempts).toBe(2);
    }
  });

  it("succeeds on the retry after a timeout", async () => {
    const port = scriptedPort([{ kind: "timeout" }, { kind: "text", text: VALID }]);
    const outcome = await draftWithLiveModel({ request: request(), port });
    expect(outcome.kind).toBe("draft");
    if (outcome.kind === "draft") {
      expect(outcome.attempts).toBe(2);
    }
  });

  it("reports MODEL_UNAVAILABLE without falling back to a preset", async () => {
    const port = scriptedPort([{ kind: "unavailable" }]);
    const outcome = await draftWithLiveModel({ request: request(), port });
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.code).toBe("MODEL_UNAVAILABLE");
      expect(outcome.attempts).toBe(1);
    }
    expect(port.calls).toBe(1);
  });
});

describe("A09 evaluation harness", () => {
  it("loads the versioned 40-prompt fixture with the required mix", () => {
    expect(promptsFixture.prompts).toHaveLength(40);
    const counts = { valid: 0, ambiguous: 0, unsupported: 0 };
    for (const prompt of promptsFixture.prompts) {
      counts[prompt.category] += 1;
    }
    expect(counts).toEqual({ valid: 20, ambiguous: 10, unsupported: 10 });
    expect(promptsFixture.baseline.version).toBe(1);
    expect(promptsFixture.baseline.weekdayCutoffs["FRI"]).toBe("16:00");
  });

  it("classifies a perfect scripted model as a passing evaluation", async () => {
    const report = await runEvaluation({
      promptsFixture,
      baselinePolicy,
      port: scriptedPort([]),
      portForPrompt: (prompt: EvalPromptFixture): ModelPort =>
        scriptedPort([
          {
            kind: "text",
            text:
              prompt.expected.status === "clarify"
                ? JSON.stringify({
                    status: "clarify",
                    question: "Which weekday and which UTC time?",
                    missingFields: prompt.expected.missingFields ?? ["weekday"],
                  })
                : prompt.expected.status === "unsupported"
                  ? JSON.stringify({
                      status: "unsupported",
                      reasonCode: prompt.expected.acceptableReasonCodes?.[0] ?? "UNSUPPORTED_OPERATION",
                    })
                  : JSON.stringify({
                      status: "proposed",
                      operation: prompt.expected.operation,
                      asset: prompt.expected.asset,
                      weekday: prompt.expected.weekday,
                      timeUtc: prompt.expected.timeUtc,
                      timezone: prompt.expected.timezone,
                      ...(prompt.expected.expectedTimeUtc === undefined
                        ? {}
                        : { expectedTimeUtc: prompt.expected.expectedTimeUtc }),
                    }),
          },
        ]),
    });
    expect(report.summary.validExact).toBe(20);
    expect(report.summary.clarifyPassed).toBe(10);
    expect(report.summary.unsupportedNonExecutable).toBe(10);
    expect(report.summary.passed).toBe(true);
    expect(report.model.model).toBe("scripted-small-model");
  });

  it("fails the evaluation when the model drifts to proposed for everything", async () => {
    const report = await runEvaluation({
      promptsFixture,
      baselinePolicy,
      port: scriptedPort([]),
      portForPrompt: () =>
        scriptedPort([
          {
            kind: "text",
            text: JSON.stringify({
              status: "proposed",
              operation: "set_subscription_cutoff",
              asset: "eFUND",
              weekday: "FRI",
              timeUtc: "15:00",
              timezone: "UTC",
            }),
          },
        ]),
    });
    expect(report.summary.validExact).toBeLessThan(report.summary.thresholds.validExactMin);
    expect(report.summary.clarifyPassed).toBe(0);
    expect(report.summary.unsupportedNonExecutable).toBe(0);
    expect(report.summary.passed).toBe(false);
    expect(report.prompts.filter((item) => !item.pass).length).toBeGreaterThan(30);
  });

  it("verifies the structure of a committed report and rejects a non-ollama one", async () => {
    const mockReport: EvalReport = {
      schemaVersion: "1.0.0",
      reportId: "A09-live-model-eval",
      fixtureId: promptsFixture.fixtureId,
      fixtureVersion: promptsFixture.fixtureVersion,
      generatedBy: "test",
      model: {
        provider: "ollama",
        model: "qwen2.5:1.5b",
        digest: "abc",
        promptVersion: LIVE_PROMPT_VERSION,
        temperature: 0,
        seed: 42,
        timeoutMs: 15_000,
      },
      settings: {
        promptVersion: LIVE_PROMPT_VERSION,
        temperature: 0,
        seed: 42,
        timeoutMs: 15_000,
        maxAttempts: 2,
        numCtx: 4096,
        numPredict: 200,
        exactness: "required-fields-with-optional-prior-time",
      },
      prompts: promptsFixture.prompts.map((prompt) => ({
        promptId: prompt.promptId,
        category: prompt.category,
        question: prompt.question,
        expected: prompt.expected,
        observedStatus: prompt.category === "valid" ? "proposed" : prompt.expected.status,
        observedProposal: null,
        failure: null,
        attempts: 1,
        elapsedMs: 1,
        pass: true,
        failureReason: null,
      })),
      summary: {
        validExact: 20,
        validTotal: 20,
        clarifyPassed: 10,
        clarifyTotal: 10,
        unsupportedNonExecutable: 10,
        unsupportedTotal: 10,
        modelErrors: 0,
        thresholds: { validExactMin: 18, clarifyMin: 10, unsupportedMin: 10 },
        thresholdsMet: true,
        passed: true,
      },
    };
    expect(verifyEvaluationReport(mockReport, promptsFixture).valid).toBe(true);

    const wrongProvider = { ...mockReport, model: { ...mockReport.model, provider: "scripted" as const } };
    const verification = verifyEvaluationReport(wrongProvider, promptsFixture);
    expect(verification.valid).toBe(false);
    expect(verification.errors.some((error) => error.includes("live Ollama"))).toBe(true);
  });
});
