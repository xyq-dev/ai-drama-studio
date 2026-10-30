import { defineConfig } from "vitest/config";

/** Explicitly selected, guarded disposable-database acceptance. Never collected by test or integration. */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/vimax-candidate.acceptance.spec.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
