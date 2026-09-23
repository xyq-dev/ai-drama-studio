import { describe, expect, it } from "vitest";
import { pickPublicEnv } from "./public-env";

describe("public env", () => {
  it("drops server secrets", () => {
    const picked = pickPublicEnv({
      NODE_ENV: "development",
      NEXT_PUBLIC_API_BASE_URL: "http://127.0.0.1:3001",
      DATABASE_URL: "postgresql://ai_drama:super-secret-password@127.0.0.1:55432/ai_drama",
      S3_SECRET_ACCESS_KEY: "secret",
    });
    expect(picked).toEqual({
      NODE_ENV: "development",
      NEXT_PUBLIC_API_BASE_URL: "http://127.0.0.1:3001",
    });
    expect(JSON.stringify(picked)).not.toContain("super-secret-password");
  });
});
