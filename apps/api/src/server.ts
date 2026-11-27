#!/usr/bin/env node
/** Local API server bootstrap. */
import { createApp } from "./app.js";
import { createApiConfig } from "./config.js";

async function main(): Promise<void> {
  const config = createApiConfig();
  const ctx = await createApp({ config, logger: true });
  await ctx.app.listen({ host: config.host, port: config.port });
  const address = ctx.app.server.address();
  const port = typeof address === "object" && address !== null ? address.port : config.port;
  console.log(`EuroRollup partner API listening on http://${config.host}:${port}`);
  console.log(`  OpenAPI: http://${config.host}:${port}/openapi.json`);
  console.log(`  Fixture clock starts at ${ctx.clock.getNow()}`);
  console.log(`  SQLite file: ${config.dbFile}`);
  console.log("  Press Ctrl+C to stop.");

  const shutdown = async (): Promise<void> => {
    console.log("Shutting down...");
    await ctx.close();
    process.exit(0);
  };
  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

main().catch((error: unknown) => {
  console.error("Failed to start the API:", error);
  process.exit(1);
});
