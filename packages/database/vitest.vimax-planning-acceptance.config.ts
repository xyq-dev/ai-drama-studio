import { defineConfig } from "vitest/config";
/** Explicit, guarded new-empty-database draft validation. Not part of ordinary test/integration. */
export default defineConfig({ test: { environment: "node", include: ["src/vimax-planning.acceptance.spec.ts"], testTimeout: 30000, hookTimeout: 60000, fileParallelism: false } });
