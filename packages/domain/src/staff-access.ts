/**
 * Staff roles for the operator console. Browser-safe: no Node APIs.
 * A creator membership never grants any of these permissions.
 */

export const STAFF_PERMISSIONS = [
  "review_works",
  "manage_creators",
  "view_usage",
  "retry_paid",
  "maintain_model_keys",
  "probe_models",
  "enable_models",
  "grant_membership",
  "adjust_quota",
  "manage_staff",
] as const;

export type StaffPermission = (typeof STAFF_PERMISSIONS)[number];

export const STAFF_PERMISSION_LABELS: Record<StaffPermission, string> = {
  review_works: "审核作品",
  manage_creators: "管理创作者",
  view_usage: "查看用量",
  retry_paid: "付费重试",
  maintain_model_keys: "维护模型密钥",
  probe_models: "检测模型",
  enable_models: "启用模型",
  grant_membership: "开通会员",
  adjust_quota: "调整额度",
  manage_staff: "管理后台人员",
};

export const SUPER_ADMIN_ROLE_CODE = "super_admin";
export const OPS_ADMIN_ROLE_CODE = "ops_admin";

export const BUILTIN_STAFF_ROLES: readonly { code: string; name: string; permissions: readonly StaffPermission[] }[] = [
  { code: SUPER_ADMIN_ROLE_CODE, name: "超级管理员", permissions: STAFF_PERMISSIONS },
  {
    code: OPS_ADMIN_ROLE_CODE,
    name: "运营管理员",
    permissions: ["review_works", "manage_creators", "view_usage"],
  },
];

export const INVITE_TTL_MS = 24 * 60 * 60 * 1000;

export type StaffAccountStatus = "pending" | "active" | "disabled";

export function isStaffPermission(value: string): value is StaffPermission {
  return (STAFF_PERMISSIONS as readonly string[]).includes(value);
}

export function staffPermissionsOf(values: readonly string[]): StaffPermission[] {
  const seen = new Set<StaffPermission>();
  for (const value of values) {
    if (isStaffPermission(value)) seen.add(value);
  }
  return STAFF_PERMISSIONS.filter((permission) => seen.has(permission));
}

export function staffHasPermission(permissions: readonly string[] | null | undefined, permission: StaffPermission): boolean {
  return Boolean(permissions?.includes(permission));
}

/**
 * Legacy env operator sessions are not bound to a staff row yet and keep full access.
 * A bound staff session uses only the live permission list. Creators never pass.
 */
export function sessionAllowsStaffPermission(input: {
  role: "operator" | "creator";
  staffId: string | null;
  permissions: readonly string[];
  required: StaffPermission;
}): boolean {
  if (input.role !== "operator") return false;
  if (!input.staffId) return true;
  return staffHasPermission(input.permissions, input.required);
}

export function staffStatusLabel(status: StaffAccountStatus): string {
  if (status === "pending") return "待激活";
  if (status === "active") return "已启用";
  return "已停用";
}

export type InviteUsability = "open" | "expired" | "used" | "revoked";

export function inviteUsability(input: {
  now: number;
  expiresAt: number;
  usedAt: number | null;
  revokedAt: number | null;
}): InviteUsability {
  if (input.usedAt != null) return "used";
  if (input.revokedAt != null) return "revoked";
  if (input.now >= input.expiresAt) return "expired";
  return "open";
}

export function inviteUsabilityMessage(status: InviteUsability): string {
  if (status === "open") return "邀请仍然有效。";
  if (status === "expired") return "邀请已超过 24 小时，请联系管理员重新邀请。";
  if (status === "used") return "邀请已经使用过，不能再次设置密码。";
  return "邀请已撤销，请联系管理员重新邀请。";
}

/** Demoting or disabling must leave at least one active super administrator. */
export function lastSuperAdminAllows(input: {
  activeSuperAdminCount: number;
  targetIsActiveSuperAdmin: boolean;
  remainsActiveSuperAdmin: boolean;
}): { ok: true } | { ok: false; message: string } {
  if (input.targetIsActiveSuperAdmin && !input.remainsActiveSuperAdmin && input.activeSuperAdminCount <= 1) {
    return { ok: false, message: "必须保留至少一位可用的超级管理员。" };
  }
  return { ok: true };
}

export function permissionDeniedMessage(permission: StaffPermission): string {
  return `没有「${STAFF_PERMISSION_LABELS[permission]}」权限，请求已拒绝。`;
}
