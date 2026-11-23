import { describe, expect, it, vi } from "vitest";
import { hashPassword } from "../auth/password-hash";
import { SiteAuth } from "../auth/site-auth";
import { LEGACY_OWNER_ACCOUNT_ID } from "@ai-drama/domain";
import { currentTotp } from "../auth/totp";
import { MemoryStaffRepository } from "./staff-repository";
import { StaffAccessError, StaffAccessService, assertStaffPermission } from "./staff-access.service";

const cheap = { log2N: 15, r: 8, p: 1, saltBytes: 16, keyBytes: 32 };
const workspace = "11111111-1111-4111-8111-111111111111";

async function setup() {
  const passwordHash = await hashPassword("operator-pass", cheap);
  const auth = new SiteAuth({
    username: "owner",
    passwordHash,
    publicOrigin: "http://127.0.0.1:3000",
  });
  const repository = new MemoryStaffRepository();
  const audits: string[] = [];
  const staff = new StaffAccessService({
    workspaceId: workspace,
    repository,
    publicOrigin: "http://127.0.0.1:3000",
    envUsername: "owner",
    envPasswordHash: passwordHash,
    hashPassword: (password) => hashPassword(password, cheap),
    verifyPassword: async () => true,
    sessions: {
      sync: (id, access) => auth.syncStaff(id, access),
      revokeAccount: (id) => auth.revokeAccount(id),
      list: (id) => auth.listStaffSessions(id),
      revokeOne: (id, publicId) => auth.revokeStaffSession(id, publicId),
    },
    audit: (entry) => { audits.push(`${entry.actor}:${entry.action}:${entry.target}`); },
  });
  auth.setStaffDirectory(staff.loginDirectory());
  await staff.ensureEnvSuperAdmin();
  return { auth, staff, audits, repository };
}

const headers = { origin: "http://127.0.0.1:3000", "content-type": "application/json" };

function actorOf(session: { accountId: string; staffId: string | null; username: string; permissions: readonly import("@ai-drama/domain").StaffPermission[] }) {
  return { id: session.staffId ?? session.accountId, username: session.username, permissions: session.permissions };
}

function cookieHeader(cookies: readonly string[]): Record<string, string> {
  return { cookie: cookies.map((item) => item.split(";")[0]).join("; "), origin: "http://127.0.0.1:3000" };
}

async function login(auth: SiteAuth, username: string, password: string) {
  const result = await auth.login(headers, { password, username });
  if (result.totpRequired || !result.session) throw new Error(`${username} login`);
  return result;
}

describe("staff administration", () => {
  it("invites an operator, lets them review, and rejects model-key and quota changes", async () => {
    const { auth, staff, audits } = await setup();
    const owner = await login(auth, "owner", "operator-pass");
    expect(owner.session.accountId).toBe(LEGACY_OWNER_ACCOUNT_ID);
    const roles = await staff.list();
    const ops = roles.roles.find((role) => role.code === "ops_admin");
    if (!ops) throw new Error("missing ops role");
    const invited = await staff.invite(actorOf(owner.session), {
      username: "ops",
      displayName: "运营同事",
      roleId: ops.id,
    });
    expect(invited.inviteUrl).toContain("/activate?token=");
    expect(audits.some((row) => row.includes("邀请管理员"))).toBe(true);
    await staff.acceptInvite(invited.inviteUrl.split("token=")[1]!, "ops-password");
    const opsLogin = await login(auth, "ops", "ops-password");
    expect(opsLogin.session.permissions).toContain("review_works");
    expect(() => assertStaffPermission(opsLogin.session!, "maintain_model_keys")).toThrow(StaffAccessError);
    expect(() => assertStaffPermission(opsLogin.session!, "adjust_quota")).toThrow(StaffAccessError);
    await staff.setStatus(actorOf(owner.session), opsLogin.session.staffId!, "disabled");
    expect(() => auth.session(cookieHeader(opsLogin.cookies))).toThrow();
    expect(audits.some((row) => row.startsWith("owner:") && row.includes("停用"))).toBe(true);
  });

  it("rejects an expired invite and the last super admin being disabled", async () => {
    const { auth, staff } = await setup();
    const owner = await login(auth, "owner", "operator-pass");
    const roles = await staff.list();
    const ops = roles.roles.find((role) => role.code === "ops_admin");
    const invited = await staff.invite(actorOf(owner.session), { username: "late", displayName: "迟到", roleId: ops!.id });
    await staff.revokeInvite(actorOf(owner.session), (await staff.list()).staff.find((row) => row.username === "late")!.id);
    await expect(staff.acceptInvite(invited.inviteUrl.split("token=")[1]!, "late-password")).rejects.toMatchObject({ code: "INVITE_REVOKED" });
    await expect(staff.setStatus(actorOf(owner.session), owner.session.staffId!, "disabled")).rejects.toMatchObject({ code: "LAST_SUPER_ADMIN" });
  });

  it("requires a second factor after the authenticator is confirmed", async () => {
    const { auth, staff } = await setup();
    const owner = await login(auth, "owner", "operator-pass");
    const started = await staff.beginTotp(owner.session.staffId!, "operator-pass");
    const confirmed = await staff.confirmTotp(owner.session.staffId!, currentTotp(started.secret));
    expect(confirmed.recoveryCodes).toHaveLength(8);
    const again = await auth.login(headers, { password: "operator-pass", username: "owner" });
    expect(again.totpRequired).toBe(true);
    if (!again.totpRequired) return;
    const finished = await auth.completeTotp(headers, { challenge: again.challenge, code: currentTotp(started.secret) });
    expect(finished.session.username).toBe("owner");
    const recovered = await auth.login(headers, { password: "operator-pass", username: "owner" });
    if (!recovered.totpRequired) throw new Error("second factor missing");
    const withCode = await auth.completeTotp(headers, { challenge: recovered.challenge, code: confirmed.recoveryCodes[0]! });
    expect(withCode.session.staffId).toBe(owner.session.staffId);
    const replacement = await staff.beginTotp(owner.session.staffId!, "operator-pass", currentTotp(started.secret));
    const during = await auth.login(headers, { password: "operator-pass", username: "owner" });
    if (!during.totpRequired) throw new Error("old authenticator should stay valid");
    await auth.completeTotp(headers, { challenge: during.challenge, code: currentTotp(started.secret) });
    await staff.confirmTotp(owner.session.staffId!, currentTotp(replacement.secret));
    const switched = await auth.login(headers, { password: "operator-pass", username: "owner" });
    if (!switched.totpRequired) throw new Error("new authenticator missing");
    await auth.completeTotp(headers, { challenge: switched.challenge, code: currentTotp(replacement.secret) });
  });

  it("bounds second-factor failures and grants a single session for a concurrently completed challenge", async () => {
    const passwordHash = await hashPassword("staff-password", cheap);
    const auth = new SiteAuth({ username: "owner", passwordHash, publicOrigin: headers.origin });
    const verify = vi.fn(async (_id: string, _code: string) => false);
    const recordLogin = vi.fn(async () => {});
    auth.setStaffDirectory({
      findByUsername: async (username) => ({ id: "staff", username, passwordHash, status: "active", permissions: [], totpEnabled: true }),
      verifySecondFactor: verify, recordLogin,
    });
    const challenge = async () => {
      const result = await auth.login(headers, { username: "staff", password: "staff-password" });
      if (!result.totpRequired) throw new Error("Expected second factor");
      return result.challenge;
    };
    const first = await challenge();
    for (let n = 0; n < 5; n++) {
      await expect(auth.completeTotp(headers, { challenge: first, code: "test-code" })).rejects.toMatchObject({ status: 401 });
    }
    verify.mockResolvedValue(true);
    await expect(auth.completeTotp(headers, { challenge: first, code: "test-code" })).rejects.toMatchObject({ status: 401 });
    expect(verify).toHaveBeenCalledTimes(5);
    const next = await challenge();
    verify.mockResolvedValueOnce(false);
    await expect(auth.completeTotp(headers, { challenge: next, code: "test-code" })).rejects.toMatchObject({ status: 401 });
    const complete = () => auth.completeTotp(headers, { challenge: next, code: "test-code" });
    const results = await Promise.allSettled([complete(), complete()]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    await expect(complete()).rejects.toMatchObject({ status: 401 });
    expect(verify).toHaveBeenCalledTimes(7);
    expect(recordLogin).toHaveBeenCalledTimes(1);
  });
});

describe("staff and creator login compatibility", () => {
  it.each(["pending", "disabled", "active"] as const)("keeps the creator login when historical staff is %s", async status => {
    const creatorHash = await hashPassword("creator-secret", cheap);
    const staffHash = await hashPassword("staff-secret", cheap);
    const auth = new SiteAuth({ username: "shared", passwordHash: staffHash, publicOrigin: headers.origin }, {
      creators: { findActiveByUsername: async () => ({ id: "creator-id", username: "shared", passwordHash: creatorHash }) },
    });
    auth.setStaffDirectory({
      findByUsername: async () => ({ id: "staff-id", username: "shared", status, passwordHash: status === "pending" ? null : staffHash,
        permissions: ["manage_staff"], totpEnabled: true }),
      recordLogin: async () => {}, verifySecondFactor: async () => false,
    });
    expect((await login(auth, "shared", "creator-secret")).session).toMatchObject({ role: "creator", staffId: null, permissions: [] });
    const staffLogin = auth.login(headers, { username: "shared", password: "staff-secret" });
    if (status === "active") expect(await staffLogin).toMatchObject({ totpRequired: true, cookies: [] });
    else await expect(staffLogin).rejects.toMatchObject({ status: 401 });
    await expect(auth.login(headers, { username: "shared", password: "invalid" })).rejects.toMatchObject({ status: 401 });
  });

  it("uses only the creator identity if the two historical passwords are identical", async () => {
    const hash = await hashPassword("same-password", cheap);
    const auth = new SiteAuth({ username: "env", passwordHash: hash, publicOrigin: headers.origin }, {
      creators: { findActiveByUsername: async () => ({ id: "creator-id", username: "shared", passwordHash: hash }) },
    });
    auth.setStaffDirectory({
      findByUsername: async () => ({ id: "staff-id", username: "shared", status: "active", passwordHash: hash,
        permissions: ["manage_staff"], totpEnabled: false }),
      recordLogin: async () => {}, verifySecondFactor: async () => false,
    });
    expect((await login(auth, "shared", "same-password")).session).toMatchObject({ role: "creator", accountId: "creator-id", staffId: null });
  });

  it("rejects a password beyond the login limit and protects an established authenticator", async () => {
    const { auth, staff } = await setup();
    const owner = await login(auth, "owner", "operator-pass");
    const id = owner.session.staffId!;
    await expect(staff.changePassword(id, "operator-pass", "x".repeat(1025))).rejects.toMatchObject({ code: "PASSWORD_INVALID" });
    const { secret } = await staff.beginTotp(id, "operator-pass");
    const { recoveryCodes } = await staff.confirmTotp(id, currentTotp(secret));
    await expect(staff.beginTotp(id, "operator-pass")).rejects.toMatchObject({ code: "REAUTH_REQUIRED" });
    const verify = () => staff.loginDirectory().verifySecondFactor(id, recoveryCodes[0]!);
    expect((await Promise.all([verify(), verify()])).sort()).toEqual([false, true]);
  });
});

it("does not report a password change or reopen the session if the account was disabled while hashing", async () => {
  const { auth, staff, audits, repository } = await setup();
  const owner = await login(auth, "owner", "operator-pass");
  const id = owner.session.staffId!;
  const before = (await repository.getStaff(id))!;
  const write = repository.changePassword.bind(repository);
  vi.spyOn(repository, "changePassword").mockImplementationOnce(async (staffId, previous, next) => {
    await repository.updateManagement(staffId, before.permissionVersion, { status: "disabled" });
    auth.syncStaff(staffId, { status: "disabled", permissions: [] });
    return write(staffId, previous, next);
  });
  await expect(staff.changePassword(id, "operator-pass", "next-password")).rejects.toMatchObject({ code: "STAFF_CHANGED" });
  expect(await repository.getStaff(id)).toMatchObject({ status: "disabled", passwordHash: before.passwordHash });
  expect(audits.some(entry => entry.includes("修改密码"))).toBe(false);
  expect(() => auth.session(cookieHeader(owner.cookies))).toThrow();
});
