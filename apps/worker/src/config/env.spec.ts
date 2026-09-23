import { describe, expect, it } from "vitest";
import { loadWorkerEnv } from "./env";

describe("loadWorkerEnv", () => {
  it("does not echo database secrets and ignores storage credentials", () => {
    try {
      loadWorkerEnv({
        DATABASE_URL: "postgresql://ai_drama:super-secret-password@127.0.0.1:55432/ai_drama",
        REDIS_URL: "not-a-url",
        S3_SECRET_ACCESS_KEY: "object-secret",
      });
      throw new Error("expected validation to fail");
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      expect(text).toContain("REDIS_URL");
      expect(text).not.toContain("super-secret-password");
      expect(text).not.toContain("object-secret");
    }
  });
});
