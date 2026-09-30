import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveMockMediaProvisionConfig } from "./provision-mock-media";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const objectDir = resolve("mock-objects");

function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    NODE_ENV: "development",
    M3_MOCK_IMAGE_ENABLED: "true",
    MOCK_OBJECT_DIR: objectDir,
    DATABASE_URL: "postgresql://ai_drama:secret@127.0.0.1:55432/ai_drama_m3",
    APP_WORKSPACE_ID: workspaceId,
    ...overrides,
  };
}

describe("mock media provision config", () => {
  it("accepts an explicit non-production development configuration", () => {
    expect(resolveMockMediaProvisionConfig(env())).toEqual({
      databaseUrl: "postgresql://ai_drama:secret@127.0.0.1:55432/ai_drama_m3",
      workspaceId,
      objectDir,
    });
  });

  it("rejects production, a disabled flag, a relative directory, and a missing database URL", () => {
    expect(() => resolveMockMediaProvisionConfig(env({ NODE_ENV: "production" }))).toThrow(/production/);
    expect(() => resolveMockMediaProvisionConfig(env({ M3_MOCK_IMAGE_ENABLED: "false" }))).toThrow(/M3_MOCK_IMAGE_ENABLED/);
    expect(() => resolveMockMediaProvisionConfig(env({ MOCK_OBJECT_DIR: "relative/objects" }))).toThrow(/absolute/);
    expect(() => resolveMockMediaProvisionConfig(env({ DATABASE_URL: undefined }))).toThrow(/DATABASE_URL/);
    expect(() => resolveMockMediaProvisionConfig(env({ APP_WORKSPACE_ID: "workspace" }))).toThrow(/UUID/);
  });
});
