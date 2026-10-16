import { defineConfig } from "vitest/config";

/**
 * Online candidate migration and store acceptance only: one file, guarded by title-writing-acceptance-guard.ts. It is not
 * part of `test` or `integration`, and it collects no other suite.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/writing-candidate.acceptance.spec.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
