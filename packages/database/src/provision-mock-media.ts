import { isAbsolute } from "node:path";
import type { PostgresQueryClient } from "./index";

const WORKSPACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface MockMediaProvisionConfig {
  databaseUrl: string;
  workspaceId: string;
  objectDir: string;
}

export function resolveMockMediaProvisionConfig(
  env: Record<string, string | undefined>,
): MockMediaProvisionConfig {
  if (env.NODE_ENV === "production") throw new Error("Mock media provision is disabled in production");
  if (env.M3_MOCK_IMAGE_ENABLED !== "true") throw new Error("M3_MOCK_IMAGE_ENABLED=true is required");
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

export async function provisionMockMediaProvider(
  pool: PostgresQueryClient,
  workspaceId: string,
): Promise<{ id: string; created: boolean }> {
  const workspace = await pool.query(
    "SELECT status FROM workspace WHERE id = $1",
    [workspaceId],
  ) as { rows: Array<{ status: string }> };
  const status = workspace.rows[0]?.status;
  if (!status) throw new Error("Configured workspace does not exist");
  if (status !== "ACTIVE") throw new Error("Configured workspace is not ACTIVE");

  const existing = await pool.query(
    `SELECT id, enabled, encrypted_credential_ref
       FROM provider_configuration
      WHERE workspace_id = $1 AND provider_key = 'mock-media' AND capability = 'image.generate'`,
    [workspaceId],
  ) as { rows: Array<{ id: string; enabled: boolean; encrypted_credential_ref: string | null }> };
  const row = existing.rows[0];
  if (row) {
    if (!row.enabled || row.encrypted_credential_ref) {
      throw new Error("Existing mock-media image.generate configuration is incompatible and was not changed");
    }
    return { id: row.id, created: false };
  }

  const created = await pool.query(
    `INSERT INTO provider_configuration
      (workspace_id, provider_key, capability, default_timeout_ms)
     VALUES ($1, 'mock-media', 'image.generate', 30000)
     ON CONFLICT (workspace_id, provider_key, capability) DO NOTHING
     RETURNING id`,
    [workspaceId],
  ) as { rows: Array<{ id: string }> };
  const id = created.rows[0]?.id;
  if (!id) {
    const again = await pool.query(
      `SELECT id, enabled, encrypted_credential_ref
         FROM provider_configuration
        WHERE workspace_id = $1 AND provider_key = 'mock-media' AND capability = 'image.generate'`,
      [workspaceId],
    ) as { rows: Array<{ id: string; enabled: boolean; encrypted_credential_ref: string | null }> };
    const raced = again.rows[0];
    if (!raced || !raced.enabled || raced.encrypted_credential_ref) {
      throw new Error("Existing mock-media image.generate configuration is incompatible and was not changed");
    }
    return { id: raced.id, created: false };
  }
  return { id, created: true };
}
