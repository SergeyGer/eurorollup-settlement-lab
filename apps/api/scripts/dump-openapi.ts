#!/usr/bin/env node
/**
 * Generates the committed OpenAPI document from the live route schemas.
 *
 * Usage:
 *   pnpm api:openapi            write docs/api/openapi.json
 *   pnpm api:openapi -- --check regenerate and compare with the committed file
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createApp } from "../src/app.js";
import { createApiConfig, repositoryRoot } from "../src/config.js";

async function main(): Promise<void> {
  const checkOnly = process.argv.includes("--check");
  const config = createApiConfig({ dbFile: ":memory:", autoWorker: false });
  const ctx = await createApp({ config });
  try {
    await ctx.app.ready();
    const spec = ctx.app.swagger();
    const text = `${JSON.stringify(spec, null, 2)}\n`;
    const absolutePath = join(repositoryRoot(), "docs/api/openapi.json");
    if (checkOnly) {
      if (!existsSync(absolutePath)) {
        console.error("FAIL docs/api/openapi.json is missing; run pnpm api:openapi");
        process.exitCode = 1;
        return;
      }
      if (readFileSync(absolutePath, "utf8") !== text) {
        console.error("FAIL docs/api/openapi.json differs from the generated document");
        process.exitCode = 1;
        return;
      }
      console.log("OK   docs/api/openapi.json matches the generated document");
      return;
    }
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, text, "utf8");
    console.log(`wrote docs/api/openapi.json (${text.length} bytes)`);
    const paths = Object.keys((spec as { paths?: Record<string, unknown> }).paths ?? {});
    console.log(`  ${paths.length} paths: ${paths.join(", ")}`);
  } finally {
    await ctx.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
