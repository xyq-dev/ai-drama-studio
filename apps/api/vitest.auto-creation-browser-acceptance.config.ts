import { defineConfig } from "vitest/config";

/**
 * AI automatic creation browser acceptance only (needs pnpm build first): one file, guarded by @ai-drama/database's title writing acceptance
 * guard. Not part of `test` or `integration`; it collects no other suite.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/studio/auto-creation.browser-acceptance.spec.ts"],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    fileParallelism: false,
  },
});
