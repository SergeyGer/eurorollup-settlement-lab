/** Fixture clock. Only explicit advancement moves time; nothing reads wall clock. */
import { addUtcDaysToDate, formatUtcInstant, parseUtcInstant } from "@eurorollup/dealing";
import { readClock, writeClock, type Database } from "./db.js";
import { problem } from "./problems.js";

export interface ClockState {
  readonly now: string;
  readonly previous?: string;
}

export const MAX_CLOCK_ADVANCE_DAYS = 366;

export class ClockService {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  getNow(): string {
    return readClock(this.db);
  }

  /** Advances the fixture clock forward within a bounded window. */
  advance(to: string): ClockState {
    const now = readClock(this.db);
    const nowMs = parseUtcInstant(now).epochMs;
    const toMs = parseUtcInstant(to).epochMs;
    if (toMs < nowMs) {
      throw problem(422, "CLOCK_OUT_OF_RANGE", "The fixture clock cannot move backwards", {
        now,
        requested: to,
      });
    }
    const maxMs = parseUtcInstant(addUtcDaysToDate(now.slice(0, 10), MAX_CLOCK_ADVANCE_DAYS) + "T00:00:00Z").epochMs;
    if (toMs > maxMs) {
      throw problem(422, "CLOCK_OUT_OF_RANGE", "The fixture clock advance is too large", {
        now,
        requested: to,
        maxDays: MAX_CLOCK_ADVANCE_DAYS,
      });
    }
    const normalized = formatUtcInstant(toMs);
    writeClock(this.db, normalized, now);
    return { now: normalized, previous: now };
  }
}
