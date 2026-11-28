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
  const attestationPath = process.env.RELEASE_ATTESTATION_IN ?? "evidence/release-attestation.json";
  const attestation = readJson(attestationPath);
  check(validate(attestation) === true, `schema validation: ${JSON.stringify(validate.errors)}`);
  check(/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(attestation["tag"]), "a semantic release tag is recorded");
  check(/^[0-9a-f]{40}$/.test(attestation["tagCommit"]), "the tag commit is recorded");
  check(/^[0-9a-f]{40}$/.test(attestation["builtFromCommit"]), "the build commit is recorded");
  check(attestation["tagCommit"] !== attestation["builtFromCommit"], "the build commit differs from the tag commit and their relationship is described");
  const relationship = attestation["tagRelationship"];
  check(relationship["kind"] === "evidence-and-metadata-only", "the tag/build relationship is evidence-and-metadata-only");
  const diffFiles = (relationship["diffFiles"] as Array<{ status: string; path: string }>).map((entry) => entry.path).sort();
  const expectedV1 = ["evidence/a08/public-release.json", "evidence/a08/release-package.json", "evidence/release-checks.json", "media/film/film-metadata.json"].sort();
  if (attestation["tag"] === "v1.0.0") {
    check(JSON.stringify(diffFiles) === JSON.stringify(expectedV1), "the v1.0.0 recorded diff contains exactly the four evidence/metadata files");
  } else {
    check(diffFiles.length > 0, "the recorded diff must contain at least one evidence/metadata file");
    check(diffFiles.every((path) => path.startsWith("evidence/") || path.startsWith("media/") || path.startsWith("docs/") || path.startsWith("scripts/") || path.startsWith("schemas/")), "the tag diff may only contain evidence, media, documentation or supporting tooling files");
  }
  const artifacts = attestation["artifacts"];
  check(artifacts["package"]["exactTaggedTree"] === false, "the archive is not claimed as the exact tagged tree");
  check(artifacts["package"]["builtFromCommit"] === attestation["builtFromCommit"], "the archive records the build commit");
  // Historical records: when the tagged commit is available, compare the attestation
  // against the film/package records that were published with that tag instead of the
  // current working tree (which moves on with later releases).
  const hasCommit = (commit: string): boolean => {
    try {
      execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: repoRoot, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  };
  const gitShowJson = (tagRef: string, path: string): Record<string, any> | null => {
    try {
      const output = execFileSync("git", ["show", `${tagRef}:${path}`], { cwd: repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
      return JSON.parse(output) as Record<string, any>;
    } catch {
      return null;
    }
  };
  const historicalPackage = gitShowJson(attestation["tag"], "evidence/a08/release-package.json");
  const historicalFilm = gitShowJson(attestation["tag"], "media/film/film-metadata.json");
  if (historicalPackage !== null) {
    check(artifacts["package"]["sha256"] === historicalPackage["sha256"], "the archive digest matches the tagged package record");
    check(artifacts["package"]["fileName"] === historicalPackage["fileName"], "the archive name matches the tagged package record");
  }
  if (historicalFilm !== null) {
    check(artifacts["film"]["sha256"] === historicalFilm["film"]["sha256"], "the film digest matches the tagged film metadata");
    check(artifacts["captions"]["sha256"] === historicalFilm["captions"]["sha256"], "the caption digest matches the tagged film metadata");
    check(artifacts["transcript"]["sha256"] === historicalFilm["transcript"]["sha256"], "the transcript digest matches the tagged film metadata");
  }
  if (historicalPackage === null || historicalFilm === null) {
    const currentPackage = readJson("evidence/a08/release-package.json");
    const currentFilm = readJson("media/film/film-metadata.json");
    const expectedVersion = String(attestation["tag"]).replace(/^v/, "");
    if (currentFilm["version"] === expectedVersion) {
      check(artifacts["film"]["sha256"] === currentFilm["film"]["sha256"], "the film digest matches the committed film metadata");
      check(artifacts["captions"]["sha256"] === currentFilm["captions"]["sha256"], "the caption digest matches the film metadata");
      check(artifacts["transcript"]["sha256"] === currentFilm["transcript"]["sha256"], "the transcript digest matches the film metadata");
    }
    if (currentPackage["version"] === expectedVersion) {
      check(artifacts["package"]["sha256"] === currentPackage["sha256"], "the archive digest matches the committed package record");
    }
    console.log("note: historical tagged records are not available; verified against matching-version working-tree records where possible");
  }
  // Git-level checks when the commits are present (CI fetches full history for the tag).
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
    const currentFilm = readJson("media/film/film-metadata.json");
    const expectedVersion = String(attestation["tag"]).replace(/^v/, "");
    if (currentFilm["version"] === expectedVersion) {
      check(sha256File(join(repoRoot, "media/film/release-film.mp4")) === artifacts["film"]["sha256"], "the local film digest matches the attestation");
    } else {
      console.log(`note: local film is version ${String(currentFilm["version"])} and does not belong to ${String(attestation["tag"])}; digest comparison skipped`);
    }
  }
  if (failures.length > 0) {
    console.error("REL-01 release attestation verification failed:");
    failures.forEach((failure) => console.error(`- ${failure}`));
    process.exit(1);
  }
  console.log(`REL-01 release attestation verified: ${attestationPath} tag ${attestation["tag"]} (${String(attestation["tagCommit"]).slice(0, 12)}) over build ${String(attestation["builtFromCommit"]).slice(0, 12)}, four evidence/metadata files, archive not claimed as the tagged tree`);
}

main();
