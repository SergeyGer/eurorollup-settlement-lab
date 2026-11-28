/**
 * Offline verification of the REL-01 release attestation.
 *
 * Checks the tag/build-commit relationship, the evidence/metadata-only diff, the archive
 * and media digests against the committed records, and refuses any claim that the archive
 * is the exact tagged tree.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (path: string): Record<string, any> =>
  JSON.parse(readFileSync(join(repoRoot, path), "utf8")) as Record<string, any>;
function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
const failures: string[] = [];
function check(condition: boolean, message: string): void {
  if (!condition) failures.push(message);
}

function main(): void {
  const ajv = new Ajv({ strict: false, allErrors: true, logger: false });
  const validate = ajv.compile(readJson("schemas/release-attestation.schema.json"));
  const attestation = readJson("evidence/release-attestation.json");
  check(validate(attestation) === true, `schema validation: ${JSON.stringify(validate.errors)}`);
  check(/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(attestation["tag"]), "a semantic release tag is recorded");
  check(/^[0-9a-f]{40}$/.test(attestation["tagCommit"]), "the tag commit is recorded");
  check(/^[0-9a-f]{40}$/.test(attestation["builtFromCommit"]), "the build commit is recorded");
  check(attestation["tagCommit"] !== attestation["builtFromCommit"], "the build commit differs from the tag commit and their relationship is described");
  const relationship = attestation["tagRelationship"];
  check(relationship["kind"] === "evidence-and-metadata-only", "the tag/build relationship is evidence-and-metadata-only");
  const diffFiles = (relationship["diffFiles"] as Array<{ status: string; path: string }>).map((entry) => entry.path).sort();
  check(
    JSON.stringify(diffFiles) ===
      JSON.stringify(["evidence/a08/public-release.json", "evidence/a08/release-package.json", "evidence/release-checks.json", "media/film/film-metadata.json"].sort()),
    "the recorded diff contains exactly the four evidence/metadata files",
  );
  const artifacts = attestation["artifacts"];
  check(artifacts["package"]["exactTaggedTree"] === false, "the archive is not claimed as the exact tagged tree");
  check(artifacts["package"]["builtFromCommit"] === attestation["builtFromCommit"], "the archive records the build commit");
  const packageRecord = readJson("evidence/a08/release-package.json");
  check(artifacts["package"]["sha256"] === packageRecord["sha256"], "the archive digest matches the committed package record");
  check(artifacts["package"]["fileName"] === packageRecord["fileName"], "the archive name matches the committed package record");
  const film = readJson("media/film/film-metadata.json");
  check(artifacts["film"]["sha256"] === film["film"]["sha256"], "the film digest matches the committed film metadata");
  check(artifacts["film"]["builtFromCommit"] === attestation["builtFromCommit"], "the film records the build commit");
  check(artifacts["captions"]["sha256"] === film["captions"]["sha256"], "the caption digest matches the film metadata");
  check(artifacts["transcript"]["sha256"] === film["transcript"]["sha256"], "the transcript digest matches the film metadata");
  // Git-level checks when the commits are present (CI fetches full history for the tag).
  const hasCommit = (commit: string): boolean => {
    try {
      execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: repoRoot, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  if (hasCommit(attestation["builtFromCommit"]) && hasCommit(attestation["tagCommit"])) {
    const tagCommit = execFileSync("git", ["rev-list", "-n", "1", attestation["tag"]], { cwd: repoRoot, encoding: "utf8" }).trim();
    check(tagCommit === attestation["tagCommit"], "the recorded tag commit matches the local tag");
    const diff = execFileSync("git", ["diff", "--name-only", `${attestation["builtFromCommit"]}..${attestation["tagCommit"]}`], { cwd: repoRoot, encoding: "utf8" })
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .sort();
    check(JSON.stringify(diff) === JSON.stringify(diffFiles), "the recorded diff matches the git diff");
  } else {
    console.log("note: release commits are not available in this checkout; verified against the committed records");
  }
  for (const entry of attestation["checks"] as Array<{ id: string; passed: boolean }>) {
    check(entry.passed === true, `attestation check ${entry.id} must pass`);
  }
  check(attestation["passed"] === true, "the attestation must record a pass");
  if (existsSync(join(repoRoot, "media/film/release-film.mp4"))) {
    check(sha256File(join(repoRoot, "media/film/release-film.mp4")) === artifacts["film"]["sha256"], "the local film digest matches the attestation");
  }
  if (failures.length > 0) {
    console.error("REL-01 release attestation verification failed:");
    failures.forEach((failure) => console.error(`- ${failure}`));
    process.exit(1);
  }
  console.log(`REL-01 release attestation verified: tag ${attestation["tag"]} (${String(attestation["tagCommit"]).slice(0, 12)}) over build ${String(attestation["builtFromCommit"]).slice(0, 12)}, four evidence/metadata files, archive not claimed as the tagged tree`);
}

main();
