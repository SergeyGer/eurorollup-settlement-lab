/**
 * Deterministic two-branch replay tests for the Friday cutoff experiment.
 *
 * The expected values are frozen by the specification: 3.125000 vs 3.000000
 * units for the 15:30 order, one of two orders changing dealing date, EUR 300
 * more reserved at Friday close, and a 72 hour settlement difference.
 */
import { describe, expect, it } from "vitest";
import { canonicalJson, type CalendarFixture } from "@eurorollup/dealing";
import {
  buildP01ComparisonPack,
  policyFromFixture,
  runP01BoundaryCases,
  runP01Comparison,
  serializeP01ComparisonPack,
  type P01BoundaryFixture,
} from "../src/index.js";
import p01Json from "../../../fixtures/p01/scenario.json";
import labUtc1Json from "../../../fixtures/calendar/LAB-UTC-1.json";
import labUtc2Json from "../../../fixtures/calendar/LAB-UTC-2.json";
import boundaryJson from "../../../fixtures/policy-lab/p01-boundary.json";
import type { P01Scenario } from "@eurorollup/dealing";

const fixture = p01Json as unknown as P01Scenario;
const labUtc1 = labUtc1Json as unknown as CalendarFixture;
const labUtc2 = labUtc2Json as unknown as CalendarFixture;
const boundaryFixture = boundaryJson as unknown as P01BoundaryFixture;
const baselinePolicy = policyFromFixture(fixture.baselinePolicy);
const candidatePolicy = policyFromFixture(fixture.candidatePolicy);

function runComparison() {
  return runP01Comparison({
    fixture,
    calendarFixture: labUtc1,
    baselinePolicy,
    candidatePolicy,
  });
}

describe("P01 baseline branch", () => {
  const comparison = runComparison();

  it("allocates both orders on Friday at NAV 96.00", () => {
    expect(comparison.baseline.orders.map((order) => order.dealingDate)).toEqual([
      "2026-11-20",
      "2026-11-20",
    ]);
    expect(comparison.baseline.orders.map((order) => order.unitsBase)).toEqual([
      "3125000",
      "3125000",
    ]);
  });

  it("shows 1,400.00 spendable, no reservation and 6.250000 units at both closes", () => {
    expect(comparison.baseline.snapshots["fridayClose"]).toEqual({
      spendableBase: "1400000000",
      reservedBase: "0",
      unitsBase: "6250000",
    });
    expect(comparison.baseline.snapshots["mondayClose"]).toEqual({
      spendableBase: "1400000000",
      reservedBase: "0",
      unitsBase: "6250000",
    });
  });
});

describe("P01 candidate branch", () => {
  const comparison = runComparison();

  it("keeps the 14:50 order on Friday and moves the 15:30 order to Monday", () => {
    const first = comparison.candidate.orders.find((order) => order.orderId === "P01-F-1450");
    const second = comparison.candidate.orders.find((order) => order.orderId === "P01-F-1530");
    expect(first?.dealingDate).toBe("2026-11-20");
    expect(second?.dealingDate).toBe("2026-11-23");
    expect(second?.navBase).toBe("100000000");
    expect(second?.unitsBase).toBe("3000000");
  });

  it("leaves 300.00 dEUR reserved at Friday close with 3.125000 units", () => {
    expect(comparison.candidate.snapshots["fridayClose"]).toEqual({
      spendableBase: "1400000000",
      reservedBase: "300000000",
      unitsBase: "3125000",
    });
  });

  it("settles at 6.125000 units on Monday and releases the reservation", () => {
    expect(comparison.candidate.snapshots["mondayClose"]).toEqual({
      spendableBase: "1400000000",
      reservedBase: "0",
      unitsBase: "6125000",
    });
  });
});

describe("P01 result card", () => {
  const comparison = runComparison();

  it("reports one affected order out of two and EUR 300 extra reserved", () => {
    expect(comparison.affectedOrders).toBe(1);
    expect(comparison.totalOrders).toBe(2);
    expect(comparison.extraReservedAtFridayCloseBase).toBe("300000000");
    expect(comparison.deltas.changedOrderIds).toEqual(["P01-F-1530"]);
  });

  it("reports 0.125000 fewer units for the later order", () => {
    expect(comparison.deltas.unitDeltaByOrder["P01-F-1530"]).toBe("-125000");
    expect(comparison.deltas.unitDeltaByOrder["P01-F-1450"]).toBe("0");
  });

  it("settles the later order 72 hours later", () => {
    const change = comparison.orderChanges.find((item) => item.orderId === "P01-F-1530");
    expect(change?.baselineDealingDate).toBe("2026-11-20");
    expect(change?.candidateDealingDate).toBe("2026-11-23");
    const hours =
      (Date.parse("2026-11-23T17:01:00Z") - Date.parse("2026-11-20T17:01:00Z")) / 3_600_000;
    expect(hours).toBe(72);
  });

  it("keeps both branches independent with distinct policy hashes and logs", () => {
    expect(comparison.baseline.policyHash).not.toBe(comparison.candidate.policyHash);
    expect(comparison.baseline.eventLogHash).not.toBe(comparison.candidate.eventLogHash);
    expect(comparison.baseline.policy.version).toBe(1);
    expect(comparison.candidate.policy.version).toBe(2);
  });

  it("produces the same comparison digest on every run", () => {
    const second = runComparison();
    expect(second.comparisonDigest).toBe(comparison.comparisonDigest);
    expect(canonicalJson(second)).toBe(canonicalJson(comparison));
  });
});

describe("P01 boundary replay cases", () => {
  const cases = runP01BoundaryCases({
    fixture,
    boundaryFixture,
    calendars: { "LAB-UTC-1": labUtc1, "LAB-UTC-2": labUtc2 },
    baselinePolicy,
    candidatePolicy,
  });

  it("passes every frozen boundary case", () => {
    expect(cases.filter((item) => !item.pass)).toEqual([]);
    expect(cases).toHaveLength(6);
  });

  it("assigns 14:59:59, 15:00:00 and 16:00:00 UTC as specified", () => {
    const byId = new Map(cases.map((item) => [item.caseId, item]));
    expect(byId.get("P01-B-145959")?.candidate.dealingDate).toBe("2026-11-20");
    expect(byId.get("P01-B-150000")?.candidate.dealingDate).toBe("2026-11-23");
    expect(byId.get("P01-B-160000")?.baseline.dealingDate).toBe("2026-11-23");
    expect(byId.get("P01-B-160000")?.candidate.dealingDate).toBe("2026-11-23");
  });

  it("moves the candidate order to Tuesday when Monday is closed", () => {
    const closed = cases.find((item) => item.caseId === "P01-B-MONDAY-CLOSED");
    expect(closed?.baseline.dealingDate).toBe("2026-11-20");
    expect(closed?.candidate.dealingDate).toBe("2026-11-24");
    expect(closed?.candidate.unitsBase).toBe("3030303");
  });

  it("keeps the candidate order pending when Monday NAV is missing", () => {
    const missing = cases.find((item) => item.caseId === "P01-B-MISSING-MONDAY-NAV");
    expect(missing?.candidate.pending).toBe(true);
    expect(missing?.candidate.unitsBase).toBeNull();
    expect(missing?.candidate.reservedCashBase).toBe("300000000");
  });
});

describe("P01 evidence pack", () => {
  it("builds a deterministic pack with the committed comparison digest", () => {
    const comparison = runComparison();
    const cases = runP01BoundaryCases({
      fixture,
      boundaryFixture,
      calendars: { "LAB-UTC-1": labUtc1, "LAB-UTC-2": labUtc2 },
      baselinePolicy,
      candidatePolicy,
    });
    const pack = buildP01ComparisonPack({ comparison, boundaryCases: cases, boundaryFixture });
    expect(pack.comparisonDigest).toBe(comparison.comparisonDigest);
    expect(pack.boundarySummary).toEqual({ total: 6, passed: 6, failed: 0 });
    expect(pack.packDigest).toMatch(/^[0-9a-f]{64}$/);
    const first = serializeP01ComparisonPack(pack);
    const second = serializeP01ComparisonPack(
      buildP01ComparisonPack({ comparison: runComparison(), boundaryCases: cases, boundaryFixture }),
    );
    expect(first).toBe(second);
  });
});
