#!/usr/bin/env node
/**
 * Evidence runner for gates A02 (API dealing cases) and A06 (invariants).
 *
 * Usage:
 *   pnpm scenario:api            write evidence files
 *   pnpm scenario:api -- --check regenerate and compare with the committed bytes
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { dirname, join } from "node:path";
import { repositoryRoot } from "../src/config.js";
import { runApiDealingCases, runInvariantCases } from "../src/evidence/cases.js";
import { buildEvidenceFile, type CaseResult } from "../src/evidence/types.js";

interface EvidenceTarget {
  readonly path: string;
  readonly fixtureId: string;
  readonly fixtureVersion: string;
}

async function main(): Promise<void> {
  const checkOnly = process.argv.includes("--check");
  const root = repositoryRoot();
  const targets: EvidenceTarget[] = [
    { path: "evidence/a02/api-dealing-cases.json", fixtureId: "A02-api-dealing", fixtureVersion: "1.0.0" },
    { path: "evidence/a06/invariants.json", fixtureId: "A06-invariants", fixtureVersion: "1.0.0" },
  ];
  const caseSets: readonly CaseResult[][] = [
    await runApiDealingCases(),
    await runInvariantCases(),
  ];

  let failed = false;
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    const cases = caseSets[index];
    if (target === undefined || cases === undefined) {
      continue;
    }
    const evidence = buildEvidenceFile({
      fixtureId: target.fixtureId,
      fixtureVersion: target.fixtureVersion,
      generatedBy: "pnpm scenario:api",
      cases,
    });
    const text = `${JSON.stringify(evidence, null, 2)}\n`;
    console.log(`\n${target.fixtureId}: ${evidence.summary.passed}/${evidence.summary.total} cases passed`);
    console.log(`  business digest ${evidence.businessDigest}`);
    for (const item of cases) {
      const icon = item.pass ? "PASS" : "FAIL";
      console.log(`  ${icon} ${item.caseId} — ${item.title}`);
      for (const check of item.checks) {
        if (!check.pass) {
          console.log(`       expected ${check.expected}, observed ${check.actual} (${check.label})`);
        }
      }
      if (!item.pass) {
        failed = true;
      }
    }
    const absolutePath = join(root, target.path);
    if (checkOnly) {
      if (!existsSync(absolutePath)) {
        console.error(`  FAIL ${target.path} is missing; run without --check to generate it`);
        failed = true;
        continue;
      }
      const committed = readFileSync(absolutePath, "utf8");
      if (committed !== text) {
        console.error(`  FAIL ${target.path} differs from a fresh evidence run`);
        failed = true;
      } else {
        console.log(`  OK   ${target.path} matches a fresh evidence run`);
      }
    } else {
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, text, "utf8");
      console.log(`  wrote ${target.path} (${Buffer.byteLength(text, "utf8")} bytes)`);
    }
  }
  process.exitCode = failed ? 1 : 0;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
