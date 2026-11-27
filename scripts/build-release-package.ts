/**
 * Build the downloadable release package for the public release.
 *
 * The package is a source archive of the release commit plus a machine-checkable
 * MANIFEST.json with SHA-256 for every file. The builder then re-extracts the
 * archive and verifies every manifest entry, so a broken package cannot be
 * published silently. Output:
 *
 *   release/eurollup-settlement-lab-<version>.tar.gz
 *   evidence/a08/release-package.json
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const releaseDir = join(repoRoot, "release");
const evidenceDir = join(repoRoot, "evidence", "a08");
const version = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string };
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
const publicReplayUrl = process.env.PUBLIC_REPLAY_URL ?? "https://sergeyger.github.io/eurorollup-settlement-lab/";
const fileName = `eurollup-settlement-lab-${version.version}.tar.gz`;

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function walk(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute));
    else files.push(absolute);
  }
  return files.sort();
}

function main(): void {
  rmSync(releaseDir, { recursive: true, force: true });
  mkdirSync(releaseDir, { recursive: true });
  mkdirSync(evidenceDir, { recursive: true });
  const staging = mkdtempSync(join(tmpdir(), "eurorollup-release-"));
  const packageRoot = join(staging, "eurollup-settlement-lab");
  mkdirSync(packageRoot, { recursive: true });
  try {
    // Deterministic source archive of the release commit.
    const archive = execFileSync("git", ["archive", "--format=tar", "HEAD"], { cwd: repoRoot, maxBuffer: 256 * 1024 * 1024 });
    execFileSync("tar", ["-x", "-C", packageRoot], { input: archive });

    const files = walk(packageRoot).filter((absolute) => relative(packageRoot, absolute) !== "MANIFEST.json");
    const manifestEntries = files.map((absolute) => {
      const relativePath = relative(packageRoot, absolute).split("\\").join("/");
      return { path: relativePath, sha256: sha256File(absolute), bytes: statSync(absolute).size };
    });
    const manifest = {
      schemaVersion: "1.0.0",
      packageVersion: version.version,
      commit,
      generatedBy: "pnpm release:package",
      publicReplayUrl,
      fileCount: manifestEntries.length,
      files: manifestEntries,
      notes: [
        "The archive contains the release commit source, fixtures, schemas, evidence, benchmarks and documentation.",
        "Every file digest is listed here; verify with `tar -xzf <archive> && sha256sum -c` style tooling or the committed verification record.",
      ],
    };
    const manifestPath = join(packageRoot, "MANIFEST.json");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const manifestDigest = sha256File(manifestPath);

    const archivePath = join(releaseDir, fileName);
    execFileSync(
      "tar",
      [
        "--sort=name",
        "--mtime=UTC 1970-01-01",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "-czf",
        archivePath,
        "-C",
        staging,
        "eurollup-settlement-lab",
      ],
      { maxBuffer: 256 * 1024 * 1024 },
    );

    // Re-extract the published archive and verify every manifest entry.
    const verificationDir = mkdtempSync(join(tmpdir(), "eurorollup-verify-"));
    execFileSync("tar", ["-xzf", archivePath, "-C", verificationDir]);
    const extractedRoot = join(verificationDir, "eurollup-settlement-lab");
    const extractedManifest = JSON.parse(readFileSync(join(extractedRoot, "MANIFEST.json"), "utf8")) as typeof manifest;
    const extractedFiles = walk(extractedRoot)
      .filter((absolute) => relative(extractedRoot, absolute) !== "MANIFEST.json")
      .map((absolute) => relative(extractedRoot, absolute).split("\\").join("/"));
    const manifestPaths = extractedManifest.files.map((entry) => entry.path);
    const missing = manifestPaths.filter((path) => !extractedFiles.includes(path));
    const extra = extractedFiles.filter((path) => !manifestPaths.includes(path));
    const mismatched = extractedManifest.files.filter((entry) => sha256File(join(extractedRoot, entry.path)) !== entry.sha256);
    const archiveSha256 = sha256File(archivePath);
    const archiveBytes = statSync(archivePath).size;
    const verified = missing.length === 0 && extra.length === 0 && mismatched.length === 0;
    rmSync(verificationDir, { recursive: true, force: true });

    const evidence = {
      schemaVersion: "1.0.0",
      reportId: "A08-release-package",
      packId: "A08-release",
      generatedBy: "pnpm release:package",
      generatedAt: new Date().toISOString(),
      version: version.version,
      commit,
      fileName,
      filePath: `release/${fileName}`,
      bytes: archiveBytes,
      sha256: archiveSha256,
      manifestDigest,
      manifestFileCount: extractedManifest.files.length,
      verified: {
        extracted: true,
        manifestMatches: verified,
        missingFiles: missing,
        extraFiles: extra,
        mismatchedFiles: mismatched.map((entry) => entry.path),
      },
      publicReplayUrl,
      notes: [
        "The package is a deterministic source archive of the release commit with a SHA-256 manifest.",
        "The builder re-extracts the archive and verifies every manifest entry before writing this record.",
      ],
    };
    writeFileSync(join(evidenceDir, "release-package.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`built release/${fileName} (${String(archiveBytes)} bytes, sha256 ${archiveSha256})`);
    console.log(`verified ${String(extractedManifest.files.length)} manifest entries; matches=${String(verified)}`);
    if (!verified) process.exitCode = 1;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

main();
