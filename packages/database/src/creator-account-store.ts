import { randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import { PersistenceError, type DatabasePool } from "./job-service";

export type CreatorAccountStatus = "ACTIVE" | "DISABLED" | "LEGACY";

export interface CreatorAccountRecord {
  id: string;
  workspaceId: string;
  username: string;
  status: CreatorAccountStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreatorAccountWithHash extends CreatorAccountRecord {
  passwordHash: string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapAccount(row: QueryResultRow): CreatorAccountRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    username: String(row.username),
    status: String(row.status) as CreatorAccountStatus,
    createdAt: iso(row.created_at as Date),
    updatedAt: iso(row.updated_at as Date),
  };
}

/** Both staff invitations and creator registrations reserve the same case-insensitive workspace login. */
export async function withAvailableLoginName<T>(
  pool: DatabasePool, workspaceId: string, username: string, create: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`workspace-login:${workspaceId}:${username.toLowerCase()}`]);
    const tables = await client.query("SELECT to_regclass('creator_account') AS creators, to_regclass('staff_account') AS staff");
    if (!tables.rows[0]?.creators) throw new PersistenceError("NOT_FOUND", "Creator accounts are not migrated");
    const staff = tables.rows[0]?.staff ? "UNION ALL SELECT 1 FROM staff_account WHERE workspace_id=$1 AND lower(username)=lower($2)" : "";
    const clash = await client.query(
      `SELECT EXISTS (SELECT 1 FROM creator_account WHERE workspace_id=$1 AND lower(username)=lower($2) ${staff}) AS present`,
      [workspaceId, username],
    );
    if (clash.rows[0]?.present) throw new PersistenceError("VALIDATION_ERROR", "账号已存在");
    const result = await create(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Creator accounts for phase-4 isolation. Operator SITE_AUTH login is separate and unchanged. */
export class CreatorAccountStore {
  constructor(private readonly pool: DatabasePool) {}

  async ready(): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ present: boolean }>(
        `SELECT to_regclass('creator_account') IS NOT NULL AS present`,
      );
      return result.rows[0]?.present === true;
    } finally {
      client.release();
    }
  }

  async findActiveByUsername(workspaceId: string, username: string): Promise<CreatorAccountWithHash | null> {
    if (!this.readySyncableUsername(username)) return null;
    const client = await this.pool.connect();
    try {
      if (!await this.tablesPresent(client)) return null;
      const result = await client.query<QueryResultRow>(
        `SELECT id, workspace_id, username, password_hash, status, created_at, updated_at
           FROM creator_account
          WHERE workspace_id = $1 AND lower(username) = lower($2) AND status = 'ACTIVE'`,
        [workspaceId, username],
      );
      const row = result.rows[0];
      if (!row) return null;
      return { ...mapAccount(row), passwordHash: String(row.password_hash) };
    } finally {
      client.release();
    }
  }

  /** Operator directory: active and disabled creators. LEGACY is not a login-able account. Never returns password hashes. */
  async listManaged(workspaceId: string, limit = 100): Promise<CreatorAccountRecord[]> {
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 100);
    const client = await this.pool.connect();
    try {
      if (!await this.tablesPresent(client)) return [];
      const result = await client.query<QueryResultRow>(
        `SELECT id, workspace_id, username, status, created_at, updated_at
           FROM creator_account
          WHERE workspace_id = $1 AND status IN ('ACTIVE', 'DISABLED')
          ORDER BY created_at ASC, username ASC
          LIMIT $2`,
        [workspaceId, safeLimit],
      );
      return result.rows.map(mapAccount);
    } finally {
      client.release();
    }
  }

  /** Reuses the existing status column. LEGACY rows cannot be enabled or disabled here. */
  async setStatus(workspaceId: string, id: string, status: "ACTIVE" | "DISABLED"): Promise<CreatorAccountRecord> {
    if (status !== "ACTIVE" && status !== "DISABLED") {
      throw new PersistenceError("VALIDATION_ERROR", "账号状态无效");
    }
    const client = await this.pool.connect();
    try {
      if (!await this.tablesPresent(client)) throw new PersistenceError("NOT_FOUND", "Creator accounts are not migrated");
      const result = await client.query<QueryResultRow>(
        `UPDATE creator_account
            SET status = $3, updated_at = now()
          WHERE id = $1 AND workspace_id = $2 AND status IN ('ACTIVE', 'DISABLED')
          RETURNING id, workspace_id, username, status, created_at, updated_at`,
        [id, workspaceId, status],
      );
      const row = result.rows[0];
      if (!row) throw new PersistenceError("NOT_FOUND", "创作者账号不存在");
      return mapAccount(row);
    } finally {
      client.release();
    }
  }

  /** Minimal operator listing for provisioning checks. Never returns password hashes. */
  async listActive(workspaceId: string, limit = 50): Promise<CreatorAccountRecord[]> {
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 100);
    const client = await this.pool.connect();
    try {
      if (!await this.tablesPresent(client)) return [];
      const result = await client.query<QueryResultRow>(
        `SELECT id, workspace_id, username, status, created_at, updated_at
           FROM creator_account
          WHERE workspace_id = $1 AND status = 'ACTIVE'
          ORDER BY created_at ASC, username ASC
          LIMIT $2`,
        [workspaceId, safeLimit],
      );
      return result.rows.map(mapAccount);
    } finally {
      client.release();
    }
  }

  async createActive(input: {
    workspaceId: string;
    username: string;
    passwordHash: string;
    id?: string;
  }): Promise<CreatorAccountRecord> {
    if (!this.readySyncableUsername(input.username)) {
      throw new PersistenceError("VALIDATION_ERROR", "账号格式无效");
    }
    try {
      return await withAvailableLoginName(this.pool, input.workspaceId, input.username, async client => {
        const id = input.id ?? randomUUID();
        const result = await client.query<QueryResultRow>(
          `INSERT INTO creator_account (id, workspace_id, username, password_hash, status)
           VALUES ($1, $2, $3, $4, 'ACTIVE')
           RETURNING id, workspace_id, username, status, created_at, updated_at`,
          [id, input.workspaceId, input.username, input.passwordHash],
        );
        const row = result.rows[0];
        if (!row) throw new PersistenceError("VALIDATION_ERROR", "Creator account was not created");
        return mapAccount(row);
      });
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      const code = typeof error === "object" && error && "code" in error ? String((error as { code: unknown }).code) : "";
      if (code === "23505") throw new PersistenceError("VALIDATION_ERROR", "账号已存在");
      throw error;
    }
  }

  private readySyncableUsername(username: string): boolean {
    return /^[A-Za-z0-9._-]{1,64}$/u.test(username);
  }

  private async tablesPresent(client: { query(sql: string, values?: unknown[]): Promise<{ rows: QueryResultRow[] }> }): Promise<boolean> {
    const result = await client.query(`SELECT to_regclass('creator_account') IS NOT NULL AS present`);
    return result.rows[0]?.present === true;
  }
}
