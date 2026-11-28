/**
 * Publication link check (REL-02): relative repository links and signed-out public URLs.
 *
 * Checks that README/wiki-facing relative links resolve in the checkout and that the
 * public replay, repository, release page and release assets answer without
 * authentication. Writes evidence/rel/link-check.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDir = join(repoRoot, "evidence", "rel");
const repositoryUrl = "https://github.com/SergeyGer/eurorollup-settlement-lab";
const tag = process.env.CHECK_LINK_TAG ?? "v1.0.0";
const publicReplayUrl = "https://sergeyger.github.io/eurorollup-settlement-lab/";

interface LinkCheck {
  readonly id: string;
  readonly target: string;
  readonly kind: "relative-file" | "public-url";
  readonly status: number | null;
  readonly passed: boolean;
  readonly detail: string;
}

function checkRelativeLinks(): LinkCheck[] {
  const results: LinkCheck[] = [];
  const documents = ["README.md", "docs/README.md", "docs/release/README.md"];
  const linkPattern = /\]\(([^)]+)\)/g;
  for (const document of documents) {
    if (!existsSync(join(repoRoot, document))) continue;
    const content = readFileSync(join(repoRoot, document), "utf8");
    for (const match of content.matchAll(linkPattern)) {
      const target = match[1]!.trim();
      if (target.startsWith("http://") || target.startsWith("https://") || target.startsWith("#") || target.startsWith("mailto:")) continue;
      const pathPart = target.split("#")[0]!;
      if (pathPart.length === 0) continue;
      const absolute = isAbsolute(pathPart) ? pathPart : join(repoRoot, normalize(join(dirname(document), pathPart)));
      const exists = existsSync(absolute);
      // Links to evidence packs or benchmark files are allowed to point at release assets
      // only when they are declared as release URLs; local missing files are failures.
      results.push({
        id: `relative:${document}:${pathPart}`,
        target: pathPart,
        kind: "relative-file",
        status: null,
        passed: exists,
        detail: exists ? "file exists" : `missing file referenced from ${document}`,
      });
    }
  }
  return results;
}

async function checkUrl(url: string): Promise<LinkCheck> {
  try {
    const response = await fetch(url, { redirect: "follow", headers: { "user-agent": "eurorollup-link-check" } });
    return {
      id: `url:${url}`,
      target: url,
      kind: "public-url",
      status: response.status,
      passed: response.ok,
      detail: `HTTP ${String(response.status)} signed out`,
    };
  } catch (error) {
    return {
      id: `url:${url}`,
      target: url,
      kind: "public-url",
      status: null,
      passed: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main(): Promise<void> {
  mkdirSync(evidenceDir, { recursive: true });
  const relativeChecks = checkRelativeLinks();
  const urls = [
    publicReplayUrl,
    repositoryUrl,
    `${repositoryUrl}/releases/tag/${tag}`,
    `${repositoryUrl}/releases/download/${tag}/eurollup-release-film-1.0.0.mp4`,
    `${repositoryUrl}/releases/download/${tag}/eurollup-settlement-lab-1.0.0.tar.gz`,
    `${repositoryUrl}/releases/download/${tag}/release-film.vtt`,
    `${repositoryUrl}/releases/download/${tag}/release-checks.json`,
    `${repositoryUrl}/wiki`,
    `${repositoryUrl}/wiki/Release-Film`,
  ];
  const urlChecks: LinkCheck[] = [];
  for (const url of urls) {
    urlChecks.push(await checkUrl(url));
  }
  const checks = [...relativeChecks, ...urlChecks];
  const relativeFailures = relativeChecks.filter((entry) => !entry.passed);
  const urlFailures = urlChecks.filter((entry) => !entry.passed);
  const evidence = {
    schemaVersion: "1.0.0",
    reportId: "REL-02-link-check",
    generatedBy: "pnpm check:links",
    generatedAt: new Date().toISOString(),
    tag,
    checks,
    summary: {
      total: checks.length,
      relativeFiles: relativeChecks.length,
      publicUrls: urlChecks.length,
      relativeFailures: relativeFailures.length,
      urlFailures: urlFailures.length,
    },
    passed: relativeFailures.length === 0 && urlFailures.length === 0,
    notes: [
      "Public URLs are fetched without cookies or tokens; the replay and release assets must answer signed out.",
      "Relative links are resolved inside the checkout; evidence packs referenced by URL are checked as release assets.",
    ],
  };
  writeFileSync(join(evidenceDir, "link-check.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  for (const failure of [...relativeFailures, ...urlFailures]) {
    console.error(`FAIL ${failure.id}: ${failure.detail}`);
  }
  console.log(`link check: ${String(checks.length)} checks, relative failures ${String(relativeFailures.length)}, url failures ${String(urlFailures.length)}`);
  if (!evidence.passed) process.exitCode = 1;
}

main();
