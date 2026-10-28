import { defineConfig } from "vitest/config";

/**
 * Script breakdown API acceptance only: one file, guarded by @ai-drama/database's title writing acceptance guard. It is
 * not part of `test` or `integration`, and it collects no other suite, so no other file's database setup can run here.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/studio/script-breakdown.acceptance.spec.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
