import { describe, expect, it } from "vitest";
import { hashPassword } from "../auth/password-hash";
import { SiteAuth } from "../auth/site-auth";
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
  return { auth, staff, audits };
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
  });
});
