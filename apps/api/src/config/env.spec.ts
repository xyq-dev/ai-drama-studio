import { describe, expect, it } from "vitest";
import { loadApiEnv } from "./env";

const valid = {
  DATABASE_URL: "postgresql://ai_drama:super-secret-password@127.0.0.1:55432/ai_drama",
  REDIS_URL: "redis://127.0.0.1:56379",
  S3_ENDPOINT: "http://127.0.0.1:59000",
  S3_REGION: "us-east-1",
  S3_BUCKET: "ai-drama-dev",
  S3_ACCESS_KEY_ID: "ai-drama-dev",
  S3_SECRET_ACCESS_KEY: "another-secret-value",
  APP_WORKSPACE_ID: "11111111-1111-4111-8111-111111111111",
};

describe("loadApiEnv", () => {
  it("rejects missing required fields by name", () => {
    expect(() => loadApiEnv({})).toThrow(/DATABASE_URL/);
  });

  it("does not include secret values in validation errors", () => {
    try {
      loadApiEnv({ ...valid, API_PORT: "nope" });
      throw new Error("expected validation to fail");
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      expect(text).toContain("API_PORT");
      expect(text).not.toContain("super-secret-password");
      expect(text).not.toContain("another-secret-value");
    }
  });

  it("prefers process values and ignores unrelated file secrets", () => {
    const env = loadApiEnv(
      { ...valid, API_PORT: "3101" },
      { DATABASE_URL: "postgresql://file-user:file-secret@127.0.0.1:55432/ai_drama", UNUSED_TOKEN: "token" },
    );
    expect(env.API_PORT).toBe(3101);
    expect(env.DATABASE_URL).toContain("super-secret-password");
    expect(env.S3_FORCE_PATH_STYLE).toBe(true);
  });
});
