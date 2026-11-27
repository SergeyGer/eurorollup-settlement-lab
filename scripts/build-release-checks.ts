/**
 * Release gate verification (S08).
 *
 * Runs the repository verification commands, validates each committed evidence
 * pack against its versioned JSON Schema, records SHA-256 digests and assembles
 * the per-gate matrix A01-A09 into `evidence/release-checks.json`.
 *
 * A gate passes only when its commands exit zero and its evidence packs validate.
 * A gate may pass with recorded limitations when the evidence honestly reports an
 * unmet observation (for example the execution-only local L1 in A05); those
 * limitations are carried into the release checks instead of being hidden. A08
 * (public release, clean-browser replay, downloadable pack and film) stays
 * pending until the S09/S10 artifacts exist.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, hostname, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import Ajv2020 from "ajv/dist/2020.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceRoot = join(repoRoot, "evidence");
const generatedAt = new Date().toISOString();

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(join(repoRoot, path), "utf8"));
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(join(repoRoot, path))).digest("hex");
}

interface CommandSpec {
  readonly id: string;
  readonly command: string;
  readonly timeoutMs: number;
}

const a08EvidencePath = "evidence/a08/public-release.json";
const a08EvidenceExists = existsSync(join(repoRoot, a08EvidencePath));
const filmMetadataPath = "media/film/film-metadata.json";
const filmComplete = (() => {
  if (!existsSync(join(repoRoot, filmMetadataPath))) return false;
  const metadata = readJson(filmMetadataPath) as Record<string, unknown>;
  return metadata["passed"] === true;
})();

const COMMANDS: readonly CommandSpec[] = [
  { id: "typecheck", command: "pnpm typecheck", timeoutMs: 600_000 },
  { id: "tests", command: "pnpm test", timeoutMs: 600_000 },
  { id: "build", command: "pnpm build", timeoutMs: 600_000 },
  { id: "golden", command: "pnpm scenario:golden -- --check", timeoutMs: 300_000 },
  { id: "boundary", command: "pnpm scenario:boundary -- --check", timeoutMs: 300_000 },
  { id: "api-evidence", command: "pnpm scenario:api -- --check", timeoutMs: 300_000 },
  { id: "policy-replay", command: "pnpm policy:replay -- --check", timeoutMs: 300_000 },
  { id: "policy-verify", command: "pnpm policy:verify", timeoutMs: 300_000 },
  { id: "policy-eval-mock", command: "pnpm policy:eval -- --adapter mock", timeoutMs: 300_000 },
  { id: "policy-eval-committed", command: "pnpm policy:eval -- --verify-only", timeoutMs: 300_000 },
  { id: "eligibility-matrix", command: "pnpm eligibility:matrix -- --check", timeoutMs: 300_000 },
  { id: "eligibility-verify", command: "pnpm eligibility:verify", timeoutMs: 300_000 },
  { id: "aa-verify", command: "pnpm aa:verify", timeoutMs: 300_000 },
  { id: "a05-verify", command: "pnpm a05:verify", timeoutMs: 300_000 },
  { id: "a07-verify", command: "pnpm a07:verify", timeoutMs: 300_000 },
  { id: "openapi", command: "pnpm api:openapi -- --check", timeoutMs: 300_000 },
  { id: "pack-verify", command: "pnpm verify", timeoutMs: 300_000 },
  { id: "partner-demo", command: "pnpm demo:partner", timeoutMs: 300_000 },
  ...(a08EvidenceExists ? [{ id: "a08-verify", command: "pnpm a08:verify", timeoutMs: 300_000 }] : []),
];

interface CommandResult {
  readonly id: string;
  readonly command: string;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly outputTail: string;
}

function runCommand(spec: CommandSpec): CommandResult {
  const args = spec.command.split(/\s+/);
  const binary = args[0]!;
  const started = Date.now();
  const result = spawnSync(binary, args.slice(1), {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: spec.timeoutMs,
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
  const durationMs = Date.now() - started;
  const output = [result.stdout ?? "", result.stderr ?? ""].join("\n");
  const outputTail = output.length > 2_000 ? output.slice(-2_000) : output;
  return {
    id: spec.id,
    command: spec.command,
    exitCode: result.status ?? (result.error === undefined ? 1 : 124),
    durationMs,
    outputTail,
  };
}

interface EvidenceSpec {
  readonly path: string;
  readonly schema: string | null;
  readonly description: string;
}

interface GateSpec {
  readonly gate: string;
  readonly title: string;
  readonly evidence: readonly EvidenceSpec[];
  readonly commands: readonly string[];
  readonly pending?: string;
}

const GATES: readonly GateSpec[] = [
  {
    gate: "A01",
    title: "Portfolio replay",
    evidence: [
      { path: "evidence/g01/golden-run.json", schema: "schemas/golden-run.schema.json", description: "G01 and G01-R golden run" },
      { path: "evidence/g01/manifest.json", schema: "schemas/evidence-manifest.schema.json", description: "G01 evidence manifest" },
    ],
    commands: ["golden", "pack-verify"],
  },
  {
    gate: "A02",
    title: "NAV and dealing boundaries",
    evidence: [
      { path: "evidence/a02/dealing-cases.json", schema: "schemas/dealing-cases.schema.json", description: "Boundary dealing cases" },
      { path: "evidence/a02/api-dealing-cases.json", schema: "schemas/api-dealing-cases.schema.json", description: "API dealing cases" },
    ],
    commands: ["boundary", "api-evidence"],
  },
  {
    gate: "A03",
    title: "Eligibility and policy matrix",
    evidence: [
      { path: "evidence/a03/policy-matrix.json", schema: "schemas/eligibility-policy-matrix.schema.json", description: "Three-persona policy matrix" },
      { path: "evidence/a03/proof-vectors.json", schema: "schemas/eligibility-proof-vectors.schema.json", description: "Positive and negative proof vectors" },
      { path: "evidence/a03/browser-proving.json", schema: null, description: "Browser proving measurement" },
    ],
    commands: ["eligibility-matrix", "eligibility-verify"],
  },
  {
    gate: "A04",
    title: "Account abstraction receipts",
    evidence: [{ path: "evidence/a04/aa-receipts.json", schema: "schemas/aa-receipts.schema.json", description: "Sponsored, included-failure and exhausted-sponsor receipts" }],
    commands: ["aa-verify"],
  },
  {
    gate: "A05",
    title: "Chain batch publication and withdrawal",
    evidence: [
      { path: "evidence/a05/protocol-run.json", schema: "schemas/a05-protocol-run.schema.json", description: "Protocol run with batch publication" },
      { path: "evidence/a05/bridge-trace.json", schema: "schemas/a05-bridge-trace.schema.json", description: "Canonical withdrawal prove/resolve/finalize" },
    ],
    commands: ["a05-verify"],
  },
  {
    gate: "A06",
    title: "Accounting invariants",
    evidence: [{ path: "evidence/a06/invariants.json", schema: "schemas/invariants.schema.json", description: "Duplicate, concurrent, restart and replaced-event invariants" }],
    commands: ["api-evidence"],
  },
  {
    gate: "A07",
    title: "Economics and operations",
    evidence: [
      { path: "evidence/a07/bundle-reconciliation.json", schema: "schemas/a07-bundle-reconciliation.schema.json", description: "Measured bundle reconciliation in wei" },
      { path: "benchmarks/cost-experiment.json", schema: "schemas/a07-cost-experiment.schema.json", description: "Cost experiment scenarios" },
      { path: "benchmarks/rpc-failover.json", schema: null, description: "RPC failover drill" },
      { path: "benchmarks/batch-publication-drill.json", schema: null, description: "Batch publication pause/restore drill" },
      { path: "benchmarks/indexer-restore.json", schema: null, description: "Indexer restore drill" },
      { path: "benchmarks/nav-source-drill.json", schema: null, description: "Delayed NAV drill" },
      { path: "benchmarks/performance.json", schema: null, description: "Performance publication" },
      { path: "benchmarks/operations-dashboard.json", schema: null, description: "Operating dashboard snapshot" },
      { path: "benchmarks/provider-evaluation.json", schema: null, description: "Provider evaluation" },
      { path: "benchmarks/incident-report.json", schema: null, description: "Incident postmortem" },
    ],
    commands: ["a07-verify"],
  },
  {
    gate: "A08",
    title: "Public release",
    evidence: [],
    commands: [],
    pending: "Awaiting S09 (public replay URL, clean-browser replay and downloadable pack) and S10 (60-second film).",
  },
  {
    gate: "A09",
    title: "AI Policy Lab",
    evidence: [
      { path: "evidence/policy-lab/p01-comparison.json", schema: "schemas/p01-comparison.schema.json", description: "P01 two-branch comparison" },
      { path: "evidence/policy-lab/eval.json", schema: null, description: "40-prompt evaluation" },
      { path: "evidence/policy-lab/live-model-draft.json", schema: null, description: "Recorded live model draft" },
      { path: "evidence/policy-lab/manifest.json", schema: null, description: "Policy Lab manifest" },
    ],
    commands: ["policy-replay", "policy-verify", "policy-eval-mock", "policy-eval-committed"],
  },
];

const ajvDraft7 = new Ajv({ strict: false, allErrors: true, logger: false });
const ajv2020 = new Ajv2020({ strict: false, allErrors: true, logger: false });

interface EvidenceCheck {
  readonly path: string;
  readonly description: string;
  readonly exists: boolean;
  readonly sha256: string | null;
  readonly bytes: number | null;
  readonly schema: string | null;
  readonly schemaValid: boolean;
  readonly schemaErrors: readonly string[];
}

function validateEvidence(spec: EvidenceSpec): EvidenceCheck {
  const absolute = join(repoRoot, spec.path);
  const exists = existsSync(absolute);
  if (!exists) {
    return { path: spec.path, description: spec.description, exists: false, sha256: null, bytes: null, schema: spec.schema, schemaValid: false, schemaErrors: ["file is missing"] };
  }
  const bytes = readFileSync(absolute).length;
  const sha256 = sha256File(spec.path);
  if (spec.schema === null) {
    return { path: spec.path, description: spec.description, exists: true, sha256, bytes, schema: null, schemaValid: true, schemaErrors: [] };
  }
  const schemaDocument = readJson(spec.schema) as Record<string, unknown>;
  const uses2020 = String(schemaDocument["$schema"] ?? "").includes("2020-12");
  const validate = (uses2020 ? ajv2020 : ajvDraft7).compile(schemaDocument as object);
  const payload = readJson(spec.path);
  const valid = validate(payload) === true;
  const schemaErrors = valid ? [] : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ""}`.trim());
  return { path: spec.path, description: spec.description, exists: true, sha256, bytes, schema: spec.schema, schemaValid: valid, schemaErrors };
}

function a05Limitations(): { limitations: string[]; missedTargets: Array<Record<string, unknown>> } {
  const protocol = readJson("evidence/a05/protocol-run.json") as Record<string, any>;
  const limitations: string[] = [];
  const missedTargets: Array<Record<string, unknown>> = [];
  if (protocol["summary"]["blobDataAvailability"] === false) {
    limitations.push("Blob data availability is not demonstrated: the execution-only local L1 posts calldata batches (documented development mode).");
    missedTargets.push({
      target: "blob batch publication (EIP-4844)",
      actual: "calldata batch publication demonstrated",
      cause: "the controlled local lane has no L1 consensus client or beacon API, and the pinned consensus-backed Kurtosis lane is blocked by an upstream image/genesis mismatch",
      followUp: "resolve the consensus-backed lane and re-capture A05 with blob batches",
    });
  }
  if (protocol["summary"]["l1FinalityObserved"] === false || protocol["chains"]["l1"]["finalityAvailable"] === false) {
    limitations.push("L1 consensus finality is not modelled: the local L1 is execution-only and exposes only head advancement.");
    missedTargets.push({
      target: "L1 safe/finalized head observations",
      actual: "L2 safe/finalized heads recorded from op-node; L1 head recorded",
      cause: "no L1 consensus client on the controlled local lane",
      followUp: "record L1 safe/finalized heads on the consensus-backed lane",
    });
  }
  return { limitations, missedTargets };
}

function a07Details(): Record<string, unknown> {
  const batch = readJson("benchmarks/batch-publication-drill.json") as Record<string, any>;
  const performance = readJson("benchmarks/performance.json") as Record<string, any>;
  const provider = readJson("benchmarks/provider-evaluation.json") as Record<string, any>;
  const bundle = readJson("evidence/a07/bundle-reconciliation.json") as Record<string, any>;
  return {
    bundle: {
      outerTxHash: bundle["bundle"]["outerTxHash"],
      sponsorPaidWei: bundle["bundle"]["sponsorPaidWei"],
      allocationsReproduceTotal: bundle["reconciliation"]["invariants"]["allocationsPlusResidualEqualsTotal"],
      unavailable: bundle["unavailable"],
    },
    batchPublication: {
      finalityDelayed: batch["finalityDelayed"],
      pausedHeadPreserved: batch["pausedHeadPreserved"],
      backlogClearanceMs: batch["restore"]["backlogClearanceMs"],
      missedTargets: batch["missedTargets"],
    },
    performance: {
      apiReadsP95Ms: performance["apiReads"]["p95Ms"],
      proofP95Ms: performance["proofGenerations"]["p95Ms"],
      passed: performance["passed"],
    },
    providerEvaluation: {
      profiles: (provider["profiles"] as Array<Record<string, unknown>>).map((profile) => profile["profileId"]),
      unknowns: provider["unknowns"],
    },
  };
}

function main(): void {
  console.log("running release verification commands");
  const gateSpecs = GATES.map((gate) =>
    gate.gate === "A08" && a08EvidenceExists
      ? {
          ...gate,
          ...(filmComplete ? { pending: undefined } : {}),
          evidence: [
            { path: a08EvidencePath, schema: "schemas/a08-public-release.schema.json", description: "Public replay, clean-browser, quickstart, public links, downloadable package and film-completion verification" },
            ...(filmComplete
              ? [{ path: filmMetadataPath, schema: "schemas/film-metadata.schema.json", description: "60-second film frame, audio, caption and link-check metadata" }]
              : []),
          ],
          commands: ["a08-verify"],
        }
      : gate,
  );
  const commandResults = new Map<string, CommandResult>();
  for (const spec of COMMANDS) {
    const result = runCommand(spec);
    commandResults.set(spec.id, result);
    console.log(`  ${result.exitCode === 0 ? "PASS" : "FAIL"} ${spec.id} (${String(result.durationMs)} ms)`);
  }

  const gates: Array<Record<string, unknown>> = [];
  const allLimitations: string[] = [];
  const allMissedTargets: Array<Record<string, unknown>> = [];
  for (const gate of gateSpecs) {
    const evidenceChecks = gate.evidence.map(validateEvidence);
    const commandChecks = gate.commands.map((id) => commandResults.get(id) ?? { id });
    const commandsPass = commandChecks.every((check) => "exitCode" in check && (check as CommandResult).exitCode === 0);
    const commandOutputs = commandChecks.map((check) =>
      "exitCode" in check
        ? {
            id: (check as CommandResult).id,
            command: (check as CommandResult).command,
            exitCode: (check as CommandResult).exitCode,
            durationMs: (check as CommandResult).durationMs,
          }
        : { id: (check as { id: string }).id, exitCode: null },
    );
    const evidenceOk = evidenceChecks.every((check) => check.exists && check.schemaValid);
    let limitations: string[] = [];
    let missedTargets: Array<Record<string, unknown>> = [];
    if (gate.gate === "A05") {
      const details = a05Limitations();
      limitations = details.limitations;
      missedTargets = details.missedTargets;
      allMissedTargets.push(...details.missedTargets);
    }
    allLimitations.push(...limitations);
    const isPendingGate = gate.pending !== undefined && !(gate.gate === "A08" && filmComplete);
    const pendingChecksPassed = isPendingGate ? evidenceOk && commandsPass : null;
    const status =
      isPendingGate
        ? pendingChecksPassed === true
          ? "pending"
          : "fail"
        : commandsPass && evidenceOk
          ? limitations.length > 0
            ? "pass_with_recorded_limitations"
            : "pass"
          : "fail";
    if (status === "fail") {
      for (const check of evidenceChecks) {
        if (!check.exists) console.error(`  missing evidence: ${check.path}`);
        else if (!check.schemaValid) console.error(`  schema failure: ${check.path}: ${check.schemaErrors.join("; ")}`);
      }
      for (const check of commandOutputs) {
        if (check.exitCode !== 0) console.error(`  command failure: ${check.id}`);
      }
    }
    gates.push({
      gate: gate.gate,
      title: gate.title,
      status,
      ...(gate.pending === undefined || (gate.gate === "A08" && filmComplete) ? {} : { pendingReason: gate.pending, requiredArtifacts: ["public replay URL verified signed out", "clean-browser replay check", "downloadable evidence pack", "60-second film with frame and narration checks"] }),
      commands: commandOutputs,
      evidence: evidenceChecks,
      evidenceValid: evidenceOk,
      pendingChecksPassed,
      limitations,
      missedTargets,
    });
  }

  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  const statusCounts = gates.reduce<Record<string, number>>((counts, gate) => {
    const status = String(gate["status"]);
    counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }, {});
  const failedGates = gates.filter((gate) => gate["status"] === "fail").map((gate) => gate["gate"]);
  const evidenceDigests = gates
    .flatMap((gate) => (gate["evidence"] as EvidenceCheck[]).map((check) => ({ gate: gate["gate"], path: check.path, sha256: check.sha256, bytes: check.bytes })))
    .filter((entry) => entry.sha256 !== null);
  const checks = {
    schemaVersion: "1.0.0",
    reportId: "S08-release-checks",
    packId: "S08-verification",
    generatedBy: "pnpm release:checks",
    generatedAt,
    commit,
    branch,
    environment: {
      hostname: hostname(),
      platform: platform(),
      nodeVersion: process.version,
      cpuModel: cpus()[0]?.model ?? "unknown",
      cpuCount: cpus().length,
    },
    gates,
    summary: {
      totalGates: gates.length,
      pass: statusCounts["pass"] ?? 0,
      passWithRecordedLimitations: statusCounts["pass_with_recorded_limitations"] ?? 0,
      pending: statusCounts["pending"] ?? 0,
      failed: statusCounts["fail"] ?? 0,
      failedGates,
      releaseCandidate: failedGates.length === 0 && gates.every((gate) => gate["status"] !== "pending" || gate["gate"] === "A08"),
      pendingGates: gates.filter((gate) => gate["status"] === "pending").map((gate) => gate["gate"]),
    },
    commands: [...commandResults.values()],
    evidenceDigests,
    limitations: [...new Set(allLimitations)],
    missedTargets: allMissedTargets,
    a07Details: a07Details(),
    notes: [
      "A gate passes only when its commands exit zero and every evidence pack validates against its versioned JSON Schema.",
      "A gate may pass with recorded limitations when the evidence honestly reports an unmet observation; the limitation and a follow-up are kept in this file.",
      "A08 stays pending until the public replay, downloadable pack and film exist in S09/S10.",
      "The recorded commit is the source commit the checks were generated from; CI re-runs every verification command on the merged commit, and this file is attached to the release tag.",
    ],
  };

  mkdirSync(evidenceRoot, { recursive: true });
  writeFileSync(join(evidenceRoot, "release-checks.json"), `${JSON.stringify(checks, null, 2)}\n`);
  console.log(
    `wrote evidence/release-checks.json: ${String(checks.summary.pass)} pass, ${String(checks.summary.passWithRecordedLimitations)} pass with recorded limitations, ${String(checks.summary.pending)} pending, ${String(checks.summary.failed)} failed`,
  );
  if (!checks.summary.releaseCandidate) {
    console.error("release candidate is not satisfied");
    process.exitCode = 1;
  }
}

main();
