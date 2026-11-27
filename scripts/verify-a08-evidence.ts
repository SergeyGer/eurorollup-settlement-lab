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
import { readFileSync } from "node:fs";
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
  film: { status: string; requiredBy: string };
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
  check(evidence.film.status === "pending" && evidence.film.requiredBy === "S10", "the film must be recorded as a pending S10 artifact");
  check(evidence.publicPartsPassed === true, "all completed public parts must pass");
  check(evidence.passed === false, "A08 must stay incomplete until the film exists");
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
      `package ${evidence.releasePackage.fileName} sha256 ${evidence.releasePackage.sha256.slice(0, 12)}…; film pending (S10)`,
  );
}

main();
