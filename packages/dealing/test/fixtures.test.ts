import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  allocateCashToUnits,
  buildDealingCasesEvidence,
  calendarFromFixture,
  runBoundaryCases,
  p01OrderAssignments,
  type BoundaryCasesFixture,
  type CalendarFixture,
} from "../src/index.js";
import {
  boundaryFixture,
  buildG01TestEvidence,
  labUtc1,
  p01Scenario,
} from "./helpers.js";
import calendar2Json from "../../../fixtures/calendar/LAB-UTC-2.json";
import instrumentsJson from "../../../fixtures/instruments.json";

const labUtc2 = calendar2Json as unknown as CalendarFixture;

function readRepo(relativePath: string): string {
  return readFileSync(new URL(`../../../${relativePath}`, import.meta.url), "utf8");
}

function readSchema(name: string): Record<string, unknown> {
  return JSON.parse(readRepo(`schemas/${name}`)) as Record<string, unknown>;
}

const ajv = new Ajv2020({ strict: false, allErrors: true });

describe("A02 boundary dealing cases", () => {
  it("passes every frozen boundary case", () => {
    const results = runBoundaryCases(boundaryFixture, [labUtc1, labUtc2]);
    const failed = results.filter((result) => !result.pass);
    expect(failed).toEqual([]);
    expect(results).toHaveLength(boundaryFixture.cases.length);
  });

  it("assigns 14:59:59, 15:00:00 and 16:00:00 exactly as specified", () => {
    const results = runBoundaryCases(boundaryFixture, [labUtc1, labUtc2]);
    const byId = new Map(results.map((result) => [result.caseId, result]));
    expect(byId.get("B-1459-59")?.candidate.dealingDate).toBe("2026-11-20");
    expect(byId.get("B-1500-00")?.candidate.dealingDate).toBe("2026-11-23");
    expect(byId.get("B-1600-00")?.baseline.dealingDate).toBe("2026-11-23");
    expect(byId.get("B-1600-00")?.candidate.dealingDate).toBe("2026-11-23");
  });

  it("produces deterministic boundary evidence", () => {
    const calendars = [labUtc1, labUtc2];
    const results = runBoundaryCases(boundaryFixture, calendars);
    const first = buildDealingCasesEvidence({ fixture: boundaryFixture, calendars, results });
    const second = buildDealingCasesEvidence({ fixture: boundaryFixture, calendars, results });
    expect(first.businessDigest).toBe(second.businessDigest);
    expect(first.summary).toEqual({ total: 8, passed: 8, failed: 0 });
  });
});

describe("P01 Friday cutoff assignments", () => {
  const calendar = calendarFromFixture(labUtc1);
  const assignments = p01OrderAssignments(p01Scenario, labUtc1);
  const byId = new Map(assignments.map((assignment) => [assignment.orderId, assignment]));

  it("keeps the 14:50 order on Friday under both policies", () => {
    expect(byId.get("P01-F-1450")?.baselineDealingDate).toBe("2026-11-20");
    expect(byId.get("P01-F-1450")?.candidateDealingDate).toBe("2026-11-20");
  });

  it("moves the 15:30 order from Friday to Monday under the candidate policy", () => {
    expect(byId.get("P01-F-1530")?.baselineDealingDate).toBe("2026-11-20");
    expect(byId.get("P01-F-1530")?.candidateDealingDate).toBe("2026-11-23");
  });

  it("matches the frozen unit expectations at the supplied NAVs", () => {
    const friday = allocateCashToUnits({
      cashBase: 300_000_000n,
      cashDecimals: 6,
      navBase: 96_000_000n,
      navDecimals: 6,
      unitDecimals: 6,
    });
    const monday = allocateCashToUnits({
      cashBase: 300_000_000n,
      cashDecimals: 6,
      navBase: 100_000_000n,
      navDecimals: 6,
      unitDecimals: 6,
    });
    expect(friday.unitsBase.toString()).toBe(p01Scenario.expected.unitsByBranch.baseline["P01-F-1530"]);
    expect(monday.unitsBase.toString()).toBe(p01Scenario.expected.unitsByBranch.candidate["P01-F-1530"]);
    expect(p01Scenario.expected.affectedOrders).toBe(1);
    expect(p01Scenario.expected.extraReservedAtFridayCloseBase).toBe("300000000");
    expect(calendar.calendarId).toBe("LAB-UTC-1");
  });

  it("documents the 72 hour settlement difference", () => {
    const friday = byId.get("P01-F-1530")?.baselineDealingDate;
    const monday = byId.get("P01-F-1530")?.candidateDealingDate;
    expect(friday).toBe("2026-11-20");
    expect(monday).toBe("2026-11-23");
    const hours = (Date.parse(`${monday}T17:01:00Z`) - Date.parse(`${friday}T17:01:00Z`)) / 3_600_000;
    expect(hours).toBe(72);
  });
});

describe("fixtures and versioned schemas", () => {
  it("declares the expected instruments and decimals", () => {
    const instruments = instrumentsJson as {
      assets: Array<{ assetId: string; decimals: number; kind: string }>;
    };
    expect(instruments.assets.map((asset) => [asset.assetId, asset.decimals, asset.kind])).toEqual([
      ["dEUR", 6, "cash"],
      ["tWETH", 18, "spot"],
      ["eFUND", 6, "fund"],
    ]);
  });

  it("validates the generated G01 evidence against the golden-run schema", () => {
    const validate = ajv.compile(readSchema("golden-run.schema.json"));
    const { run, manifest } = buildG01TestEvidence();
    expect(validate(run)).toBe(true);
    expect(validate.errors).toBeNull();
    const validateManifest = ajv.compile(readSchema("evidence-manifest.schema.json"));
    expect(validateManifest(manifest)).toBe(true);
    const validateJournal = ajv.compile(readSchema("journal.schema.json"));
    expect(
      validateJournal({
        schemaVersion: "1.0.0",
        entries: run.cases.flatMap((item) => item.steps.flatMap((step) => step.journal)),
        imbalances: [],
      }),
    ).toBe(true);
  });

  it("validates every receipt against its schema", () => {
    const { run } = buildG01TestEvidence();
    const receiptsSchemaByName: Record<string, string> = {
      "G01-SPOT-01": "spot-receipt.schema.json",
      "G01-FUND-01": "receipt.schema.json",
      "G01-RED-01": "redemption-receipt.schema.json",
    };
    for (const receipt of run.cases.flatMap((item) => item.receipts)) {
      const schemaName = receiptsSchemaByName[receipt.orderId];
      expect(schemaName).toBeDefined();
      const validate = ajv.compile(readSchema(schemaName as string));
      expect(validate(receipt)).toBe(true);
    }
  });

  it("validates the boundary evidence against its schema", () => {
    const calendars = [labUtc1, labUtc2];
    const results = runBoundaryCases(boundaryFixture as BoundaryCasesFixture, calendars);
    const evidence = buildDealingCasesEvidence({
      fixture: boundaryFixture,
      calendars,
      results,
    });
    const validate = ajv.compile(readSchema("dealing-cases.schema.json"));
    expect(validate(evidence)).toBe(true);
  });

  it("keeps every fixture readable as versioned JSON", () => {
    for (const path of [
      "fixtures/instruments.json",
      "fixtures/calendar/LAB-UTC-1.json",
      "fixtures/calendar/LAB-UTC-2.json",
      "fixtures/g01/scenario.json",
      "fixtures/g01/redemption.json",
      "fixtures/p01/scenario.json",
      "fixtures/dealing-cases/boundary.json",
    ]) {
      expect(() => JSON.parse(readRepo(path))).not.toThrow();
    }
  });
});
