import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.spec.ts"],
    // The title writing acceptances write to a dedicated database; only their own commands collect them.
    exclude: ["src/**/*.integration.spec.ts", "src/studio/title-writing.acceptance.spec.ts", "src/studio/title-writing.browser-acceptance.spec.ts",
      "src/studio/title-writing.runtime-acceptance.spec.ts", "src/studio/script-breakdown.acceptance.spec.ts",
      "src/studio/script-breakdown.media-acceptance.spec.ts", "src/studio/writing-online.browser-acceptance.spec.ts",
      "src/studio/auto-creation.acceptance.spec.ts", "src/studio/auto-creation.browser-acceptance.spec.ts",
      "src/studio/series-writing.acceptance.spec.ts", "src/studio/series-writing.browser-acceptance.spec.ts"],
    testTimeout: 15000,
  },
});
