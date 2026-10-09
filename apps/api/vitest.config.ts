import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.spec.ts"],
    // The title writing acceptance writes to a dedicated database; only its own command collects it.
    exclude: ["src/**/*.integration.spec.ts", "src/studio/title-writing.acceptance.spec.ts"],
    testTimeout: 15000,
  },
});
