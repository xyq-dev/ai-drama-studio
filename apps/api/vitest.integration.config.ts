import { configDefaults, defineConfig } from "vitest/config";

const writingAcceptance = "src/studio/writing-assistant.acceptance.integration.spec.ts";
const dedicatedName = process.env.WRITING_ACCEPTANCE_DATABASE;
const dedicated = dedicatedName === "ai_drama_writing" || dedicatedName === "ai_drama_writing_web";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.integration.spec.ts"],
    exclude: dedicated
      ? [...configDefaults.exclude]
      : [...configDefaults.exclude, writingAcceptance],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
