import { describe, expect, it } from "vitest";
import { buildReplayHash, clampReplayIndex, parseReplayHash } from "../src/replay-state.js";

describe("replay direct links", () => {
  it("round-trips every addressable state", () => {
    expect(parseReplayHash(buildReplayHash("g01", 0))).toEqual({ mode: "g01", index: 0 });
    expect(parseReplayHash(buildReplayHash("redemption", 6))).toEqual({ mode: "redemption", index: 6 });
  });

  it("rejects unknown modes, negative and malformed indexes", () => {
    expect(parseReplayHash("")).toBeNull();
    expect(parseReplayHash("#replay/p01/0")).toBeNull();
    expect(parseReplayHash("#replay/g01/-1")).toBeNull();
    expect(parseReplayHash("#replay/g01/one")).toBeNull();
    expect(parseReplayHash("#other")).toBeNull();
  });

  it("clamps indexes into the available steps", () => {
    expect(clampReplayIndex(-3, 6)).toBe(0);
    expect(clampReplayIndex(99, 6)).toBe(5);
    expect(clampReplayIndex(2, 6)).toBe(2);
    expect(clampReplayIndex(2, 0)).toBe(0);
  });
});
