/**
 * Versioned UTC dealing calendar and dealing-day assignment.
 *
 * Rules (specification, section 03 and 06):
 * - requests strictly before the cutoff on a dealing day enter that day's batch;
 * - at or after the cutoff, at weekends and on fixture holidays the order moves
 *   to the next dealing day;
 * - the calendar is versioned so a saved comparison cannot silently change.
 */
import { DealingError } from "./errors.js";
import {
  addUtcDaysToDate,
  isoWeekdayOfDate,
  secondsOfUtcTime,
  parseUtcInstant,
} from "./time.js";

export type SupportedDealingWeekday = "MON" | "TUE" | "WED" | "THU" | "FRI";

export const WEEKDAY_CODES = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const;

export type WeekdayCode = (typeof WEEKDAY_CODES)[number];

export interface DealingCalendar {
  readonly calendarId: string;
  readonly version: string;
  readonly timezone: "UTC";
  /**
   * Optional explicit whitelist of dealing days. When present, only these
   * dates are dealing days (weekends and other dates are closed). When absent,
   * Monday to Friday are dealing days except for dates in `closedDates`.
   */
  readonly dealingDays?: readonly string[];
  readonly closedDates?: readonly string[];
  readonly description?: string;
}

export type DealingAssignmentReason =
  | "BEFORE_CUTOFF_SAME_DAY"
  | "AT_OR_AFTER_CUTOFF"
  | "NON_DEALING_DAY";

export interface DealingAssignment {
  readonly requestedAt: string;
  readonly requestedDate: string;
  readonly cutoffTimeUtc: string;
  readonly dealingDate: string;
  readonly reason: DealingAssignmentReason;
  readonly calendarId: string;
  readonly calendarVersion: string;
}

export function isWeekend(date: string): boolean {
  const weekday = isoWeekdayOfDate(date);
  return weekday === 6 || weekday === 7;
}

/** Returns the weekday code for a UTC date (MON..SUN). */
export function weekdayCodeOfDate(date: string): WeekdayCode {
  const code = WEEKDAY_CODES[isoWeekdayOfDate(date) - 1];
  if (code === undefined) {
    throw new DealingError("INVALID_CALENDAR", `Cannot resolve weekday for ${date}`);
  }
  return code;
}

export function isDealingDay(date: string, calendar: DealingCalendar): boolean {
  const closed = calendar.closedDates?.includes(date) ?? false;
  if (closed) {
    return false;
  }
  const explicitDealingDays = calendar.dealingDays;
  if (explicitDealingDays !== undefined && explicitDealingDays.length > 0) {
    return explicitDealingDays.includes(date);
  }
  return !isWeekend(date);
}

/** Next dealing day strictly after `date`. Throws when the calendar is empty ahead. */
export function nextDealingDayAfter(
  date: string,
  calendar: DealingCalendar,
  maxLookaheadDays = 31,
): string {
  let cursor = date;
  for (let offset = 0; offset < maxLookaheadDays; offset += 1) {
    cursor = addUtcDaysToDate(cursor, 1);
    if (isDealingDay(cursor, calendar)) {
      return cursor;
    }
  }
  throw new DealingError(
    "INVALID_CALENDAR",
    `No dealing day within ${maxLookaheadDays} days after ${date} in ${calendar.calendarId}`,
  );
}

/** True when the UTC time is strictly before the cutoff time. */
export function isStrictlyBeforeCutoff(timeUtc: string, cutoffTimeUtc: string): boolean {
  return secondsOfUtcTime(timeUtc) < secondsOfUtcTime(cutoffTimeUtc);
}

/**
 * Assigns the dealing date for a subscription or redemption requested at the
 * given UTC instant with the given cutoff time.
 */
export function assignDealingDay(params: {
  requestedAt: string;
  cutoffTimeUtc: string;
  calendar: DealingCalendar;
}): DealingAssignment {
  const instant = parseUtcInstant(params.requestedAt);
  const dealingDayToday = isDealingDay(instant.date, params.calendar);
  const beforeCutoff = isStrictlyBeforeCutoff(instant.time, params.cutoffTimeUtc);

  if (dealingDayToday && beforeCutoff) {
    return {
      requestedAt: params.requestedAt,
      requestedDate: instant.date,
      cutoffTimeUtc: params.cutoffTimeUtc,
      dealingDate: instant.date,
      reason: "BEFORE_CUTOFF_SAME_DAY",
      calendarId: params.calendar.calendarId,
      calendarVersion: params.calendar.version,
    };
  }

  return {
    requestedAt: params.requestedAt,
    requestedDate: instant.date,
    cutoffTimeUtc: params.cutoffTimeUtc,
    dealingDate: nextDealingDayAfter(instant.date, params.calendar),
    reason: dealingDayToday ? "AT_OR_AFTER_CUTOFF" : "NON_DEALING_DAY",
    calendarId: params.calendar.calendarId,
    calendarVersion: params.calendar.version,
  };
}

/** Validates a calendar fixture and returns it unchanged. */
export function validateCalendar(calendar: DealingCalendar): DealingCalendar {
  if (calendar.timezone !== "UTC") {
    throw new DealingError("INVALID_CALENDAR", "Only UTC calendars are supported");
  }
  if (calendar.calendarId.trim() === "" || calendar.version.trim() === "") {
    throw new DealingError("INVALID_CALENDAR", "Calendar id and version are required");
  }
  if (
    (calendar.dealingDays !== undefined && calendar.dealingDays.length === 0) ||
    (calendar.closedDates !== undefined && calendar.closedDates.length === 0)
  ) {
    throw new DealingError(
      "INVALID_CALENDAR",
      "Empty dealingDays or closedDates lists are ambiguous; omit the field instead",
    );
  }
  for (const date of calendar.dealingDays ?? []) {
    if (isWeekend(date)) {
      throw new DealingError(
        "INVALID_CALENDAR",
        `dealingDays must not contain weekend date ${date}`,
      );
    }
  }
  return calendar;
}
