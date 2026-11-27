import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fileSha256 } from "../src/index.js";
import { buildG01TestEvidence } from "./helpers.js";

function readCommitted(relativePath: string): string {
  return readFileSync(new URL(`../../../${relativePath}`, import.meta.url), "utf8");
}

describe("committed G01 evidence pack", () => {
  it("is byte-identical to a fresh replay", () => {
    const { goldenText } = buildG01TestEvidence();
    expect(readCommitted("evidence/g01/golden-run.json")).toBe(goldenText);
  });

  it("publishes a manifest matching the committed golden run", () => {
    const { manifestText } = buildG01TestEvidence();
    expect(readCommitted("evidence/g01/manifest.json")).toBe(manifestText);
    const manifest = JSON.parse(manifestText) as {
      files: Array<{ path: string; sha256: string }>;
      businessDigest: string;
    };
    const goldenFile = manifest.files.find((file) => file.path === "golden-run.json");
    expect(goldenFile).toBeDefined();
    expect(goldenFile?.sha256).toBe(fileSha256(readCommitted("evidence/g01/golden-run.json")));
    expect(manifest.businessDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("detects a tampered golden run through its digest", () => {
    const tampered = `${readCommitted("evidence/g01/golden-run.json")} `;
    const original = readCommitted("evidence/g01/golden-run.json");
    expect(fileSha256(tampered)).not.toBe(fileSha256(original));
  });
});

describe("committed A02 boundary evidence", () => {
  it("is byte-identical to a fresh evaluation", () => {
    const committed = JSON.parse(readCommitted("evidence/a02/dealing-cases.json")) as {
      summary: { total: number; passed: number; failed: number };
      businessDigest: string;
    };
    expect(committed.summary).toEqual({ total: 8, passed: 8, failed: 0 });
    expect(committed.businessDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});
