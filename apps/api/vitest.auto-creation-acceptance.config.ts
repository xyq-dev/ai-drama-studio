import { defineConfig } from "vitest/config";

/**
 * AI automatic creation PostgreSQL acceptance only: one file, guarded by @ai-drama/database's title writing acceptance
 * guard. Not part of `test` or `integration`; it collects no other suite.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/studio/auto-creation.acceptance.spec.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
