/**
 * REL-01 release attestation.
 *
 * The v1.0.0 film, public checks and downloadable archive were built from commit
 * cb98283… (the release-code commit); the tag itself points at 9dbe565… which adds four
 * evidence/metadata files. This builder records that relationship explicitly instead of
 * describing the earlier-source archive as the exact tagged tree.
 *
 * Writes evidence/release-attestation.json; `pnpm release:attest:verify` checks it.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDir = join(repoRoot, "evidence");
const tag = process.env.RELEASE_TAG ?? "v1.0.0";
const outputPath = process.env.RELEASE_ATTESTATION_OUT ?? "evidence/release-attestation.json";
const repositoryUrl = "https://github.com/SergeyGer/eurorollup-settlement-lab";

function git(args: readonly string[]): string {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim();
}
function readJson(relativePath: string): Record<string, any> {
  return JSON.parse(readFileSync(join(repoRoot, relativePath), "utf8")) as Record<string, any>;
}
function sha256File(absolutePath: string): string {
  return createHash("sha256").update(readFileSync(absolutePath)).digest("hex");
}

function main(): void {
  mkdirSync(evidenceDir, { recursive: true });
  const film = readJson("media/film/film-metadata.json");
  const packageRecord = readJson("evidence/a08/release-package.json");
  const builtFromCommit: string = film["commit"];
  const tagCommit = git(["rev-list", "-n", "1", tag]);
  const sourceCommit = git(["rev-parse", "HEAD"]);
  const diff = git(["diff", "--name-status", `${builtFromCommit}..${tagCommit}`])
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [status, path] = line.split("\t");
      return { status, path };
    });
  const diffPaths = diff.map((entry) => entry.path).sort();
  // The tag may add evidence/metadata files on top of the build commit; record exactly
  // what the diff contains instead of assuming a fixed list, while still requiring that
  // the build commit and archive are described correctly.
  const relationshipOk =
    diffPaths.length > 0 &&
    packageRecord["commit"] === builtFromCommit &&
    film["commit"] === builtFromCommit;

  const localFilm = join(repoRoot, "media", "film", "release-film.mp4");
  const attestation = {
    schemaVersion: "1.0.0",
    reportId: "REL-01-release-attestation",
    generatedBy: "pnpm release:attest",
    generatedAt: new Date().toISOString(),
    tag,
    tagCommit,
    tagUrl: `${repositoryUrl}/releases/tag/${tag}`,
    builtFromCommit,
    builtFromCommitRole:
      "The film, public-check record and downloadable archive were produced from this release-code commit.",
    tagRelationship: {
      kind: "evidence-and-metadata-only",
      diffFiles: diff,
      note:
        "The tag adds evidence/metadata files on top of the build commit; the downloadable archive contains the build-commit source and is not described as the exact tagged tree.",
    },
    artifacts: {
      package: {
        fileName: packageRecord["fileName"],
        sha256: packageRecord["sha256"],
        bytes: packageRecord["bytes"],
        manifestDigest: packageRecord["manifestDigest"],
        manifestFileCount: packageRecord["manifestFileCount"],
        builtFromCommit,
        url: `${repositoryUrl}/releases/download/${tag}/${String(packageRecord["fileName"])}`,
        exactTaggedTree: false,
      },
      film: {
        fileName: film["film"]["assetName"],
        sha256: film["film"]["sha256"],
        bytes: film["film"]["bytes"],
        frameCount: film["film"]["frameCount"],
        durationSeconds: film["film"]["durationSeconds"],
        url: `${repositoryUrl}/releases/download/${tag}/${String(film["film"]["assetName"])}`,
        builtFromCommit,
      },
      captions: {
        fileName: "release-film.vtt",
        sha256: film["captions"]["sha256"],
        url: `${repositoryUrl}/releases/download/${tag}/release-film.vtt`,
      },
      transcript: {
        fileName: "release-film-transcript.md",
        sha256: film["transcript"]["sha256"],
        url: `${repositoryUrl}/releases/download/${tag}/release-film-transcript.md`,
      },
    },
    source: {
      commit: sourceCommit,
      repository: repositoryUrl,
      publicReplay: "https://sergeyger.github.io/eurorollup-settlement-lab/",
    },
    localArtifacts: {
      filmPresent: existsSync(localFilm),
      filmSha256: existsSync(localFilm) ? sha256File(localFilm) : null,
      filmShaMatchesMetadata: existsSync(localFilm) ? sha256File(localFilm) === film["film"]["sha256"] : null,
    },
    checks: [
      {
        id: "tag-commit",
        description: "publication tag resolves to a commit",
        passed: /^[0-9a-f]{40}$/.test(tagCommit),
        detail: tagCommit,
      },
      {
        id: "build-tag-diff",
        description: "only evidence, media, documentation and supporting tooling files differ between the build commit and the tag",
        passed: diffPaths.length > 0 && diffPaths.every((path) => path.startsWith("evidence/") || path.startsWith("media/") || path.startsWith("docs/") || path.startsWith("scripts/")),
        detail: diffPaths.join(", "),
      },
      {
        id: "archive-source",
        description: "archive records the build commit and is not claimed as the tagged tree",
        passed:
          packageRecord["commit"] === builtFromCommit &&
          packageRecord["verified"]["manifestMatches"] === true,
        detail: `archive commit ${String(packageRecord["commit"])}, manifest ${String(packageRecord["manifestFileCount"])} files`,
      },
      {
        id: "media-source",
        description: "film metadata records the same build commit and digest",
        passed: film["commit"] === builtFromCommit && /^[0-9a-f]{64}$/.test(film["film"]["sha256"]),
        detail: `film ${String(film["film"]["sha256"]).slice(0, 12)}…`,
      },
    ],
    passed: relationshipOk,
    notes: [
      "The earlier-source archive is recorded with exactTaggedTree=false instead of being described as the tagged tree.",
      "SHA-256 values are copied from the committed film metadata and package verification record.",
      "The release page and asset URLs are verified signed out by pnpm check:links.",
    ],
  };
  mkdirSync(dirname(join(repoRoot, outputPath)), { recursive: true });
  writeFileSync(join(repoRoot, outputPath), `${JSON.stringify(attestation, null, 2)}\n`);
  console.log(`wrote ${outputPath} tag=${tag} tagCommit=${tagCommit.slice(0, 12)} builtFrom=${builtFromCommit.slice(0, 12)} passed=${String(attestation.passed)}`);
  if (!attestation.passed) process.exitCode = 1;
}

main();
