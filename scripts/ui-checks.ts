/**
 * Investor-journey UI checks (S12: UX-01/02/03).
 *
 * Serves the built browser app, then verifies with Playwright:
 *   - the recorded replay opens at the seed and Start replay / View outcome agree;
 *   - direct links and keyboard Home/End address the same states;
 *   - ordered portfolio values, six-decimal fund/spot quantities and the five-cent
 *     charge are visible in holdings, event effects, journal and receipt;
 *   - receipts show the "what changed" strip, source label, next event and evidence;
 *   - the pending subscription shows reserved cash, the blocking rule and the next action;
 *   - a 390 px viewport has no horizontal scrolling and keeps the values readable.
 *
 * Writes evidence/s12/investor-journey-checks.json and screenshots under docs/media/.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDir = join(repoRoot, "evidence", "s12");
const mediaDir = join(repoRoot, "docs", "media");
const port = Number(process.env.UI_CHECK_PORT ?? "8123");
const baseUrl = `http://127.0.0.1:${String(port)}/`;
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();

interface UiCheck {
  readonly id: string;
  readonly description: string;
  readonly passed: boolean;
  readonly detail: string;
}
const checks: UiCheck[] = [];
const screenshots: Array<{ file: string; sha256: string }> = [];
function check(id: string, description: string, passed: boolean, detail: string): void {
  checks.push({ id, description, passed, detail });
  console.log(`${passed ? "PASS" : "FAIL"} ${id}: ${detail}`);
}
function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function text(value: string | null): string {
  return value === null ? "" : value.replace(/\s+/g, " ").trim();
}
async function bodyText(page: Page): Promise<string> {
  return text(await page.locator("body").innerText());
}
async function shot(page: Page, name: string): Promise<void> {
  const path = join(mediaDir, name);
  await page.screenshot({ path, fullPage: false });
  screenshots.push({ file: `docs/media/${name}`, sha256: sha256File(path) });
}
async function waitForText(page: Page, fragment: string): Promise<void> {
  await page.getByText(fragment, { exact: false }).first().waitFor({ timeout: 15_000 });
}

async function desktopJourney(browser: Browser): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "en-GB" });
  const page = await context.newPage();
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  const seed = await bodyText(page);
  check("seed-initial-state", "recorded replay opens at the seed", page.url().endsWith("#replay/g01/0") && seed.includes("€1,000.00"), `url ${page.url()} spendable=${seed.includes("€1,000.00") ? "€1,000.00" : "missing"}`);
  check("seed-empty-holdings", "seed shows no funded holdings", seed.includes("0.000000") && !seed.includes("€799.95"), "holdings zero at the seed");
  await shot(page, "s12-seed-desktop.png");

  // Direct link to the fill event.
  await page.goto(`${baseUrl}#replay/g01/2`, { waitUntil: "networkidle" });
  await waitForText(page, "Spot order filled");
  const fill = await bodyText(page);
  check("direct-link-fill", "direct link restores the spot fill event", fill.includes("Spot order filled") && page.url().endsWith("#replay/g01/2"), "hash replay/g01/2 loads the fill");
  check("fill-spendable", "spendable cash after the fill is EUR 799.95", fill.includes("€799.95"), "€799.95");
  check("fill-quantity-six-decimals", "tWETH quantity uses six display decimals", fill.includes("0.100000") && !fill.includes("0.10 tWETH"), "0.100000 tWETH");
  check("fill-charge", "five-cent charge is visible in the event and receipt", fill.includes("0.05 dEUR") && fill.includes("€0.05"), "€0.05");
  const fillLower = fill.toLowerCase();
  check("fill-what-changed", "receipt shows the what-changed strip and source label", fillLower.includes("what changed") && fillLower.includes("fixture replay") && fillLower.includes("next event"), "what changed + source + next event");
  await shot(page, "s12-fill-desktop.png");

  // Walk the remaining events through the normal Next control.
  await page.getByRole("button", { name: "Next event" }).click();
  await waitForText(page, "Fund subscription reserved");
  const reserved = await bodyText(page);
  check("reserved-values", "reservation shows EUR 499.95 spendable and EUR 300.00 pending", reserved.includes("€499.95") && reserved.includes("€300.00"), "€499.95 / €300.00");
  check("held-order-detail", "held fund order shows reserved cash, blocking rule and next action", reserved.includes("reserved €300.00") && reserved.includes("blocking rule") && reserved.includes("next action"), "reserved + blocking rule + next action");
  await shot(page, "s12-reserved-desktop.png");

  await page.getByRole("button", { name: "Next event" }).click();
  await waitForText(page, "NAV observation recorded");
  await page.getByRole("button", { name: "Next event" }).click();
  await waitForText(page, "Fund units allocated");
  const allocated = await bodyText(page);
  check("allocated-values", "allocation shows EUR 499.95, zero pending and 3.125000 eFUND", allocated.includes("€499.95") && allocated.includes("3.125000") && allocated.includes("€0.00"), "€499.95 / 3.125000 / €0.00");
  check("allocated-receipt-units", "allocation receipt shows 3.125000 eFUND (not +3.12)", allocated.includes("3.125000 eFUND") && !allocated.includes("+3.12 eFUND"), "six-decimal receipt and movement");
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, "s12-allocated-desktop.png");
  await page.getByRole("link", { name: "Evidence" }).first().click();
  const evidenceOpen = await page.locator("#receipt-evidence").evaluate((element) => (element as HTMLDetailsElement).open);
  const evidenceText = await page.locator("#receipt-evidence").innerText();
  check("receipt-evidence", "evidence link opens canonical base units", evidenceOpen && evidenceText.includes("3125000"), "base units 3125000 visible");
  await shot(page, "s12-receipt-evidence.png");

  // Keyboard and jump controls address the same state.
  await page.keyboard.press("Home");
  await page.waitForTimeout(300);
  check("keyboard-home", "Home returns to the seed", page.url().endsWith("#replay/g01/0"), page.url());
  await page.keyboard.press("End");
  await page.waitForTimeout(300);
  check("keyboard-end", "End opens the outcome", page.url().endsWith("#replay/g01/5"), page.url());
  await page.getByRole("button", { name: "Start replay at the synthetic account seed" }).click();
  await page.waitForTimeout(300);
  check("start-button", "Start replay returns to the seed", page.url().endsWith("#replay/g01/0"), page.url());
  await page.getByRole("button", { name: "View the final outcome of this replay" }).click();
  await page.waitForTimeout(300);
  check("outcome-button", "View outcome opens the final event", page.url().endsWith("#replay/g01/5"), page.url());
  await context.close();
}

async function mobileJourney(browser: Browser): Promise<void> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, locale: "en-GB" });
  const page = await context.newPage();
  await page.goto(`${baseUrl}#replay/g01/5`, { waitUntil: "networkidle" });
  await waitForText(page, "Fund units allocated");
  const mobile = await bodyText(page);
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  check("mobile-no-horizontal-scroll", "390 px viewport has no horizontal scrolling", overflow.scrollWidth <= overflow.innerWidth, `scrollWidth ${String(overflow.scrollWidth)} / innerWidth ${String(overflow.innerWidth)}`);
  check("mobile-values", "390 px keeps values and reason readable", mobile.includes("€499.95") && mobile.includes("3.125000") && mobile.toLowerCase().includes("what changed"), "amounts + reason visible");
  await shot(page, "s12-mobile-allocated.png");
  await context.close();
}

async function main(): Promise<void> {
  mkdirSync(evidenceDir, { recursive: true });
  mkdirSync(mediaDir, { recursive: true });
  const server: ChildProcess = spawn("python3", ["-m", "http.server", String(port), "--bind", "127.0.0.1", "--directory", "apps/web/dist"], {
    cwd: repoRoot,
    stdio: "ignore",
  });
  const browser = await chromium.launch({ headless: true });
  try {
    // Wait for the static server.
    const started = Date.now();
    for (;;) {
      try {
        const response = await fetch(baseUrl);
        if (response.ok) break;
      } catch {
        // not ready yet
      }
      if (Date.now() - started > 20_000) throw new Error("static server did not start");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await desktopJourney(browser);
    await mobileJourney(browser);
    const passed = checks.every((entry) => entry.passed);
    const evidence = {
      schemaVersion: "1.0.0",
      reportId: "S12-investor-journey-ui-checks",
      generatedBy: "pnpm ui:checks",
      generatedAt: new Date().toISOString(),
      commit,
      baseUrl,
      browser: `chromium ${browser.version()}`,
      viewports: ["1440x1000", "390x844"],
      checks,
      screenshots,
      passed,
      notes: [
        "The app is served from the built browser replay; the API is not required for the recorded replay.",
        "These checks cover presentation and navigation only; amounts remain integer base units in the evidence inspector.",
      ],
    };
    writeFileSync(join(evidenceDir, "investor-journey-checks.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`wrote evidence/s12/investor-journey-checks.json passed=${String(passed)}`);
    if (!passed) process.exitCode = 1;
  } finally {
    await browser.close();
    server.kill("SIGTERM");
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
