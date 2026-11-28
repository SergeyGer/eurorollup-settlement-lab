/**
 * Offline verification of the committed A08 public-release evidence.
 *
 * The public URL, browser and package checks are recorded by
 * `pnpm a08:public-check`; CI verifies the committed record without network
 * access. The A08 gate stays pending until the S10 film exists, and this verifier
 * asserts that the pending state is explicit and that every completed public part
 * passed.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (path: string): unknown => JSON.parse(readFileSync(join(repoRoot, path), "utf8"));

interface PublicEvidence {
  schemaVersion: string;
  reportId: string;
  commit: string;
  version: string;
  publicReplay: {
    url: string;
    authentication: string;
    httpStatus: number;
    contentChecks: { hasTitle: boolean; hasAppMount: boolean };
    cleanBrowser: { engine: string; pageErrors: string[]; consoleErrors: string[]; views: Array<{ button: string; rendered: boolean }>; screenshots: Array<{ path: string; sha256: string }> };
  };
  quickstart: { commands: Array<{ command: string; exitCode: number }> };
  publicLinks: Array<{ url: string; statusCode: number; authentication: string }>;
  releasePackage: { fileName: string; sha256: string; bytes: number; downloadMode: string; verified: { downloaded: boolean; extracted: boolean; manifestMatches: boolean } };
  film: { status: string; requiredBy: string; metadataFile?: string; metadataSha256?: string; filmSha256?: string; frameCount?: number; durationSeconds?: number; checksPassed?: number; checksTotal?: number; checks?: Array<{ id: string; passed: boolean }> };
  publicPartsPassed: boolean;
  passed: boolean;
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
  const validate = ajv.compile(readJson("schemas/a08-public-release.schema.json") as object);
  const evidence = readJson("evidence/a08/public-release.json") as PublicEvidence;
  check(validate(evidence) === true, `schema validation: ${JSON.stringify(validate.errors)}`);
  check(/^[0-9a-f]{40}$/.test(evidence.commit), "the source commit must be recorded");
  check(evidence.reportId === "A08-public-release", "report id");
  check(evidence.publicReplay.url.startsWith("https://"), "the public replay URL must be HTTPS");
  check(evidence.publicReplay.authentication === "none" && evidence.publicLinks.every((link) => link.authentication === "none"), "public checks must be unauthenticated");
  check(evidence.publicReplay.httpStatus === 200, "the public replay must return HTTP 200");
  check(evidence.publicReplay.contentChecks.hasTitle && evidence.publicReplay.contentChecks.hasAppMount, "the replay content must be present");
  check(evidence.publicReplay.cleanBrowser.pageErrors.length === 0, "the clean browser must not report page errors");
  check(evidence.publicReplay.cleanBrowser.views.length >= 5 && evidence.publicReplay.cleanBrowser.views.every((view) => view.rendered), "all five browser views must render");
  check(evidence.publicReplay.cleanBrowser.screenshots.length >= 1, "at least one clean-browser screenshot is required");
  for (const screenshot of evidence.publicReplay.cleanBrowser.screenshots) {
    check(sha256File(screenshot.path) === screenshot.sha256, `screenshot digest mismatch for ${screenshot.path}`);
  }
  check(evidence.quickstart.commands.length >= 1 && evidence.quickstart.commands.every((command) => command.exitCode === 0), "representative quickstart commands must pass");
  check(evidence.publicLinks.length >= 3 && evidence.publicLinks.every((link) => link.statusCode === 200), "all public links must return HTTP 200");
  check(evidence.releasePackage.verified.downloaded && evidence.releasePackage.verified.extracted && evidence.releasePackage.verified.manifestMatches, "the downloadable package must be downloaded, extracted and match its manifest");
  check(/^[0-9a-f]{64}$/.test(evidence.releasePackage.sha256), "the package digest must be recorded");
  check(evidence.publicPartsPassed === true, "all completed public parts must pass");
  if (evidence.film.status === "complete") {
    // S10 closes A08: the film metadata must exist, match its recorded digest and
    // contain only passing frame/narration/audio checks.
    const metadataPath = evidence.film.metadataFile ?? "media/film/film-metadata.json";
    check(existsSync(join(repoRoot, metadataPath)), `the film metadata must exist at ${metadataPath}`);
    check(sha256File(metadataPath) === evidence.film.metadataSha256, "the film metadata digest must match the A08 record");
    const metadata = readJson(metadataPath) as Record<string, any>;
    check(metadata["passed"] === true, "the film metadata must record a passing film");
    check(metadata["film"]["sha256"] === evidence.film.filmSha256, "the film digest must match the A08 record");
    check(metadata["film"]["frameCount"] === 1800, "the film must have exactly 1800 frames");
    check(Math.abs(Number(metadata["film"]["durationSeconds"]) - 60) <= 0.05, "the film must be exactly 60.0 seconds");
    check(metadata["film"]["fps"] === "30/1" && metadata["film"]["width"] === 1920 && metadata["film"]["height"] === 1080, "the film must be 1920x1080 at constant 30 fps");
    check(metadata["captions"]["burnedIn"] === false && metadata["captions"]["separateTrack"] === true, "captions must be delivered separately and never burned into the frames");
    check(metadata["endCard"]["urlSingleLineAt720p"] === true && metadata["endCard"]["urlSingleLineAtPhoneWidth"] === true, "the repository URL must be readable on one line at 720p and phone width");
    check(metadata["socialPreview"]["approved"] === true, "the film must use the owner-approved artwork");
    const approvedPath = join(repoRoot, "media", "social-preview", "approved-1280x640.png");
    check(existsSync(approvedPath) && sha256File("media/social-preview/approved-1280x640.png") === metadata["socialPreview"]["sha256"], "the film opening artwork digest must match the approved artwork");
    check(typeof metadata["publication"]?.["player"] === "string", "the film metadata must describe the accessible player");
    check(Number(metadata["narration"]["closingLineEndsAtSeconds"]) < 60, "the closing line must finish before the final frame");
    check(Math.abs(Number(metadata["narration"]["loudnessIntegratedLufs"]) + 16) <= 2, "integrated loudness must be about -16 LUFS");
    check(Number(metadata["narration"]["truePeakDbtp"]) <= -1, "true peak must be at most -1 dBTP");
    check((metadata["checks"] as Array<Record<string, unknown>>).every((entry) => entry["passed"] === true), "every film check must pass");
    check(evidence.passed === true, "A08 must be complete when the film is complete and every public part passes");
    const vtt = readFileSync(join(repoRoot, metadata["captions"]["file"]), "utf8");
    const transcript = readFileSync(join(repoRoot, metadata["transcript"]["file"]), "utf8");
    check((vtt.match(/--!?>/g) ?? []).length >= 7, "the WebVTT must contain every narration cue");
    check(transcript.includes("Release film transcript"), "the verbatim transcript must be present");
    check(sha256File(metadata["captions"]["file"]) === metadata["captions"]["sha256"], "the caption digest must match");
    check(sha256File(metadata["transcript"]["file"]) === metadata["transcript"]["sha256"], "the transcript digest must match");
  } else {
    check(evidence.film.status === "pending" && evidence.film.requiredBy === "S10", "the film must be recorded as a pending S10 artifact before S10");
    check(evidence.passed === false, "A08 must stay incomplete until the film exists");
  }
  const packageRecord = readJson("evidence/a08/release-package.json") as Record<string, any>;
  check(packageRecord["sha256"] === evidence.releasePackage.sha256, "the public evidence must reference the built package digest");
  check(packageRecord["fileName"] === evidence.releasePackage.fileName, "the package file name must match the build record");

  if (failures.length > 0) {
    console.error("A08 public-release evidence verification failed:");
    failures.forEach((failure) => console.error(`- ${failure}`));
    process.exit(1);
  }
  console.log(
    `A08 public-release evidence verified: ${evidence.publicReplay.url} HTTP ${String(evidence.publicReplay.httpStatus)}, ` +
      `${String(evidence.publicReplay.cleanBrowser.views.length)} browser views, ${String(evidence.publicLinks.length)} public links, ` +
      `package ${evidence.releasePackage.fileName} sha256 ${evidence.releasePackage.sha256.slice(0, 12)}…; film ${evidence.film.status}`,
  );
}

main();
