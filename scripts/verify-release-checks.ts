/**
 * Offline verification of the committed S08 release-check matrix.
 *
 * CI cannot re-run the live drills, so this verifier checks that the committed
 * matrix is complete and internally consistent: every gate A01-A09 is present,
 * every gate except the pending public release has validated evidence with
 * matching SHA-256 digests, no gate failed, the A05 limitations and missed
 * targets are recorded, the A07 drill details show no missed target, and the
 * release-candidate flag agrees with the gate statuses.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (path: string): unknown => JSON.parse(readFileSync(join(repoRoot, path), "utf8"));

interface GateEntry {
  gate: string;
  title: string;
  status: string;
  evidence: Array<{ path: string; exists: boolean; sha256: string | null; schemaValid: boolean }>;
  commands: Array<{ id: string; exitCode: number | null }>;
  limitations: string[];
  missedTargets: Array<Record<string, unknown>>;
  requiredArtifacts?: string[];
  pendingReason?: string;
  pendingChecksPassed?: boolean | null;
}

interface Checks {
  schemaVersion: string;
  reportId: string;
  commit: string;
  branch: string;
  gates: GateEntry[];
  summary: { totalGates: number; pass: number; passWithRecordedLimitations: number; pending: number; failed: number; failedGates: string[]; releaseCandidate: boolean; pendingGates: string[] };
  commands: Array<{ id: string; exitCode: number }>;
  evidenceDigests: Array<{ gate: string; path: string; sha256: string; bytes: number }>;
  limitations: string[];
  missedTargets: Array<Record<string, unknown>>;
  a07Details: Record<string, any>;
}

const failures: string[] = [];
function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(join(repoRoot, path))).digest("hex");
}

function main(): void {
  const ajv = new Ajv({ strict: false, allErrors: true, logger: false });
  const validate = ajv.compile(readJson("schemas/release-checks.schema.json") as object);
  const checks = readJson("evidence/release-checks.json") as Checks;
  check(validate(checks) === true, `schema validation: ${JSON.stringify(validate.errors)}`);

  const expectedGates = ["A01", "A02", "A03", "A04", "A05", "A06", "A07", "A08", "A09"];
  const actualGates = checks.gates.map((gate) => gate.gate);
  check(actualGates.length === expectedGates.length && expectedGates.every((gate) => actualGates.includes(gate)), "all gates A01-A09 must be present");
  check(/^[0-9a-f]{40}$/.test(checks.commit), "the source commit must be recorded");
  check(checks.branch.length > 0, "the source branch must be recorded");

  for (const gate of checks.gates) {
    if (gate.gate === "A08") {
      // S10 completes A08: public replay, quickstart, links, package and the film.
      if (gate.status === "pass") {
        check(gate.evidence.length >= 2, "A08 must reference both the public-release evidence and the film metadata");
        check(gate.evidence.every((entry) => entry.exists && entry.schemaValid && entry.sha256 !== null), "A08 evidence must exist and validate");
        for (const entry of gate.evidence) {
          check(sha256File(entry.path) === entry.sha256, `A08 digest mismatch for ${entry.path}`);
        }
        check(gate.commands.length >= 1 && gate.commands.every((command) => command.exitCode === 0), "A08 verification commands must all pass");
        const publicEvidence = readJson("evidence/a08/public-release.json") as Record<string, any>;
        check(publicEvidence["film"]["status"] === "complete", "A08 pass requires the film to be complete");
        check(publicEvidence["passed"] === true, "A08 pass requires the public evidence to be complete");
        continue;
      }
      check(gate.status === "pending", "A08 must be pending or pass");
      check((gate.requiredArtifacts ?? []).length >= 4, "A08 must list the required public-release and film artifacts");
      if (gate.evidence.length > 0) {
        check(gate.evidence.every((entry) => entry.exists && entry.schemaValid && entry.sha256 !== null), "A08 evidence must exist and validate");
        for (const entry of gate.evidence) {
          check(sha256File(entry.path) === entry.sha256, `A08 digest mismatch for ${entry.path}`);
        }
        check(gate.commands.length >= 1 && gate.commands.every((command) => command.exitCode === 0), "A08 verification commands must all pass");
        check(gate.pendingChecksPassed === true, "A08 pending checks must pass once the public-release evidence exists");
      } else {
        check(gate.commands.length === 0, "A08 must not claim a verification command before evidence exists");
      }
      continue;
    }
    check(gate.status === "pass" || gate.status === "pass_with_recorded_limitations", `${gate.gate} must pass or pass with recorded limitations (got ${gate.status})`);
    check(gate.evidence.length >= 1, `${gate.gate} must reference at least one evidence file`);
    check(gate.evidence.every((entry) => entry.exists && entry.schemaValid && entry.sha256 !== null), `${gate.gate} evidence must exist and validate`);
    for (const entry of gate.evidence) {
      check(sha256File(entry.path) === entry.sha256, `${gate.gate} digest mismatch for ${entry.path}`);
    }
    check(gate.commands.length >= 1 && gate.commands.every((command) => command.exitCode === 0), `${gate.gate} verification commands must all pass`);
  }

  check(checks.summary.failed === 0, "no gate may be failed");
  check(checks.summary.releaseCandidate === true, "the release-candidate flag must be true");
  const a08Gate = checks.gates.find((gate) => gate.gate === "A08");
  if (a08Gate?.status === "pass") {
    check(checks.summary.pendingGates.length === 0, "a completed release must have no pending gate");
    check(checks.summary.failed === 0, "a completed release must have no failed gate");
  } else {
    check(checks.summary.pendingGates.length === 1 && checks.summary.pendingGates[0] === "A08", "only A08 may be pending in the release candidate");
  }

  check(checks.commands.every((command) => command.exitCode === 0), "every recorded command must exit zero");
  check(checks.commands.length >= 15, "at least fifteen verification commands are expected");
  for (const entry of checks.evidenceDigests) {
    check(sha256File(entry.path) === entry.sha256, `evidence digest mismatch for ${entry.path}`);
  }

  const a05 = checks.gates.find((gate) => gate.gate === "A05");
  check(a05 !== undefined, "A05 must be present");
  if (a05 !== undefined) {
    check(a05.limitations.some((limitation) => limitation.toLowerCase().includes("blob")), "A05 must record the missing blob data-availability observation");
    check(a05.limitations.some((limitation) => limitation.toLowerCase().includes("finality")), "A05 must record the missing L1 finality observation");
    check(a05.missedTargets.length >= 2, "A05 must record the missed observations with a cause and follow-up");
    check(a05.status === "pass_with_recorded_limitations", "A05 must not be marked as a plain pass while limitations exist");
  }
  const a07 = checks.a07Details;
  check(a07["performance"]["passed"] === true, "A07 performance must meet its targets");
  check((a07["batchPublication"]["missedTargets"] as unknown[]).length === 0, "A07 batch drill must not have a missed target");
  check(a07["bundle"]["allocationsReproduceTotal"] === true, "A07 bundle allocations must reproduce the bundle total");

  if (failures.length > 0) {
    console.error("S08 release-check verification failed:");
    failures.forEach((failure) => console.error(`- ${failure}`));
    process.exit(1);
  }
  console.log(
    `S08 release checks verified on commit ${checks.commit.slice(0, 12)}: ${String(checks.summary.pass)} pass, ` +
      `${String(checks.summary.passWithRecordedLimitations)} pass with recorded limitations, ` +
      `${String(checks.summary.pending)} pending (A08), ${String(checks.summary.failed)} failed`,
  );
}

main();
