import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const dealingSource = fileURLToPath(
  new URL("../../packages/dealing/src/index.ts", import.meta.url),
);
const policyLabSource = fileURLToPath(
  new URL("../../packages/policy-lab/src/index.ts", import.meta.url),
);
const eligibilityBrowserSource = fileURLToPath(
  new URL("../../packages/eligibility/src/browser.ts", import.meta.url),
);
const eligibilityProverSource = fileURLToPath(
  new URL("../../packages/eligibility/src/prover.ts", import.meta.url),
);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@eurorollup/dealing": dealingSource,
      "@eurorollup/policy-lab": policyLabSource,
      "@eurorollup/eligibility/prover": eligibilityProverSource,
      "@eurorollup/eligibility": eligibilityBrowserSource,
    },
  },
  server: {
    port: 5173,
    fs: {
      allow: [repoRoot],
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
