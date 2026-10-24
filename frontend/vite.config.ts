// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  vite: {
    // Live calls: the dashboard reuses the Higgs Realtime / Avatar client code in ../src
    // (imported as "@higgs/..."), and its /api/* calls go to the same token server as the
    // debug page (npm run dev at the repo root, port 3000).
    server: {
      fs: { allow: [".."] },
      proxy: { "/api": { target: "http://localhost:3000", changeOrigin: true } },
    },
  },
});
