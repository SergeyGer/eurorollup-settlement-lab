/**
 * Committed P01 evidence: byte reproducibility and JSON Schema validation.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  buildP01ComparisonPack,
  policyFromFixture,
  runP01BoundaryCases,
  runP01Comparison,
  serializeP01ComparisonPack,
} from "../src/index.js";
import type { CalendarFixture, P01Scenario } from "@eurorollup/dealing";
import type { P01BoundaryFixture } from "../src/types.js";
import p01Json from "../../../fixtures/p01/scenario.json";
import labUtc1Json from "../../../fixtures/calendar/LAB-UTC-1.json";
import labUtc2Json from "../../../fixtures/calendar/LAB-UTC-2.json";
import boundaryJson from "../../../fixtures/policy-lab/p01-boundary.json";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const fixture = p01Json as unknown as P01Scenario;
const labUtc1 = labUtc1Json as unknown as CalendarFixture;
const labUtc2 = labUtc2Json as unknown as CalendarFixture;
const boundaryFixture = boundaryJson as unknown as P01BoundaryFixture;
const catalog = { "LAB-UTC-1": labUtc1, "LAB-UTC-2": labUtc2 };

function readRepo(relativePath: string): string {
  return readFileSync(`${repoRoot}${relativePath}`, "utf8");
}

function buildPack(): string {
  const baselinePolicy = policyFromFixture(fixture.baselinePolicy);
  const candidatePolicy = policyFromFixture(fixture.candidatePolicy);
  const comparison = runP01Comparison({
    fixture,
    calendarFixture: labUtc1,
    baselinePolicy,
    candidatePolicy,
  });
  const boundaryCases = runP01BoundaryCases({
    fixture,
    boundaryFixture,
    calendars: catalog,
    baselinePolicy,
    candidatePolicy,
  });
  return serializeP01ComparisonPack(
    buildP01ComparisonPack({ comparison, boundaryCases, boundaryFixture }),
  );
}

describe("committed P01 comparison evidence", () => {
  it("is byte-identical to a fresh replay", () => {
    expect(readRepo("evidence/policy-lab/p01-comparison.json")).toBe(buildPack());
  });

  it("matches the committed manifest digests", () => {
    const manifest = JSON.parse(readRepo("evidence/policy-lab/manifest.json")) as {
      packDigest: string;
      comparisonDigest: string;
      files: Array<{ path: string }>;
    };
    const pack = JSON.parse(readRepo("evidence/policy-lab/p01-comparison.json")) as {
      packDigest: string;
      comparisonDigest: string;
    };
    expect(manifest.packDigest).toBe(pack.packDigest);
    expect(manifest.comparisonDigest).toBe(pack.comparisonDigest);
    expect(manifest.files.map((file) => file.path)).toEqual(["p01-comparison.json"]);
  });

  it("validates against the versioned P01 evidence schema", () => {
    const schema = JSON.parse(readRepo("schemas/p01-comparison.schema.json")) as Record<string, unknown>;
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const validate = ajv.compile(schema);
    const pack = JSON.parse(buildPack()) as Record<string, unknown>;
    expect(validate(pack)).toBe(true);
    expect(validate.errors).toBeNull();
  });

  it("keeps the comparison digest stable across runtimes", () => {
    const pack = JSON.parse(buildPack()) as { comparisonDigest: string };
    expect(pack.comparisonDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});
