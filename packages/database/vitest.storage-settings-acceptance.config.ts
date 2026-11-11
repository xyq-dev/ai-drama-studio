import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", include: ["src/storage-settings.acceptance.spec.ts"], testTimeout: 20000, hookTimeout: 30000, fileParallelism: false } });
