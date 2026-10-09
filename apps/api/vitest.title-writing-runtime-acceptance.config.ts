import { defineConfig } from "vitest/config";

/**
 * Title writing runtime acceptance only: one file, guarded by @ai-drama/database's title writing acceptance guard. It
 * starts the built API (`dist/main.js`) as child processes, so run `pnpm build` first. It is not part of `test` or
 * `integration`, and it collects no other suite. Its crash test waits out the product lease (240 s).
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/studio/title-writing.runtime-acceptance.spec.ts"],
    testTimeout: 900_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
