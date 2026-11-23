import { describe, expect, it } from "vitest";
import {
  INVITE_TTL_MS,
  inviteUsability,
  inviteUsabilityMessage,
  lastSuperAdminAllows,
  sessionAllowsStaffPermission,
  staffPermissionsOf,
} from "./staff-access";

describe("staff access rules", () => {
  it("keeps built-in permission order and drops unknown names", () => {
    expect(staffPermissionsOf(["adjust_quota", "nope", "review_works", "review_works"])).toEqual([
      "review_works",
      "adjust_quota",
    ]);
  });

  it("lets an unbound operator through and a creator through nothing", () => {
    expect(sessionAllowsStaffPermission({
      role: "operator", staffId: null, permissions: [], required: "maintain_model_keys",
    })).toBe(true);
    expect(sessionAllowsStaffPermission({
      role: "creator", staffId: null, permissions: ["maintain_model_keys"], required: "maintain_model_keys",
    })).toBe(false);
  });

  it("uses the live list once the session is bound to a staff account", () => {
    expect(sessionAllowsStaffPermission({
      role: "operator", staffId: "s1", permissions: ["review_works"], required: "review_works",
    })).toBe(true);
    expect(sessionAllowsStaffPermission({
      role: "operator", staffId: "s1", permissions: ["review_works"], required: "maintain_model_keys",
    })).toBe(false);
    expect(sessionAllowsStaffPermission({
      role: "operator", staffId: "s1", permissions: ["review_works"], required: "adjust_quota",
    })).toBe(false);
  });

  it("expires an invite at 24 hours and distinguishes revoke from reuse", () => {
    const expiresAt = 1_000 + INVITE_TTL_MS;
    expect(inviteUsability({ now: expiresAt - 1, expiresAt, usedAt: null, revokedAt: null })).toBe("open");
    expect(inviteUsability({ now: expiresAt, expiresAt, usedAt: null, revokedAt: null })).toBe("expired");
    expect(inviteUsabilityMessage("expired")).toContain("24 小时");
    expect(inviteUsability({ now: expiresAt - 1, expiresAt, usedAt: null, revokedAt: 5 })).toBe("revoked");
    expect(inviteUsability({ now: expiresAt - 1, expiresAt, usedAt: 5, revokedAt: null })).toBe("used");
  });

  it("refuses to remove the last active super administrator", () => {
    expect(lastSuperAdminAllows({
      activeSuperAdminCount: 1, targetIsActiveSuperAdmin: true, remainsActiveSuperAdmin: false,
    }).ok).toBe(false);
    expect(lastSuperAdminAllows({
      activeSuperAdminCount: 2, targetIsActiveSuperAdmin: true, remainsActiveSuperAdmin: false,
    }).ok).toBe(true);
    expect(lastSuperAdminAllows({
      activeSuperAdminCount: 1, targetIsActiveSuperAdmin: true, remainsActiveSuperAdmin: true,
    }).ok).toBe(true);
  });
});
