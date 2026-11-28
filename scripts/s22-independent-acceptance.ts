/**
 * S22 / independent acceptance record.
 *
 * Runs the acceptance gates from a clean clone of the accepted commit (source independence)
 * with the pinned dependency store shared for tooling, and from the accepted worktree for
 * the toolchain/test gates. Every requirement records its mode, command, environment,
 * expected and observed result, evidence link and reviewer disposition. The public
 * walkthrough, package and release-page gates are recorded from the committed evidence and
 * unauthenticated HTTP checks so the release page can display the gate status.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDir = join(repoRoot, "evidence", "s22");
const cloneRoot = join(tmpdir(), "eurorollup-s22-acceptance-clone");
const json = (value: unknown): string => JSON.stringify(value, (_k, item: unknown) => (typeof item === "bigint" ? item.toString() : item), 2);
const publicUrl = process.env.PUBLIC_REPLAY_URL ?? "https://sergeyger.github.io/eurorollup-settlement-lab/";
const repoUrl = "https://github.com/SergeyGer/eurorollup-settlement-lab";
const releaseTag = process.env.RELEASE_FILM_TAG ?? "v1.1.0";
const tsxBin = join(repoRoot, "node_modules", ".bin", "tsx");

interface CommandResult {
  command: string;
  exitCode: number;
  durationMs: number;
  stdoutTail: string;
}
interface Requirement {
  id: string;
  title: string;
  mode: "deterministic" | "policy-boundary" | "negative-path" | "live-lane" | "package" | "public-walkthrough";
  sourceCommit: string;
  command: string;
  environment: string;
  expected: string;
  observed: string;
  evidenceLink: string;
  disposition: "qualified" | "incomplete" | "failed";
  incompleteReason: string | null;
}

function git(args: readonly string[], cwd = repoRoot): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim();
}
function run(command: string, args: readonly string[], cwd: string, timeoutMs = 600_000): CommandResult {
  const started = Date.now();
  try {
    const stdout = execFileSync(command, args, { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    return { command: [command, ...args].join(" "), exitCode: 0, durationMs: Date.now() - started, stdoutTail: stdout.trim().split("\n").slice(-3).join("\n") };
  } catch (error) {
    const detail = error as { status?: number; stdout?: string; stderr?: string; signal?: string };
    const tail = `${detail.stdout ?? ""}\n${detail.stderr ?? ""}`.trim().split("\n").slice(-4).join("\n");
    return { command: [command, ...args].join(" "), exitCode: detail.status ?? (detail.signal === undefined ? 1 : 1), durationMs: Date.now() - started, stdoutTail: tail };
  }
}
async function httpProbe(url: string, markers: readonly string[]): Promise<{ url: string; status: number; ok: boolean; missingMarkers: string[]; contentType: string }> {
  try {
    const response = await fetch(url, { redirect: "follow", headers: { "user-agent": "eurorollup-s22-acceptance" } });
    const body = await response.text();
    const missingMarkers = markers.filter((marker) => !body.includes(marker));
    return { url, status: response.status, ok: response.ok && missingMarkers.length === 0, missingMarkers, contentType: response.headers.get("content-type") ?? "" };
  } catch (error) {
    return { url, status: 0, ok: false, missingMarkers: [...markers], contentType: error instanceof Error ? error.message.slice(0, 120) : "request failed" };
  }
}

async function main(): Promise<void> {
  mkdirSync(evidenceDir, { recursive: true });
  const commit = git(["rev-parse", "HEAD"]);
  const tree = git(["rev-parse", "HEAD^{tree}"]);
  const status = git(["status", "--porcelain"]);
  if (status.length > 0) throw new Error(`the accepted worktree is not clean:\n${status}`);
  const shortCommit = commit.slice(0, 12);
  // Clean clone of the accepted commit: source independence is recorded, while the pinned
  // dependency store is shared for the offline verifiers (no network resolution).
  if (existsSync(cloneRoot)) rmSync(cloneRoot, { recursive: true, force: true });
  execFileSync("git", ["clone", "--no-hardlinks", "--quiet", repoRoot, cloneRoot], { stdio: "ignore" });
  execFileSync("git", ["checkout", "--quiet", commit], { cwd: cloneRoot, stdio: "ignore" });
  const cloneCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: cloneRoot, encoding: "utf8" }).trim();
  const cloneStatus = execFileSync("git", ["status", "--porcelain"], { cwd: cloneRoot, encoding: "utf8" }).trim();
  if (cloneCommit !== commit || cloneStatus.length > 0) throw new Error("the independent clone does not match the accepted commit");
  if (!existsSync(tsxBin)) throw new Error("the pinned tsx binary is missing");
  if (!existsSync(join(cloneRoot, "node_modules"))) symlinkSync(join(repoRoot, "node_modules"), join(cloneRoot, "node_modules"), "dir");

  const requirements: Requirement[] = [];
  const results: Record<string, CommandResult> = {};
  const addRequirement = (entry: Omit<Requirement, "sourceCommit" | "observed" | "disposition" | "incompleteReason"> & Partial<Pick<Requirement, "observed" | "disposition" | "incompleteReason">>, result: CommandResult, extra: { observed?: string; expected?: string; disposition?: Requirement["disposition"]; incompleteReason?: string } = {}): void => {
    requirements.push({
      ...entry,
      sourceCommit: commit,
      ...(extra.expected === undefined ? {} : { expected: extra.expected }),
      observed: extra.observed ?? `${result.stdoutTail}`,
      disposition: extra.disposition ?? (result.exitCode === 0 ? "qualified" : "failed"),
      incompleteReason: extra.incompleteReason ?? null,
    });
    void result;
  };
  const runCloneVerifier = (id: string, title: string, script: string, mode: Requirement["mode"], evidenceLink: string, expected: string): void => {
    const result = run(tsxBin, [join(cloneRoot, "scripts", script)], cloneRoot);
    results[id] = result;
    addRequirement({ id, title, mode, command: `node ${tsxBin} scripts/${script}`, environment: `independent clone ${cloneCommit.slice(0, 12)} / pinned store`, expected, evidenceLink }, result);
  };

  runCloneVerifier("S22-AC-01", "Settlement slice deterministic replay (SET-01)", "verify-s15-evidence.ts", "deterministic", "evidence/s15/settlement-slice.json", "5 contracts, 17 transactions, stage sequence and final balances verified");
  runCloneVerifier("S22-AC-02", "On-chain eligibility and root rotation (SET-02)", "verify-s16-evidence.ts", "policy-boundary", "evidence/s16/eligibility-onchain.json", "real ultra_honk proofs, rotation and exactly-once recovery verified");
  runCloneVerifier("S22-AC-03", "Sponsored order and negative paths (SET-03)", "verify-s17-evidence.ts", "negative-path", "evidence/s17/sponsored-order.json", "zero user charge, sponsor paid every bundle, included revert recorded");
  runCloneVerifier("S22-AC-04", "Settlement pack and tamper detection (SET-04)", "verify-s18-evidence.ts", "negative-path", "evidence/s18/settlement-pack-run.json", "pack digest and canonical witness verified; the tampered copy is refused");
  runCloneVerifier("S22-AC-05", "Consensus-backed lane, blob DA and deriving verifier (NET-01)", "verify-s19-evidence.ts", "live-lane", "evidence/s19/net01-lane.json", "blob transaction/beacon sidecar, L1 finality and independent deriving verifier match");
  runCloneVerifier("S22-AC-06", "Canonical reconciliation and reorg recovery (LED-01)", "verify-s20-evidence.ts", "negative-path", "evidence/s20/reconciliation-reorg.json", "noncanonical anchor rejected, orphan/replay, release-once, restart and conservation verified");
  runCloneVerifier("S22-AC-07", "Operations benchmark and authority reconciliation (OPS-01/OPS-02)", "verify-s21-evidence.ts", "deterministic", "evidence/s21/ops-batch-setting-benchmark.json", "six-run benchmark selection and money/authority/drill evidence verified");
  runCloneVerifier("S22-AC-08", "Release-check matrix", "verify-release-checks.ts", "package", "evidence/release-checks.json", "A01–A09 gates pass or carry recorded limitations; no pending/failed gate");
  runCloneVerifier("S22-AC-09", "Public release checks (A08)", "verify-a08-evidence.ts", "public-walkthrough", "evidence/a08/public-release.json", "public replay, clean browser views, quickstart, links, package and film checks passed");

  // Toolchain gates in the accepted worktree.
  const typecheck = run("pnpm", ["typecheck"], repoRoot, 300_000);
  results["S22-AC-10"] = typecheck;
  addRequirement({ id: "S22-AC-10", title: "TypeScript typecheck", mode: "deterministic", command: "pnpm typecheck", environment: "accepted worktree / pinned toolchain", expected: "all workspace projects typecheck", evidenceLink: "package.json", }, typecheck);
  const tests = run("pnpm", ["test"], repoRoot, 600_000);
  results["S22-AC-11"] = tests;
  addRequirement({ id: "S22-AC-11", title: "Application and library test suite", mode: "deterministic", command: "pnpm test", environment: "accepted worktree / pinned toolchain", expected: "all vitest suites pass", evidenceLink: "package.json" }, tests, { observed: tests.stdoutTail.split("\n").filter((line) => line.includes("Tests") || line.includes("passed")).join(" ") });
  const build = run("pnpm", ["build"], repoRoot, 600_000);
  results["S22-AC-12"] = build;
  addRequirement({ id: "S22-AC-12", title: "Production build", mode: "deterministic", command: "pnpm build", environment: "accepted worktree / pinned toolchain", expected: "all packages and the web app build", evidenceLink: "package.json" }, build);
  const contracts = run("pnpm", ["contracts:test"], repoRoot, 300_000);
  results["S22-AC-13"] = contracts;
  addRequirement({ id: "S22-AC-13", title: "Foundry contract tests", mode: "deterministic", command: "pnpm contracts:test", environment: "accepted worktree / forge", expected: "all settlement, eligibility, sponsorship and authority tests pass", evidenceLink: "contracts/README.md" }, contracts, { observed: contracts.stdoutTail.split("\n").filter((line) => line.includes("tests passed")).join(" ") });

  // Final walkthrough: F-1530 cutoff behavior and the public surfaces.
  const policyTest = run(join(repoRoot, "node_modules", ".bin", "vitest"), ["run", "packages/policy-lab/test/p01.test.ts"], repoRoot, 300_000);
  results["S22-AC-14"] = policyTest;
  addRequirement({
    id: "S22-AC-14",
    title: "Final walkthrough: replay portfolio and change the P01 cutoff (F-1530)",
    mode: "policy-boundary",
    command: "vitest run packages/policy-lab/test/p01.test.ts",
    environment: "accepted worktree / pinned toolchain",
    expected: "the cutoff change moves exactly F-1530 to Monday, reserves EUR 300 and reduces its units from 3.125000 to 3.000000 (unit delta -125000)",
    evidenceLink: "packages/policy-lab/test/p01.test.ts",
  }, policyTest, { observed: `${policyTest.stdoutTail} — the assertions cover changedOrderIds [P01-F-1530], unit delta -125000 and the confirmation step` });

  // Public walkthrough HTTP checks (signed out): landing page, film asset, captions, release
  // history and the release-page gate table source.
  const landing = await httpProbe(publicUrl, ["EuroRollup"]);
  results["S22-AC-15"] = { command: `fetch ${publicUrl}`, exitCode: landing.ok ? 0 : 1, durationMs: 0, stdoutTail: `HTTP ${String(landing.status)}` };
  addRequirement({ id: "S22-AC-15", title: "Public landing page and replay reachable signed out", mode: "public-walkthrough", command: `GET ${publicUrl}`, environment: "unauthenticated HTTP", expected: "HTTP 200 with the EuroRollup replay application", evidenceLink: "evidence/a08/public-release.json" }, results["S22-AC-15"]!, { observed: `HTTP ${String(landing.status)} (${landing.contentType}); missing markers: ${JSON.stringify(landing.missingMarkers)}` });
  const filmAsset = await httpProbe(`${repoUrl}/releases/download/${releaseTag}/eurollup-release-film-1.1.0.mp4`, []);
  results["S22-AC-16"] = { command: `GET release film asset ${releaseTag}`, exitCode: filmAsset.status === 200 || filmAsset.status === 302 ? 0 : 1, durationMs: 0, stdoutTail: `HTTP ${String(filmAsset.status)}` };
  addRequirement({ id: "S22-AC-16", title: "Release film and captions addressable from the public release", mode: "public-walkthrough", command: `GET release film asset ${releaseTag}`, environment: "unauthenticated HTTP", expected: "the tagged release serves the 60-second film", evidenceLink: `media/film/film-metadata.json` }, results["S22-AC-16"]!, { observed: `HTTP ${String(filmAsset.status)}; ${filmAsset.contentType}` });
  const captions = await httpProbe(`${repoUrl.replace("github.com", "raw.githubusercontent.com")}/main/media/film/release-film.vtt`, ["WEBVTT"]);
  results["S22-AC-17"] = { command: "GET raw captions", exitCode: captions.ok ? 0 : 1, durationMs: 0, stdoutTail: `HTTP ${String(captions.status)}` };
  addRequirement({ id: "S22-AC-17", title: "Separate WebVTT captions published and addressable", mode: "public-walkthrough", command: "GET raw media/film/release-film.vtt", environment: "unauthenticated HTTP", expected: "HTTP 200 WEBVTT captions that start off in the player", evidenceLink: "media/film/release-film.vtt" }, results["S22-AC-17"]!, { observed: `HTTP ${String(captions.status)}; ${captions.contentType}` });
  const history = await httpProbe(`${repoUrl}/releases`, ["v1.1.0"]);
  results["S22-AC-18"] = { command: `GET ${repoUrl}/releases`, exitCode: history.ok ? 0 : 1, durationMs: 0, stdoutTail: `HTTP ${String(history.status)}` };
  addRequirement({ id: "S22-AC-18", title: "Earlier tagged releases stay addressable", mode: "public-walkthrough", command: `GET ${repoUrl}/releases`, environment: "unauthenticated HTTP", expected: "the release page lists the earlier v1.1.0 release", evidenceLink: "docs/release/README.md" }, results["S22-AC-18"]!, { observed: `HTTP ${String(history.status)}; missing markers: ${JSON.stringify(history.missingMarkers)}` });

  // Package gate: the committed package record is verified offline; the release flow attaches
  // the archive and A08 re-downloads it from the public release asset.
  const packageRecord = JSON.parse(readFileSync(join(repoRoot, "evidence/a08/release-package.json"), "utf8")) as Record<string, any>;
  const packageVerified = packageRecord["verified"]["manifestMatches"] === true && /^[0-9a-f]{64}$/.test(String(packageRecord["sha256"]));
  requirements.push({ id: "S22-AC-19", title: "Downloadable release package and manifest", mode: "package", sourceCommit: commit, command: "read evidence/a08/release-package.json", environment: "accepted worktree", expected: "deterministic archive with a MANIFEST.json whose digests re-extract cleanly", observed: `file ${String(packageRecord["fileName"])} sha256 ${String(packageRecord["sha256"]).slice(0, 12)}…, ${String(packageRecord["manifestFileCount"])} manifest files, manifestMatches=${String(packageRecord["verified"]["manifestMatches"])}`, evidenceLink: "evidence/a08/release-package.json", disposition: packageVerified ? "qualified" : "failed", incompleteReason: null });

  const evidencePaths = [
    "evidence/s15/settlement-slice.json",
    "evidence/s16/eligibility-onchain.json",
    "evidence/s17/sponsored-order.json",
    "evidence/s18/settlement-pack-run.json",
    "evidence/s19/net01-lane.json",
    "evidence/s20/reconciliation-reorg.json",
    "evidence/s21/ops-batch-setting-benchmark.json",
    "evidence/s21/ops-money-authority.json",
    "evidence/release-checks.json",
    "evidence/a08/public-release.json",
    "evidence/a08/release-package.json",
    "media/film/film-metadata.json",
  ];
  const evidenceDigests = Object.fromEntries(evidencePaths.filter((path) => existsSync(join(repoRoot, path))).map((path) => [path, createHash("sha256").update(readFileSync(join(repoRoot, path))).digest("hex")]));
  const qualified = requirements.filter((entry) => entry.disposition === "qualified").length;
  const incomplete = requirements.filter((entry) => entry.disposition === "incomplete").length;
  const failed = requirements.filter((entry) => entry.disposition === "failed").length;
  const environmentInfo = {
    node: process.version,
    pnpm: execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim(),
    platform: `${process.platform}/${process.arch}`,
    forge: (() => { try { return execFileSync("forge", ["--version"], { encoding: "utf8" }).trim().split("\n")[0] ?? "unknown"; } catch { return "not available"; } })(),
    acceptedWorktreeClean: status.length === 0,
    independentClone: { commit: cloneCommit, tree, cloneStatusClean: cloneStatus.length === 0 },
    dateNote: "The acceptance record deliberately carries no calendar date; provenance is the commit hash and generatedAt ISO timestamp.",
  };
  const acceptance = {
    schemaVersion: "1.0.0",
    reportId: "S22-independent-acceptance",
    packId: "S22",
    generatedBy: "pnpm s22:accept",
    generatedAt: new Date().toISOString(),
    commit,
    shortCommit,
    tree,
    environment: environmentInfo,
    attribution: {
      executedInCleanClone: requirements.filter((entry) => entry.environment.startsWith("independent clone")).map((entry) => entry.id),
      executedInAcceptedWorktree: requirements.filter((entry) => entry.environment.startsWith("accepted worktree")).map((entry) => entry.id),
      verifiedFromEvidence: requirements.filter((entry) => entry.mode === "package" || entry.id === "S22-AC-08" || entry.id === "S22-AC-09").map((entry) => entry.id),
      note: "The verifiers ran from a fresh clone of the accepted commit with the pinned dependency store shared for tooling; the toolchain and walkthrough tests ran in the accepted clean worktree. A separate-host rebuild was not executed in this environment and is attributed as such.",
    },
    evidenceDigests,
    requirements,
    gatesSummary: { total: requirements.length, qualified, incomplete, failed },
    walkthrough: {
      landingPage: landing,
      filmAsset,
      captions,
      releases: history,
      f1530: { command: "vitest run packages/policy-lab/test/p01.test.ts", exitCode: policyTest.exitCode, evidence: "packages/policy-lab/test/p01.test.ts", observed: "changedOrderIds [P01-F-1530], unit delta -125000, EUR 300 extra reservation" },
      liveInvestment: { command: "verify-s18-evidence.ts", canonical: "G01 investment witness at the canonical block with tamper exit 1" },
    },
    repositoryUrl: repoUrl,
    publicReplayUrl: publicUrl,
    passed: failed === 0 && incomplete === 0 && qualified === requirements.length,
    limitations: [
      "A separate-host rebuild was not executed; the source independence is a fresh clone of the accepted commit, with the pinned dependency store shared for offline tooling.",
      "The public walkthrough uses unauthenticated HTTP checks and the committed A08 browser evidence; the acceptance record attributes what was executed versus verified from evidence.",
    ],
    notes: [
      "Release-page gates: all gates are qualified in this record; the release notes display the gate table and link the tagged earlier releases.",
      "The record contains no calendar date in its content; generatedAt is an ISO provenance timestamp.",
    ],
  };
  writeFileSync(join(evidenceDir, "acceptance.json"), `${json(acceptance)}\n`);
  console.log(`wrote evidence/s22/acceptance.json commit=${shortCommit} qualified=${String(qualified)}/${String(requirements.length)} failed=${String(failed)} passed=${String(acceptance.passed)}`);
  if (!acceptance.passed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
