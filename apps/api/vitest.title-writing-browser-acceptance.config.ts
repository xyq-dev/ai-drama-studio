import { defineConfig } from "vitest/config";

/**
 * Title writing browser acceptance only: one file, guarded by @ai-drama/database's title writing acceptance guard. It is
 * not part of `test` or `integration`, and it collects no other suite. It serves the built web app, so run `pnpm build`
 * first.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/studio/title-writing.browser-acceptance.spec.ts"],
    testTimeout: 240_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
