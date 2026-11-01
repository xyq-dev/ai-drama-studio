import { defineConfig } from "vitest/config";

/** Explicit guarded speech acceptance only; this configuration collects no other database suites. */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/speech.acceptance.spec.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 90_000,
  },
});
