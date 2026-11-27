/**
 * UTC-only time handling.
 *
 * The sandbox never depends on the host timezone: fixtures carry explicit UTC
 * instants and replay uses those instants as observation times.
 */
import { DealingError } from "./errors.js";

const INSTANT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{2}):(\d{2})$/;

export const MILLIS_PER_DAY = 86_400_000;

export interface UtcInstantParts {
  readonly epochMs: number;
  /** ISO date, e.g. "2026-11-20". */
  readonly date: string;
  /** ISO time without an offset, e.g. "15:30:05". */
  readonly time: string;
  /** ISO weekday: 1 = Monday ... 7 = Sunday. */
  readonly weekday: number;
}

function isoWeekdayFromEpoch(epochMs: number): number {
  const day = new Date(epochMs).getUTCDay();
  return day === 0 ? 7 : day;
}

/** Parses a strict `YYYY-MM-DDTHH:mm:ssZ` UTC instant. */
export function parseUtcInstant(instant: string): UtcInstantParts {
  const match = INSTANT_RE.exec(instant);
  if (match === null) {
    throw new DealingError(
      "INVALID_TIMESTAMP",
      `Expected a UTC instant of the form YYYY-MM-DDTHH:mm:ssZ, received ${JSON.stringify(instant)}`,
    );
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new DealingError("INVALID_TIMESTAMP", `Component out of range in ${instant}`);
  }
  const epochMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(epochMs);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new DealingError("INVALID_TIMESTAMP", `Invalid calendar date in ${instant}`);
  }
  return {
    epochMs,
    date: `${yearText}-${monthText}-${dayText}`,
    time: `${hourText}:${minuteText}:${secondText}`,
    weekday: isoWeekdayFromEpoch(epochMs),
  };
}

/** Formats epoch milliseconds as a strict UTC instant. */
export function formatUtcInstant(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (value: number, width = 2): string => value.toString().padStart(width, "0");
  return (
    `${date.getUTCFullYear().toString().padStart(4, "0")}-` +
    `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}Z`
  );
}

/** Parses a UTC date (YYYY-MM-DD) into epoch milliseconds at midnight. */
export function parseUtcDate(date: string): number {
  const match = DATE_RE.exec(date);
  if (match === null) {
    throw new DealingError(
      "INVALID_TIMESTAMP",
      `Expected a UTC date of the form YYYY-MM-DD, received ${JSON.stringify(date)}`,
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const epochMs = Date.UTC(year, month - 1, day);
  const check = new Date(epochMs);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new DealingError("INVALID_TIMESTAMP", `Invalid calendar date ${date}`);
  }
  return epochMs;
}

export function addUtcDays(epochMs: number, days: number): number {
  return epochMs + days * MILLIS_PER_DAY;
}

export function addUtcDaysToDate(date: string, days: number): string {
  return formatUtcInstant(addUtcDays(parseUtcDate(date), days)).slice(0, 10);
}

/** ISO weekday (1 = Monday ... 7 = Sunday) for a UTC date. */
export function isoWeekdayOfDate(date: string): number {
  return isoWeekdayFromEpoch(parseUtcDate(date));
}

/** ISO weekday (1..7) for a UTC instant. */
export function isoWeekdayOfInstant(instant: string): number {
  return parseUtcInstant(instant).weekday;
}

const TIME_WITH_SECONDS_RE = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** Seconds since midnight for an "HH:MM" or "HH:MM:SS" UTC time. */
export function secondsOfUtcTime(time: string): number {
  const match = TIME_WITH_SECONDS_RE.exec(time);
  if (match === null) {
    throw new DealingError(
      "INVALID_TIMESTAMP",
      `Expected a UTC time of the form HH:MM or HH:MM:SS, received ${JSON.stringify(time)}`,
    );
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] ?? "0");
  if (hours > 23 || minutes > 59 || seconds > 59) {
    throw new DealingError("INVALID_TIMESTAMP", `Invalid UTC time ${time}`);
  }
  return hours * 3600 + minutes * 60 + seconds;
}

/** Minutes since midnight for an "HH:MM" UTC time. */
export function minutesOfUtcTime(time: string): number {
  const match = TIME_RE.exec(time);
  if (match === null) {
    throw new DealingError(
      "INVALID_TIMESTAMP",
      `Expected a UTC time of the form HH:MM, received ${JSON.stringify(time)}`,
    );
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    throw new DealingError("INVALID_TIMESTAMP", `Invalid UTC time ${time}`);
  }
  return hours * 60 + minutes;
}

/** True when `a` is strictly earlier than `b`. Both are UTC instants. */
export function isBeforeInstant(a: string, b: string): boolean {
  return parseUtcInstant(a).epochMs < parseUtcInstant(b).epochMs;
}

/** Signed difference in milliseconds: a - b. */
export function instantDifferenceMs(a: string, b: string): number {
  return parseUtcInstant(a).epochMs - parseUtcInstant(b).epochMs;
}

/** True when the source time is not older than the maximum age at the reference instant. */
export function isFresh(sourceTime: string, referenceTime: string, maxAgeMs: number): boolean {
  const age = instantDifferenceMs(referenceTime, sourceTime);
  return age >= 0 && age <= maxAgeMs;
}

export function secondsBetween(a: string, b: string): number {
  return instantDifferenceMs(a, b) / 1000;
}
