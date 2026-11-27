import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const dealingSource = fileURLToPath(
  new URL("../../packages/dealing/src/index.ts", import.meta.url),
);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@eurorollup/dealing": dealingSource,
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
