import { defineConfig } from "vitest/config";

/**
 * Episode plan acceptance only: one file, guarded by title-writing-acceptance-guard.ts (a named, new, empty, disposable
 * database). It is not part of `test` or `integration` and collects no other suite.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/episode-plan.acceptance.spec.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
