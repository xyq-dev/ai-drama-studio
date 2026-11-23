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
  await staff.saveStaff({ ...active, status: "disabled", permissionVersion: 3 });
  await staff.recordLogin(account.id, now);
  expect(await staff.getStaff(account.id)).toMatchObject({ status: "disabled", permissionVersion: 3, lastLoginAt: now });
  const other = { ...invite, id: randomUUID(), tokenHash: randomBytes(32).toString("hex") };
  await staff.saveInvite(other);
  expect(await staff.activateInvite(other.id, account.id, "late", now)).toBeNull();
  expect(await staff.findInviteByHash(other.tokenHash)).toMatchObject({ usedAt: null });
  const code = { id: randomUUID(), staffId: account.id, codeHash: randomBytes(32).toString("hex"), usedAt: null };
  await staff.saveStaff({ ...active, status: "active" });
  expect(await staff.setAuthenticator(account.id, null, "fixture-secret", [code])).toBe(true);
  expect(await staff.setAuthenticator(account.id, null, "stale", [])).toBe(false);
  const used = await Promise.all([staff.consumeRecoveryCode(code.id, now), staff.consumeRecoveryCode(code.id, now)]);
  expect(used.sort()).toEqual([false, true]);
});
