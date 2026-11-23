import { randomUUID } from "node:crypto";
import type { StaffAccountStatus, StaffPermission } from "@ai-drama/domain";
import { PersistenceError, withAvailableLoginName, type DatabasePool } from "@ai-drama/database";

export interface StaffRoleRecord {
  id: string;
  workspaceId: string;
  code: string;
  name: string;
  builtIn: boolean;
  permissions: StaffPermission[];
}

export interface StaffAccountRecord {
  id: string;
  workspaceId: string;
  username: string;
  displayName: string;
  passwordHash: string | null;
  status: StaffAccountStatus;
  roleId: string;
  permissionVersion: number;
  totpSecret: string | null;
  totpEnabled: boolean;
  lastLoginAt: string | null;
  authSource: "env" | "invite";
}

export interface StaffInviteRecord {
  id: string;
  workspaceId: string;
  staffId: string;
  tokenHash: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
}

export interface RecoveryCodeRecord {
  id: string;
  staffId: string;
  codeHash: string;
  usedAt: string | null;
}

type StaffManagementChange = { displayName?: string; roleId?: string; status?: StaffAccountStatus };
type StaffRoleMember = Pick<StaffAccountRecord, "id" | "status">;

export interface StaffRepository {
  ready(): Promise<boolean>;
  listRoles(workspaceId: string): Promise<StaffRoleRecord[]>;
  getRole(id: string): Promise<StaffRoleRecord | null>;
  saveRole(role: StaffRoleRecord): Promise<void>;
  listStaff(workspaceId: string): Promise<StaffAccountRecord[]>;
  getStaff(id: string): Promise<StaffAccountRecord | null>;
  findByUsername(workspaceId: string, username: string): Promise<StaffAccountRecord | null>;
  createEnvStaff(account: StaffAccountRecord): Promise<void>;
  updateManagement(id: string, expectedVersion: number, change: StaffManagementChange): Promise<boolean>;
  changePassword(id: string, expectedHash: string, nextHash: string): Promise<boolean>;
  refreshRoleMembers(workspaceId: string, roleId: string): Promise<StaffRoleMember[]>;
  createInvitedStaff(account: StaffAccountRecord): Promise<boolean>;
  recordLogin(id: string, at: string): Promise<void>;
  listInvites(workspaceId: string, staffId?: string): Promise<StaffInviteRecord[]>;
  saveInvite(invite: StaffInviteRecord): Promise<void>;
  activateInvite(id: string, staffId: string, passwordHash: string, at: string): Promise<StaffAccountRecord | null>;
  findInviteByHash(tokenHash: string): Promise<StaffInviteRecord | null>;
  recoveryCodes(staffId: string): Promise<RecoveryCodeRecord[]>;
  setAuthenticator(staffId: string, previousSecret: string | null, secret: string, codes: RecoveryCodeRecord[]): Promise<boolean>;
  consumeRecoveryCode(id: string, at: string): Promise<boolean>;
}

export class MemoryStaffRepository implements StaffRepository {
  roles: StaffRoleRecord[] = [];
  staff: StaffAccountRecord[] = [];
  invites: StaffInviteRecord[] = [];
  codes: RecoveryCodeRecord[] = [];

  async ready(): Promise<boolean> {
    return true;
  }

  async listRoles(workspaceId: string): Promise<StaffRoleRecord[]> {
    return this.roles.filter((role) => role.workspaceId === workspaceId).map(cloneRole);
  }

  async getRole(id: string): Promise<StaffRoleRecord | null> {
    const role = this.roles.find((item) => item.id === id);
    return role ? cloneRole(role) : null;
  }

  async saveRole(role: StaffRoleRecord): Promise<void> {
    const index = this.roles.findIndex((item) => item.id === role.id);
    if (index >= 0) this.roles[index] = cloneRole(role);
    else this.roles.push(cloneRole(role));
  }

  async listStaff(workspaceId: string): Promise<StaffAccountRecord[]> {
    return this.staff.filter((account) => account.workspaceId === workspaceId).map(cloneAccount);
  }

  async getStaff(id: string): Promise<StaffAccountRecord | null> {
    const account = this.staff.find((item) => item.id === id);
    return account ? cloneAccount(account) : null;
  }

  async findByUsername(workspaceId: string, username: string): Promise<StaffAccountRecord | null> {
    const account = this.staff.find((item) => item.workspaceId === workspaceId && item.username.toLowerCase() === username.toLowerCase());
    return account ? cloneAccount(account) : null;
  }

  async createEnvStaff(account: StaffAccountRecord): Promise<void> {
    if (!this.staff.some(row => row.workspaceId === account.workspaceId && row.username.toLowerCase() === account.username.toLowerCase())) {
      this.staff.push(cloneAccount(account));
    }
  }

  async updateManagement(id: string, expectedVersion: number, change: StaffManagementChange): Promise<boolean> {
    const account = this.staff.find(row => row.id === id && row.permissionVersion === expectedVersion);
    if (!account) return false;
    account.displayName = change.displayName ?? account.displayName;
    account.roleId = change.roleId ?? account.roleId;
    account.status = change.status ?? account.status;
    account.permissionVersion++;
    return true;
  }

  async changePassword(id: string, expectedHash: string, nextHash: string): Promise<boolean> {
    const account = this.staff.find(row => row.id === id && row.status === "active" && row.passwordHash === expectedHash);
    if (!account) return false;
    account.passwordHash = nextHash;
    return true;
  }

  async refreshRoleMembers(workspaceId: string, roleId: string): Promise<StaffRoleMember[]> {
    const members = this.staff.filter(row => row.workspaceId === workspaceId && row.roleId === roleId);
    return members.map(row => {
      row.permissionVersion++;
      return { id: row.id, status: row.status };
    });
  }

  async createInvitedStaff(account: StaffAccountRecord): Promise<boolean> {
    if (this.staff.some(row => row.workspaceId === account.workspaceId && row.username.toLowerCase() === account.username.toLowerCase())) return false;
    this.staff.push(cloneAccount(account));
    return true;
  }

  async recordLogin(id: string, at: string): Promise<void> {
    const account = this.staff.find(row => row.id === id);
    if (account) account.lastLoginAt = at;
  }

  async listInvites(workspaceId: string, staffId?: string): Promise<StaffInviteRecord[]> {
    return this.invites.filter((invite) => invite.workspaceId === workspaceId && (staffId === undefined || invite.staffId === staffId)).map((invite) => ({ ...invite }));
  }

  async saveInvite(invite: StaffInviteRecord): Promise<void> {
    const index = this.invites.findIndex((item) => item.id === invite.id);
    if (index >= 0) this.invites[index] = { ...invite, usedAt: this.invites[index]!.usedAt ?? invite.usedAt, revokedAt: this.invites[index]!.revokedAt ?? invite.revokedAt };
    else this.invites.push({ ...invite });
  }

  async activateInvite(id: string, staffId: string, passwordHash: string, at: string): Promise<StaffAccountRecord | null> {
    const invite = this.invites.find(item => item.id === id && item.staffId === staffId);
    const account = this.staff.find(item => item.id === staffId);
    if (!account || account.status !== "pending" || !invite || invite.usedAt || invite.revokedAt || Date.parse(invite.expiresAt) <= Date.parse(at)) return null;
    invite.usedAt = at;
    account.status = "active";
    account.passwordHash = passwordHash;
    account.permissionVersion++;
    return cloneAccount(account);
  }

  async findInviteByHash(tokenHash: string): Promise<StaffInviteRecord | null> {
    return this.invites.find((invite) => invite.tokenHash === tokenHash) ?? null;
  }

  async recoveryCodes(staffId: string): Promise<RecoveryCodeRecord[]> {
    return this.codes.filter((code) => code.staffId === staffId).map((code) => ({ ...code }));
  }

  async setAuthenticator(staffId: string, previousSecret: string | null, secret: string, codes: RecoveryCodeRecord[]): Promise<boolean> {
    const account = this.staff.find(row => row.id === staffId && row.status === "active" && row.totpSecret === previousSecret);
    if (!account) return false;
    account.totpSecret = secret;
    account.totpEnabled = true;
    this.codes = this.codes.filter((code) => code.staffId !== staffId).concat(codes.map((code) => ({ ...code })));
    return true;
  }

  async consumeRecoveryCode(id: string, at: string): Promise<boolean> {
    const code = this.codes.find((item) => item.id === id);
    if (!code || code.usedAt) return false;
    code.usedAt = at;
    return true;
  }
}

function cloneRole(role: StaffRoleRecord): StaffRoleRecord {
  return { ...role, permissions: [...role.permissions] };
}

function cloneAccount(account: StaffAccountRecord): StaffAccountRecord {
  return { ...account };
}

export class PostgresStaffRepository implements StaffRepository {
  constructor(private readonly pool: DatabasePool) {}

  async ready(): Promise<boolean> {
    try {
      const client = await this.pool.connect();
      try {
        const result = await client.query<{ present: boolean }>(`SELECT to_regclass('staff_account') IS NOT NULL AS present`);
        return result.rows[0]?.present === true;
      } finally {
        client.release();
      }
    } catch {
      // The env operator still signs in when this database cannot be reached.
      return false;
    }
  }

  async listRoles(workspaceId: string): Promise<StaffRoleRecord[]> {
    return this.rows<StaffRoleRecord>(
      `SELECT id, workspace_id, code, name, built_in, permissions FROM staff_role WHERE workspace_id = $1 ORDER BY built_in DESC, name ASC`,
      [workspaceId],
      mapRole,
    );
  }

  async getRole(id: string): Promise<StaffRoleRecord | null> {
    const rows = await this.rows<StaffRoleRecord>(
      `SELECT id, workspace_id, code, name, built_in, permissions FROM staff_role WHERE id = $1`,
      [id],
      mapRole,
    );
    return rows[0] ?? null;
  }

  async saveRole(role: StaffRoleRecord): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO staff_role (id, workspace_id, code, name, built_in, permissions)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, permissions = EXCLUDED.permissions, updated_at = now()`,
        [role.id, role.workspaceId, role.code, role.name, role.builtIn, role.permissions],
      );
    } finally {
      client.release();
    }
  }

  async listStaff(workspaceId: string): Promise<StaffAccountRecord[]> {
    return this.rows(`SELECT ${STAFF_COLUMNS} FROM staff_account WHERE workspace_id = $1 ORDER BY created_at ASC`, [workspaceId], mapStaff);
  }

  async getStaff(id: string): Promise<StaffAccountRecord | null> {
    const rows = await this.rows(`SELECT ${STAFF_COLUMNS} FROM staff_account WHERE id = $1`, [id], mapStaff);
    return rows[0] ?? null;
  }

  async findByUsername(workspaceId: string, username: string): Promise<StaffAccountRecord | null> {
    const rows = await this.rows(
      `SELECT ${STAFF_COLUMNS} FROM staff_account WHERE workspace_id = $1 AND lower(username) = lower($2)`,
      [workspaceId, username],
      mapStaff,
    );
    return rows[0] ?? null;
  }

  async createEnvStaff(account: StaffAccountRecord): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO staff_account(id, workspace_id, username, display_name, password_hash, role_id, status, auth_source)
         VALUES ($1,$2,$3,$4,$5,$6,'active','env') ON CONFLICT DO NOTHING`,
        [account.id, account.workspaceId, account.username, account.displayName, account.passwordHash, account.roleId],
      );
    } finally {
      client.release();
    }
  }

  async updateManagement(id: string, expectedVersion: number, change: StaffManagementChange): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `UPDATE staff_account SET display_name=COALESCE($3,display_name), role_id=COALESCE($4,role_id),
           status=COALESCE($5,status), permission_version=permission_version+1, updated_at=now()
         WHERE id=$1 AND permission_version=$2`,
        [id, expectedVersion, change.displayName ?? null, change.roleId ?? null, change.status ?? null],
      );
      return result.rowCount === 1;
    } finally {
      client.release();
    }
  }

  async changePassword(id: string, expectedHash: string, nextHash: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        "UPDATE staff_account SET password_hash=$3, updated_at=now() WHERE id=$1 AND status='active' AND password_hash=$2",
        [id, expectedHash, nextHash],
      );
      return result.rowCount === 1;
    } finally {
      client.release();
    }
  }

  async refreshRoleMembers(workspaceId: string, roleId: string): Promise<StaffRoleMember[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<StaffRoleMember>(
        "UPDATE staff_account SET permission_version=permission_version+1, updated_at=now() WHERE workspace_id=$1 AND role_id=$2 RETURNING id,status",
        [workspaceId, roleId],
      );
      return result.rows;
    } finally {
      client.release();
    }
  }

  async createInvitedStaff(account: StaffAccountRecord): Promise<boolean> {
    try {
      await withAvailableLoginName(this.pool, account.workspaceId, account.username, client => client.query(
        `INSERT INTO staff_account(id,workspace_id,username,display_name,role_id,status,auth_source)
         VALUES ($1,$2,$3,$4,$5,'pending','invite')`,
        [account.id, account.workspaceId, account.username, account.displayName, account.roleId],
      ));
      return true;
    } catch (error) {
      if (error instanceof PersistenceError && error.code === "VALIDATION_ERROR") return false;
      throw error;
    }
  }

  async recordLogin(id: string, at: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("UPDATE staff_account SET last_login_at = GREATEST(last_login_at, $2::timestamptz) WHERE id = $1", [id, at]);
    } finally {
      client.release();
    }
  }

  async listInvites(workspaceId: string, staffId?: string): Promise<StaffInviteRecord[]> {
    return this.rows(
      `SELECT id, workspace_id, staff_id, token_hash, expires_at, used_at, revoked_at
         FROM staff_invite WHERE workspace_id = $1 AND ($2::uuid IS NULL OR staff_id = $2)`,
      [workspaceId, staffId ?? null],
      mapInvite,
    );
  }

  async saveInvite(invite: StaffInviteRecord): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO staff_invite (id, workspace_id, staff_id, token_hash, expires_at, used_at, revoked_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO UPDATE SET used_at = COALESCE(staff_invite.used_at, EXCLUDED.used_at), revoked_at = COALESCE(staff_invite.revoked_at, EXCLUDED.revoked_at)`,
        [invite.id, invite.workspaceId, invite.staffId, invite.tokenHash, invite.expiresAt, invite.usedAt, invite.revokedAt],
      );
    } finally {
      client.release();
    }
  }

  async activateInvite(id: string, staffId: string, passwordHash: string, at: string): Promise<StaffAccountRecord | null> {
    const client = await this.pool.connect();
    try {
      const updated = await client.query(
        `WITH target AS (
           SELECT id FROM staff_account WHERE id=$2 AND status='pending' FOR UPDATE
         ), claimed AS (
           UPDATE staff_invite SET used_at=$4
           WHERE id=$1 AND staff_id IN (SELECT id FROM target) AND used_at IS NULL AND revoked_at IS NULL AND expires_at > $4::timestamptz
           RETURNING staff_id
         )
         UPDATE staff_account SET status='active', password_hash=$3, permission_version=permission_version+1, updated_at=now()
         WHERE id IN (SELECT staff_id FROM claimed) RETURNING ${STAFF_COLUMNS}`,
        [id, staffId, passwordHash, at],
      );
      return updated.rows[0] ? mapStaff(updated.rows[0]) : null;
    } finally {
      client.release();
    }
  }

  async findInviteByHash(tokenHash: string): Promise<StaffInviteRecord | null> {
    const rows = await this.rows(
      `SELECT id, workspace_id, staff_id, token_hash, expires_at, used_at, revoked_at FROM staff_invite WHERE token_hash = $1`,
      [tokenHash],
      mapInvite,
    );
    return rows[0] ?? null;
  }

  async recoveryCodes(staffId: string): Promise<RecoveryCodeRecord[]> {
    return this.rows(
      `SELECT id, staff_id, code_hash, used_at FROM staff_recovery_code WHERE staff_id = $1`,
      [staffId],
      (row) => ({ id: String(row.id), staffId: String(row.staff_id), codeHash: String(row.code_hash), usedAt: row.used_at ? new Date(row.used_at as string).toISOString() : null }),
    );
  }

  async setAuthenticator(staffId: string, previousSecret: string | null, secret: string, codes: RecoveryCodeRecord[]): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const changed = await client.query(
        "UPDATE staff_account SET totp_enabled=true,totp_secret=$3,updated_at=now() WHERE id=$1 AND status='active' AND totp_secret IS NOT DISTINCT FROM $2",
        [staffId, previousSecret, secret],
      );
      if (!changed.rowCount) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query(`DELETE FROM staff_recovery_code WHERE staff_id = $1`, [staffId]);
      for (const code of codes) {
        await client.query(
          `INSERT INTO staff_recovery_code (id, staff_id, code_hash) VALUES ($1, $2, $3)`,
          [code.id, code.staffId, code.codeHash],
        );
      }
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async consumeRecoveryCode(id: string, at: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const consumed = await client.query(`UPDATE staff_recovery_code SET used_at = $2 WHERE id = $1 AND used_at IS NULL`, [id, at]);
      return consumed.rowCount === 1;
    } finally {
      client.release();
    }
  }

  private async rows<T>(sql: string, values: unknown[], map: (row: Record<string, unknown>) => T): Promise<T[]> {
    if (!await this.ready()) return [];
    const client = await this.pool.connect();
    try {
      const result = await client.query(sql, values);
      return result.rows.map((row) => map(row as Record<string, unknown>));
    } finally {
      client.release();
    }
  }
}

const STAFF_COLUMNS = `id, workspace_id, username, display_name, password_hash, status, role_id, permission_version,
  totp_secret, totp_enabled, last_login_at, auth_source`;

function iso(value: unknown): string {
  return (value instanceof Date ? value : new Date(String(value))).toISOString();
}

function mapRole(row: Record<string, unknown>): StaffRoleRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    code: String(row.code),
    name: String(row.name),
    builtIn: row.built_in === true,
    permissions: Array.isArray(row.permissions) ? row.permissions.map(String) as StaffPermission[] : [],
  };
}

function mapStaff(row: Record<string, unknown>): StaffAccountRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    username: String(row.username),
    displayName: String(row.display_name),
    passwordHash: row.password_hash == null ? null : String(row.password_hash),
    status: String(row.status) as StaffAccountStatus,
    roleId: String(row.role_id),
    permissionVersion: Number(row.permission_version),
    totpSecret: row.totp_secret == null ? null : String(row.totp_secret),
    totpEnabled: row.totp_enabled === true,
    lastLoginAt: row.last_login_at == null ? null : iso(row.last_login_at),
    authSource: String(row.auth_source) as "env" | "invite",
  };
}

function mapInvite(row: Record<string, unknown>): StaffInviteRecord {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    staffId: String(row.staff_id),
    tokenHash: String(row.token_hash),
    expiresAt: iso(row.expires_at),
    usedAt: row.used_at == null ? null : iso(row.used_at),
    revokedAt: row.revoked_at == null ? null : iso(row.revoked_at),
  };
}

export function newId(): string {
  return randomUUID();
}
