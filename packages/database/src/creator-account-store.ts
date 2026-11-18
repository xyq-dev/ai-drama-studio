import { randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";
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

  async createActive(input: {
    workspaceId: string;
    username: string;
    passwordHash: string;
    id?: string;
  }): Promise<CreatorAccountRecord> {
    if (!this.readySyncableUsername(input.username)) {
      throw new PersistenceError("VALIDATION_ERROR", "账号格式无效");
    }
    const client = await this.pool.connect();
    try {
      if (!await this.tablesPresent(client)) {
        throw new PersistenceError("NOT_FOUND", "Creator accounts are not migrated");
      }
      const id = input.id ?? randomUUID();
      // Case-insensitive uniqueness matches findActiveByUsername (lower(username)).
      const clash = await client.query<{ present: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM creator_account
            WHERE workspace_id = $1 AND lower(username) = lower($2)
         ) AS present`,
        [input.workspaceId, input.username],
      );
      if (clash.rows[0]?.present === true) {
        throw new PersistenceError("VALIDATION_ERROR", "账号已存在");
      }
      const result = await client.query<QueryResultRow>(
        `INSERT INTO creator_account (id, workspace_id, username, password_hash, status)
         VALUES ($1, $2, $3, $4, 'ACTIVE')
         RETURNING id, workspace_id, username, status, created_at, updated_at`,
        [id, input.workspaceId, input.username, input.passwordHash],
      );
      const row = result.rows[0];
      if (!row) throw new PersistenceError("VALIDATION_ERROR", "Creator account was not created");
      return mapAccount(row);
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      const code = typeof error === "object" && error && "code" in error ? String((error as { code: unknown }).code) : "";
      if (code === "23505") throw new PersistenceError("VALIDATION_ERROR", "账号已存在");
      throw error;
    } finally {
      client.release();
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
