import { describe, expect, it } from "vitest";
import {
  assignDealingDay,
  calendarFromFixture,
  isDealingDay,
  nextDealingDayAfter,
  parseUtcInstant,
  secondsOfUtcTime,
  validateCalendar,
  weekdayCodeOfDate,
} from "../src/index.js";
import { labUtc1, boundaryFixture } from "./helpers.js";
import calendar2Json from "../../../fixtures/calendar/LAB-UTC-2.json";
import type { CalendarFixture } from "../src/index.js";

const labUtc2 = calendar2Json as unknown as CalendarFixture;

describe("UTC time handling", () => {
  it("parses instants without host-timezone dependence", () => {
    const instant = parseUtcInstant("2026-11-20T14:59:59Z");
    expect(instant.date).toBe("2026-11-20");
    expect(instant.time).toBe("14:59:59");
    expect(instant.weekday).toBe(5);
  });

  it("compares cutoff times including seconds", () => {
    expect(secondsOfUtcTime("14:59:59")).toBeLessThan(secondsOfUtcTime("15:00"));
    expect(secondsOfUtcTime("16:00")).toBe(57_600);
    expect(secondsOfUtcTime("15:00:00")).toBe(secondsOfUtcTime("15:00"));
  });

  it("rejects malformed instants", () => {
    expect(() => parseUtcInstant("2026-11-20 14:00:00")).toThrowError();
    expect(() => parseUtcInstant("2026-02-31T00:00:00Z")).toThrowError();
  });
});

describe("dealing calendar LAB-UTC-1", () => {
  const calendar = calendarFromFixture(labUtc1);

  it("knows fixture dealing days and weekends", () => {
    expect(isDealingDay("2026-11-20", calendar)).toBe(true);
    expect(isDealingDay("2026-11-23", calendar)).toBe(true);
    expect(isDealingDay("2026-11-21", calendar)).toBe(false);
    expect(isDealingDay("2026-11-22", calendar)).toBe(false);
  });

  it("moves to the next dealing day after the weekend", () => {
    expect(nextDealingDayAfter("2026-11-20", calendar)).toBe("2026-11-23");
    expect(nextDealingDayAfter("2026-11-21", calendar)).toBe("2026-11-23");
  });

  it("assigns strictly-before-cutoff requests to the same dealing day", () => {
    const assignment = assignDealingDay({
      requestedAt: "2026-11-20T14:59:59Z",
      cutoffTimeUtc: "15:00",
      calendar,
    });
    expect(assignment.dealingDate).toBe("2026-11-20");
    expect(assignment.reason).toBe("BEFORE_CUTOFF_SAME_DAY");
  });

  it("advances exactly-at-cutoff requests to the next dealing day", () => {
    const assignment = assignDealingDay({
      requestedAt: "2026-11-20T15:00:00Z",
      cutoffTimeUtc: "15:00",
      calendar,
    });
    expect(assignment.dealingDate).toBe("2026-11-23");
    expect(assignment.reason).toBe("AT_OR_AFTER_CUTOFF");
  });

  it("advances weekend requests to the next dealing day", () => {
    const assignment = assignDealingDay({
      requestedAt: "2026-11-21T12:00:00Z",
      cutoffTimeUtc: "16:00",
      calendar,
    });
    expect(assignment.dealingDate).toBe("2026-11-23");
    expect(assignment.reason).toBe("NON_DEALING_DAY");
  });
});

describe("alternate calendar LAB-UTC-2", () => {
  const calendar = calendarFromFixture(labUtc2);

  it("moves a closed Monday request to Tuesday", () => {
    const assignment = assignDealingDay({
      requestedAt: "2026-11-23T10:00:00Z",
      cutoffTimeUtc: "16:00",
      calendar,
    });
    expect(assignment.dealingDate).toBe("2026-11-24");
    expect(assignment.reason).toBe("NON_DEALING_DAY");
  });

  it("keeps the Friday boundary cases intact under both cutoffs", () => {
    const cases = [
      { at: "2026-11-20T14:59:59Z", cutoff: "15:00", expected: "2026-11-20" },
      { at: "2026-11-20T15:00:00Z", cutoff: "15:00", expected: "2026-11-23" },
      { at: "2026-11-20T15:59:59Z", cutoff: "16:00", expected: "2026-11-20" },
      { at: "2026-11-20T16:00:00Z", cutoff: "16:00", expected: "2026-11-23" },
    ];
    for (const testCase of cases) {
      expect(
        assignDealingDay({
          requestedAt: testCase.at,
          cutoffTimeUtc: testCase.cutoff,
          calendar: calendarFromFixture(labUtc1),
        }).dealingDate,
      ).toBe(testCase.expected);
    }
  });
});

describe("calendar validation and weekday codes", () => {
  it("rejects weekend dates in an explicit dealing-day whitelist", () => {
    expect(() =>
      validateCalendar({
        calendarId: "bad",
        version: "1",
        timezone: "UTC",
        dealingDays: ["2026-11-21"],
      }),
    ).toThrowError();
  });

  it("resolves weekday codes used by the policy change", () => {
    expect(weekdayCodeOfDate("2026-11-20")).toBe("FRI");
    expect(weekdayCodeOfDate("2026-11-23")).toBe("MON");
    expect(boundaryFixture.fixtureId).toBe("A02-boundaries");
  });
});
