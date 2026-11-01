import { defineConfig } from "vitest/config";

/** Separate opt-in command: this suite requires a new, verified-empty database of its own. */
export default defineConfig({ test: {
  environment: "node", include: ["src/studio/real-media-flow.acceptance.spec.ts"],
  fileParallelism: false, testTimeout: 60_000, hookTimeout: 90_000,
} });
