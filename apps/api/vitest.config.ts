import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.spec.ts"],
    // The title writing acceptances write to a dedicated database; only their own commands collect them.
    exclude: ["src/**/*.integration.spec.ts", "src/studio/title-writing.acceptance.spec.ts", "src/studio/title-writing.browser-acceptance.spec.ts",
      "src/studio/title-writing.runtime-acceptance.spec.ts"],
    testTimeout: 15000,
  },
});
