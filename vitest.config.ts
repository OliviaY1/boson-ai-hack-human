import { defineConfig } from "vitest/config";

// The repo root's own tests. frontend/ is a separate app with its own vitest
// config (cd frontend && bun run test), so it is excluded here.
export default defineConfig({
  test: {
    exclude: ["frontend/**", "node_modules/**", "dist/**"],
  },
});
