import { createHash, randomBytes } from "node:crypto";
import { SiteAuthError } from "../auth/site-auth";
import {
  BUILTIN_STAFF_ROLES,
  INVITE_TTL_MS,
  OPS_ADMIN_ROLE_CODE,
  SUPER_ADMIN_ROLE_CODE,
  inviteUsability,
  inviteUsabilityMessage,
  lastSuperAdminAllows,
  permissionDeniedMessage,
  sessionAllowsStaffPermission,
  staffHasPermission,
  staffPermissionsOf,
  staffStatusLabel,
  type StaffAccountStatus,
  type StaffPermission,
} from "@ai-drama/domain";
import { createRecoveryCodes, createTotpSecret, totpUri, verifyTotp } from "../auth/totp";
import {
  newId,
  type RecoveryCodeRecord,
  type StaffAccountRecord,
  type StaffInviteRecord,
  type StaffRepository,
  type StaffRoleRecord,
} from "./staff-repository";

export const STAFF_ACCESS_SERVICE = "STAFF_ACCESS_SERVICE";

export class StaffAccessError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "StaffAccessError";
  }
}

export interface StaffSessionInfo {
  publicId: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface StaffSessionControl {
  sync(staffId: string, access: { status: StaffAccountStatus; permissions: readonly string[] }): void;
  revokeAccount(accountId: string): void;
  list(accountId: string): StaffSessionInfo[];
  revokeOne(accountId: string, publicId: string): boolean;
}

export interface StaffAudit {
  (entry: {
    actor: string;
    action: string;
    target: string;
    result: "success" | "failed";
    detail?: string;
  }, forbidden?: readonly string[]): Promise<void>;
}

export interface StaffActor {
  id: string;
  username: string;
  permissions: readonly string[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function assertStaffPermission(session: {
  role: "operator" | "creator";
  staffId: string | null;
  permissions: readonly string[];
}, permission: StaffPermission): void {
  if (session.role !== "operator") throw new SiteAuthError(401, "AUTH_REQUIRED");
  if (!sessionAllowsStaffPermission({
    role: session.role,
    staffId: session.staffId,
    permissions: session.permissions,
    required: permission,
  })) {
    throw new StaffAccessError(403, "PERMISSION_DENIED", permissionDeniedMessage(permission));
  }
}

function assertManage(actor: StaffActor): void {
  if (!staffHasPermission(actor.permissions, "manage_staff")) {
    throw new StaffAccessError(403, "PERMISSION_DENIED", "没有「管理后台人员」权限，请求已拒绝。");
  }
}

export class StaffAccessService {
  private ensured = false;
  private readonly pendingTotp = new Map<string, string>();
  private staffGate: Promise<void> = Promise.resolve();

  constructor(private readonly deps: {
    workspaceId: string;
    repository: StaffRepository;
    publicOrigin: string;
    envUsername: string;
    envPasswordHash: string;
    hashPassword: (password: string, cheap?: boolean) => Promise<string>;
    verifyPassword: (password: string, passwordHash: string) => Promise<boolean>;
    sessions: StaffSessionControl;
    audit?: StaffAudit;
    now?: () => Date;
  }) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  async ensureEnvSuperAdmin(): Promise<void> {
    if (this.ensured) return;
    if (!await this.deps.repository.ready()) return;
    let roles = await this.deps.repository.listRoles(this.deps.workspaceId);
    if (!roles.some((role) => role.code === SUPER_ADMIN_ROLE_CODE)) {
      for (const builtin of BUILTIN_STAFF_ROLES) {
        await this.deps.repository.saveRole({
          id: newId(),
          workspaceId: this.deps.workspaceId,
          code: builtin.code,
          name: builtin.name,
          builtIn: true,
          permissions: [...builtin.permissions],
        });
      }
      roles = await this.deps.repository.listRoles(this.deps.workspaceId);
    }
    const superRole = roles.find((role) => role.code === SUPER_ADMIN_ROLE_CODE);
    if (!superRole) return;
    const existing = await this.deps.repository.findByUsername(this.deps.workspaceId, this.deps.envUsername);
    if (!existing) {
      const account: StaffAccountRecord = {
        id: newId(),
        workspaceId: this.deps.workspaceId,
        username: this.deps.envUsername,
        displayName: "超级管理员",
        passwordHash: this.deps.envPasswordHash,
        status: "active",
        roleId: superRole.id,
        permissionVersion: 1,
        totpSecret: null,
        totpEnabled: false,
        lastLoginAt: null,
        authSource: "env",
      };
      await this.deps.repository.saveStaff(account);
      this.deps.sessions.sync(account.id, { status: "active", permissions: superRole.permissions });
    } else {
      const role = await this.deps.repository.getRole(existing.roleId);
      this.deps.sessions.sync(existing.id, { status: existing.status, permissions: role?.permissions ?? [] });
    }
    this.ensured = true;
  }

  loginDirectory(): {
    findByUsername(username: string): Promise<{
      id: string;
      username: string;
      passwordHash: string | null;
      status: StaffAccountStatus;
      permissions: StaffPermission[];
      totpEnabled: boolean;
    } | null>;
    recordLogin(staffId: string): Promise<void>;
    verifySecondFactor(staffId: string, code: string): Promise<boolean>;
  } {
    return {
      findByUsername: async (username) => {
        await this.ensureEnvSuperAdmin();
        if (!await this.deps.repository.ready()) return null;
        const account = await this.deps.repository.findByUsername(this.deps.workspaceId, username);
        if (!account) return null;
        const role = await this.deps.repository.getRole(account.roleId);
        this.deps.sessions.sync(account.id, { status: account.status, permissions: role?.permissions ?? [] });
        return {
          id: account.id,
          username: account.username,
          passwordHash: account.passwordHash,
          status: account.status,
          permissions: role?.permissions ?? [],
          totpEnabled: account.totpEnabled,
        };
      },
      recordLogin: async (staffId) => {
        const account = await this.deps.repository.getStaff(staffId);
        if (!account) return;
        account.lastLoginAt = this.now().toISOString();
        await this.deps.repository.saveStaff(account);
      },
      verifySecondFactor: (staffId, code) => this.verifySecondFactor(staffId, code),
    };
  }

  async list(): Promise<{
    staff: Array<StaffAccountRecord & { roleName: string; statusLabel: string; permissions: StaffPermission[] }>;
    roles: StaffRoleRecord[];
  }> {
    await this.ensureEnvSuperAdmin();
    const roles = await this.deps.repository.listRoles(this.deps.workspaceId);
    const staff = await this.deps.repository.listStaff(this.deps.workspaceId);
    return {
      roles,
      staff: staff.map((account) => {
        const role = roles.find((item) => item.id === account.roleId);
        return {
          ...account,
          passwordHash: null,
          totpSecret: null,
          roleName: role?.name ?? "未分配",
          statusLabel: staffStatusLabel(account.status),
          permissions: role?.permissions ?? [],
        };
      }),
    };
  }

  async invite(actor: StaffActor, input: {
    username: string;
    displayName: string;
    roleId: string;
    currentPassword?: string;
    totpCode?: string;
  }): Promise<{ staffId: string; inviteUrl: string; expiresAt: string }> {
    assertManage(actor);
    await this.ensureEnvSuperAdmin();
    const username = input.username.trim();
    const displayName = input.displayName.trim();
    if (!/^[A-Za-z0-9._-]{1,64}$/u.test(username) || displayName.length < 1 || displayName.length > 40) {
      throw new StaffAccessError(400, "STAFF_INPUT_INVALID", "请填写 1–64 位账号（字母、数字、点、下划线或短横线）和显示名。");
    }
    if (username.toLowerCase() === this.deps.envUsername.toLowerCase()) {
      throw new StaffAccessError(409, "STAFF_USERNAME_TAKEN", "这个账号已是超级管理员，不能再邀请。");
    }
    if (await this.deps.repository.findByUsername(this.deps.workspaceId, username)) {
      throw new StaffAccessError(409, "STAFF_USERNAME_TAKEN", "这个账号已经存在。");
    }
    const role = await this.requireRole(input.roleId);
    if (role.code === SUPER_ADMIN_ROLE_CODE) await this.reauthenticate(actor.id, input.currentPassword, input.totpCode);
    const account: StaffAccountRecord = {
      id: newId(),
      workspaceId: this.deps.workspaceId,
      username,
      displayName,
      passwordHash: null,
      status: "pending",
      roleId: role.id,
      permissionVersion: 1,
      totpSecret: null,
      totpEnabled: false,
      lastLoginAt: null,
      authSource: "invite",
    };
    await this.deps.repository.saveStaff(account);
    const issued = await this.issueInvite(account.id);
    await this.audit(actor, "邀请管理员", username, `角色 ${role.name}。邀请 24 小时内有效，只能使用一次。`, [issued.token, issued.inviteUrl]);
    return { staffId: account.id, inviteUrl: issued.inviteUrl, expiresAt: issued.expiresAt };
  }

  async revokeInvite(actor: StaffActor, staffId: string): Promise<void> {
    assertManage(actor);
    const invites = await this.deps.repository.listInvites(this.deps.workspaceId, staffId);
    const now = this.now().toISOString();
    for (const invite of invites) {
      if (invite.usedAt || invite.revokedAt) continue;
      invite.revokedAt = now;
      await this.deps.repository.saveInvite(invite);
    }
    const account = await this.deps.repository.getStaff(staffId);
    await this.audit(actor, "撤销邀请", account?.username ?? staffId, "未使用的邀请已撤销。");
  }

  async resendInvite(actor: StaffActor, staffId: string): Promise<{ inviteUrl: string; expiresAt: string }> {
    assertManage(actor);
    const account = await this.requireStaff(staffId);
    if (account.status !== "pending") throw new StaffAccessError(409, "STAFF_NOT_PENDING", "只有待激活账号可以重新邀请。");
    await this.revokeInvite(actor, staffId);
    const issued = await this.issueInvite(staffId);
    await this.audit(actor, "重新邀请", account.username, "已生成新的一次性邀请。", [issued.token, issued.inviteUrl]);
    return { inviteUrl: issued.inviteUrl, expiresAt: issued.expiresAt };
  }

  async acceptInvite(token: string, password: string): Promise<{ username: string }> {
    if (password.length < 8 || password.length > 1024) {
      throw new StaffAccessError(400, "PASSWORD_INVALID", "密码至少 8 位。请重新设置。");
    }
    const invite = await this.deps.repository.findInviteByHash(sha256(token));
    if (!invite || invite.workspaceId !== this.deps.workspaceId) {
      throw new StaffAccessError(400, "INVITE_INVALID", "邀请无效。请向管理员索取新的邀请。");
    }
    const usability = inviteUsability({
      now: this.now().getTime(),
      expiresAt: Date.parse(invite.expiresAt),
      usedAt: invite.usedAt ? Date.parse(invite.usedAt) : null,
      revokedAt: invite.revokedAt ? Date.parse(invite.revokedAt) : null,
    });
    if (usability !== "open") {
      throw new StaffAccessError(400, usability === "expired" ? "INVITE_EXPIRED" : usability === "revoked" ? "INVITE_REVOKED" : "INVITE_USED", inviteUsabilityMessage(usability));
    }
    const account = await this.requireStaff(invite.staffId);
    const consumed = await this.deps.repository.consumeInvite(invite.id, this.now().toISOString());
    if (!consumed) throw new StaffAccessError(400, "INVITE_USED", "这份邀请已经使用过。请向管理员索取新的邀请。");
    account.passwordHash = await this.deps.hashPassword(password, process.env.NODE_ENV === "test");
    account.status = "active";
    account.permissionVersion += 1;
    await this.deps.repository.saveStaff(account);
    const role = await this.deps.repository.getRole(account.roleId);
    this.deps.sessions.sync(account.id, { status: "active", permissions: role?.permissions ?? [] });
    await this.audit({ id: account.id, username: account.username, permissions: role?.permissions ?? [] }, "激活管理员", account.username, "对方已自行设置密码。", [token, password]);
    return { username: account.username };
  }

  async updateStaff(actor: StaffActor, staffId: string, input: {
    displayName?: string;
    roleId?: string;
    currentPassword?: string;
    totpCode?: string;
  }): Promise<void> {
    return this.exclusive(async () => {
    assertManage(actor);
    const account = await this.requireStaff(staffId);
    const currentRole = await this.requireRole(account.roleId);
    const nextRole = input.roleId ? await this.requireRole(input.roleId) : currentRole;
    const staysSuper = account.status === "active" && nextRole.code === SUPER_ADMIN_ROLE_CODE;
    const guard = lastSuperAdminAllows({
      activeSuperAdminCount: await this.countActiveSuperAdmins(),
      targetIsActiveSuperAdmin: account.status === "active" && currentRole.code === SUPER_ADMIN_ROLE_CODE,
      remainsActiveSuperAdmin: staysSuper,
    });
    if (!guard.ok) throw new StaffAccessError(409, "LAST_SUPER_ADMIN", guard.message);
    if (currentRole.code === SUPER_ADMIN_ROLE_CODE || nextRole.code === SUPER_ADMIN_ROLE_CODE) {
      await this.reauthenticate(actor.id, input.currentPassword, input.totpCode);
    }
    if (input.displayName?.trim()) account.displayName = input.displayName.trim();
    if (input.roleId && input.roleId !== account.roleId) {
      account.roleId = nextRole.id;
      account.permissionVersion += 1;
    }
    await this.deps.repository.saveStaff(account);
    this.deps.sessions.sync(account.id, { status: account.status, permissions: nextRole.permissions });
    await this.audit(actor, "修改管理员", account.username, `角色 ${nextRole.name}。`);
    });
  }

  async setStatus(actor: StaffActor, staffId: string, status: "active" | "disabled", reauth?: { currentPassword?: string; totpCode?: string }): Promise<void> {
    return this.exclusive(async () => {
    assertManage(actor);
    const account = await this.requireStaff(staffId);
    const role = await this.requireRole(account.roleId);
    const guard = lastSuperAdminAllows({
      activeSuperAdminCount: await this.countActiveSuperAdmins(),
      targetIsActiveSuperAdmin: account.status === "active" && role.code === SUPER_ADMIN_ROLE_CODE,
      remainsActiveSuperAdmin: status === "active" && role.code === SUPER_ADMIN_ROLE_CODE,
    });
    if (!guard.ok) throw new StaffAccessError(409, "LAST_SUPER_ADMIN", guard.message);
    if (role.code === SUPER_ADMIN_ROLE_CODE) await this.reauthenticate(actor.id, reauth?.currentPassword, reauth?.totpCode);
    account.status = status;
    account.permissionVersion += 1;
    await this.deps.repository.saveStaff(account);
    this.deps.sessions.sync(account.id, { status, permissions: role.permissions });
    if (status === "disabled") {
      const now = this.now().toISOString();
      for (const invite of await this.deps.repository.listInvites(this.deps.workspaceId, account.id)) {
        if (invite.usedAt || invite.revokedAt) continue;
        invite.revokedAt = now;
        await this.deps.repository.saveInvite(invite);
      }
      this.deps.sessions.revokeAccount(account.id);
    }
    await this.audit(actor, status === "disabled" ? "停用管理员" : "重新启用管理员", account.username, staffStatusLabel(status));
    });
  }

  async saveRole(actor: StaffActor, input: { id?: string; name: string; permissions: readonly string[] }): Promise<StaffRoleRecord> {
    assertManage(actor);
    const permissions = staffPermissionsOf(input.permissions);
    if (input.id) {
      const role = await this.requireRole(input.id);
      if (role.code === SUPER_ADMIN_ROLE_CODE) {
        throw new StaffAccessError(409, "SUPER_ADMIN_LOCKED", "超级管理员的权限保持完整，不能改小。");
      }
      role.name = input.name.trim() || role.name;
      if (role.code !== OPS_ADMIN_ROLE_CODE || input.permissions.length > 0) role.permissions = permissions;
      if (role.code === OPS_ADMIN_ROLE_CODE) role.permissions = permissions;
      await this.deps.repository.saveRole(role);
      await this.syncRole(role);
      await this.audit(actor, "修改角色权限", role.name, permissions.join(","));
      return role;
    }
    const role: StaffRoleRecord = {
      id: newId(),
      workspaceId: this.deps.workspaceId,
      code: `role_${newId().slice(0, 8)}`,
      name: input.name.trim(),
      builtIn: false,
      permissions,
    };
    if (role.name.length < 1) throw new StaffAccessError(400, "STAFF_INPUT_INVALID", "请填写岗位名称。");
    await this.deps.repository.saveRole(role);
    await this.audit(actor, "创建角色", role.name, permissions.join(","));
    return role;
  }

  async changePassword(staffId: string, currentPassword: string, nextPassword: string): Promise<void> {
    if (nextPassword.length < 8) throw new StaffAccessError(400, "PASSWORD_INVALID", "新密码至少 8 位。");
    const account = await this.requireStaff(staffId);
    if (!account.passwordHash || !await this.deps.verifyPassword(currentPassword, account.passwordHash)) {
      throw new StaffAccessError(403, "REAUTH_FAILED", "当前密码不正确，没有修改密码。");
    }
    account.passwordHash = await this.deps.hashPassword(nextPassword, process.env.NODE_ENV === "test");
    account.permissionVersion += 1;
    await this.deps.repository.saveStaff(account);
    await this.audit({ id: staffId, username: account.username, permissions: [] }, "修改密码", account.username, "已修改自己的密码。", [currentPassword, nextPassword]);
  }

  async beginTotp(staffId: string, currentPassword: string): Promise<{ secret: string; uri: string }> {
    const account = await this.requireStaff(staffId);
    if (!account.passwordHash || !await this.deps.verifyPassword(currentPassword, account.passwordHash)) {
      throw new StaffAccessError(403, "REAUTH_FAILED", "当前密码不正确，没有开启验证器。");
    }
    const secret = createTotpSecret();
    this.pendingTotp.set(staffId, secret);
    return { secret, uri: totpUri(secret, account.username) };
  }

  async confirmTotp(staffId: string, code: string): Promise<{ recoveryCodes: string[] }> {
    const account = await this.requireStaff(staffId);
    const secret = this.pendingTotp.get(staffId);
    if (!secret || !verifyTotp(secret, code, this.now().getTime())) {
      throw new StaffAccessError(400, "TOTP_INVALID", "验证器动态码不正确，双重验证尚未开启。");
    }
    account.totpSecret = secret;
    account.totpEnabled = true;
    this.pendingTotp.delete(staffId);
    await this.deps.repository.saveStaff(account);
    const plain = createRecoveryCodes();
    const records: RecoveryCodeRecord[] = plain.map((value) => ({ id: newId(), staffId, codeHash: sha256(value), usedAt: null }));
    await this.deps.repository.replaceRecoveryCodes(staffId, records);
    await this.audit({ id: staffId, username: account.username, permissions: [] }, "开启双重验证", account.username, "已开启验证器。恢复码只显示这一次。", [account.totpSecret, ...plain]);
    return { recoveryCodes: plain };
  }

  listSessions(staffId: string): StaffSessionInfo[] {
    return this.deps.sessions.list(staffId);
  }

  async revokeSession(actor: StaffActor, staffId: string, publicId: string): Promise<void> {
    if (actor.id !== staffId) assertManage(actor);
    const removed = this.deps.sessions.revokeOne(staffId, publicId);
    if (!removed) throw new StaffAccessError(404, "SESSION_NOT_FOUND", "没有找到这台设备的登录。");
    const account = await this.deps.repository.getStaff(staffId);
    await this.audit(actor, "撤销登录会话", account?.username ?? staffId, "该设备的下一次请求需要重新登录。");
  }

  private async verifySecondFactor(staffId: string, code: string): Promise<boolean> {
    const account = await this.deps.repository.getStaff(staffId);
    if (!account?.totpEnabled || !account.totpSecret) return false;
    if (verifyTotp(account.totpSecret, code, this.now().getTime())) return true;
    const codes = await this.deps.repository.recoveryCodes(staffId);
    const match = codes.find((item) => item.usedAt == null && item.codeHash === sha256(code.trim()));
    if (!match) return false;
    await this.deps.repository.markRecoveryUsed(match.id, this.now().toISOString());
    return true;
  }

  private async reauthenticate(staffId: string, password: string | undefined, totpCode: string | undefined): Promise<void> {
    const account = await this.requireStaff(staffId);
    if (!password || !account.passwordHash || !await this.deps.verifyPassword(password, account.passwordHash)) {
      throw new StaffAccessError(403, "REAUTH_REQUIRED", "交接最高权限前需要重新验证当前密码。本次没有修改。");
    }
    if (account.totpEnabled && (!totpCode || !await this.verifySecondFactor(staffId, totpCode))) {
      throw new StaffAccessError(403, "REAUTH_REQUIRED", "交接最高权限前需要验证器动态码或恢复码。本次没有修改。");
    }
  }

  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.staffGate;
    let release = () => undefined as void;
    this.staffGate = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  private async countActiveSuperAdmins(): Promise<number> {
    const roles = await this.deps.repository.listRoles(this.deps.workspaceId);
    const superIds = new Set(roles.filter((role) => role.code === SUPER_ADMIN_ROLE_CODE).map((role) => role.id));
    const staff = await this.deps.repository.listStaff(this.deps.workspaceId);
    return staff.filter((account) => account.status === "active" && superIds.has(account.roleId)).length;
  }

  private async requireStaff(id: string): Promise<StaffAccountRecord> {
    const account = await this.deps.repository.getStaff(id);
    if (!account || account.workspaceId !== this.deps.workspaceId) throw new StaffAccessError(404, "STAFF_NOT_FOUND", "没有找到这个管理员。");
    return account;
  }

  private async requireRole(id: string): Promise<StaffRoleRecord> {
    const role = await this.deps.repository.getRole(id);
    if (!role || role.workspaceId !== this.deps.workspaceId) throw new StaffAccessError(404, "ROLE_NOT_FOUND", "没有找到这个岗位。");
    return role;
  }

  private async issueInvite(staffId: string): Promise<{ token: string; inviteUrl: string; expiresAt: string }> {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(this.now().getTime() + INVITE_TTL_MS).toISOString();
    const invite: StaffInviteRecord = {
      id: newId(),
      workspaceId: this.deps.workspaceId,
      staffId,
      tokenHash: sha256(token),
      expiresAt,
      usedAt: null,
      revokedAt: null,
    };
    await this.deps.repository.saveInvite(invite);
    return { token, inviteUrl: `${this.deps.publicOrigin}/activate?token=${encodeURIComponent(token)}`, expiresAt };
  }

  private async syncRole(role: StaffRoleRecord): Promise<void> {
    const staff = await this.deps.repository.listStaff(this.deps.workspaceId);
    for (const account of staff) {
      if (account.roleId !== role.id) continue;
      account.permissionVersion += 1;
      await this.deps.repository.saveStaff(account);
      this.deps.sessions.sync(account.id, { status: account.status, permissions: role.permissions });
    }
  }

  private async audit(actor: StaffActor, action: string, target: string, detail: string, forbidden: readonly string[] = []): Promise<void> {
    await this.deps.audit?.({
      actor: actor.username,
      action,
      target,
      result: "success",
      detail,
    }, forbidden);
  }
}
