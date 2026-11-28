/**
 * Direct-link state for the recorded replay.
 *
 * The replay is addressable so that a visitor can share "start at the seed" or a
 * specific event, and so that Reset, Start replay, View outcome, the browser Back
 * button and the keyboard controls all agree on the same state.
 */

export type ReplayMode = "g01" | "redemption";

export interface ReplayLocation {
  readonly mode: ReplayMode;
  readonly index: number;
}

const HASH_PREFIX = "#replay/";

export function isReplayMode(value: string): value is ReplayMode {
  return value === "g01" || value === "redemption";
}

export function buildReplayHash(mode: ReplayMode, index: number): string {
  return `${HASH_PREFIX}${mode}/${String(Math.max(0, Math.trunc(index)))}`;
}

export function parseReplayHash(hash: string): ReplayLocation | null {
  if (!hash.startsWith(HASH_PREFIX)) {
    return null;
  }
  const [modePart, indexPart] = hash.slice(HASH_PREFIX.length).split("/");
  if (modePart === undefined || indexPart === undefined || !isReplayMode(modePart)) {
    return null;
  }
  const index = Number.parseInt(indexPart, 10);
  if (!Number.isInteger(index) || index < 0) {
    return null;
  }
  return { mode: modePart, index };
}

/** Clamps an addressable index into the available steps for the current mode. */
export function clampReplayIndex(index: number, total: number): number {
  if (!Number.isInteger(index) || total <= 0) {
    return 0;
  }
  return Math.min(Math.max(index, 0), total - 1);
}
