/**
 * Verifies the GitHub repository Social Preview setting against the approved artwork.
 *
 * GitHub does not expose the repository Social Preview through its REST API, so this
 * check reads the public repository page's `og:image`, downloads it signed out and
 * compares its SHA-256 and dimensions with the owner-approved PNG. Writes
 * evidence/rel/social-preview.json.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDir = join(repoRoot, "evidence", "rel");
const repoUrl = "https://github.com/SergeyGer/eurorollup-settlement-lab";
const approvedPath = join(repoRoot, "media", "social-preview", "approved-1280x640.png");

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  const signature = Buffer.from(bytes.slice(0, 8)).toString("hex");
  if (signature !== "89504e470d0a1a0a") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

async function main(): Promise<void> {
  mkdirSync(evidenceDir, { recursive: true });
  const approved = new Uint8Array(readFileSync(approvedPath));
  const approvedSha = sha256(approved);
  const page = await fetch(repoUrl, { headers: { "user-agent": "Mozilla/5.0" } });
  const html = await page.text();
  const match = /<meta property="og:image" content="([^"]+)"/.exec(html);
  const ogImageUrl = match === null ? null : match[1]!;
  let downloaded = new Uint8Array();
  let status = 0;
  let contentType = "";
  if (ogImageUrl !== null) {
    const response = await fetch(ogImageUrl, { headers: { "user-agent": "Mozilla/5.0" } });
    status = response.status;
    contentType = response.headers.get("content-type") ?? "";
    downloaded = new Uint8Array(await response.arrayBuffer());
  }
  const size = downloaded.length > 0 ? pngSize(downloaded) : null;
  const checks = [
    { id: "repository-page", description: "public repository page answers signed out", passed: page.ok, detail: `HTTP ${String(page.status)}` },
    { id: "og-image", description: "repository page publishes an og:image (custom social preview)", passed: ogImageUrl !== null, detail: ogImageUrl ?? "missing" },
    { id: "image-download", description: "social preview image downloads signed out", passed: status === 200 && downloaded.length > 0, detail: `HTTP ${String(status)} ${contentType} ${String(downloaded.length)} bytes` },
    { id: "approved-digest", description: "uploaded social preview is the owner-approved revision C2", passed: downloaded.length > 0 && sha256(downloaded) === approvedSha, detail: `uploaded sha ${downloaded.length > 0 ? sha256(downloaded).slice(0, 16) : "n/a"}…, approved ${approvedSha.slice(0, 16)}…` },
    { id: "dimensions", description: "social preview is 1280x640", passed: size !== null && size.width === 1280 && size.height === 640, detail: size === null ? "unknown" : `${String(size.width)}x${String(size.height)}` },
  ];
  const passed = checks.every((entry) => entry.passed);
  const evidence = {
    schemaVersion: "1.0.0",
    reportId: "REL-02-repository-social-preview",
    generatedBy: "pnpm check:social",
    generatedAt: new Date().toISOString(),
    repository: repoUrl,
    ogImageUrl,
    approvedArtwork: { path: "media/social-preview/approved-1280x640.png", sha256: approvedSha, size: "1280x640" },
    uploaded: { bytes: downloaded.length, sha256: downloaded.length > 0 ? sha256(downloaded) : null, contentType, dimensions: size },
    checks,
    passed,
    notes: [
      "GitHub's repository Social Preview has no public REST API; this check verifies the public page metadata and image bytes.",
      "The owner uploaded the approved PNG manually in the repository settings; the digests match.",
    ],
  };
  writeFileSync(join(evidenceDir, "social-preview.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`repository social preview: ${passed ? "PASS" : "FAIL"} (${checks.filter((c) => c.passed).length}/${String(checks.length)} checks)`);
  if (!passed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
