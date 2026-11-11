import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", include: ["src/script-workbench-trash.acceptance.spec.ts"], testTimeout: 30000, hookTimeout: 30000, fileParallelism: false },
});
