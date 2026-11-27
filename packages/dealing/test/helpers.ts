import { readFileSync } from "node:fs";
import {
  buildEvidenceManifest,
  buildG01Evidence,
  calendarFromFixture,
  fileSha256,
  runG01,
  runG01Redemption,
  serializeEvidenceJson,
  serializeGoldenRun,
  type CalendarFixture,
  type EvidenceManifest,
  type G01RedemptionScenario,
  type G01Scenario,
  type GoldenRun,
} from "../src/index.js";
import scenarioJson from "../../../fixtures/g01/scenario.json";
import redemptionJson from "../../../fixtures/g01/redemption.json";
import calendarJson from "../../../fixtures/calendar/LAB-UTC-1.json";
import p01Json from "../../../fixtures/p01/scenario.json";
import boundaryJson from "../../../fixtures/dealing-cases/boundary.json";
import type { BoundaryCasesFixture, P01Scenario } from "../src/index.js";
import { Buffer } from "node:buffer";

export const g01Scenario = scenarioJson as unknown as G01Scenario;
export const g01RedemptionScenario = redemptionJson as unknown as G01RedemptionScenario;
export const labUtc1 = calendarJson as unknown as CalendarFixture;
export const p01Scenario = p01Json as unknown as P01Scenario;
export const boundaryFixture = boundaryJson as unknown as BoundaryCasesFixture;

export interface BuiltEvidence {
  readonly run: GoldenRun;
  readonly goldenText: string;
  readonly manifest: EvidenceManifest;
  readonly manifestText: string;
}

export function buildG01TestEvidence(): BuiltEvidence {
  const calendar = calendarFromFixture(labUtc1);
  const scenarioText = readFileSync(
    new URL("../../../fixtures/g01/scenario.json", import.meta.url),
    "utf8",
  );
  const redemptionText = readFileSync(
    new URL("../../../fixtures/g01/redemption.json", import.meta.url),
    "utf8",
  );
  const calendarText = readFileSync(
    new URL("../../../fixtures/calendar/LAB-UTC-1.json", import.meta.url),
    "utf8",
  );
  const instrumentsText = readFileSync(
    new URL("../../../fixtures/instruments.json", import.meta.url),
    "utf8",
  );
  const g01 = runG01(g01Scenario, labUtc1);
  const redemption = runG01Redemption(
    g01RedemptionScenario,
    g01.engine,
    g01Scenario.accounts.investorId,
  );
  const run = buildG01Evidence({
    scenario: g01Scenario,
    redemptionScenario: g01RedemptionScenario,
    calendarFixture: labUtc1,
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
  const manifest = buildEvidenceManifest({
    packId: "G01",
    run,
    inputFiles: [
      {
        path: "fixtures/g01/scenario.json",
        sha256: fileSha256(scenarioText),
        bytes: Buffer.byteLength(scenarioText, "utf8"),
      },
      {
        path: "fixtures/g01/redemption.json",
        sha256: fileSha256(redemptionText),
        bytes: Buffer.byteLength(redemptionText, "utf8"),
      },
      {
        path: "fixtures/calendar/LAB-UTC-1.json",
        sha256: fileSha256(calendarText),
        bytes: Buffer.byteLength(calendarText, "utf8"),
      },
      {
        path: "fixtures/instruments.json",
        sha256: fileSha256(instrumentsText),
        bytes: Buffer.byteLength(instrumentsText, "utf8"),
      },
    ],
    files: [
      {
        path: "golden-run.json",
        sha256: fileSha256(goldenText),
        bytes: Buffer.byteLength(goldenText, "utf8"),
      },
    ],
  });
  return { run, goldenText, manifest, manifestText: serializeEvidenceJson(manifest) };
}
