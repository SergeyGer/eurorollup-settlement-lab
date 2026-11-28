#!/usr/bin/env node
/**
 * Evidence runner for the EuroRollup Settlement Lab.
 *
 * Commands:
 *   golden [--check]        replay G01 and write evidence/g01/golden-run.json
 *   boundary [--check]      evaluate A02 boundary dealing cases
 *   verify [--pack <dir>]   verify a committed evidence pack against fresh replay
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import {
  ENGINE_VERSION,
  buildDealingCasesEvidence,
  buildEvidenceManifest,
  buildG01Evidence,
  calendarFromFixture,
  fileSha256,
  formatDisplayAmount,
  parseBaseUnits,
  runBoundaryCases,
  runG01,
  runG01Redemption,
  serializeEvidenceJson,
  resolvePackDirectory,
  serializeGoldenRun,
  type BoundaryCasesFixture,
  type CalendarFixture,
  type EvidenceFileRef,
  type G01RedemptionScenario,
  type G01Scenario,
  type PortfolioSnapshot,
} from "./index.js";

const repoRoot = process.cwd();

function readRepoJson<T>(relativePath: string): T {
  const absolutePath = join(repoRoot, relativePath);
  if (!existsSync(absolutePath)) {
    throw new Error(`Missing fixture: ${relativePath}`);
  }
  return JSON.parse(readFileSync(absolutePath, "utf8")) as T;
}

function readRepoText(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

function fileRef(relativePath: string): EvidenceFileRef {
  const text = readRepoText(relativePath);
  return {
    path: relativePath,
    sha256: fileSha256(text),
    bytes: Buffer.byteLength(text, "utf8"),
  };
}

function formatD(amountBase: string, decimals = 6, display = 2): string {
  return formatDisplayAmount(parseBaseUnits(amountBase), decimals, display);
}

function printCheckpoint(snapshot: PortfolioSnapshot): void {
  const tWeth = snapshot.holdings.find((holding) => holding.assetId === "tWETH");
  const eFund = snapshot.holdings.find((holding) => holding.assetId === "eFUND");
  console.log(
    `  ${snapshot.label.padEnd(52)} spendable ${formatD(snapshot.spendableCashBase)} | reserved ${formatD(snapshot.reservedCashBase)} | tWETH ${formatD(tWeth?.balanceBase ?? "0", 18, 6)} | eFUND ${formatD(eFund?.balanceBase ?? "0", 6, 6)} | value ${formatD(snapshot.totalMarkedValueBase)}`,
  );
}

interface CommandOptions {
  readonly check: boolean;
  readonly pack: string;
}

function parseOptions(argv: readonly string[]): CommandOptions {
  let check = false;
  let pack = "evidence/g01";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") {
      check = true;
      continue;
    }
    if (argument === "--pack") {
      const next = argv[index + 1];
      if (next !== undefined) {
        pack = next;
        index += 1;
      }
      continue;
    }
    if (argument !== undefined && argument.startsWith("--pack=")) {
      pack = argument.slice("--pack=".length);
    }
  }
  return { check, pack };
}

function writeOrCheck(relativePath: string, content: string, check: boolean): boolean {
  if (check) {
    if (!existsSync(join(repoRoot, relativePath))) {
      console.error(`FAIL ${relativePath} does not exist; run without --check to generate it`);
      return false;
    }
    const committed = readRepoText(relativePath);
    if (committed !== content) {
      console.error(`FAIL ${relativePath} differs from a fresh replay`);
      return false;
    }
    console.log(`OK   ${relativePath} matches a fresh replay`);
    return true;
  }
  mkdirSync(join(repoRoot, relativePath, ".."), { recursive: true });
  writeFileSync(join(repoRoot, relativePath), content, "utf8");
  console.log(`Wrote ${relativePath} (${Buffer.byteLength(content, "utf8")} bytes)`);
  return true;
}

function buildGoldenRun(): {
  run: ReturnType<typeof buildG01Evidence>;
  manifest: ReturnType<typeof buildEvidenceManifest>;
  goldenText: string;
  manifestText: string;
} {
  const scenario = readRepoJson<G01Scenario>("fixtures/g01/scenario.json");
  const redemptionScenario =
    readRepoJson<G01RedemptionScenario>("fixtures/g01/redemption.json");
  const calendarFixture = readRepoJson<CalendarFixture>("fixtures/calendar/LAB-UTC-1.json");
  const calendar = calendarFromFixture(calendarFixture);

  const g01 = runG01(scenario, calendarFixture);
  const redemption = runG01Redemption(
    redemptionScenario,
    g01.engine,
    scenario.accounts.investorId,
  );
  const run = buildG01Evidence({
    scenario,
    redemptionScenario,
    calendarFixture,
    calendar,
    g01Steps: g01.engine.steps,
    g01Receipts: g01.receipts,
    g01Checkpoints: g01.checkpoints,
    g01FinalPortfolio: g01.finalPortfolio,
    redemptionSteps: redemption.engine.steps.slice(g01.engine.steps.length),
    redemptionReceipt: redemption.receipt,
    redemptionFinalPortfolio: redemption.finalizedPortfolio,
  });
  const goldenText = serializeGoldenRun(run);
  const inputFiles = [
    fileRef("fixtures/g01/scenario.json"),
    fileRef("fixtures/g01/redemption.json"),
    fileRef("fixtures/calendar/LAB-UTC-1.json"),
    fileRef("fixtures/instruments.json"),
  ];
  const manifest = buildEvidenceManifest({
    packId: "G01",
    run,
    inputFiles,
    files: [{ path: "golden-run.json", sha256: fileSha256(goldenText), bytes: Buffer.byteLength(goldenText, "utf8") }],
  });
  const manifestText = serializeEvidenceJson(manifest);
  return { run, manifest, goldenText, manifestText };
}

function commandGolden(options: CommandOptions): number {
  console.log(`EuroRollup Settlement Lab — G01 golden replay (engine ${ENGINE_VERSION})`);
  const { run, goldenText, manifestText } = buildGoldenRun();
  printCheckpoint(run.cases[0]?.checkpoints[0] as PortfolioSnapshot);
  for (const snapshot of (run.cases[0]?.checkpoints ?? []).slice(1)) {
    printCheckpoint(snapshot);
  }
  console.log("  Checkpoints:");
  for (const snapshot of run.cases[1]?.checkpoints ?? []) {
    printCheckpoint(snapshot);
  }
  console.log("  Receipts:");
  for (const receipt of run.cases.flatMap((item) => item.receipts)) {
    console.log(`    ${receipt.orderId}: ${JSON.stringify(receipt)}`);
  }
  console.log(`  Business digest: ${run.businessDigest}`);

  const goldenOk = writeOrCheck("evidence/g01/golden-run.json", goldenText, options.check);
  const manifestOk = writeOrCheck("evidence/g01/manifest.json", manifestText, options.check);
  if (options.check) {
    return goldenOk && manifestOk ? 0 : 1;
  }
  return 0;
}

function commandBoundary(options: CommandOptions): number {
  const fixture = readRepoJson<BoundaryCasesFixture>("fixtures/dealing-cases/boundary.json");
  const calendarDir = join(repoRoot, "fixtures/calendar");
  const calendars = readdirSync(calendarDir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => readRepoJson<CalendarFixture>(`fixtures/calendar/${file}`));
  const results = runBoundaryCases(fixture, calendars);
  const evidence = buildDealingCasesEvidence({ fixture, calendars, results });
  console.log(`EuroRollup Settlement Lab — A02 boundary dealing cases (engine ${ENGINE_VERSION})`);
  for (const result of results) {
    const expected = result.expected;
    const icon = result.pass ? "PASS" : "FAIL";
    console.log(
      `  ${icon} ${result.caseId.padEnd(18)} requested ${result.requestedAt} calendar ${result.calendarId}: baseline ${result.baseline.dealingDate} (expected ${expected.baselineDealingDate}), candidate ${result.candidate.dealingDate} (expected ${expected.candidateDealingDate})`,
    );
  }
  console.log(
    `  Summary: ${evidence.summary.passed}/${evidence.summary.total} cases passed; business digest ${evidence.businessDigest}`,
  );
  const text = serializeEvidenceJson(evidence);
  const written = writeOrCheck("evidence/a02/dealing-cases.json", text, options.check);
  return evidence.summary.failed === 0 && written ? 0 : 1;
}

function commandVerify(options: CommandOptions): number {
  const packDir = resolvePackDirectory(options.pack);
  const manifestPath = join(repoRoot, packDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    console.error(`FAIL pack manifest not found: ${packDir}/manifest.json`);
    return 1;
  }
  const manifestText = readFileSync(manifestPath, "utf8");
  const manifest = JSON.parse(manifestText) as {
    packId: string;
    businessDigest: string;
    inputs: EvidenceFileRef[];
    files: EvidenceFileRef[];
  };
  console.log(`EuroRollup Settlement Lab — verify ${packDir} (pack ${manifest.packId})`);

  let firstMismatch: string | null = null;
  for (const input of manifest.inputs) {
    const absolute = join(repoRoot, input.path);
    if (!existsSync(absolute)) {
      firstMismatch ??= `missing input ${input.path}`;
      continue;
    }
    const text = readFileSync(absolute, "utf8");
    if (fileSha256(text) !== input.sha256) {
      firstMismatch ??= `input digest mismatch for ${input.path}`;
    }
  }
  for (const file of manifest.files) {
    const absolute = join(repoRoot, packDir, file.path);
    if (!existsSync(absolute)) {
      firstMismatch ??= `missing pack file ${file.path}`;
      continue;
    }
    const text = readFileSync(absolute, "utf8");
    if (fileSha256(text) !== file.sha256) {
      firstMismatch ??= `file digest mismatch for ${file.path}`;
    }
    if (Buffer.byteLength(text, "utf8") !== file.bytes) {
      firstMismatch ??= `file size mismatch for ${file.path}`;
    }
  }

  if (manifest.packId === "G01" && firstMismatch === null) {
    const { run, goldenText, manifestText: regeneratedManifestText } = buildGoldenRun();
    const committedGoldenText = readRepoText(join(packDir, "golden-run.json"));
    if (committedGoldenText !== goldenText) {
      firstMismatch ??= "golden-run.json is not byte-identical to a fresh replay";
    }
    if (manifest.businessDigest !== run.businessDigest) {
      firstMismatch ??= "business digest differs from a fresh replay";
    }
    if (manifestText.trim() !== regeneratedManifestText.trim()) {
      firstMismatch ??= "manifest is not byte-identical to a fresh replay";
    }
  }

  if (firstMismatch !== null) {
    console.error(`FAIL ${firstMismatch}`);
    return 1;
  }
  console.log(`OK   ${packDir} verified: inputs, file digests, business digest and replay match`);
  return 0;
}

function main(argv: readonly string[]): number {
  const [command, ...rest] = argv;
  const options = parseOptions(rest);
  switch (command) {
    case "golden":
      return commandGolden(options);
    case "boundary":
      return commandBoundary(options);
    case "verify":
      return commandVerify(options);
    default:
      console.error(
        [
          "Usage:",
          "  tsx packages/dealing/src/cli.ts golden [--check]",
          "  tsx packages/dealing/src/cli.ts boundary [--check]",
          "  tsx packages/dealing/src/cli.ts verify [--pack evidence/g01]",
        ].join("\n"),
      );
      return 2;
  }
}

process.exitCode = main(process.argv.slice(2));
