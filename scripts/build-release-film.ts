/**
 * Build the required 60-second release film.
 *
 * The film is produced deterministically in five steps:
 *   cards   – 1280×640 social preview, intro frame and end card rendered from HTML;
 *   tts     – local Piper English voiceover, one clip per script segment, plus the
 *             WebVTT captions and the verbatim transcript;
 *   record  – Playwright records the G01 portfolio journey and the Policy Lab live
 *             model journey from the release build at a readable zoom, with a short
 *             cursor halo and one focus change per action;
 *   assemble– 150 intro frames + 1500 body frames + 150 end-card frames = exactly
 *             1800 frames at 30 fps, H.264/AAC 48 kHz, burned captions and a
 *             loudness-normalised narration track;
 *   verify  – frame count, duration, codecs, frame-range identity, loudness, end-card
 *             URL readability at 720p, signed-out public link checks and checksums.
 *
 * The narration script is the specification's 131-word script. The capture uses a
 * longer model attempt deadline than the product default because the local 4B model
 * on this host can exceed 15 s; the proposal itself is genuine model output and the
 * capture environment is recorded in the metadata.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const mediaDir = join(repoRoot, "media", "film");
const tmpDir = join(repoRoot, "tmp-film");
const cardsDir = join(tmpDir, "cards");
const ttsDir = join(tmpDir, "tts");
const recordDir = join(tmpDir, "record");
const buildDir = join(tmpDir, "build");
const webUrl = process.env.FILM_WEB_URL ?? "http://127.0.0.1:8080/";
const publicReplayUrl = process.env.PUBLIC_REPLAY_URL ?? "https://sergeyger.github.io/eurorollup-settlement-lab/";
const repoUrl = "https://github.com/SergeyGer/eurorollup-settlement-lab";
const piperBin = process.env.PIPER_BIN ?? "/tmp/piper/piper";
const piperVoice = process.env.PIPER_VOICE ?? "/tmp/piper-voices/en_GB-alan-medium.onnx";
const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string };
const COMMIT = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
const FPS = 30;
const INTRO_FRAMES = 150;
const BODY_FRAMES = 1500;
const END_FRAMES = 150;
const TOTAL_FRAMES = INTRO_FRAMES + BODY_FRAMES + END_FRAMES;
const DURATION_SECONDS = TOTAL_FRAMES / FPS;

interface ScriptSegment {
  readonly id: string;
  readonly start: number;
  readonly text: string;
}
const SEGMENTS: readonly ScriptSegment[] = [
  { id: "s0", start: 0, text: "EuroRollup shows how crypto trades and fund investments settle in euros." },
  { id: "s1", start: 5, text: "Starting with a thousand demo euros, I buy two hundred euros of test ether. The receipt shows the five-cent charge." },
  { id: "s2", start: 14, text: "My fund order waits for its valuation. At ninety-six euros per unit, three hundred euros buys three and one eighth units." },
  { id: "s3", start: 22, text: "Now I ask what happens if Friday's fund cutoff moves from four to three. The model turns my question into one proposed rule." },
  { id: "s4", start: 33, text: "I confirm the change and replay two orders. The earlier one still settles Friday. The three-thirty order now waits until Monday." },
  { id: "s5", start: 44, text: "That leaves three hundred extra euros reserved over the weekend. On Monday the later order receives three units. Both outcomes come with a reproducible record." },
  { id: "s6", start: 55, text: "Open the project on GitHub and replay the experiment yourself." },
];
const SEGMENT_SLOT: Record<string, number> = {
  s0: 5, s1: 9, s2: 8, s3: 11, s4: 11, s5: 11, s6: 5,
};

interface TtsTiming {
  readonly id: string;
  readonly start: number;
  readonly text: string;
  readonly duration: number;
  readonly atempo: number;
  readonly effective: number;
  readonly end: number;
}

function run(command: string, args: readonly string[], options: { cwd?: string; input?: string } = {}): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    input: options.input,
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr ?? "").slice(-1500)}`);
  }
  return result.stdout ?? "";
}
function ffmpeg(args: readonly string[]): void {
  run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args]);
}
function ffprobe(args: readonly string[]): string {
  return run("ffprobe", ["-v", "error", ...args]);
}
function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function ensureDirs(): void {
  for (const dir of [mediaDir, tmpDir, cardsDir, ttsDir, recordDir, buildDir]) mkdirSync(dir, { recursive: true });
}
function probeNumber(path: string, entries: string): number {
  const value = ffprobe(["-select_streams", "v:0", "-show_entries", entries, "-of", "default=nw=1:nk=1", path]).trim().split("\n")[0] ?? "0";
  return Number(value);
}

/* ------------------------------------------------------------------ cards --- */

const SOCIAL_PREVIEW_HTML = `<!doctype html><html><head><style>
*{box-sizing:border-box;margin:0;padding:0}body{font-family:'DejaVu Sans',system-ui,sans-serif;background:#0b1220;color:#e8eefc;display:flex;align-items:center;justify-content:center;width:100%;height:100%}
.card{width:1280px;height:640px;background:radial-gradient(1200px 600px at 15% 0%,#12305a 0%,#0b1220 55%,#0a0f19 100%);padding:56px 64px;display:flex;flex-direction:column;justify-content:space-between;border:1px solid #1e3a63}
.brand{display:flex;align-items:center;gap:22px}.logo{width:76px;height:76px;border-radius:20px;background:linear-gradient(135deg,#38e1c4,#2f7cf6);display:flex;align-items:center;justify-content:center;font-size:44px;font-weight:800;color:#04121e}
h1{font-size:52px;letter-spacing:-.5px;font-weight:800} .sub{margin-top:6px;font-size:22px;color:#a9bce0}
.rows{display:flex;gap:28px;margin-top:8px}.asset{flex:1;background:#111e34;border:1px solid #24405f;border-radius:16px;padding:22px 26px}
.asset .sym{font-size:26px;font-weight:700;color:#7fe9d2}.asset .name{font-size:17px;color:#9fb3d9;margin-top:2px}.asset .val{font-size:34px;font-weight:800;margin-top:10px}
.foot{display:flex;justify-content:space-between;color:#8aa0c8;font-size:18px}.tag{color:#7fe9d2}
</style></head><body><div class="card"><div class="brand"><div class="logo">€</div><div><h1>EuroRollup Settlement Lab</h1><div class="sub">Euro settlement sandbox for crypto trades and tokenized fund orders</div></div></div>
<div class="rows"><div class="asset"><div class="sym">tWETH</div><div class="name">test wrapped ETH</div><div class="val">€2,000.00</div></div><div class="asset"><div class="sym">eFUND</div><div class="name">fictional bond fund unit</div><div class="val">€96.00</div></div></div>
<div class="foot"><span>Synthetic data · recorded fixtures · public replay</span><span class="tag">Settlement · Policy Lab · Economics</span></div></div></body></html>`;

function introHtml(previewBase64: string): string {
  return `<!doctype html><html><head><style>
*{box-sizing:border-box;margin:0;padding:0}body{background:#05080e;display:flex;align-items:center;justify-content:center;width:100%;height:100%}
.frame{width:1920px;height:1080px;display:flex;align-items:center;justify-content:center;background:radial-gradient(1400px 800px at 50% 40%,#0d1b31 0%,#05080e 70%)}
.preview{width:1728px;height:864px;border:1px solid #24405f;border-radius:8px;overflow:hidden}
</style></head><body><div class="frame"><div class="preview"><img src="data:image/png;base64,${previewBase64}" style="width:100%;height:100%;display:block"></div></div></body></html>`;
}

function endCardHtml(): string {
  return `<!doctype html><html><head><style>
*{box-sizing:border-box;margin:0;padding:0}body{font-family:'DejaVu Sans',system-ui,sans-serif;background:#070c15;color:#e8eefc;width:100%;height:100%}
.card{width:100%;height:100%;background:radial-gradient(1400px 700px at 50% 30%,#0f2747 0%,#070c15 70%);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:30px;text-align:center;padding:0 96px}
h1{font-size:84px;font-weight:800;letter-spacing:-1px}.line{font-size:40px;color:#c8d6f2;max-width:1400px}
.url{font-size:56px;font-weight:700;color:#7fe9d2;white-space:nowrap;letter-spacing:.2px}
.note{font-size:26px;color:#8aa0c8;margin-top:8px}.rule{width:220px;height:4px;background:linear-gradient(90deg,#38e1c4,#2f7cf6);border-radius:2px}
</style></head><body><div class="card"><div class="rule"></div><h1>EuroRollup Settlement Lab</h1><div class="line">Open the project on GitHub and replay the experiment yourself.</div><div class="url" id="repo-url">github.com/SergeyGer/eurorollup-settlement-lab</div><div class="note">Synthetic data only · recorded from the release build</div></div></body></html>`;
}

async function stepCards(): Promise<void> {
  console.log("[cards] rendering the social preview, intro frame and end card");
  const browser = await chromium.launch({ headless: true });
  try {
    const socialPage = await browser.newPage({ viewport: { width: 1280, height: 640 } });
    await socialPage.setContent(SOCIAL_PREVIEW_HTML, { waitUntil: "load" });
    await socialPage.screenshot({ path: join(cardsDir, "social-preview-1280x640.png") });
    await socialPage.close();
    const previewBase64 = readFileSync(join(cardsDir, "social-preview-1280x640.png")).toString("base64");
    const introPage = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await introPage.setContent(introHtml(previewBase64), { waitUntil: "load" });
    await introPage.screenshot({ path: join(cardsDir, "intro-1920x1080.png") });
    await introPage.close();
    const endPage = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await endPage.setContent(endCardHtml(), { waitUntil: "load" });
    await endPage.screenshot({ path: join(cardsDir, "end-card-1920x1080.png") });
    // Readability at 720p: same design rendered at 1280x720 and measured in the DOM.
    const endPage720 = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await endPage720.setContent(endCardHtml(), { waitUntil: "load" });
    const measure = await endPage720.evaluate(() => {
      const element = document.getElementById("repo-url")!;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
      // The film is a 1080p design; at 720p playback it is scaled by 720/1080.
      const scale720 = 720 / 1080;
      const widthAt720p = Math.round(rect.width * scale720);
      return {
        text: element.textContent ?? "",
        widthPx: widthAt720p,
        heightPx: Math.round(rect.height * scale720),
        fontSizePx: Math.round(parseFloat(style.fontSize) * scale720),
        singleLine: rect.height <= lineHeight * 1.5,
        withinViewport: widthAt720p + 2 * Math.round(1280 * 0.05) <= 1280,
      };
    });
    await endPage720.screenshot({ path: join(cardsDir, "end-card-720p.png") });
    await endPage720.close();
    writeFileSync(join(cardsDir, "card-checks.json"), `${JSON.stringify({ endCardUrlAt720p: measure }, null, 2)}\n`);
    console.log(`[cards] end-card URL at 720p: ${String(measure.widthPx)}px singleLine=${String(measure.singleLine)}`);
  } finally {
    await browser.close();
  }
  const mediaNames: Record<string, string> = {
    "social-preview-1280x640.png": "social-preview-1280x640.png",
    "intro-1920x1080.png": "intro-frame-1920x1080.png",
    "end-card-1920x1080.png": "end-card-1920x1080.png",
  };
  for (const [source, destination] of Object.entries(mediaNames)) {
    writeFileSync(join(mediaDir, destination), readFileSync(join(cardsDir, source)));
  }
}

/* --------------------------------------------------------------------- tts --- */

function stepTts(): void {
  console.log("[tts] generating the English narration and captions");
  if (!existsSync(piperBin) || !existsSync(piperVoice)) {
    throw new Error(`Piper is required: set PIPER_BIN/PIPER_VOICE (looked at ${piperBin} and ${piperVoice})`);
  }
  const timings: TtsTiming[] = [];
  SEGMENTS.forEach((segment, index) => {
    const wav = join(ttsDir, `${segment.id}.wav`);
    run(piperBin, ["--model", piperVoice, "--output_file", wav], { input: segment.text });
    const duration = Number(ffprobe(["-show_entries", "format=duration", "-of", "default=nw=1:nk=1", wav]).trim());
    const nextStart = index + 1 < SEGMENTS.length ? SEGMENTS[index + 1]!.start : DURATION_SECONDS;
    const slot = nextStart - segment.start;
    const ratio = duration / slot;
    const atempo = ratio > 1.0 ? Math.round(ratio * 1.02 * 1000) / 1000 : 1.0;
    const effective = duration / atempo;
    timings.push({ id: segment.id, start: segment.start, text: segment.text, duration, atempo, effective, end: segment.start + effective });
  });
  writeFileSync(join(tmpDir, "tts-timing.json"), `${JSON.stringify(timings, null, 2)}\n`);
  const vtt = ["WEBVTT", ""];
  for (const timing of timings) {
    const end = Math.min(DURATION_SECONDS, timing.start + SEGMENT_SLOT[timing.id]!);
    vtt.push(`${formatTimestamp(timing.start)} --> ${formatTimestamp(end)}`, timing.text, "");
  }
  writeFileSync(join(mediaDir, "release-film.vtt"), vtt.join("\n"));
  // Burn-in captions use an explicit ASS canvas so the font size is real pixels at
  // 1080p, with a 5% safe margin (96 px horizontal, 60 px vertical).
  const ass = [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 1920",
    "PlayResY: 1080",
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Film,DejaVu Sans,36,&H00FFFFFF,&H000000FF,&HAA04121E,&H661E1204,0,0,0,0,100,100,0,0,3,1,0,2,96,96,60,1",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...timings.map((timing) => {
      const end = Math.min(DURATION_SECONDS, timing.start + SEGMENT_SLOT[timing.id]!);
      return `Dialogue: 0,${assTimestamp(timing.start)},${assTimestamp(end)},Film,,0,0,0,,${timing.text}`;
    }),
    "",
  ].join("\n");
  writeFileSync(join(mediaDir, "release-film.ass"), ass);
  const transcript = [
    "# Release film transcript",
    "",
    "English narration, verbatim. 131 words, approximately 60 seconds.",
    "",
    ...timings.map((timing) => `**${formatTimestamp(timing.start).slice(3, 8)}** — ${timing.text}`),
    "",
    "Captions: `release-film.vtt`. Film: `release-film.mp4` (attached to the GitHub Release).",
    "",
  ];
  writeFileSync(join(mediaDir, "release-film-transcript.md"), transcript.join("\n"));
  console.log(`[tts] ${String(timings.length)} segments, closing line ends at ${timings[timings.length - 1]!.end.toFixed(2)}s`);
}

function assTimestamp(seconds: number): string {
  const centi = Math.round(seconds * 100);
  const total = Math.floor(centi / 100);
  const cs = centi % 100;
  const hh = String(Math.floor(total / 3600)).padStart(1, "0");
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}.${String(cs).padStart(2, "0")}`;
}

function formatTimestamp(seconds: number): string {
  const whole = Math.floor(seconds);
  const ms = Math.round((seconds - whole) * 1000);
  const hh = String(Math.floor(whole / 3600)).padStart(2, "0");
  const mm = String(Math.floor((whole % 3600) / 60)).padStart(2, "0");
  const ss = String(whole % 60).padStart(2, "0");
  return `${hh}:${mm}:${ss}.${String(ms).padStart(3, "0")}`;
}

/* ----------------------------------------------------------------- record --- */

const CURSOR_CSS = `
#film-cursor{position:fixed;left:0;top:0;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;
 border:3px solid rgba(127,233,210,.95);box-shadow:0 0 26px 10px rgba(127,233,210,.38),0 0 0 2px rgba(4,18,30,.55);
 background:radial-gradient(circle,rgba(127,233,210,.30) 0%,rgba(127,233,210,.06) 65%,rgba(127,233,210,0) 70%);
 pointer-events:none;z-index:2147483000;transition:left .32s ease,top .32s ease,transform .12s ease}
#film-cursor.clicked{transform:scale(.72)}
.film-focus{outline:3px solid rgba(127,233,210,.9) !important;outline-offset:5px;border-radius:12px;
 box-shadow:0 0 0 9px rgba(127,233,210,.14),0 0 40px rgba(127,233,210,.25) !important;transition:box-shadow .25s,outline-color .25s}
`;

import type { Locator } from "playwright";

async function injectFilmOverlay(page: Page, index: string): Promise<Locator> {
  await page.addStyleTag({ content: CURSOR_CSS });
  await page.evaluate((label) => {
    const cursor = document.createElement("div");
    cursor.id = "film-cursor";
    cursor.dataset.index = label;
    document.body.appendChild(cursor);
    cursor.style.left = "50%";
    cursor.style.top = "55%";
  }, index);
  return page.locator("#film-cursor");
}

async function moveCursor(cursor: Locator, target: Locator, click = false): Promise<void> {
  const box = await target.boundingBox();
  if (box === null) return;
  const x = Math.round(box.x + Math.min(box.width * 0.5, 260));
  const y = Math.round(box.y + Math.max(18, box.height * 0.5));
  await cursor.evaluate((element, position) => {
    const node = element as HTMLElement;
    node.style.left = `${String(position.x)}px`;
    node.style.top = `${String(position.y)}px`;
  }, { x, y });
  await cursor.page().waitForTimeout(420);
  if (click) {
    await cursor.evaluate((element) => (element as HTMLElement).classList.add("clicked"));
    await cursor.page().waitForTimeout(120);
    await target.click();
    await cursor.evaluate((element) => (element as HTMLElement).classList.remove("clicked"));
  }
}

async function setFocus(page: Page, target: Locator | null, previous: Locator | null): Promise<void> {
  if (previous !== null) await previous.evaluate((element) => (element as HTMLElement).classList.remove("film-focus")).catch(() => undefined);
  if (target !== null) await target.evaluate((element) => (element as HTMLElement).classList.add("film-focus")).catch(() => undefined);
  await page.waitForTimeout(260);
}

interface RecordingTimeline {
  file: string;
  start: number;
  end: number;
  marks: Record<string, number>;
}

async function recordBrowserVideo(
  label: string,
  estimateMs: number,
  script: (page: Page, cursor: Locator, timeline: RecordingTimeline) => Promise<void>,
): Promise<RecordingTimeline> {
  mkdirSync(recordDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    recordVideo: { dir: recordDir, size: { width: 1920, height: 1080 } },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  const cursor = await (async () => {
    await page.goto(webUrl, { waitUntil: "networkidle" });
    return injectFilmOverlay(page, label);
  })();
  const started = Date.now();
  const timeline: RecordingTimeline = { file: "", start: started, end: started, marks: {} };
  try {
    await script(page, cursor, timeline);
  } finally {
    timeline.end = Date.now();
    const video = page.video();
    await context.close();
    await browser.close();
    const path = await video!.path();
    (timeline as { file: string }).file = path;
    writeFileSync(join(recordDir, `${label}.timeline.json`), `${JSON.stringify(timeline, null, 2)}\n`);
    console.log(`[record] ${label}: ${((timeline.end - timeline.start) / 1000).toFixed(1)}s (estimated ${(estimateMs / 1000).toFixed(0)}s)`);
  }
  return timeline;
}

async function stepRecord(): Promise<void> {
  console.log(`[record] recording from ${webUrl}`);
  // Portfolio journey (used as the first 17 s of the body).
  await recordBrowserVideo("portfolio", 20_000, async (page, cursor, timeline) => {
    const spendable = page.locator(".cash-card").first();
    const fillStep = page.getByRole("button", { name: /Spot order filled/ });
    await page.waitForTimeout(400);
    await moveCursor(cursor, fillStep);
    await setFocus(page, fillStep, null);
    await moveCursor(cursor, fillStep, true);
    timeline.marks["spotFill"] = Date.now();
    await page.waitForTimeout(900);
    const receipt = page.locator(".receipt").first();
    if ((await receipt.count()) > 0) {
      await setFocus(page, receipt, fillStep);
      await moveCursor(cursor, receipt);
      await page.waitForTimeout(2200);
    }
    await setFocus(page, spendable, receipt);
    await moveCursor(cursor, spendable);
    await page.waitForTimeout(2000);
    const reserveStep = page.getByRole("button", { name: /Fund subscription reserved/ });
    await moveCursor(cursor, reserveStep);
    await setFocus(page, reserveStep, spendable);
    await moveCursor(cursor, reserveStep, true);
    timeline.marks["fundReserved"] = Date.now();
    await page.waitForTimeout(1400);
    const allocateStep = page.getByRole("button", { name: /Fund units allocated/ });
    await moveCursor(cursor, allocateStep);
    await setFocus(page, allocateStep, reserveStep);
    await moveCursor(cursor, allocateStep, true);
    timeline.marks["fundAllocated"] = Date.now();
    await page.waitForTimeout(900);
    const units = page.getByText(/3\.125000 eFUND units/).first();
    if ((await units.count()) > 0) {
      await setFocus(page, units, allocateStep);
      await moveCursor(cursor, units);
      await page.waitForTimeout(2400);
    }
    const fundReceipt = page.locator(".receipt").last();
    if ((await fundReceipt.count()) > 0) {
      await setFocus(page, fundReceipt, units);
      await moveCursor(cursor, fundReceipt);
      await page.waitForTimeout(2600);
    }
    await page.waitForTimeout(800);
  });

  // Policy Lab journey: live model question, genuine proposal, confirmation and impact.
  await recordBrowserVideo("policy", 75_000, async (page, cursor, timeline) => {
    await page.getByRole("button", { name: "AI Policy Lab" }).click();
    await page.waitForTimeout(500);
    const liveTab = page.getByRole("tab", { name: "Live local model" });
    await moveCursor(cursor, liveTab);
    await setFocus(page, liveTab, null);
    await moveCursor(cursor, liveTab, true);
    timeline.marks["liveTab"] = Date.now();
    await page.waitForTimeout(400);
    const textarea = page.locator("textarea");
    await setFocus(page, textarea, liveTab);
    await moveCursor(cursor, textarea);
    await page.waitForTimeout(300);
    await textarea.fill("What if the fund moved its Friday cutoff from 16:00 to 15:00 UTC?");
    timeline.marks["questionTyped"] = Date.now();
    const ask = page.getByRole("button", { name: /Ask local model/ });
    await moveCursor(cursor, ask);
    await setFocus(page, ask, textarea);
    timeline.marks["questionReady"] = Date.now();
    await moveCursor(cursor, ask, true);
    timeline.marks["askClicked"] = Date.now();
    await page.getByText("2 · Review proposal").waitFor({ timeout: 180_000 });
    timeline.marks["draftVisible"] = Date.now();
    await page.waitForTimeout(900);
    const proposal = page.getByText(/proposed cutoff/i).first();
    if ((await proposal.count()) > 0) {
      await setFocus(page, proposal, ask);
      await moveCursor(cursor, proposal);
      await page.waitForTimeout(1400);
    }
    const confirm = page.getByRole("button", { name: /Confirm and compare/ });
    await moveCursor(cursor, confirm);
    await setFocus(page, confirm, proposal);
    await moveCursor(cursor, confirm, true);
    timeline.marks["confirmClicked"] = Date.now();
    await page.getByText("3 · Impact").waitFor({ timeout: 120_000 });
    timeline.marks["impactVisible"] = Date.now();
    await page.waitForTimeout(1000);
    const extraReserved = page.getByText(/extra cash reserved/i).first();
    if ((await extraReserved.count()) > 0) {
      await setFocus(page, extraReserved, confirm);
      await moveCursor(cursor, extraReserved);
      await page.waitForTimeout(2200);
    }
    const rows = page.locator("table.order-table tbody tr");
    const firstRow = rows.nth(0);
    const secondRow = rows.nth(1);
    if ((await secondRow.count()) > 0) {
      await moveCursor(cursor, firstRow);
      await setFocus(page, firstRow, extraReserved);
      await page.waitForTimeout(1800);
      await moveCursor(cursor, secondRow);
      await setFocus(page, secondRow, firstRow);
      await page.waitForTimeout(2600);
    }
    const mondayCard = page.getByText(/monday 17:01 utc close/i).first();
    if ((await mondayCard.count()) > 0) {
      await mondayCard.scrollIntoViewIfNeeded();
      await moveCursor(cursor, mondayCard);
      await setFocus(page, mondayCard, secondRow);
      await page.waitForTimeout(2600);
    }
    const download = page.getByRole("button", { name: /Download comparison pack/ });
    if ((await download.count()) > 0) {
      await download.scrollIntoViewIfNeeded();
      await moveCursor(cursor, download);
      await setFocus(page, download, mondayCard);
      await page.waitForTimeout(1600);
      await moveCursor(cursor, download, true);
      timeline.marks["evidenceOpened"] = Date.now();
      await page.waitForTimeout(1800);
    }
  });
}

/* --------------------------------------------------------------- assemble --- */

function framesFromImage(image: string, frames: number, out: string): void {
  ffmpeg([
    "-loop", "1", "-i", image,
    "-t", String(frames / FPS), "-r", String(FPS), "-frames:v", String(frames),
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart", out,
  ]);
}

function stepAssemble(): void {
  console.log("[assemble] building exactly 1800 frames");
  const timings = JSON.parse(readFileSync(join(tmpDir, "tts-timing.json"), "utf8")) as TtsTiming[];
  const portfolio = JSON.parse(readFileSync(join(recordDir, "portfolio.timeline.json"), "utf8")) as RecordingTimeline;
  const policy = JSON.parse(readFileSync(join(recordDir, "policy.timeline.json"), "utf8")) as RecordingTimeline;
  // Recording-relative offsets (video starts approximately when the recording page
  // is created; the first interaction happens ~0.4 s in).
  const videoStart = (timeline: RecordingTimeline, mark: string): number => Math.max(0, (timeline.marks[mark]! - timeline.start) / 1000 - 0.4);
  const portfolioStart = videoStart(portfolio, "spotFill") - 0.3;
  const policyAsk = videoStart(policy, "askClicked");
  const draftVisible = videoStart(policy, "draftVisible");
  const confirmClicked = videoStart(policy, "confirmClicked");
  // Body composition: 17 s portfolio + 5 s question + 3 s draft + 25 s impact.
  const bodyParts: Array<{ file: string; start: number; frames: number }> = [
    { file: portfolio.file, start: portfolioStart, frames: 510 },
    { file: policy.file, start: Math.max(0, policyAsk - 3.4), frames: 150 },
    { file: policy.file, start: Math.max(0, draftVisible - 1.2), frames: 90 },
    { file: policy.file, start: Math.max(0, confirmClicked - 1.6), frames: 750 },
  ];
  const inputs = bodyParts.flatMap((part) => ["-i", part.file]);
  const filters = bodyParts.map((part, index) => {
    const frames = part.frames;
    // Playwright records the 1600x900 viewport on a 1920x1080 canvas with padding;
    // crop the viewport content first, then upscale 1.2x for readable zoom.
    return `[${String(index)}:v]crop=1600:900:0:0,scale=1920:1080,fps=${String(FPS)},trim=start=${part.start.toFixed(3)},setpts=PTS-STARTPTS,setsar=1,tpad=stop_mode=clone:stop_duration=20,trim=start_frame=0:end_frame=${String(frames)},setpts=PTS-STARTPTS[v${String(index)}]`;
  });
  const concat = `${bodyParts.map((_, index) => `[v${String(index)}]`).join("")}concat=n=${String(bodyParts.length)}:v=1:a=0[body]`;
  ffmpeg([
    ...inputs,
    "-filter_complex", `${filters.join(";")};${concat}`,
    "-map", "[body]", "-r", String(FPS), "-frames:v", String(BODY_FRAMES),
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
    join(buildDir, "body.mp4"),
  ]);
  console.log(`[assemble] body frames: ${String(probeNumber(join(buildDir, "body.mp4"), "stream=nb_frames"))}`);
  framesFromImage(join(cardsDir, "intro-1920x1080.png"), INTRO_FRAMES, join(buildDir, "intro.mp4"));
  framesFromImage(join(cardsDir, "end-card-1920x1080.png"), END_FRAMES, join(buildDir, "end.mp4"));
  writeFileSync(join(buildDir, "concat.txt"), ["intro.mp4", "body.mp4", "end.mp4"].map((name) => `file '${join(buildDir, name)}'`).join("\n"));
  ffmpeg(["-f", "concat", "-safe", "0", "-i", join(buildDir, "concat.txt"), "-c", "copy", join(buildDir, "silent.mp4")]);
  console.log(`[assemble] silent frames: ${String(probeNumber(join(buildDir, "silent.mp4"), "stream=nb_frames"))}`);

  // Narration: resample each Piper clip to 48 kHz stereo, time-compress where needed,
  // place it at its script offset and mix without normalisation surprises.
  const audioInputs: string[] = [];
  const audioFilters: string[] = [];
  timings.forEach((timing, index) => {
    const resampled = join(buildDir, `tts-${timing.id}.wav`);
    ffmpeg(["-i", join(ttsDir, `${timing.id}.wav`), "-filter:a", `atempo=${timing.atempo.toFixed(3)},aresample=48000`, "-ac", "2", resampled]);
    audioInputs.push("-i", resampled);
    const delayMs = Math.round(timing.start * 1000);
    audioFilters.push(`[${String(index)}:a]adelay=${String(delayMs)}|${String(delayMs)}[a${String(index)}]`);
  });
  const mix = `${timings.map((_, index) => `[a${String(index)}]`).join("")}amix=inputs=${String(timings.length)}:duration=longest:normalize=0,loudnorm=I=-16:TP=-1:LRA=11[a]`;
  ffmpeg([...audioInputs, "-filter_complex", `${audioFilters.join(";")};${mix}`, "-map", "[a]", "-t", String(DURATION_SECONDS), "-ar", "48000", "-ac", "2", join(buildDir, "narration.wav")]);

  // Burn captions, encode H.264 30 fps and mux the AAC narration.
  // ffmpeg filter path escaping: backslash, colon and quote are the metacharacters
  // of the filter argument; escape all of them explicitly.
  const subtitlePath = join(mediaDir, "release-film.ass").replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
  ffmpeg([
    "-i", join(buildDir, "silent.mp4"),
    "-i", join(buildDir, "narration.wav"),
    "-filter_complex", `[0:v]subtitles='${subtitlePath}'[v]`,
    "-map", "[v]", "-map", "1:a",
    "-r", String(FPS), "-frames:v", String(TOTAL_FRAMES),
    "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-ar", "48000", "-ac", "2", "-b:a", "192k",
    "-movflags", "+faststart", "-t", String(DURATION_SECONDS),
    join(mediaDir, "release-film.mp4"),
  ]);
  console.log(`[assemble] film frames: ${String(probeNumber(join(mediaDir, "release-film.mp4"), "stream=nb_frames"))}`);
}

/* ----------------------------------------------------------------- verify --- */

interface Check {
  readonly id: string;
  readonly label: string;
  readonly passed: boolean;
  readonly detail: string;
}
const checks: Check[] = [];
function check(id: string, label: string, passed: boolean, detail: string): void {
  checks.push({ id, label, passed, detail });
  console.log(`[verify] ${passed ? "PASS" : "FAIL"} ${id}: ${detail}`);
}

async function stepVerify(): Promise<void> {
  console.log("[verify] checking the film, media metadata and public links");
  const timings = JSON.parse(readFileSync(join(tmpDir, "tts-timing.json"), "utf8")) as TtsTiming[];
  const filmPath = join(mediaDir, "release-film.mp4");
  const probe = JSON.parse(
    ffprobe(["-show_streams", "-show_format", "-of", "json", filmPath]),
  ) as { streams: Array<Record<string, any>>; format: Record<string, any> };
  const video = probe.streams.find((stream) => stream["codec_type"] === "video")!;
  const audio = probe.streams.find((stream) => stream["codec_type"] === "audio");
  const nbFrames = Number(video["nb_frames"]);
  const duration = Number(probe.format["duration"]);
  const raster = `${String(video["width"])}x${String(video["height"])}`;
  const frameRate = String(video["r_frame_rate"]);
  check("video-resolution", "1920x1080 H.264", raster === "1920x1080" && video["codec_name"] === "h264", `${raster} ${String(video["codec_name"])} ${String(video["pix_fmt"])}`);
  check("video-frames", "exactly 1800 frames", nbFrames === TOTAL_FRAMES, `${String(nbFrames)} frames`);
  check("video-duration", "exactly 60.0 seconds", Math.abs(duration - DURATION_SECONDS) <= 0.05, `${duration.toFixed(3)} s`);
  check("video-fps", "constant 30 fps", frameRate === "30/1", frameRate);
  check("audio-stream", "AAC 48 kHz stereo", audio !== undefined && audio["codec_name"] === "aac" && Number(audio["sample_rate"]) === 48000 && Number(audio["channels"]) === 2, audio === undefined ? "missing audio" : `${String(audio["codec_name"])} ${String(audio["sample_rate"])} Hz ${String(audio["channels"])} ch`);

  // Static ranges: the opening and closing five seconds must be static cards. The
  // video is lossy, so compare broadcast-similar decoded frames with SSIM rather
  // than exact hashes, and confirm the body differs from the opening card.
  const framePath = (frame: number): string => {
    const out = join(buildDir, `frame-${String(frame)}.png`);
    ffmpeg(["-i", filmPath, "-vf", `select=eq(n\\,${String(frame)})`, "-frames:v", "1", out]);
    return out;
  };
  const ssim = (first: string, second: string): number => {
    const result = spawnSync("ffmpeg", ["-hide_banner", "-i", first, "-i", second, "-lavfi", "ssim", "-f", "null", "-"], { encoding: "utf8" });
    const match = /All:\s*([0-9.]+)/.exec(result.stderr ?? "");
    return match === null ? 0 : Number(match[1]);
  };
  const [frame0, frame149, frame150, frame1650, frame1724, frame1799] = [0, 149, 150, 1650, 1724, 1799].map(framePath);
  const introSsim = ssim(frame0!, frame149!);
  const endSsim = ssim(frame1650!, frame1799!);
  const endSsim2 = ssim(frame1724!, frame1799!);
  const introVsBody = ssim(frame149!, frame150!);
  check("intro-range", "frames 0-149 show the static social preview", introSsim > 0.999 && introVsBody < 0.98, `SSIM ${introSsim.toFixed(4)} (body ${introVsBody.toFixed(3)})`);
  check("end-range", "frames 1650-1799 show the uninterrupted repository card", endSsim > 0.999 && endSsim2 > 0.999, `SSIM ${endSsim.toFixed(4)} / ${endSsim2.toFixed(4)}, ${String(END_FRAMES / FPS)} s`);

  // Loudness: integrated around -16 LUFS, true peak at most -1 dBTP.
  const loudnessRun = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", filmPath, "-map", "0:a", "-af", "ebur128=peak=true", "-f", "null", "-"], { encoding: "utf8" });
  const loudnessText = loudnessRun.stderr;
  const integratedMatches = [...loudnessText.matchAll(/I:\s+(-?[0-9.]+) LUFS/g)];
  const peakMatches = [...loudnessText.matchAll(/Peak:\s+(-?[0-9.]+) dBFS/g)];
  const integrated = integratedMatches.length === 0 ? Number.NaN : Number(integratedMatches[integratedMatches.length - 1]![1]);
  const truePeak = peakMatches.length === 0 ? Number.NaN : Number(peakMatches[peakMatches.length - 1]![1]);
  check("loudness-integrated", "about -16 LUFS integrated", Math.abs(integrated + 16) <= 2, `${integrated.toFixed(1)} LUFS`);
  check("loudness-true-peak", "at most -1 dBTP", truePeak <= -1, `${truePeak.toFixed(1)} dBTP`);

  // End-card URL single-line readability at 720p.
  const cardChecks = JSON.parse(readFileSync(join(cardsDir, "card-checks.json"), "utf8")) as { endCardUrlAt720p: { widthPx: number; singleLine: boolean; withinViewport: boolean } };
  const card = cardChecks.endCardUrlAt720p;
  check("end-card-url", "repository URL readable on one line at 720p", card.singleLine && card.withinViewport, `${String(card.widthPx)}px wide, singleLine=${String(card.singleLine)}`);

  // Signed-out public link checks.
  const links = await Promise.all([publicReplayUrl, repoUrl].map(async (url) => {
    const response = await fetch(url, { redirect: "follow" });
    return { url, statusCode: response.status };
  }));
  check("public-links", "public links verified signed out", links.every((link) => link.statusCode === 200), links.map((link) => `${link.url} ${String(link.statusCode)}`).join(", "));

  // Captions and transcript exist and match the script.
  const vtt = readFileSync(join(mediaDir, "release-film.vtt"), "utf8");
  const transcript = readFileSync(join(mediaDir, "release-film-transcript.md"), "utf8");
  const cues = (vtt.match(/--!?>/g) ?? []).length;
  const narrationMatches = SEGMENTS.every((segment) => vtt.includes(segment.text) && transcript.includes(segment.text));
  check("captions", "English WebVTT with every script line", cues === SEGMENTS.length && narrationMatches, `${String(cues)} cues`);
  check("transcript", "verbatim English transcript", transcript.includes("Release film transcript") && narrationMatches, "all 131 script words present");
  const wordCount = SEGMENTS.map((segment) => segment.text).join(" ").trim().split(/\s+/).length;
  check("script-words", "131-word script", wordCount === 131, `${String(wordCount)} words`);

  const passed = checks.every((entry) => entry.passed);
  const checksums = {
    film: sha256File(filmPath),
    captions: sha256File(join(mediaDir, "release-film.vtt")),
    transcript: sha256File(join(mediaDir, "release-film-transcript.md")),
    socialPreview: sha256File(join(cardsDir, "social-preview-1280x640.png")),
    endCard: sha256File(join(cardsDir, "end-card-1920x1080.png")),
  };
  const metadata = {
    schemaVersion: "1.0.0",
    reportId: "S10-release-film",
    generatedBy: "pnpm film:build",
    generatedAt: new Date().toISOString(),
    version: packageJson.version,
    commit: COMMIT,
    film: {
      file: "media/film/release-film.mp4",
      assetName: `eurollup-release-film-${packageJson.version}.mp4`,
      bytes: statSync(filmPath).size,
      sha256: checksums.film,
      frameCount: nbFrames,
      width: Number(video["width"]),
      height: Number(video["height"]),
      fps: frameRate,
      durationSeconds: Number(duration.toFixed(3)),
      videoCodec: String(video["codec_name"]),
      audioCodec: audio === undefined ? null : String(audio["codec_name"]),
      audioSampleRate: audio === undefined ? null : Number(audio["sample_rate"]),
      audioChannels: audio === undefined ? null : Number(audio["channels"]),
    },
    ranges: {
      socialPreview: { fromFrame: 0, toFrame: 149, seconds: 5 },
      body: { fromFrame: 150, toFrame: 1649, seconds: 50 },
      repositoryCard: { fromFrame: 1650, toFrame: 1799, seconds: 5, url: "github.com/SergeyGer/eurorollup-settlement-lab" },
    },
    narration: {
      scriptWords: wordCount,
      segments: timings.map((timing) => ({ id: timing.id, start: timing.start, end: Number(timing.end.toFixed(3)), text: timing.text })),
      closingLineEndsAtSeconds: Number(timings[timings.length - 1]!.end.toFixed(3)),
      loudnessIntegratedLufs: Number(integrated.toFixed(1)),
      truePeakDbtp: Number(truePeak.toFixed(1)),
    },
    captions: {
      file: "media/film/release-film.vtt",
      sha256: checksums.captions,
      cueCount: cues,
      safeMarginPercent: 5,
      burnedIn: true,
    },
    transcript: { file: "media/film/release-film-transcript.md", sha256: checksums.transcript },
    socialPreview: {
      designFile: "media/film/social-preview-1280x640.png",
      sha256: checksums.socialPreview,
      size: "1280x640",
      introFrame: "media/film/intro-frame-1920x1080.png",
    },
    endCard: {
      designFile: "media/film/end-card-1920x1080.png",
      sha256: checksums.endCard,
      url: "github.com/SergeyGer/eurorollup-settlement-lab",
      urlSingleLineAt720p: card.singleLine,
      urlWidthAt720p: card.widthPx,
      durationSeconds: 5,
      frames: "1650-1799",
    },
    captureEnvironment: {
      browser: "Chromium (Playwright)",
      viewport: "1600x900 recorded at 1920x1080, 1.2x readable zoom",
      model: "qwen3:4b via local Ollama (genuine live proposal)",
      modelTimeoutMs: 45000,
      modelTimeoutNote: "capture-only attempt deadline; the product default remains 15 s and is covered by A09 evidence",
      tts: "Piper en_GB-alan-medium local voice",
    },
    publicLinks: links,
    checks,
    passed,
  };
  writeFileSync(join(mediaDir, "film-metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  console.log(`[verify] film passed=${String(passed)}`);
  if (!passed) process.exitCode = 1;
}

/* ------------------------------------------------------------------- main --- */

async function main(): Promise<void> {
  ensureDirs();
  const steps = (process.env.FILM_STEPS ?? "cards,tts,record,assemble,verify").split(",").map((step) => step.trim());
  if (steps.includes("cards")) await stepCards();
  if (steps.includes("tts")) stepTts();
  if (steps.includes("record")) await stepRecord();
  if (steps.includes("assemble")) stepAssemble();
  if (steps.includes("verify")) await stepVerify();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
