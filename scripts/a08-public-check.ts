/**
 * A08 public-release verification.
 *
 * Checks the public replay signed out (no authentication), opens every browser
 * view in a clean Playwright context with console/page error capture, exercises
 * representative documented quickstart commands, tests the public links and
 * verifies the downloadable release package (local build or a public release
 * asset URL). The 60-second film is a separate S10 artifact: until it exists the
 * A08 gate stays pending, which is recorded explicitly.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDir = join(repoRoot, "evidence", "a08");
const mediaDir = join(repoRoot, "docs", "media");
const publicUrl = process.env.PUBLIC_REPLAY_URL ?? "https://sergeyger.github.io/eurorollup-settlement-lab/";
const packageUrl = process.env.PACKAGE_URL ?? null;
const repositoryUrl = "https://github.com/SergeyGer/eurorollup-settlement-lab";
const wikiUrl = "https://github.com/SergeyGer/eurorollup-settlement-lab/wiki";
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string };
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
const filmMetadataPath = join(repoRoot, "media/film/film-metadata.json");

function filmEvidence(): Record<string, unknown> {
  const pending = {
    status: "pending",
    requiredBy: "S10",
    requirements: ["about 60 seconds", "English narration", "frame and narration checks"],
  };
  if (!existsSync(filmMetadataPath)) return pending;
  const metadata = JSON.parse(readFileSync(filmMetadataPath, "utf8")) as Record<string, any>;
  if (metadata["passed"] !== true) return pending;
  return {
    status: "complete",
    requiredBy: "S10",
    metadataFile: "media/film/film-metadata.json",
    metadataSha256: createHash("sha256").update(readFileSync(filmMetadataPath)).digest("hex"),
    filmSha256: metadata["film"]["sha256"],
    frameCount: metadata["film"]["frameCount"],
    durationSeconds: metadata["film"]["durationSeconds"],
    captionsFile: metadata["captions"]["file"],
    transcriptFile: metadata["transcript"]["file"],
    checksPassed: metadata["checks"].filter((check: Record<string, unknown>) => check["passed"] === true).length,
    checksTotal: metadata["checks"].length,
    checks: metadata["checks"],
  };
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
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

const VIEWS = [
  { button: "Recorded replay", marker: "Investor portfolio" },
  { button: "Local API lab", marker: "Local API" },
  { button: "AI Policy Lab", marker: "Policy" },
  { button: "Eligibility & sponsorship", marker: "Eligibility" },
  { button: "Economics & operations", marker: "Observed bundle" },
] as const;

async function httpCheck(url: string): Promise<{ url: string; statusCode: number; contentType: string; authentication: "none" }> {
  // Node fetch performs an unauthenticated request: no cookies, no token.
  const response = await fetch(url, { redirect: "follow", headers: { "user-agent": "eurorollup-a08-check" } });
  return { url, statusCode: response.status, contentType: response.headers.get("content-type") ?? "", authentication: "none" };
}

async function verifyDownloadablePackage(): Promise<Record<string, unknown>> {
  const localEvidencePath = join(evidenceDir, "release-package.json");
  const localPackage = readFileSync(localEvidencePath, "utf8");
  const local = JSON.parse(localPackage) as Record<string, any>;
  let archivePath = join(repoRoot, local["filePath"] as string);
  let downloadMode = "local-build";
  let downloadUrl: string | null = null;
  if (packageUrl !== null) {
    downloadMode = "public-release-asset";
    downloadUrl = packageUrl;
    const response = await fetch(packageUrl, { redirect: "follow" });
    if (!response.ok) throw new Error(`package download failed with HTTP ${String(response.status)}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const downloadPath = join(mkdtempSync(join(tmpdir(), "eurorollup-download-")), "package.tar.gz");
    mkdirSync(dirname(downloadPath), { recursive: true });
    writeFileSync(downloadPath, bytes);
    archivePath = downloadPath;
    const downloadedSha = sha256Bytes(bytes);
    if (downloadedSha !== local["sha256"]) throw new Error("downloaded package sha256 does not match the recorded package");
  }
  const verificationDir = mkdtempSync(join(tmpdir(), "eurorollup-package-verify-"));
  try {
    execFileSync("tar", ["-xzf", archivePath, "-C", verificationDir]);
    const root = join(verificationDir, "eurollup-settlement-lab");
    const manifest = JSON.parse(readFileSync(join(root, "MANIFEST.json"), "utf8")) as { files: Array<{ path: string; sha256: string }> };
    const extracted = walk(root)
      .filter((absolute) => relative(root, absolute) !== "MANIFEST.json")
      .map((absolute) => relative(root, absolute).split("\\").join("/"));
    const mismatched = manifest.files.filter((entry) => sha256File(join(root, entry.path)) !== entry.sha256);
    const missing = manifest.files.filter((entry) => !extracted.includes(entry.path));
    const extra = extracted.filter((path) => !manifest.files.some((entry) => entry.path === path));
    const archiveSha256 = sha256File(archivePath);
    return {
      fileName: local["fileName"],
      downloadMode,
      downloadUrl,
      sha256: archiveSha256,
      bytes: statSync(archivePath).size,
      manifestDigest: local["manifestDigest"],
      manifestFileCount: manifest.files.length,
      verified: {
        downloaded: downloadMode === "local-build" || downloadUrl !== null,
        extracted: true,
        manifestMatches: mismatched.length === 0 && missing.length === 0 && extra.length === 0,
        mismatchedFiles: mismatched.map((entry) => entry.path),
        missingFiles: missing.map((entry) => entry.path),
        extraFiles: extra,
      },
    };
  } finally {
    rmSync(verificationDir, { recursive: true, force: true });
  }
}

function runQuickstartCommand(command: string): Record<string, unknown> {
  const started = Date.now();
  const result = spawnSync("pnpm", command.split(/\s+/), { cwd: repoRoot, encoding: "utf8", timeout: 300_000 });
  return {
    command: `pnpm ${command}`,
    exitCode: result.status ?? 1,
    durationMs: Date.now() - started,
  };
}

async function main(): Promise<void> {
  mkdirSync(evidenceDir, { recursive: true });
  mkdirSync(mediaDir, { recursive: true });

  // 1. Public replay signed out.
  const replayCheck = await httpCheck(publicUrl);
  const pageHtml = (await (await fetch(publicUrl, { redirect: "follow" })).text()).slice(0, 5000);
  const contentChecks = {
    httpStatus: replayCheck.statusCode,
    contentType: replayCheck.contentType,
    hasTitle: /EuroRollup Settlement Lab/.test(pageHtml),
    hasAppMount: /<div id="root">/.test(pageHtml) || /<div id="root"><\/div>/.test(pageHtml) || /id="root"/.test(pageHtml),
    authentication: "none" as const,
  };

  // 2. Clean-browser replay check across all views.
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-GB" });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  const views: Array<Record<string, unknown>> = [];
  const screenshots: Array<{ path: string; sha256: string }> = [];
  try {
    await page.goto(publicUrl, { waitUntil: "networkidle", timeout: 120_000 });
    const title = await page.title();
    for (const view of VIEWS) {
      const button = page.getByRole("button", { name: view.button });
      await button.click();
      await page.waitForTimeout(600);
      let rendered = false;
      for (let attempt = 0; attempt < 20 && !rendered; attempt += 1) {
        const body = await page.locator("body").innerText({ timeout: 30_000 });
        // innerText reflects CSS text-transform, so compare case-insensitively.
        rendered = body.toLowerCase().includes(view.marker.toLowerCase());
        if (!rendered) await page.waitForTimeout(200);
      }
      views.push({ button: view.button, marker: view.marker, rendered });
      const screenshotName = view.button === "Recorded replay"
        ? "s09-public-replay.jpg"
        : view.button === "Economics & operations"
          ? "s09-economics.jpg"
          : view.button === "Eligibility & sponsorship"
            ? "s09-eligibility.jpg"
            : null;
      if (screenshotName !== null) {
        const path = join(mediaDir, screenshotName);
        await page.screenshot({ path, type: "jpeg", quality: 82, fullPage: false });
        screenshots.push({ path: `docs/media/${screenshotName}`, sha256: sha256File(path) });
      }
    }
    // The static replay has no local API: the "Local API lab" view reports an
    // expected connection-refused error when opened without a local server. Those
    // are recorded separately and do not count as clean-browser failures.
    const expectedConsoleErrorPattern = /ERR_CONNECTION_REFUSED|Failed to fetch|NetworkError|net::ERR_/i;
    const expectedConsoleErrors = consoleErrors.filter((message) => expectedConsoleErrorPattern.test(message));
    const unexpectedConsoleErrors = consoleErrors.filter((message) => !expectedConsoleErrorPattern.test(message));
    const cleanBrowser = {
      engine: "chromium (Playwright)",
      version: browser.version(),
      viewport: "1440x900",
      title,
      pageErrors,
      consoleErrors: unexpectedConsoleErrors,
      expectedConsoleErrors,
      views,
      screenshots,
    };
    // 3. Quickstart: representative documented commands, run locally.
    const quickstartCommands = ["verify", "demo:partner"].map(runQuickstartCommand);

    // 4. Public links tested unauthenticated.
    const publicLinks = await Promise.all([repositoryUrl, wikiUrl, `${repositoryUrl}/releases`].map(httpCheck));

    // 5. Downloadable release package verification.
    const releasePackage = await verifyDownloadablePackage();

    const publicPartsPassed =
      contentChecks.httpStatus === 200 &&
      pageErrors.length === 0 &&
      unexpectedConsoleErrors.length === 0 &&
      views.every((view) => view.rendered === true) &&
      quickstartCommands.every((command) => command["exitCode"] === 0) &&
      publicLinks.every((link) => link.statusCode === 200) &&
      (releasePackage["verified"] as Record<string, unknown>)["manifestMatches"] === true;

    const evidence = {
      schemaVersion: "1.0.0",
      reportId: "A08-public-release",
      packId: "A08-release",
      generatedBy: "pnpm a08:public-check",
      generatedAt: new Date().toISOString(),
      commit,
      version: packageJson.version,
      publicReplay: {
        url: publicUrl,
        authentication: "none",
        httpStatus: contentChecks.httpStatus,
        contentType: contentChecks.contentType,
        contentChecks: {
          hasTitle: contentChecks.hasTitle,
          hasAppMount: contentChecks.hasAppMount,
        },
        cleanBrowser,
      },
      quickstart: {
        commands: quickstartCommands,
        note: "Representative documented commands were run locally; the complete documented quickstart command set is exercised by pnpm release:checks.",
      },
      publicLinks,
      releasePackage,
      film: filmEvidence(),
      publicPartsPassed,
      passed: false,
      notes: [
        "A08 stays pending until the 60-second film exists; the public replay, quickstart, links and downloadable package are verified here.",
        "All public checks were performed without authentication.",
      ],
    };
    console.log(`public replay ${publicUrl} status ${String(contentChecks.httpStatus)}; views ${String(views.length)}; pageErrors ${String(pageErrors.length)}`);
    const film = evidence.film as Record<string, unknown>;
    evidence.passed = publicPartsPassed && film["status"] === "complete";
    writeFileSync(join(evidenceDir, "public-release.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`release package verified=${String((releasePackage["verified"] as Record<string, unknown>)["manifestMatches"])}; publicPartsPassed=${String(publicPartsPassed)}; film=${String(film["status"])}; passed=${String(evidence.passed)}`);
    if (!publicPartsPassed) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
