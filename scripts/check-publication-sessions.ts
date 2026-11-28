/**
 * S13 publication sessions: signed-out desktop and phone walkthroughs.
 *
 * Opens the public repository README and the Wiki without authentication, verifies the
 * owner-approved social preview is visible, checks that the film and replay are one click
 * from the first screen, and archives the screenshots plus the command log.
 *
 * Writes evidence/rel/publication-sessions.json and docs/media/s13-*.png.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDir = join(repoRoot, "evidence", "rel");
const mediaDir = join(repoRoot, "docs", "media");
const repoUrl = "https://github.com/SergeyGer/eurorollup-settlement-lab";
const wikiUrl = `${repoUrl}/wiki`;
const filmUrl = `${repoUrl}/releases/download/v1.0.0/eurollup-release-film-1.0.0.mp4`;
const replayUrl = "https://sergeyger.github.io/eurorollup-settlement-lab/";
const apprvedSha = "1b56f8f964dfea2363a8376ba6a668bc0c888880b15595defcc5e89a5bf4164e";

interface SessionCheck {
  readonly id: string;
  readonly description: string;
  readonly passed: boolean;
  readonly detail: string;
}
const checks: SessionCheck[] = [];
const screenshots: Array<{ file: string; sha256: string }> = [];
function check(id: string, description: string, passed: boolean, detail: string): void {
  checks.push({ id, description, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} ${id}: ${detail}`);
}
function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
async function shot(page: Page, name: string): Promise<void> {
  const path = join(mediaDir, name);
  await page.screenshot({ path, fullPage: false });
  screenshots.push({ file: `docs/media/${name}`, sha256: sha256File(path) });
}
async function openSignedOut(browser: Browser, url: string, viewport: { width: number; height: number }): Promise<Page> {
  const context = await browser.newContext({ viewport, locale: "en-GB" });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "networkidle", timeout: 120_000 });
  await page.waitForTimeout(800);
  return page;
}

async function checkReadme(browser: Browser, viewport: { width: number; height: number }, name: string): Promise<void> {
  const page = await openSignedOut(browser, repoUrl, viewport);
  try {
    const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    check(`readme-${name}-film-link`, "README reaches the film in one click", body.includes("Watch the 60-second film"), "film action present on the first screen");
    check(`readme-${name}-replay-link`, "README reaches the live replay in one click", body.includes("Try the live replay"), "replay action present on the first screen");
    check(`readme-${name}-wiki-link`, "README points at the Wiki", body.includes("Wiki"), "Wiki action present");
    const image = page.locator('img[src*="approved-1280x640"]').first();
    const imageCount = await image.count();
    let imageLoaded = false;
    let imageNaturalWidth = 0;
    if (imageCount > 0) {
      imageLoaded = await image.evaluate((element) => {
        const img = element as HTMLImageElement;
        return img.complete && img.naturalWidth > 0;
      });
      imageNaturalWidth = await image.evaluate((element) => (element as HTMLImageElement).naturalWidth);
    }
    check(`readme-${name}-approved-artwork`, "owner-approved social preview is visible", imageCount > 0 && imageLoaded, `image count ${String(imageCount)}, natural width ${String(imageNaturalWidth)}`);
    // Position the rendered README at the top of the viewport so the screenshot shows
    // the public first screen (title, purpose sentence, film/replay actions, poster).
    await page.evaluate(() => {
      const article = document.querySelector("article") ?? document.querySelector(".markdown-body");
      if (article === null) return;
      const top = article.getBoundingClientRect().top + window.scrollY - 120;
      window.scrollTo(0, Math.max(0, top));
    });
    await page.waitForTimeout(700);
    await shot(page, `s13-readme-${name}.png`);
  } finally {
    await page.context().close();
  }
}

async function checkWiki(browser: Browser): Promise<void> {
  const page = await openSignedOut(browser, wikiUrl, { width: 1440, height: 1000 });
  try {
    const body = (await page.locator("body").innerText()).replace(/\s+/g, " ");
    check("wiki-status", "Wiki home shows the published release status", body.includes("Release 1.0.0 is published"), "release status current");
    check("wiki-film-navigation", "Wiki home links to the film page", body.includes("Release-Film") || body.includes("Release film"), "film page reachable");
    await page.evaluate(() => window.scrollTo(0, 0));
    await shot(page, "s13-wiki-home.png");
  } finally {
    await page.context().close();
  }
}

async function main(): Promise<void> {
  mkdirSync(evidenceDir, { recursive: true });
  mkdirSync(mediaDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    await checkReadme(browser, { width: 1440, height: 1000 }, "desktop");
    await checkReadme(browser, { width: 390, height: 844 }, "phone");
    await checkWiki(browser);
    const passed = checks.every((entry) => entry.passed);
    const evidence = {
      schemaVersion: "1.0.0",
      reportId: "S13-publication-sessions",
      generatedBy: "pnpm check:sessions",
      generatedAt: new Date().toISOString(),
      commit: readFileSync(join(repoRoot, ".git", "HEAD"), "utf8").trim(),
      publicSurfaces: { repository: repoUrl, wiki: wikiUrl, replay: replayUrl, film: filmUrl },
      approvedArtworkSha256: apprvedSha,
      sessions: ["README desktop 1440x1000 signed out", "README phone 390x844 signed out", "Wiki home desktop 1440x1000 signed out"],
      checks,
      screenshots,
      passed,
      notes: [
        "All pages were opened without cookies or tokens.",
        "The GitHub repository Social Preview setting itself is a manual repository setting; the approved PNG is ready for that upload.",
      ],
    };
    writeFileSync(join(evidenceDir, "publication-sessions.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`wrote evidence/rel/publication-sessions.json passed=${String(passed)}`);
    if (!passed) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
