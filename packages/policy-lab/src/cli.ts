#!/usr/bin/env node
/**
 * Policy Lab evidence and local-model runner.
 *
 * Usage:
 *   pnpm policy:replay [--fixture P01] [--check]
 *   pnpm policy:verify [--pack evidence/policy-lab]
 *   pnpm policy:eval [--adapter ollama|mock] [--verify-only]
 *   pnpm policy:record
 *   pnpm policy:model:status
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createBaselinePolicy, hashJson, type CalendarFixture, type P01Scenario } from "@eurorollup/dealing";
import {
  DEFAULT_OLLAMA_MODEL,
  OllamaModelPort,
  LIVE_PROMPT_VERSION,
  ScriptedModelPort,
  buildDraft,
  buildInitialMessages,
  buildLiveDraftRequest,
  buildP01ComparisonPack,
  buildPolicyLabManifest,
  checkOllamaHealth,
  createDraft,
  createOllamaPort,
  draftWithLiveModel,
  evidenceFileRef,
  policyBaselineRef,
  policyFromFixture,
  runEvaluation,
  runP01BoundaryCases,
  runP01Comparison,
  serializeManifest,
  serializeP01ComparisonPack,
  verifyEvaluationReport,
  type EvalPromptFixture,
  type EvalPromptFixtureFile,
  type EvalReport,
  type ModelPort,
  type P01BoundaryFixture,
  type RecordedProposalFixture,
  type ReplayDraft,
} from "./index.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const EVIDENCE_DIR = "evidence/policy-lab";
const PACK_FILE = "p01-comparison.json";
const MANIFEST_FILE = "manifest.json";
const EVAL_FILE = "eval.json";
const LIVE_DRAFT_FILE = "live-model-draft.json";

function readRepoJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(repoRoot, relativePath), "utf8")) as T;
}

function readRepoText(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

function optionValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return argv[index + 1];
}

function writeRepoFile(relativePath: string, text: string): void {
  const absolute = join(repoRoot, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text, "utf8");
  console.log(`  wrote ${relativePath} (${Buffer.byteLength(text, "utf8")} bytes)`);
}

interface FixtureBundle {
  readonly fixture: P01Scenario;
  readonly calendars: Readonly<Record<string, CalendarFixture>>;
  readonly boundaryFixture: P01BoundaryFixture;
  readonly recordedProposal: RecordedProposalFixture;
}

function loadFixtures(): FixtureBundle {
  return {
    fixture: readRepoJson<P01Scenario>("fixtures/p01/scenario.json"),
    calendars: {
      "LAB-UTC-1": readRepoJson<CalendarFixture>("fixtures/calendar/LAB-UTC-1.json"),
      "LAB-UTC-2": readRepoJson<CalendarFixture>("fixtures/calendar/LAB-UTC-2.json"),
    },
    boundaryFixture: readRepoJson<P01BoundaryFixture>("fixtures/policy-lab/p01-boundary.json"),
    recordedProposal: readRepoJson<RecordedProposalFixture>(
      "fixtures/policy-lab/p01-recorded-proposal.json",
    ),
  };
}

interface BuiltPack {
  readonly packText: string;
  readonly manifestText: string;
  readonly digest: string;
  readonly packDigest: string;
  readonly summary: readonly string[];
}

function buildPack(): BuiltPack {
  const bundle = loadFixtures();
  const calendarFixture = bundle.calendars["LAB-UTC-1"];
  if (calendarFixture === undefined) {
    throw new Error("LAB-UTC-1 calendar fixture is missing");
  }
  const baselinePolicy = policyFromFixture(bundle.fixture.baselinePolicy);
  const candidatePolicy = policyFromFixture(bundle.fixture.candidatePolicy);
  const recordedDraft = createDraft({
    fixture: bundle.fixture,
    calendarFixture,
    baselinePolicy,
    input: { fixtureId: "P01", mode: "recorded" },
    recordedProposal: bundle.recordedProposal,
    createdAt: "fixture",
  });
  if (recordedDraft.status !== "proposed" || recordedDraft.diff === null) {
    throw new Error(`Recorded P01 proposal is not runnable: ${recordedDraft.status}`);
  }
  const comparison = runP01Comparison({
    fixture: bundle.fixture,
    calendarFixture,
    baselinePolicy,
    candidatePolicy,
  });
  const boundaryCases = runP01BoundaryCases({
    fixture: bundle.fixture,
    boundaryFixture: bundle.boundaryFixture,
    calendars: bundle.calendars,
    baselinePolicy,
    candidatePolicy,
  });
  const pack = buildP01ComparisonPack({ comparison, boundaryCases, boundaryFixture: bundle.boundaryFixture });
  const packText = serializeP01ComparisonPack(pack);
  const manifest = buildPolicyLabManifest({
    pack,
    files: [evidenceFileRef(PACK_FILE, packText)],
  });
  const manifestText = serializeManifest(manifest);
  return {
    packText,
    manifestText,
    digest: pack.comparisonDigest,
    packDigest: pack.packDigest,
    summary: [
      `P01 branches: baseline ${summaryLine(comparison.baseline.snapshots)}`,
      `P01 branches: candidate ${summaryLine(comparison.candidate.snapshots)}`,
      `orders: ${comparison.totalOrders}, changed dealing date: ${comparison.affectedOrders}, extra reserved at Friday close: ${comparison.extraReservedAtFridayCloseBase}`,
      `boundary cases: ${boundaryCases.filter((item) => item.pass).length}/${boundaryCases.length} pass`,
    ],
  };
}

function summaryLine(
  snapshots: Readonly<Record<string, { spendableBase: string; reservedBase: string; unitsBase: string }>>,
): string {
  const friday = snapshots["fridayClose"];
  return friday === undefined
    ? "no Friday snapshot"
    : `Friday close spendable ${friday.spendableBase}, reserved ${friday.reservedBase}, units ${friday.unitsBase}`;
}

function commandReplay(argv: readonly string[]): number {
  const checkOnly = argv.includes("--check");
  const fixtureId = optionValue(argv, "--fixture") ?? "P01";
  if (fixtureId !== "P01") {
    console.error(`FAIL unsupported fixture ${fixtureId}; release 1.0 supports P01`);
    return 1;
  }
  const built = buildPack();
  console.log("EuroRollup Policy Lab — P01 Friday cutoff comparison");
  for (const line of built.summary) {
    console.log(`  ${line}`);
  }
  console.log(`  comparison digest: ${built.digest}`);
  console.log(`  pack digest:       ${built.packDigest}`);
  let failed = false;
  for (const [file, text] of [
    [PACK_FILE, built.packText],
    [MANIFEST_FILE, built.manifestText],
  ] as const) {
    if (checkOnly) {
      if (!existsSync(join(repoRoot, EVIDENCE_DIR, file))) {
        console.error(`  FAIL ${EVIDENCE_DIR}/${file} is missing`);
        failed = true;
      } else if (readRepoText(`${EVIDENCE_DIR}/${file}`) !== text) {
        console.error(`  FAIL ${EVIDENCE_DIR}/${file} differs from a fresh replay`);
        failed = true;
      } else {
        console.log(`  OK   ${EVIDENCE_DIR}/${file} matches a fresh replay`);
      }
    } else {
      writeRepoFile(`${EVIDENCE_DIR}/${file}`, text);
    }
  }
  return failed ? 1 : 0;
}

function commandVerify(argv: readonly string[]): number {
  const packDirectory = optionValue(argv, "--pack") ?? EVIDENCE_DIR;
  const manifestPath = join(repoRoot, packDirectory, MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    console.error(`FAIL manifest not found at ${packDirectory}/${MANIFEST_FILE}`);
    return 1;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    packId: string;
    packDigest: string;
    comparisonDigest: string;
    files: Array<{ path: string; sha256: string; bytes: number }>;
  };
  console.log(`EuroRollup Policy Lab — verify ${packDirectory} (pack ${manifest.packId})`);
  let firstMismatch: string | null = null;
  for (const file of manifest.files) {
    const absolute = join(repoRoot, packDirectory, file.path);
    if (!existsSync(absolute)) {
      firstMismatch ??= `missing pack file ${file.path}`;
      continue;
    }
    const text = readFileSync(absolute, "utf8");
    if (evidenceFileRef(file.path, text).sha256 !== file.sha256) {
      firstMismatch ??= `file digest mismatch for ${file.path}`;
    }
    if (Buffer.byteLength(text, "utf8") !== file.bytes) {
      firstMismatch ??= `file size mismatch for ${file.path}`;
    }
  }
  const built = buildPack();
  if (readRepoText(`${packDirectory}/${PACK_FILE}`) !== built.packText) {
    firstMismatch ??= `${PACK_FILE} is not byte-identical to a fresh replay`;
  }
  if (manifest.comparisonDigest !== built.digest) {
    firstMismatch ??= "comparison digest differs from a fresh replay";
  }
  if (manifest.packDigest !== built.packDigest) {
    firstMismatch ??= "pack digest differs from a fresh replay";
  }
  if (firstMismatch !== null) {
    console.error(`FAIL ${firstMismatch}`);
    return 1;
  }
  console.log(`OK   ${packDirectory} verified: file digests, comparison digest and replay match`);
  return 0;
}

function expectedProposalText(prompt: EvalPromptFixture): string {
  if (prompt.expected.status === "clarify") {
    return JSON.stringify({
      status: "clarify",
      question: "Which weekday and whole-minute UTC time should apply?",
      missingFields: prompt.expected.missingFields ?? ["weekday"],
    });
  }
  if (prompt.expected.status === "unsupported") {
    return JSON.stringify({
      status: "unsupported",
      reasonCode: prompt.expected.acceptableReasonCodes?.[0] ?? "UNSUPPORTED_OPERATION",
    });
  }
  return JSON.stringify({
    status: "proposed",
    operation: prompt.expected.operation,
    asset: prompt.expected.asset,
    weekday: prompt.expected.weekday,
    timeUtc: prompt.expected.timeUtc,
    timezone: prompt.expected.timezone,
    ...(prompt.expected.expectedTimeUtc === undefined
      ? {}
      : { expectedTimeUtc: prompt.expected.expectedTimeUtc }),
  });
}

async function commandEval(argv: readonly string[]): Promise<number> {
  const verifyOnly = argv.includes("--verify-only");
  const adapter = optionValue(argv, "--adapter") ?? "ollama";
  const promptsFixture = readRepoJson<EvalPromptFixtureFile>("fixtures/policy-lab/eval-prompts.json");
  const baselinePolicy = createBaselinePolicy();
  if (verifyOnly) {
    const absolutePath = join(repoRoot, EVIDENCE_DIR, EVAL_FILE);
    if (!existsSync(absolutePath)) {
      console.error(`FAIL ${EVIDENCE_DIR}/${EVAL_FILE} is missing; run pnpm policy:eval`);
      return 1;
    }
    const report = JSON.parse(readFileSync(absolutePath, "utf8")) as EvalReport;
    const verification = verifyEvaluationReport(report, promptsFixture);
    const { summary } = report;
    console.log("EuroRollup Policy Lab — A09 live-model evaluation (committed report)");
    console.log(
      `  valid ${summary.validExact}/${summary.validTotal} · clarify ${summary.clarifyPassed}/${summary.clarifyTotal} · unsupported ${summary.unsupportedNonExecutable}/${summary.unsupportedTotal}`,
    );
    console.log(
      `  model ${report.model.model} · digest ${report.model.digest ?? "n/a"} · prompt ${report.model.promptVersion} · settings temp ${report.settings.temperature} seed ${report.settings.seed} timeout ${report.settings.timeoutMs}ms attempts ${report.settings.maxAttempts}`,
    );
    if (!verification.valid) {
      console.error(`FAIL ${verification.errors.join("; ")}`);
      return 1;
    }
    console.log("OK   the committed evaluation meets the A09 thresholds and structure");
    return 0;
  }
  let port: ModelPort;
  let portForPrompt: ((prompt: EvalPromptFixture) => ModelPort) | undefined;
  if (adapter === "mock") {
    port = new ScriptedModelPort({ responses: [] });
    portForPrompt = (prompt) =>
      new ScriptedModelPort({
        responses: [{ kind: "text", text: expectedProposalText(prompt) }],
        metadata: {
          provider: "scripted",
          model: "mock-model",
          digest: "mock-digest",
          promptVersion: LIVE_PROMPT_VERSION,
          temperature: 0,
          seed: 0,
          timeoutMs: 5_000,
        },
      });
  } else {
    port = await createOllamaPort({
      baseUrl: process.env["OLLAMA_BASE_URL"],
      model: process.env["OLLAMA_MODEL"] ?? DEFAULT_OLLAMA_MODEL,
      promptVersion: LIVE_PROMPT_VERSION,
      timeoutMs: 15_000,
    });
  }
  console.log(`EuroRollup Policy Lab — A09 live-model evaluation (${adapter})`);
  console.log(`  model: ${port.metadata.model} digest ${port.metadata.digest ?? "n/a"}`);
  if (port instanceof OllamaModelPort) {
    const firstPrompt = promptsFixture.prompts[0];
    const warmUpMs =
      firstPrompt === undefined
        ? await port.warmUp()
        : await port.warmUpMessages(
            buildInitialMessages(
              buildLiveDraftRequest({
                question: firstPrompt.question,
                baseline: policyBaselineRef(baselinePolicy),
              }),
            ),
          );
    console.log(`  warm-up completed in ${warmUpMs} ms (excluded from prompt timings)`);
  }
  const report = await runEvaluation({
    promptsFixture,
    baselinePolicy,
    port,
    ...(portForPrompt === undefined ? {} : { portForPrompt }),
    timeoutMs: 15_000,
    maxAttempts: 2,
  });
  const { summary } = report;
  for (const item of report.prompts) {
    if (!item.pass) {
      console.log(
        `  FAIL ${item.promptId} (${item.category}) ${item.observedStatus ?? item.failure?.code ?? "error"}: ${item.failureReason ?? ""}`,
      );
    }
  }
  console.log(
    `  valid ${summary.validExact}/${summary.validTotal} · clarify ${summary.clarifyPassed}/${summary.clarifyTotal} · unsupported ${summary.unsupportedNonExecutable}/${summary.unsupportedTotal} · model errors ${summary.modelErrors}`,
  );
  console.log(`  thresholds met: ${summary.thresholdsMet}`);
  if (adapter === "mock") {
    const text = `${JSON.stringify(report, null, 2)}\n`;
    writeRepoFile("eval-tmp/mock-eval.json", text);
    return summary.passed ? 0 : 1;
  }
  const verification = verifyEvaluationReport(report, promptsFixture);
  if (!verification.valid) {
    console.error(`WARN ${verification.errors.join("; ")}`);
  }
  writeRepoFile(`${EVIDENCE_DIR}/${EVAL_FILE}`, `${JSON.stringify(report, null, 2)}\n`);
  return summary.passed ? 0 : 1;
}

async function commandRecord(): Promise<number> {
  const bundle = loadFixtures();
  const calendarFixture = bundle.calendars["LAB-UTC-1"];
  if (calendarFixture === undefined) {
    throw new Error("LAB-UTC-1 calendar fixture is missing");
  }
  const baselinePolicy = policyFromFixture(bundle.fixture.baselinePolicy);
  console.log("EuroRollup Policy Lab — capture a genuine live-model proposal");
  const port = await createOllamaPort({
    baseUrl: process.env["OLLAMA_BASE_URL"],
    model: process.env["OLLAMA_MODEL"] ?? DEFAULT_OLLAMA_MODEL,
    promptVersion: LIVE_PROMPT_VERSION,
    timeoutMs: 15_000,
  });
  console.log(`  model: ${port.metadata.model} digest ${port.metadata.digest ?? "n/a"}`);
  await port.warmUp();
  const outcome = await draftWithLiveModel({
    request: buildLiveDraftRequest({
      question: bundle.recordedProposal.question,
      baseline: policyBaselineRef(baselinePolicy),
    }),
    port,
  });
  if (outcome.kind === "error") {
    console.error(`FAIL live capture failed: ${outcome.code} ${outcome.message}`);
    return 1;
  }
  const label = `Recorded live-model proposal (${outcome.model.model}, prompt ${outcome.model.promptVersion})`;
  const draft: ReplayDraft = buildDraft({
    fixture: bundle.fixture,
    calendarFixture,
    baselinePolicy,
    origin: "live",
    label,
    question: bundle.recordedProposal.question,
    proposal: outcome.proposal,
    revision: 1,
    parentRevision: null,
    parentDraftDigest: null,
    createdAt: "fixture",
  });
  const capturedFixture: RecordedProposalFixture = {
    proposalId: "P01-RECORDED-CUTOFF",
    fixtureVersion: "1.0.0",
    label,
    question: bundle.recordedProposal.question,
    proposal: outcome.proposal,
    capture: {
      provider: outcome.model.provider,
      model: outcome.model.model,
      digest: outcome.model.digest,
      promptVersion: outcome.model.promptVersion,
      temperature: outcome.model.temperature,
      seed: outcome.model.seed,
      attempts: outcome.attempts,
      elapsedMs: outcome.elapsedMs,
      rawOutput: outcome.rawOutput,
      capturedBy: "pnpm policy:record",
    },
  };
  writeRepoFile(
    "fixtures/policy-lab/p01-recorded-proposal.json",
    `${JSON.stringify(capturedFixture, null, 2)}\n`,
  );
  const capturedEvidence = {
    schemaVersion: "1.0.0",
    reportId: "A09-recorded-live-draft",
    generatedBy: "pnpm policy:record",
    origin: "live",
    model: outcome.model,
    question: bundle.recordedProposal.question,
    proposal: outcome.proposal,
    proposalStatus: outcome.proposal.status,
    draftDigest: draft.draftDigest,
    confirmationDigest: draft.confirmationDigest,
    attempts: outcome.attempts,
    elapsedMs: outcome.elapsedMs,
    rawOutput: outcome.rawOutput,
  };
  writeRepoFile(`${EVIDENCE_DIR}/${LIVE_DRAFT_FILE}`, `${JSON.stringify(capturedEvidence, null, 2)}\n`);
  console.log(`  proposal: ${JSON.stringify(outcome.proposal)}`);
  console.log(`  draft digest ${draft.draftDigest}`);
  return 0;
}

async function commandModelStatus(): Promise<number> {
  const health = await checkOllamaHealth({
    baseUrl: process.env["OLLAMA_BASE_URL"],
    model: process.env["OLLAMA_MODEL"] ?? DEFAULT_OLLAMA_MODEL,
  });
  console.log("EuroRollup Policy Lab — local model status");
  console.log(JSON.stringify({ ...health, promptVersion: LIVE_PROMPT_VERSION }, null, 2));
  if (!health.available) {
    console.error("FAIL the local model runtime is not reachable; start it with `ollama serve` and run `ollama pull <model>`");
    return 1;
  }
  return 0;
}

async function run(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "replay":
      return commandReplay(rest);
    case "verify":
      return commandVerify(rest);
    case "eval":
      return commandEval(rest);
    case "record":
      return commandRecord();
    case "model-status":
      return commandModelStatus();
    default:
      console.error(
        [
          "Usage:",
          "  tsx packages/policy-lab/src/cli.ts replay [--fixture P01] [--check]",
          "  tsx packages/policy-lab/src/cli.ts verify [--pack evidence/policy-lab]",
          "  tsx packages/policy-lab/src/cli.ts eval [--adapter ollama|mock] [--verify-only]",
          "  tsx packages/policy-lab/src/cli.ts record",
          "  tsx packages/policy-lab/src/cli.ts model-status",
        ].join("\n"),
      );
      return 2;
  }
}

run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
