import { randomBytes, randomUUID } from "node:crypto";
import { CreatorAccountStore, closePostgresPool, createPostgresPool, runMigrations } from "@ai-drama/database";
import { afterAll, beforeAll, expect, it } from "vitest";
import { PostgresStaffRepository, type StaffAccountRecord } from "./staff-repository";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for staff integration tests");
const pool = createPostgresPool({ connectionString: databaseUrl, connectionTimeoutMs: 2000, statementTimeoutMs: 10000, queryTimeoutMs: 10000 });
const staff = new PostgresStaffRepository(pool);
const creators = new CreatorAccountStore(pool);
const workspaceId = randomUUID();
const roleId = randomUUID();

beforeAll(async () => {
  if (!await staff.ready()) await runMigrations(pool);
  await pool.query("INSERT INTO workspace(id,name) VALUES ($1,'员工测试')", [workspaceId]);
  await staff.saveRole({ id: roleId, workspaceId, code: "review", name: "审核", builtIn: false, permissions: ["review_works"] });
});
afterAll(() => closePostgresPool(pool));

function pending(username: string): StaffAccountRecord {
  return { id: randomUUID(), workspaceId, username, displayName: "审核员", passwordHash: null, status: "pending",
    roleId, permissionVersion: 1, totpSecret: null, totpEnabled: false, lastLoginAt: null, authSource: "invite" };
}

it("reserves case-insensitive login names across both directories, including concurrent requests", async () => {
  const creator = (username: string) => creators.createActive({ workspaceId, username, passwordHash: "fixture" });
  await creator("Alice");
  expect(await staff.createInvitedStaff(pending("ALICE"))).toBe(false);
  expect(await staff.createInvitedStaff(pending("Bob"))).toBe(true);
  await expect(creator("bob")).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  const [invited, created] = await Promise.all([
    staff.createInvitedStaff(pending("zoe")), creator("Zoe").then(() => true, () => false),
  ]);
  expect([invited, created].filter(Boolean)).toHaveLength(1);
});

it("activates exactly once, keeps a disabled invite inactive, and never restores an old state on login", async () => {
  const account = pending("charlie");
  await staff.createInvitedStaff(account);
  const invite = { id: randomUUID(), workspaceId, staffId: account.id, tokenHash: randomBytes(32).toString("hex"), usedAt: null, revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000).toISOString() };
  await staff.saveInvite(invite);
  const now = new Date().toISOString();
  const attempts = await Promise.all(["first", "second"].map(hash => staff.activateInvite(invite.id, account.id, hash, now)));
  expect(attempts.filter(Boolean)).toHaveLength(1);
  const active = (await staff.getStaff(account.id))!;
  expect(active).toMatchObject({ status: "active", permissionVersion: 2, passwordHash: attempts.find(Boolean)?.passwordHash });
  await staff.saveInvite({ ...invite, revokedAt: now });
  expect(await staff.findInviteByHash(invite.tokenHash)).toMatchObject({ usedAt: now });
  expect(await staff.updateManagement(account.id, active.permissionVersion, { status: "disabled" })).toBe(true);
  await staff.recordLogin(account.id, now);
  expect(await staff.getStaff(account.id)).toMatchObject({ status: "disabled", permissionVersion: 3, lastLoginAt: now });
  const other = { ...invite, id: randomUUID(), tokenHash: randomBytes(32).toString("hex") };
  await staff.saveInvite(other);
  expect(await staff.activateInvite(other.id, account.id, "late", now)).toBeNull();
  expect(await staff.findInviteByHash(other.tokenHash)).toMatchObject({ usedAt: null });
  const code = { id: randomUUID(), staffId: account.id, codeHash: randomBytes(32).toString("hex"), usedAt: null };
  expect(await staff.updateManagement(account.id, 3, { status: "active" })).toBe(true);
  expect(await staff.setAuthenticator(account.id, null, "fixture-secret", [code])).toBe(true);
  expect(await staff.setAuthenticator(account.id, null, "stale", [])).toBe(false);
  const used = await Promise.all([staff.consumeRecoveryCode(code.id, now), staff.consumeRecoveryCode(code.id, now)]);
  expect(used.sort()).toEqual([false, true]);
});

it("keeps password, authenticator and management writes independent while rejecting stale changes", async () => {
  const account = { ...pending("dana"), status: "active" as const, authSource: "env" as const, passwordHash: "initial" };
  await staff.createEnvStaff(account);
  const otherRole = randomUUID();
  await staff.saveRole({ id: otherRole, workspaceId, code: "changed", name: "调整岗位", builtIn: false, permissions: [] });
  const changed = await Promise.all([
    staff.changePassword(account.id, "initial", "password-a"),
    staff.changePassword(account.id, "initial", "password-b"),
    staff.updateManagement(account.id, account.permissionVersion, { displayName: "改名", roleId: otherRole }),
    staff.setAuthenticator(account.id, null, "new-factor", []),
  ]);
  expect(changed.slice(0, 2).filter(Boolean)).toHaveLength(1);
  expect(changed.slice(2)).toEqual([true, true]);
  const hash = changed[0] ? "password-a" : "password-b";
  expect(await staff.getStaff(account.id)).toMatchObject({
    passwordHash: hash, displayName: "改名", roleId: otherRole, permissionVersion: 2, totpEnabled: true, totpSecret: "new-factor",
  });
  expect(await staff.updateManagement(account.id, account.permissionVersion, { roleId })).toBe(false);
  expect(await staff.refreshRoleMembers(workspaceId, roleId)).not.toContainEqual({ id: account.id, status: "active" });
  expect(await staff.updateManagement(account.id, 2, { status: "disabled" })).toBe(true);
  expect(await staff.changePassword(account.id, hash, "queued-before-disable")).toBe(false);
  expect(await staff.refreshRoleMembers(workspaceId, otherRole)).toContainEqual({ id: account.id, status: "disabled" });
  await staff.createEnvStaff(account);
  expect(await staff.getStaff(account.id)).toMatchObject({
    passwordHash: hash, roleId: otherRole, status: "disabled", permissionVersion: 4, totpSecret: "new-factor",
  });
});
