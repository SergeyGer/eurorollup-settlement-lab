import { describe, expect, it } from "vitest";
import {
  applyCutoffChange,
  createBaselinePolicy,
  cutoffForWeekday,
  describePolicyChange,
  policyDigest,
  validateCutoffChange,
  validateCutoffTimeUtc,
  type CutoffChange,
} from "../src/index.js";

const validChange: CutoffChange = {
  operation: "set_subscription_cutoff",
  asset: "eFUND",
  weekday: "FRI",
  timeUtc: "15:00",
  timezone: "UTC",
};

describe("supported release-1.0 rule change", () => {
  it("starts from a 16:00 UTC baseline on every supported weekday", () => {
    const policy = createBaselinePolicy();
    expect(policy.version).toBe(1);
    for (const weekday of ["MON", "TUE", "WED", "THU", "FRI"] as const) {
      expect(cutoffForWeekday(policy, weekday)).toBe("16:00");
    }
  });

  it("accepts whole-minute UTC times from 00:01 to 16:59", () => {
    expect(validateCutoffTimeUtc("00:01")).toEqual([]);
    expect(validateCutoffTimeUtc("15:00")).toEqual([]);
    expect(validateCutoffTimeUtc("16:59")).toEqual([]);
  });

  it("rejects times outside the documented window or without minute precision", () => {
    expect(validateCutoffTimeUtc("00:00").length).toBeGreaterThan(0);
    expect(validateCutoffTimeUtc("17:00").length).toBeGreaterThan(0);
    expect(validateCutoffTimeUtc("15:30:00").length).toBeGreaterThan(0);
    expect(validateCutoffTimeUtc("15:30:30").length).toBeGreaterThan(0);
    expect(validateCutoffTimeUtc("midnight").length).toBeGreaterThan(0);
  });

  it("rejects unsupported weekdays, assets, timezones and operations", () => {
    expect(
      validateCutoffChange({ ...validChange, weekday: "SAT" as unknown as "FRI" }).length,
    ).toBeGreaterThan(0);
    expect(
      validateCutoffChange({ ...validChange, asset: "tWETH" as unknown as "eFUND" }).length,
    ).toBeGreaterThan(0);
    expect(
      validateCutoffChange({ ...validChange, timezone: "CET" as unknown as "UTC" }).length,
    ).toBeGreaterThan(0);
  });

  it("applies the Friday 16:00 to 15:00 change as a new revision", () => {
    const baseline = createBaselinePolicy();
    const result = applyCutoffChange(baseline, validChange);
    expect(result.kind).toBe("APPLIED");
    if (result.kind !== "APPLIED") {
      return;
    }
    expect(result.policy.version).toBe(2);
    expect(cutoffForWeekday(result.policy, "FRI")).toBe("15:00");
    expect(cutoffForWeekday(result.policy, "MON")).toBe("16:00");
    expect(policyDigest(result.policy)).not.toBe(policyDigest(baseline));
    expect(describePolicyChange(baseline, result.policy)).toEqual([
      "eFUND weekly subscription cutoff FRI 16:00 -> 15:00 UTC",
    ]);
  });

  it("returns NO_CHANGE when the requested rule equals the current rule", () => {
    const baseline = createBaselinePolicy();
    const result = applyCutoffChange(baseline, { ...validChange, timeUtc: "16:00" });
    expect(result.kind).toBe("NO_CHANGE");
    if (result.kind === "NO_CHANGE") {
      expect(result.policy.version).toBe(baseline.version);
    }
  });

  it("rejects invalid changes without mutating the baseline", () => {
    const baseline = createBaselinePolicy();
    const result = applyCutoffChange(baseline, { ...validChange, timeUtc: "17:30" });
    expect(result.kind).toBe("REJECTED");
    expect(baseline.weekdayCutoffs.FRI).toBe("16:00");
  });

  it("produces a stable digest for identical policy content", () => {
    const first = createBaselinePolicy();
    const second = createBaselinePolicy();
    expect(policyDigest(first)).toBe(policyDigest(second));
    expect(policyDigest(first)).toMatch(/^[0-9a-f]{64}$/);
  });
});
