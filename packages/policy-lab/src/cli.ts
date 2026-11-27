#!/usr/bin/env node
/**
 * Policy Lab evidence runner.
 *
 * Usage:
 *   pnpm policy:replay [--fixture P01] [--check]
 *   pnpm policy:verify [--pack evidence/policy-lab]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CalendarFixture, P01Scenario } from "@eurorollup/dealing";
import {
  buildP01ComparisonPack,
  buildPolicyLabManifest,
  createDraft,
  evidenceFileRef,
  policyFromFixture,
  runP01BoundaryCases,
  runP01Comparison,
  serializeManifest,
  serializeP01ComparisonPack,
  type P01BoundaryFixture,
  type RecordedProposalFixture,
} from "./index.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const EVIDENCE_DIR = "evidence/policy-lab";
const PACK_FILE = "p01-comparison.json";
const MANIFEST_FILE = "manifest.json";

function readRepoJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(repoRoot, relativePath), "utf8")) as T;
}

function readRepoText(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

function optionValue(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return argv[index + 1];
}

interface FixtureBundle {
  readonly fixture: P01Scenario;
  readonly calendars: Readonly<Record<string, CalendarFixture>>;
  readonly boundaryFixture: P01BoundaryFixture;
  readonly recordedProposal: RecordedProposalFixture;
}

function loadFixtures(): FixtureBundle {
  const fixture = readRepoJson<P01Scenario>("fixtures/p01/scenario.json");
  const calendars: Record<string, CalendarFixture> = {
    "LAB-UTC-1": readRepoJson<CalendarFixture>("fixtures/calendar/LAB-UTC-1.json"),
    "LAB-UTC-2": readRepoJson<CalendarFixture>("fixtures/calendar/LAB-UTC-2.json"),
  };
  const boundaryFixture = readRepoJson<P01BoundaryFixture>("fixtures/policy-lab/p01-boundary.json");
  const recordedProposal = readRepoJson<RecordedProposalFixture>(
    "fixtures/policy-lab/p01-recorded-proposal.json",
  );
  return { fixture, calendars, boundaryFixture, recordedProposal };
}

interface BuiltPack {
  readonly packText: string;
  readonly manifestText: string;
  readonly digest: string;
  readonly packDigest: string;
  readonly summary: readonly string[];
}

function buildPack(): BuiltPack {
  const bundle = loadFixtures();
  const calendarFixture = bundle.calendars["LAB-UTC-1"];
  if (calendarFixture === undefined) {
    throw new Error("LAB-UTC-1 calendar fixture is missing");
  }
  const baselinePolicy = policyFromFixture(bundle.fixture.baselinePolicy);
  const candidatePolicy = policyFromFixture(bundle.fixture.candidatePolicy);

  // Sanity: the recorded preset must be a valid draft against the baseline.
  const recordedDraft = createDraft({
    fixture: bundle.fixture,
    calendarFixture,
    baselinePolicy,
    input: { fixtureId: "P01", mode: "recorded" },
    recordedProposal: bundle.recordedProposal,
    createdAt: "fixture",
  });
  if (recordedDraft.status !== "proposed" || recordedDraft.diff === null) {
    throw new Error(`Recorded P01 proposal is not runnable: ${recordedDraft.status}`);
  }

  const comparison = runP01Comparison({
    fixture: bundle.fixture,
    calendarFixture,
    baselinePolicy,
    candidatePolicy,
  });
  const boundaryCases = runP01BoundaryCases({
    fixture: bundle.fixture,
    boundaryFixture: bundle.boundaryFixture,
    calendars: bundle.calendars,
    baselinePolicy,
    candidatePolicy,
  });
  const pack = buildP01ComparisonPack({
    comparison,
    boundaryCases,
    boundaryFixture: bundle.boundaryFixture,
  });
  const packText = serializeP01ComparisonPack(pack);
  const manifest = buildPolicyLabManifest({
    pack,
    files: [evidenceFileRef(PACK_FILE, packText)],
  });
  const manifestText = serializeManifest(manifest);
  return {
    packText,
    manifestText,
    digest: pack.comparisonDigest,
    packDigest: pack.packDigest,
    summary: [
      `P01 branches: baseline ${summaryLine(comparison.baseline.snapshots)}`,
      `P01 branches: candidate ${summaryLine(comparison.candidate.snapshots)}`,
      `orders: ${comparison.totalOrders}, changed dealing date: ${comparison.affectedOrders}, extra reserved at Friday close: ${comparison.extraReservedAtFridayCloseBase}`,
      `boundary cases: ${boundaryCases.filter((item) => item.pass).length}/${boundaryCases.length} pass`,
    ],
  };
}

function summaryLine(
  snapshots: Readonly<Record<string, { spendableBase: string; reservedBase: string; unitsBase: string }>>,
): string {
  const friday = snapshots["fridayClose"];
  return friday === undefined
    ? "no Friday snapshot"
    : `Friday close spendable ${friday.spendableBase}, reserved ${friday.reservedBase}, units ${friday.unitsBase}`;
}

function commandReplay(argv: readonly string[]): number {
  const checkOnly = argv.includes("--check");
  const fixtureId = optionValue(argv, "--fixture") ?? "P01";
  if (fixtureId !== "P01") {
    console.error(`FAIL unsupported fixture ${fixtureId}; release 1.0 supports P01`);
    return 1;
  }
  const built = buildPack();
  console.log("EuroRollup Policy Lab — P01 Friday cutoff comparison");
  for (const line of built.summary) {
    console.log(`  ${line}`);
  }
  console.log(`  comparison digest: ${built.digest}`);
  console.log(`  pack digest:       ${built.packDigest}`);
  let failed = false;
  for (const [file, text] of [
    [PACK_FILE, built.packText],
    [MANIFEST_FILE, built.manifestText],
  ] as const) {
    const absolute = join(repoRoot, EVIDENCE_DIR, file);
    if (checkOnly) {
      if (!existsSync(absolute)) {
        console.error(`  FAIL ${EVIDENCE_DIR}/${file} is missing`);
        failed = true;
      } else if (readRepoText(`${EVIDENCE_DIR}/${file}`) !== text) {
        console.error(`  FAIL ${EVIDENCE_DIR}/${file} differs from a fresh replay`);
        failed = true;
      } else {
        console.log(`  OK   ${EVIDENCE_DIR}/${file} matches a fresh replay`);
      }
    } else {
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, text, "utf8");
      console.log(`  wrote ${EVIDENCE_DIR}/${file} (${Buffer.byteLength(text, "utf8")} bytes)`);
    }
  }
  return failed ? 1 : 0;
}

function commandVerify(argv: readonly string[]): number {
  const packDirectory = optionValue(argv, "--pack") ?? EVIDENCE_DIR;
  const manifestPath = join(repoRoot, packDirectory, MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    console.error(`FAIL manifest not found at ${packDirectory}/${MANIFEST_FILE}`);
    return 1;
  }
  const manifestText = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(manifestText) as {
    packId: string;
    packDigest: string;
    comparisonDigest: string;
    files: Array<{ path: string; sha256: string; bytes: number }>;
  };
  console.log(`EuroRollup Policy Lab — verify ${packDirectory} (pack ${manifest.packId})`);
  let firstMismatch: string | null = null;
  for (const file of manifest.files) {
    const absolute = join(repoRoot, packDirectory, file.path);
    if (!existsSync(absolute)) {
      firstMismatch ??= `missing pack file ${file.path}`;
      continue;
    }
    const text = readFileSync(absolute, "utf8");
    if (evidenceFileRef(file.path, text).sha256 !== file.sha256) {
      firstMismatch ??= `file digest mismatch for ${file.path}`;
    }
    if (Buffer.byteLength(text, "utf8") !== file.bytes) {
      firstMismatch ??= `file size mismatch for ${file.path}`;
    }
  }
  const built = buildPack();
  const committedText = readRepoText(`${packDirectory}/${PACK_FILE}`);
  if (committedText !== built.packText) {
    firstMismatch ??= `${PACK_FILE} is not byte-identical to a fresh replay`;
  }
  if (manifest.comparisonDigest !== built.digest) {
    firstMismatch ??= "comparison digest differs from a fresh replay";
  }
  if (manifest.packDigest !== built.packDigest) {
    firstMismatch ??= "pack digest differs from a fresh replay";
  }
  if (firstMismatch !== null) {
    console.error(`FAIL ${firstMismatch}`);
    return 1;
  }
  console.log(`OK   ${packDirectory} verified: file digests, comparison digest and replay match`);
  return 0;
}

function main(argv: readonly string[]): number {
  const [command, ...rest] = argv;
  switch (command) {
    case "replay":
      return commandReplay(rest);
    case "verify":
      return commandVerify(rest);
    default:
      console.error(
        [
          "Usage:",
          "  tsx packages/policy-lab/src/cli.ts replay [--fixture P01] [--check]",
          "  tsx packages/policy-lab/src/cli.ts verify [--pack evidence/policy-lab]",
        ].join("\n"),
      );
      return 2;
  }
}

process.exitCode = main(process.argv.slice(2));
