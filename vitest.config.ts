/**
 * Vitest configuration for the ops portal Test_Suite.
 *
 * Feature: admin-quality-gates-and-shared-contracts (Requirements 5.1, 6.11, 6.14)
 *
 * Invoked by the single documented script `npm test` → `vitest run`:
 * single-run, no watch, no interactive wait, non-zero exit on any failing test
 * or test-file load error.
 *
 * Test file convention: every test lives under `test/` and is named
 * `*.test.ts` (or `*.test.tsx` for tests that render a component). Nothing is
 * co-located under `src/`, which keeps the production tsconfig/build inputs and
 * the test inputs cleanly separated.
 *
 * This config is deliberately standalone rather than merged with
 * `vite.config.ts`: the app config loads the Cloudflare and TanStack Start
 * plugins, which expect a workerd/SSR build and are not wanted under Node.
 */
import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    setupFiles: ["./test/setup.ts"],
    // Whole-suite budget of 120 s (Requirement 6.11); see test/global-setup.ts.
    globalSetup: ["./test/global-setup.ts"],
    // Fail any individual test that has not completed within 10 s
    // (Requirement 6.11).
    testTimeout: 10_000,
    hookTimeout: 10_000,
    teardownTimeout: 10_000,
    // Surface a test file that fails to load as a run failure rather than a
    // silent skip (Requirement 5.1).
    passWithNoTests: false,
    reporters: ["default"],
  },
});
