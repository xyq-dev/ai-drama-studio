import { defineConfig } from "vitest/config";

/** Explicit, guarded HTTP + PostgreSQL acceptance; no other database suite is collected. */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/studio/vimax-candidate.acceptance.spec.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
