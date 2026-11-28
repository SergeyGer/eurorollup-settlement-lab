/**
 * Collect the v1.2.0 release assets: the deterministic source archive, the carried release
 * film package (video, captions, transcript, metadata), social preview, public-check and
 * playback evidence, the release-check matrix, the package record, the acceptance record
 * and the release attestation. Writes a checksums file and a manifest; the release page
 * upload uses exactly the listed files.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = (JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string }).version;
const tag = process.env.RELEASE_TAG ?? `v${version}`;
const assetsDir = join(repoRoot, "release", "assets");
const packageRecord = JSON.parse(readFileSync(join(repoRoot, "evidence/a08/release-package.json"), "utf8")) as Record<string, any>;
if (packageRecord["version"] !== version) throw new Error(`release package record is for ${String(packageRecord["version"])}, expected ${version}`);
const sources = [
  join(repoRoot, "release", String(packageRecord["fileName"])),
  join(repoRoot, "media/film/release-film.mp4"),
  join(repoRoot, "media/film/release-film.vtt"),
  join(repoRoot, "media/film/release-film-transcript.md"),
  join(repoRoot, "media/film/film-metadata.json"),
  join(repoRoot, "media/social-preview/approved-1280x640.png"),
  join(repoRoot, "evidence/s14/playback-checks.json"),
  join(repoRoot, "evidence/rel/link-check.json"),
  join(repoRoot, "evidence/a08/public-release.json"),
  join(repoRoot, "evidence/a08/release-package.json"),
  join(repoRoot, "evidence/release-checks.json"),
  join(repoRoot, "evidence/s22/acceptance.json"),
  join(repoRoot, `evidence/release-attestation-${tag}.json`),
];
for (const source of sources) if (!existsSync(source)) throw new Error(`missing release asset source: ${source}`);
mkdirSync(assetsDir, { recursive: true });
// The film metadata asset name carries the presentation release version; keep the carried
// file name verbatim so the v1.1.0 checksum record remains meaningful.
const renamed: Record<string, string> = { "approved-1280x640.png": "social-preview-1280x640.png" };
const files: Array<{ name: string; sha256: string; bytes: number; source: string }> = [];
for (const source of sources) {
  const name = renamed[basename(source)] ?? basename(source);
  const target = join(assetsDir, name);
  copyFileSync(source, target);
  const bytes = readFileSync(target);
  files.push({ name, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, source: source.slice(repoRoot.length + 1) });
}
files.sort((left, right) => left.name.localeCompare(right.name));
const checksums = files.map((entry) => `${entry.sha256}  ${entry.name}`).join("\n") + "\n";
writeFileSync(join(assetsDir, "checksums.txt"), checksums);
const manifest = {
  schemaVersion: "1.0.0",
  reportId: `S22-release-assets-${tag}`,
  generatedBy: "pnpm release:assets",
  generatedAt: new Date().toISOString(),
  tag,
  version,
  commit: readFileSync(join(repoRoot, ".git", "HEAD"), "utf8").trim(),
  files: [...files, { name: "checksums.txt", sha256: createHash("sha256").update(checksums).digest("hex"), bytes: Buffer.byteLength(checksums), source: "generated" }],
  notes: [
    "The source archive is built from the release-code commit and its MANIFEST is verified by the package builder.",
    "The v1.1.0 film is carried unchanged; its metadata records the presentation-release build commit.",
    "The release page links the acceptance record, the gate table and the earlier tagged releases.",
  ],
};
writeFileSync(join(repoRoot, "evidence/a08/release-assets.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${String(files.length + 1)} release assets to release/assets for ${tag}; manifest evidence/a08/release-assets.json`);
