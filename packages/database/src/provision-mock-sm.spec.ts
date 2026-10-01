import { resolve } from "node:path";
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import type { PostgresPool } from "./index";
import { provisionMockSmProviders, resolveMockSmProvisionConfig } from "./provision-mock-sm";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const objectDir = resolve("mock-objects");

function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    NODE_ENV: "development",
    M3_MOCK_SUBTITLE_MUSIC_ENABLED: "true",
    MOCK_OBJECT_DIR: objectDir,
    DATABASE_URL: "postgresql://ai_drama:secret@127.0.0.1:55432/ai_drama_m3",
    APP_WORKSPACE_ID: workspaceId,
    ...overrides,
  };
}

describe("mock subtitle and music provision config", () => {
  it("requires its own flag and does not accept the image or AV flags alone", () => {
    expect(resolveMockSmProvisionConfig(env())).toMatchObject({ workspaceId, objectDir });
    expect(() => resolveMockSmProvisionConfig(env({ NODE_ENV: "production" }))).toThrow(/production/);
    expect(() => resolveMockSmProvisionConfig(env({
      M3_MOCK_SUBTITLE_MUSIC_ENABLED: "false",
      M3_MOCK_IMAGE_ENABLED: "true",
      M3_MOCK_AV_ENABLED: "true",
    }))).toThrow(/M3_MOCK_SUBTITLE_MUSIC_ENABLED/);
    expect(() => resolveMockSmProvisionConfig(env({ MOCK_OBJECT_DIR: "relative/objects" }))).toThrow(/absolute/);
  });
});

describe("mock subtitle and music provision transaction", () => {
  it("rolls back both capabilities when the music row is incompatible", async () => {
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
          if (capability === "audio.music") {
            rows.set(capability, { id: "music-disabled", enabled: false, encrypted_credential_ref: null });
            return { rows: [] };
          }
          const created = { id: "subtitle-new", enabled: true, encrypted_credential_ref: null };
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
    await expect(provisionMockSmProviders(pool, workspaceId)).rejects.toThrow(/audio.music/);
    expect(statements.filter((sql) => sql === "COMMIT")).toHaveLength(0);
    expect(statements.filter((sql) => sql === "ROLLBACK")).toHaveLength(1);
    expect(rows.size).toBe(0);
  });
});
