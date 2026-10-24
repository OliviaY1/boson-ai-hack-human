import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  // The shared code in ../src imports its audio worklets with ?raw, which Vite
  // only serves from allowed directories.
  server: { fs: { allow: [".."] } },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Shared Higgs Realtime / Avatar call code at the repo root (see tsconfig paths).
      "@higgs": path.resolve(__dirname, "../src"),
    },
  },
});
