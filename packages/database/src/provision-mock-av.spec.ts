import { resolve } from "node:path";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import type { PostgresPool } from "./index";
import { provisionMockAvProviders, resolveMockAvProvisionConfig } from "./provision-mock-av";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const objectDir = resolve("mock-objects");

function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    NODE_ENV: "development",
    M3_MOCK_AV_ENABLED: "true",
    MOCK_OBJECT_DIR: objectDir,
    DATABASE_URL: "postgresql://ai_drama:secret@127.0.0.1:55432/ai_drama_m3",
    APP_WORKSPACE_ID: workspaceId,
    ...overrides,
  };
}

describe("mock AV provision config", () => {
  it("requires the AV flag and does not accept the image flag alone", () => {
    expect(resolveMockAvProvisionConfig(env())).toMatchObject({ workspaceId, objectDir });
    expect(() => resolveMockAvProvisionConfig(env({ NODE_ENV: "production" }))).toThrow(/production/);
    expect(() => resolveMockAvProvisionConfig(env({ M3_MOCK_AV_ENABLED: "false", M3_MOCK_IMAGE_ENABLED: "true" })))
      .toThrow(/M3_MOCK_AV_ENABLED/);
    expect(() => resolveMockAvProvisionConfig(env({ MOCK_OBJECT_DIR: "relative/objects" }))).toThrow(/absolute/);
  });
});

describe("mock AV provision transaction", () => {
  it("rolls back both capabilities when the second row is incompatible", async () => {
    const statements: string[] = [];
    const rows = new Map<string, { id: string; enabled: boolean; encrypted_credential_ref: string | null }>();
    let snapshot = new Map(rows);
    const client = {
      async query(sql: string, values?: unknown[]) {
        statements.push(sql);
        if (sql === "BEGIN") {
          snapshot = new Map(rows);
          return { rows: [] };
        }
        if (sql === "ROLLBACK") {
          rows.clear();
          for (const [key, value] of snapshot) rows.set(key, value);
          return { rows: [] };
        }
        if (sql === "COMMIT") return { rows: [] };
        if (sql.includes("FROM workspace")) return { rows: [{ status: "ACTIVE" }] };
        if (sql.includes("SELECT id, enabled")) {
          const capability = String(values?.[1]);
          const row = rows.get(capability);
          return { rows: row ? [row] : [] };
        }
        if (sql.includes("INSERT INTO provider_configuration")) {
          const capability = String(values?.[1]);
          if (capability === "audio.tts") {
            rows.set(capability, { id: "audio-disabled", enabled: false, encrypted_credential_ref: null });
            return { rows: [] };
          }
          const created = { id: "video-new", enabled: true, encrypted_credential_ref: null };
          rows.set(capability, created);
          return { rows: [{ id: created.id }] };
        }
        return { rows: [] };
      },
      release() { return undefined; },
    };
    const pool = {
      async connect() { return client as unknown as PoolClient; },
    } as unknown as PostgresPool;
    await expect(provisionMockAvProviders(pool, workspaceId)).rejects.toThrow(/audio.tts/);
    expect(statements.filter((sql) => sql === "COMMIT")).toHaveLength(0);
    expect(statements.filter((sql) => sql === "ROLLBACK")).toHaveLength(1);
    expect(rows.size).toBe(0);
  });
});
