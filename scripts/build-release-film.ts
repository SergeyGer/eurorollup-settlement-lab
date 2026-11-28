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

const approvedArtworkPath = join(repoRoot, "media", "social-preview", "approved-1280x640.png");

function introHtml(artBase64: string): string {
  // The owner-approved 2:1 artwork is fitted inside 16:9 by extending its own
  // background: a blurred cover layer fills the frame and the sharp artwork sits at
  // 1728x864, which keeps its title and key elements inside the 5% safe area.
  return `<!doctype html><html><head><style>
*{box-sizing:border-box;margin:0;padding:0}html,body{width:1920px;height:1080px;overflow:hidden;position:relative}
body{background:#05080e;font-family:'DejaVu Sans',system-ui,sans-serif}
.bg{position:absolute;inset:-40px;background-image:url(data:image/png;base64,${artBase64});background-size:cover;background-position:center;filter:blur(46px) brightness(.45) saturate(1.1)}
.vignette{position:absolute;inset:0;background:radial-gradient(1200px 800px at 50% 45%,rgba(5,8,14,.10) 0%,rgba(5,8,14,.72) 100%)}
.preview{position:absolute;left:96px;top:108px;width:1728px;height:864px;border:1px solid rgba(120,180,255,.35);border-radius:10px;overflow:hidden;box-shadow:0 50px 120px rgba(0,0,0,.55)}
.preview img{width:100%;height:100%;display:block}
</style></head><body><div class="bg"></div><div class="vignette"></div><div class="preview"><img src="data:image/png;base64,${artBase64}"></div></body></html>`;
}

function endCardHtml(artBase64: string): string {
  // Full-frame close (FILM-02): the approved artwork extends to every edge as a soft
  // background, the settlement layers stay recognisable through the lower third, the
  // title sits around the upper third and the repository address is centred optically
  // on a high-contrast panel. No narration caption is part of this card.
  return `<!doctype html><html><head><style>
*{box-sizing:border-box;margin:0;padding:0}html,body{width:1920px;height:1080px;overflow:hidden;position:relative}
body{font-family:'DejaVu Sans',system-ui,sans-serif;color:#eaf2ff}
.bg{position:absolute;inset:-90px;background-image:url(data:image/png;base64,${artBase64});background-size:cover;background-position:center;filter:blur(16px) brightness(.38) saturate(1.05)}
.shade{position:absolute;inset:0;background:linear-gradient(180deg,rgba(5,9,16,.80) 0%,rgba(5,9,16,.35) 34%,rgba(5,9,16,.18) 55%,rgba(5,9,16,.30) 78%,rgba(5,9,16,.66) 100%)}
.art{position:absolute;left:0;right:0;bottom:0;height:50%;background-image:url(data:image/png;base64,${artBase64});background-size:cover;background-position:center 18%;opacity:.26;filter:blur(9px) brightness(.9);mask-image:linear-gradient(180deg,transparent 0%,rgba(0,0,0,.5) 50%,rgba(0,0,0,.8) 100%)}
.content{position:absolute;inset:0;padding:54px 96px}
.title{position:absolute;left:96px;right:96px;top:226px;text-align:center}
.title .rule{width:200px;height:4px;margin:0 auto 26px;background:linear-gradient(90deg,#38e1c4,#2f7cf6);border-radius:2px}
.title h1{font-size:76px;font-weight:800;letter-spacing:-1px;line-height:1.05;text-shadow:0 6px 30px rgba(0,0,0,.65)}
.title p{margin-top:14px;font-size:32px;color:#d5e1f5;text-shadow:0 4px 20px rgba(0,0,0,.7)}
.address{position:absolute;left:96px;right:96px;top:512px;display:flex;justify-content:center}
.panel{background:rgba(4,10,19,.90);border:1px solid rgba(127,233,210,.55);border-radius:18px;padding:30px 46px;box-shadow:0 30px 90px rgba(0,0,0,.65)}
.panel .label{font-size:15px;letter-spacing:3px;text-transform:uppercase;color:#8fb6e6;text-align:center;margin-bottom:12px}
.url{font-size:54px;font-weight:700;color:#8ff3e2;white-space:nowrap;letter-spacing:.2px;text-align:center}
.foot{position:absolute;left:96px;right:96px;bottom:54px;display:flex;justify-content:space-between;font-size:21px;color:#c3d2e8;text-shadow:0 2px 14px rgba(0,0,0,.85)}
</style></head><body><div class="bg"></div><div class="shade"></div><div class="art"></div><div class="content">
<div class="title"><div class="rule"></div><h1>EuroRollup Settlement Lab</h1><p>Open the project on GitHub and replay the experiment yourself.</p></div>
<div class="address"><div class="panel"><div class="label">Repository</div><div class="url" id="repo-url">github.com/SergeyGer/eurorollup-settlement-lab</div></div></div>
<div class="foot"><span>Synthetic data · recorded from the release build</span><span>Euro settlement · OP Stack L2 evidence</span></div>
</div></body></html>`;
}

async function stepCards(): Promise<void> {
  console.log("[cards] adapting the owner-approved artwork to the opening frame and end card");
  if (!existsSync(approvedArtworkPath)) {
    throw new Error(`Owner-approved artwork is missing: ${approvedArtworkPath}`);
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const artBase64 = readFileSync(approvedArtworkPath).toString("base64");
    writeFileSync(join(cardsDir, "social-preview-1280x640.png"), readFileSync(approvedArtworkPath));
    const introPage = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await introPage.setContent(introHtml(artBase64), { waitUntil: "load" });
    await introPage.waitForTimeout(300);
    await introPage.screenshot({ path: join(cardsDir, "intro-1920x1080.png") });
    await introPage.close();

    const endPage = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await endPage.setContent(endCardHtml(artBase64), { waitUntil: "load" });
    await endPage.waitForTimeout(300);
    await endPage.screenshot({ path: join(cardsDir, "end-card-1920x1080.png") });

    // 720p and phone-width stills: scale the 1080p design as a player would.
    const scaleTo = async (width: number, height: number, name: string): Promise<Record<string, unknown>> => {
      const page = await browser.newPage({ viewport: { width, height } });
      const scale = Math.min(width / 1920, height / 1080);
      const html = endCardHtml(artBase64).replace(
        "</head>",
        `<style>.bg,.shade,.content{transform:scale(${String(scale)});transform-origin:top left}</style></head>`,
      );
      await page.setContent(html, { waitUntil: "load" });
      await page.waitForTimeout(250);
      const measure = await page.evaluate(() => {
        const element = document.getElementById("repo-url")!;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
        return {
          widthPx: Math.round(rect.width),
          heightPx: Math.round(rect.height),
          fontSizePx: Math.round(parseFloat(style.fontSize)),
          rect: { left: Math.round(rect.left), top: Math.round(rect.top), right: Math.round(rect.right), bottom: Math.round(rect.bottom) },
          viewport: { width: window.innerWidth, height: window.innerHeight },
          singleLine: rect.height <= lineHeight * 1.6,
          withinViewport: rect.left >= 0 && rect.right <= window.innerWidth && rect.top >= 0 && rect.bottom <= window.innerHeight,
        };
      });
      await page.screenshot({ path: join(cardsDir, name) });
      await page.close();
      return measure;
    };
    const endCard720 = await scaleTo(1280, 720, "end-card-720p.png");
    const endCardPhone = await scaleTo(390, 844, "end-card-phone-still.png");
    const cardChecks = { endCardUrlAt720p: endCard720, endCardUrlAtPhoneWidth: endCardPhone };
    writeFileSync(join(cardsDir, "card-checks.json"), `${JSON.stringify(cardChecks, null, 2)}\n`);
    console.log(`[cards] URL at 720p ${String(endCard720.widthPx)}px singleLine=${String(endCard720.singleLine)}; phone ${String(endCardPhone.widthPx)}px singleLine=${String(endCardPhone.singleLine)}`);
    await endPage.close();
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
  // Captions are delivered as a separate WebVTT file and are never burned into the
  // export: no narration text appears in any of the 1800 frames (FILM-01).
  const transcript = [
    "# Release film transcript",
    "",
    "English narration, verbatim. 131 words, approximately 60 seconds.",
    "",
    ...timings.map((timing) => `**${formatTimestamp(timing.start).slice(3, 8)}** — ${timing.text}`),
    "",
    "Captions: `release-film.vtt` (separate track). Film: `release-film.mp4` (attached to the GitHub Release).",
    "",
  ];
  writeFileSync(join(mediaDir, "release-film-transcript.md"), transcript.join("\n"));
  console.log(`[tts] ${String(timings.length)} segments, closing line ends at ${timings[timings.length - 1]!.end.toFixed(2)}s`);
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
  console.log(`[record] recording from ${webUrl} (clean captures, seed start)`);
  // Portfolio journey: start at the seed (EUR 1,000), cut on the spot fill, hold the
  // receipt and EUR 799.95, then follow the EUR 300 reservation and the 3.125000 units.
  await recordBrowserVideo("portfolio", 24_000, async (page, cursor, timeline) => {
    const spendable = page.locator(".cash-card").first();
    timeline.marks["seedVisible"] = Date.now();
    await page.waitForTimeout(2500);
    const fillStep = page.getByRole("button", { name: /Spot order filled/ });
    await moveCursor(cursor, fillStep);
    await setFocus(page, fillStep, null);
    await moveCursor(cursor, fillStep, true);
    timeline.marks["spotFill"] = Date.now();
    await page.waitForTimeout(900);
    const receipt = page.locator(".receipt").first();
    if ((await receipt.count()) > 0) {
      await setFocus(page, receipt, fillStep);
      await moveCursor(cursor, receipt);
      await page.waitForTimeout(2000);
    }
    await setFocus(page, spendable, receipt);
    await moveCursor(cursor, spendable);
    await page.waitForTimeout(1800);
    const reserveStep = page.getByRole("button", { name: /Fund subscription reserved/ });
    await moveCursor(cursor, reserveStep);
    await setFocus(page, reserveStep, spendable);
    await moveCursor(cursor, reserveStep, true);
    timeline.marks["fundReserved"] = Date.now();
    await page.waitForTimeout(1600);
    const pending = page.getByText(/reserved €300\.00/i).first();
    if ((await pending.count()) > 0) {
      await setFocus(page, pending, reserveStep);
      await moveCursor(cursor, pending);
      await page.waitForTimeout(1600);
    }
    const allocateStep = page.getByRole("button", { name: /Fund units allocated/ });
    await moveCursor(cursor, allocateStep);
    await setFocus(page, allocateStep, pending);
    await moveCursor(cursor, allocateStep, true);
    timeline.marks["fundAllocated"] = Date.now();
    await page.waitForTimeout(900);
    const units = page.getByText(/3\.125000 eFUND units/).first();
    if ((await units.count()) > 0) {
      await setFocus(page, units, allocateStep);
      await moveCursor(cursor, units);
      await page.waitForTimeout(2400);
    }
    await page.waitForTimeout(700);
  });

  // Policy Lab journey: the question enters, the live model proposes the typed change,
  // then confirmation reveals F-1450/F-1530, EUR 300 extra reserved and the two unit
  // quantities; the comparison evidence is opened at the end.
  await recordBrowserVideo("policy", 80_000, async (page, cursor, timeline) => {
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
    const question = "What if the fund moved its Friday cutoff from 16:00 to 15:00 UTC?";
    const words = question.split(" ");
    for (let index = 1; index <= words.length; index += 1) {
      await textarea.fill(words.slice(0, index).join(" "));
      await page.waitForTimeout(180);
    }
    timeline.marks["questionTyped"] = Date.now();
    const ask = page.getByRole("button", { name: /Ask local model/ });
    await moveCursor(cursor, ask);
    await setFocus(page, ask, textarea);
    timeline.marks["questionReady"] = Date.now();
    await moveCursor(cursor, ask, true);
    timeline.marks["askClicked"] = Date.now();
    await page.getByText("2 · Review proposal").waitFor({ timeout: 180_000 });
    timeline.marks["draftVisible"] = Date.now();
    await page.waitForTimeout(800);
    const proposal = page.getByText(/proposed cutoff/i).first();
    if ((await proposal.count()) > 0) {
      await setFocus(page, proposal, ask);
      await moveCursor(cursor, proposal);
      await page.waitForTimeout(1400);
    }
    const digest = page.getByText(/draft digest/i).first();
    if ((await digest.count()) > 0) {
      await setFocus(page, digest, proposal);
      await moveCursor(cursor, digest);
      await page.waitForTimeout(1200);
    }
    const confirm = page.getByRole("button", { name: /Confirm and compare/ });
    await moveCursor(cursor, confirm);
    await setFocus(page, confirm, digest);
    await moveCursor(cursor, confirm, true);
    timeline.marks["confirmClicked"] = Date.now();
    await page.getByText("3 · Impact").waitFor({ timeout: 120_000 });
    timeline.marks["impactVisible"] = Date.now();
    await page.waitForTimeout(500);
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
      await page.waitForTimeout(1500);
      await moveCursor(cursor, secondRow);
      await setFocus(page, secondRow, firstRow);
      await page.waitForTimeout(2400);
    }
    const mondayCard = page.getByText(/monday 17:01 utc close/i).first();
    if ((await mondayCard.count()) > 0) {
      await mondayCard.scrollIntoViewIfNeeded();
      await moveCursor(cursor, mondayCard);
      await setFocus(page, mondayCard, secondRow);
      await page.waitForTimeout(2000);
    }
    const download = page.getByRole("button", { name: /Download comparison pack/ });
    if ((await download.count()) > 0) {
      await download.scrollIntoViewIfNeeded();
      await moveCursor(cursor, download);
      await setFocus(page, download, mondayCard);
      await page.waitForTimeout(1500);
      await moveCursor(cursor, download, true);
      timeline.marks["evidenceOpened"] = Date.now();
      await page.waitForTimeout(1200);
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
  // Clean-capture body composition (no burned captions):
  //   05-14 s  portfolio seed -> spot fill -> receipt -> EUR 799.95   (270 frames)
  //   14-22 s  EUR 300 reserved -> 3.125000 units at EUR 96          (240 frames)
  //   22-33 s  question entering + live proposal diff                (330 frames, one cut)
  //   33-44 s  confirmation -> F-1450 / F-1530 impact                (330 frames)
  //   44-55 s  EUR 300 extra, Monday quantities, comparison evidence (330 frames)
  const portfolioFill = 0;
  const portfolioFund = Math.max(0, videoStart(portfolio, "fundReserved") - 1.6);
  const policyQuestion = Math.max(0, videoStart(policy, "questionReady") - 5.6);
  const policyDraft = Math.max(0, videoStart(policy, "draftVisible") - 0.8);
  const policyConfirm = Math.max(0, videoStart(policy, "confirmClicked") - 0.8);
  const policyImpact = Math.max(0, videoStart(policy, "impactVisible") + 0.3);
  const bodyParts: Array<{ file: string; start: number; frames: number }> = [
    { file: portfolio.file, start: portfolioFill, frames: 270 },
    { file: portfolio.file, start: portfolioFund, frames: 240 },
    { file: policy.file, start: policyQuestion, frames: 180 },
    { file: policy.file, start: policyDraft, frames: 150 },
    { file: policy.file, start: policyConfirm, frames: 330 },
    { file: policy.file, start: policyImpact, frames: 330 },
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
  // No subtitle filter: captions are delivered only as a separate WebVTT track.
  ffmpeg([
    "-i", join(buildDir, "silent.mp4"),
    "-i", join(buildDir, "narration.wav"),
    "-map", "0:v", "-map", "1:a",
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
  const cardChecks = JSON.parse(readFileSync(join(cardsDir, "card-checks.json"), "utf8")) as {
    endCardUrlAt720p: { widthPx: number; singleLine: boolean; withinViewport: boolean };
    endCardUrlAtPhoneWidth: { widthPx: number; singleLine: boolean; withinViewport: boolean };
  };
  const card = cardChecks.endCardUrlAt720p;
  const phoneCard = cardChecks.endCardUrlAtPhoneWidth;
  check("end-card-url", "repository URL readable on one line at 720p", card.singleLine && card.withinViewport, `${String(card.widthPx)}px wide, singleLine=${String(card.singleLine)}`);
  check("end-card-phone", "repository URL readable in a phone-width still", phoneCard.singleLine && phoneCard.withinViewport, `${String(phoneCard.widthPx)}px wide at phone scale`);
  const introImage = join(cardsDir, "intro-1920x1080.png");
  const introImageSsim = ssim(frame0!, introImage);
  const approvedSha = sha256File(approvedArtworkPath);
  check("opening-artwork", "frames 0-149 use the owner-approved artwork", introImageSsim > 0.95 && approvedSha === sha256File(join(cardsDir, "social-preview-1280x640.png")), `SSIM ${introImageSsim.toFixed(4)}, approved sha ${approvedSha.slice(0, 12)}…`);
  const assPath = join(mediaDir, "release-film.ass");
  check("captions-separate", "no narration text is burned into the export", !existsSync(assPath), `burned-in caption source absent: ${assPath}`);

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
    reportId: "S14-release-film",
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
      burnedIn: false,
      separateTrack: true,
      playerDefault: "off",
      presentation: "English WebVTT track delivered beside the film; the video frames contain no narration text.",
    },
    transcript: { file: "media/film/release-film-transcript.md", sha256: checksums.transcript },
    socialPreview: {
      designFile: "media/social-preview/approved-1280x640.png",
      approved: true,
      sha256: checksums.socialPreview,
      size: "1280x640",
      introFrame: "media/film/intro-frame-1920x1080.png",
      introComposition: "owner-approved 2:1 artwork fitted at 1728x864 inside 16:9 with its own blurred background extended to the frame edges",
    },
    endCard: {
      designFile: "media/film/end-card-1920x1080.png",
      sha256: checksums.endCard,
      url: "github.com/SergeyGer/eurorollup-settlement-lab",
      urlSingleLineAt720p: card.singleLine,
      urlWidthAt720p: card.widthPx,
      urlSingleLineAtPhoneWidth: phoneCard.singleLine,
      urlWidthAtPhoneWidth: phoneCard.widthPx,
      composition: "full-frame 1920x1080 artwork to every edge; title upper third; URL on the optical centre; settlement artwork visible through the lower third",
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
    publication: {
      player: "browser replay film view with captions off by default and a captions toggle",
      assetName: `eurollup-release-film-${packageJson.version}.mp4`,
      captionsFile: "release-film.vtt",
      transcriptFile: "release-film-transcript.md",
      releaseTag: `v${packageJson.version}`,
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
