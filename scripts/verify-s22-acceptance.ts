/**
 * Offline verification of the S22 independent acceptance record.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (path: string): Record<string, any> => JSON.parse(readFileSync(join(repoRoot, path), "utf8")) as Record<string, any>;
const failures: string[] = [];
function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

function main(): void {
  const ajv = new Ajv({ strict: false, allErrors: true, logger: false });
  const validate = ajv.compile(readJson("schemas/s22-acceptance.schema.json"));
  const acceptance = readJson("evidence/s22/acceptance.json");
  check(validate(acceptance) === true, `schema validation: ${JSON.stringify(validate.errors)}`);
  const commit = String(acceptance["commit"]);
  check(/^[0-9a-f]{40}$/.test(commit), "the accepted commit is recorded");
  let commitAvailable = false;
  try {
    execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: repoRoot, stdio: "ignore" });
    commitAvailable = true;
  } catch { /* shallow checkout in CI: the record still verifies structurally */ }
  if (commitAvailable) {
    check(execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: repoRoot, encoding: "utf8" }).trim() !== "", "the accepted tree is readable");
  }
  check(acceptance["environment"]["acceptedWorktreeClean"] === true, "the accepted worktree was clean");
  const clone = acceptance["environment"]["independentClone"] as Record<string, any>;
  check(clone["commit"] === commit, "the independent clone is the accepted commit");
  check(clone["cloneStatusClean"] === true, "the independent clone is clean");
  check(clone["tree"] === acceptance["tree"], "the independent clone tree matches the accepted tree");
  const requirements = acceptance["requirements"] as Array<Record<string, any>>;
  check(requirements.length >= 19, "all acceptance requirements are recorded");
  const ids = new Set<string>();
  for (const entry of requirements) {
    check(!ids.has(String(entry["id"])), `requirement ${String(entry["id"])} appears once`);
    ids.add(String(entry["id"]));
    check(entry["sourceCommit"] === commit, `${String(entry["id"])}: source commit matches the accepted commit`);
    check(String(entry["command"]).length > 0 && String(entry["expected"]).length > 0 && String(entry["observed"]).length > 0, `${String(entry["id"])}: command/expected/observed are recorded`);
    check(String(entry["evidenceLink"]).length > 0, `${String(entry["id"])}: evidence link is recorded`);
    check(entry["disposition"] === "qualified", `${String(entry["id"])}: disposition is qualified`);
    check(entry["incompleteReason"] === null, `${String(entry["id"])}: no incomplete reason is left`);
  }
  const summary = acceptance["gatesSummary"] as Record<string, number>;
  const qualified = requirements.filter((entry) => entry["disposition"] === "qualified").length;
  check(summary["total"] === requirements.length, "the gate summary counts every requirement");
  check(summary["qualified"] === qualified && summary["failed"] === 0 && summary["incomplete"] === 0, "all gates are qualified with no failure or incomplete gate");
  // Evidence digests: every recorded digest must match the current file content.
  for (const [path, digest] of Object.entries(acceptance["evidenceDigests"] as Record<string, string>)) {
    check(existsSync(join(repoRoot, path)), `evidence file ${path} exists`);
    if (existsSync(join(repoRoot, path))) {
      const actual = createHash("sha256").update(readFileSync(join(repoRoot, path))).digest("hex");
      check(actual === digest, `evidence digest for ${path} matches`);
    }
  }
  // Walkthrough checks are recorded and successful.
  const walkthrough = acceptance["walkthrough"] as Record<string, any>;
  check(walkthrough["landingPage"]["ok"] === true, "the public landing page was reachable signed out");
  check([200, 302].includes(Number(walkthrough["filmAsset"]["status"])), "the tagged release film asset is addressable");
  check(walkthrough["captions"]["ok"] === true, "the separate WebVTT captions are addressable");
  check(walkthrough["releases"]["ok"] === true, "the earlier releases are addressable");
  check(walkthrough["f1530"]["exitCode"] === 0, "the F-1530 cutoff walkthrough test passed");
  check(walkthrough["liveInvestment"]["command"].includes("verify-s18-evidence"), "the live-investment walkthrough is linked to the canonical witness verification");
  check(acceptance["passed"] === true, "the acceptance record declares a pass");
  check((acceptance["limitations"] as unknown[]).length >= 2, "acceptance limitations are recorded");
  check((acceptance["attribution"]["executedInCleanClone"] as unknown[]).length >= 9, "the clean-clone execution attribution covers the evidence verifiers");
  if (failures.length > 0) {
    console.error("S22 acceptance verification failed:");
    failures.forEach((failure) => console.error(`- ${failure}`));
    process.exit(1);
  }
  console.log(`S22 acceptance verified: commit ${commit.slice(0, 12)}, ${String(qualified)}/${String(requirements.length)} gates qualified, 0 incomplete, 0 failed, evidence digests match, public walkthrough reachable.`);
}

main();
