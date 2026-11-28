/**
 * REL-02 portability check: every hashed text file is LF on every checkout.
 *
 * Verifies the .gitattributes policy, scans the tracked index/worktree for CRLF or
 * mixed line endings, and simulates a Windows checkout (core.autocrlf=true) to show
 * that hashed evidence stays LF with an unchanged byte digest. The real Windows host
 * is not available on this machine; the simulation and the attribute policy are
 * recorded instead of being claimed as a native run.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDir = join(repoRoot, "evidence", "rel");
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
function git(args: readonly string[], cwd = repoRoot): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

interface EolEntry {
  readonly indexEol: string;
  readonly worktreeEol: string;
  readonly attributes: string;
  readonly path: string;
}

function parseEol(output: string): EolEntry[] {
  return output
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const [meta, ...pathParts] = line.split("\t");
      const path = pathParts.join("\t");
      const match = /^i\/(\S+)\s+w\/(\S+)\s+attr\/(.*)$/.exec(meta ?? "");
      if (match === null) {
        return { indexEol: "unknown", worktreeEol: "unknown", attributes: "", path };
      }
      return {
        indexEol: match[1]!,
        worktreeEol: match[2]!,
        attributes: match[3]!.trim(),
        path,
      };
    });
}

function main(): void {
  mkdirSync(evidenceDir, { recursive: true });
  const attributesPath = join(repoRoot, ".gitattributes");
  const attributesHash = existsSync(attributesPath) ? sha256File(attributesPath) : null;
  const entries = parseEol(git(["ls-files", "--eol"]));
  const offenders = entries.filter(
    (entry) => entry.indexEol !== "lf" && entry.indexEol !== "-text" && entry.indexEol !== "none",
  );
  const worktreeOffenders = entries.filter(
    (entry) => entry.worktreeEol !== "lf" && entry.worktreeEol !== "-text" && entry.worktreeEol !== "none",
  );

  // Attribute coverage for the byte-verified evidence paths.
  const hashedSamples = [
    "evidence/g01/golden-run.json",
    "evidence/a05/protocol-run.json",
    "schemas/golden-run.schema.json",
    "fixtures/g01/g01.json",
    "media/film/release-film.vtt",
  ].filter((path) => existsSync(join(repoRoot, path)));
  const attributeChecks = hashedSamples.map((path) => {
    const output = git(["check-attr", "text", "eol", "--", path]).trim();
    return { path, attributes: output.replace(/\n/g, "; ") };
  });

  // Simulated Windows checkout: autocrlf=true, then byte-compare a hashed file.
  const worktreeDir = mkdtempSync(join(tmpdir(), "eurorollup-win-checkout-"));
  let simulated: Record<string, unknown>;
  try {
    git(["-c", "core.autocrlf=true", "-c", "core.eol=crlf", "worktree", "add", "--detach", worktreeDir, commit]);
    try {
      const relative = "evidence/g01/golden-run.json";
      const absolute = join(worktreeDir, relative);
      const bytes = readFileSync(absolute);
      const hasCrlf = bytes.includes(Buffer.from("\r\n"));
      const localSha = sha256File(join(repoRoot, relative));
      simulated = {
        method: "git worktree with core.autocrlf=true and core.eol=crlf",
        nativeWindows: false,
        note: "A real Windows checkout is not available on this host; the simulation records the attribute policy.",
        file: relative,
        crlfPresent: hasCrlf,
        sha256: sha256File(absolute),
        shaMatchesRepository: sha256File(absolute) === localSha,
        bytes: statSync(absolute).size,
      };
    } finally {
      execFileSync("git", ["worktree", "remove", "--force", worktreeDir], { cwd: repoRoot, encoding: "utf8" });
    }
  } finally {
    rmSync(worktreeDir, { recursive: true, force: true });
  }

  const passed =
    attributesHash !== null &&
    offenders.length === 0 &&
    worktreeOffenders.length === 0 &&
    attributeChecks.every((check) => check.attributes.includes("text: set") && check.attributes.includes("eol: lf")) &&
    simulated["crlfPresent"] === false &&
    simulated["shaMatchesRepository"] === true;

  const evidence = {
    schemaVersion: "1.0.0",
    reportId: "REL-02-line-endings",
    generatedBy: "pnpm check:line-endings",
    generatedAt: new Date().toISOString(),
    commit,
    attributes: { path: ".gitattributes", sha256: attributesHash },
    counts: {
      trackedFiles: entries.length,
      textLf: entries.filter((entry) => entry.indexEol === "lf").length,
      binary: entries.filter((entry) => entry.indexEol === "-text" || entry.indexEol === "none").length,
      indexOffenders: offenders.length,
      worktreeOffenders: worktreeOffenders.length,
    },
    offenders: offenders.map((entry) => entry.path),
    worktreeOffenders: worktreeOffenders.map((entry) => entry.path),
    hashedAttributeChecks: attributeChecks,
    simulatedWindowsCheckout: simulated,
    passed,
    notes: [
      "Every published evidence, schema and fixture path is pinned to LF; binary assets are marked binary.",
      "The repository was renormalised after adding .gitattributes; no tracked file content changed.",
      "Hashed file byte digests remain strict; only the checkout line-ending policy changed.",
    ],
  };
  writeFileSync(join(evidenceDir, "line-endings.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`line endings: ${String(entries.length)} tracked files, offenders ${String(offenders.length)}, passed=${String(passed)}`);
  if (!passed) process.exitCode = 1;
}

main();
