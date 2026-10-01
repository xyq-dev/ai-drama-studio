import { isAbsolute } from "node:path";
import type { PoolClient } from "pg";
import type { PostgresPool } from "./index";

const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CAPABILITIES = ["subtitle.generate", "audio.music"] as const;

export interface MockSmProvisionConfig {
  databaseUrl: string;
  workspaceId: string;
  objectDir: string;
}

export interface MockSmProvisionResult {
  subtitleId: string;
  musicId: string;
  created: boolean;
}

export function resolveMockSmProvisionConfig(
  env: Record<string, string | undefined>,
): MockSmProvisionConfig {
  if (env.NODE_ENV === "production") throw new Error("Mock subtitle and music provision is disabled in production");
  if (env.M3_MOCK_SUBTITLE_MUSIC_ENABLED !== "true") {
    throw new Error("M3_MOCK_SUBTITLE_MUSIC_ENABLED=true is required");
  }
  if (!env.MOCK_OBJECT_DIR || !isAbsolute(env.MOCK_OBJECT_DIR)) {
    throw new Error("MOCK_OBJECT_DIR must be an absolute path");
  }
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const parsed = new URL(env.DATABASE_URL);
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error("DATABASE_URL must use PostgreSQL");
  }
  if (!env.APP_WORKSPACE_ID || !WORKSPACE_ID.test(env.APP_WORKSPACE_ID)) {
    throw new Error("APP_WORKSPACE_ID must be a UUID");
  }
  return {
    databaseUrl: env.DATABASE_URL,
    workspaceId: env.APP_WORKSPACE_ID,
    objectDir: env.MOCK_OBJECT_DIR,
  };
}

export async function provisionMockSmProviders(
  pool: PostgresPool,
  workspaceId: string,
): Promise<MockSmProvisionResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const result = await provisionBoth(client, workspaceId);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    client.release();
  }
}

async function provisionBoth(client: PoolClient, workspaceId: string): Promise<MockSmProvisionResult> {
  const workspace = await client.query<{ status: string }>(
    "SELECT status FROM workspace WHERE id = $1",
    [workspaceId],
  );
  const status = workspace.rows[0]?.status;
  if (!status) throw new Error("Configured workspace does not exist");
  if (status !== "ACTIVE") throw new Error("Configured workspace is not ACTIVE");

  const ids: string[] = [];
  let created = false;
  for (const capability of CAPABILITIES) {
    const row = await ensureCapability(client, workspaceId, capability);
    ids.push(row.id);
    created = created || row.created;
  }
  const subtitleId = ids[0];
  const musicId = ids[1];
  if (!subtitleId || !musicId) throw new Error("Mock subtitle and music provider rows were not created");
  return { subtitleId, musicId, created };
}

async function ensureCapability(
  client: PoolClient,
  workspaceId: string,
  capability: (typeof CAPABILITIES)[number],
): Promise<{ id: string; created: boolean }> {
  const existing = await client.query<{ id: string; enabled: boolean; encrypted_credential_ref: string | null }>(
    `SELECT id, enabled, encrypted_credential_ref
       FROM provider_configuration
      WHERE workspace_id = $1 AND provider_key = 'mock-media' AND capability = $2
      FOR UPDATE`,
    [workspaceId, capability],
  );
  const row = existing.rows[0];
  if (row) {
    if (!row.enabled || row.encrypted_credential_ref) {
      throw new Error(`Existing mock-media ${capability} configuration is incompatible and was not changed`);
    }
    return { id: row.id, created: false };
  }
  const created = await client.query<{ id: string }>(
    `INSERT INTO provider_configuration
      (workspace_id, provider_key, capability, default_timeout_ms)
     VALUES ($1, 'mock-media', $2, 30000)
     ON CONFLICT (workspace_id, provider_key, capability) DO NOTHING
     RETURNING id`,
    [workspaceId, capability],
  );
  const id = created.rows[0]?.id;
  if (!id) {
    const again = await client.query<{ id: string; enabled: boolean; encrypted_credential_ref: string | null }>(
      `SELECT id, enabled, encrypted_credential_ref
         FROM provider_configuration
        WHERE workspace_id = $1 AND provider_key = 'mock-media' AND capability = $2`,
      [workspaceId, capability],
    );
    const raced = again.rows[0];
    if (!raced || !raced.enabled || raced.encrypted_credential_ref) {
      throw new Error(`Existing mock-media ${capability} configuration is incompatible and was not changed`);
    }
    return { id: raced.id, created: false };
  }
  return { id, created: true };
}
