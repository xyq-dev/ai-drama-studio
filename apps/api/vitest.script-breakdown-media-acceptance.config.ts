import { defineConfig } from "vitest/config";

/**
 * Script breakdown replacement → media STALE → compose/export gates only: one file, guarded by @ai-drama/database's
 * title writing acceptance guard, a loopback Redis, a real Worker process and local FFmpeg. It is not part of `test` or
 * `integration`, and it collects no other suite, so no other file's database setup can run here.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/studio/script-breakdown.media-acceptance.spec.ts"],
    testTimeout: 900_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
