/**
 * Verifies the committed A02 and A06 evidence against a fresh run, the versioned
 * JSON Schemas and the generated OpenAPI document.
 */
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { runApiDealingCases, runInvariantCases } from "../src/evidence/cases.js";
import { buildEvidenceFile } from "../src/evidence/types.js";
import { createApiConfig, repositoryRoot } from "../src/config.js";
import { createApp } from "../src/app.js";

function readRepo(relativePath: string): string {
  return readFileSync(`${repositoryRoot()}${relativePath}`, "utf8");
}

function readSchema(name: string): Record<string, unknown> {
  return JSON.parse(readRepo(`schemas/${name}`)) as Record<string, unknown>;
}

const ajv = new Ajv2020({ strict: false, allErrors: true });

describe("committed API evidence", () => {
  it("passes every A02 API dealing case", async () => {
    const cases = await runApiDealingCases();
    const failed = cases.filter((item) => !item.pass);
    expect(failed).toEqual([]);
    expect(cases).toHaveLength(19);
  });

  it("passes every A06 invariant case", async () => {
    const cases = await runInvariantCases();
    const failed = cases.filter((item) => !item.pass);
    expect(failed).toEqual([]);
    expect(cases).toHaveLength(6);
  });

  it("reproduces the committed A02 evidence byte for byte", async () => {
    const cases = await runApiDealingCases();
    const evidence = buildEvidenceFile({
      fixtureId: "A02-api-dealing",
      fixtureVersion: "1.0.0",
      generatedBy: "pnpm scenario:api",
      cases,
    });
    const text = `${JSON.stringify(evidence, null, 2)}\n`;
    expect(readRepo("evidence/a02/api-dealing-cases.json")).toBe(text);
    const validate = ajv.compile(readSchema("api-dealing-cases.schema.json"));
    expect(validate(evidence)).toBe(true);
    expect(validate.errors).toBeNull();
    expect(evidence.summary).toEqual({ total: 19, passed: 19, failed: 0 });
  });

  it("reproduces the committed A06 evidence byte for byte", async () => {
    const cases = await runInvariantCases();
    const evidence = buildEvidenceFile({
      fixtureId: "A06-invariants",
      fixtureVersion: "1.0.0",
      generatedBy: "pnpm scenario:api",
      cases,
    });
    const text = `${JSON.stringify(evidence, null, 2)}\n`;
    expect(readRepo("evidence/a06/invariants.json")).toBe(text);
    const validate = ajv.compile(readSchema("invariants.schema.json"));
    expect(validate(evidence)).toBe(true);
    expect(validate.errors).toBeNull();
    expect(evidence.summary).toEqual({ total: 6, passed: 6, failed: 0 });
  });

  it("keeps the committed OpenAPI document in sync with the route schemas", async () => {
    const config = createApiConfig({ dbFile: ":memory:", autoWorker: false });
    const ctx = await createApp({ config });
    try {
      await ctx.app.ready();
      const spec = ctx.app.swagger();
      const text = `${JSON.stringify(spec, null, 2)}\n`;
      expect(readRepo("docs/api/openapi.json")).toBe(text);
      const paths = Object.keys((spec as { paths?: Record<string, unknown> }).paths ?? {});
      expect(paths.length).toBeGreaterThanOrEqual(13);
    } finally {
      await ctx.close();
    }
  });
});
