import { defineConfig } from "vitest/config";

/**
 * Title writing acceptance only: one file, guarded by title-writing-acceptance-guard.ts. It is not part of `test` or
 * `integration`, and it collects no other suite, so no other file's database setup can run through this command.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/title-writing-store.acceptance.spec.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
