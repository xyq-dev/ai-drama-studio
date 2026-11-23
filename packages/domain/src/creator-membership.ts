/**
 * Creator membership decisions. Prices and quotas are supplied by the caller.
 * Nothing here locks an RMB price, opens a payment, or grants staff permissions.
 */

export const MEMBERSHIP_FEATURES = ["writing", "image", "voice", "video"] as const;
export type MembershipFeature = (typeof MEMBERSHIP_FEATURES)[number];

export const MEMBERSHIP_FEATURE_LABELS: Record<MembershipFeature, string> = {
  writing: "编剧",
  image: "生图",
  voice: "配音",
  video: "视频",
};

export type MembershipDenialCode =
  | "MEMBERSHIP_REQUIRED"
  | "MEMBERSHIP_EXPIRED"
  | "MEMBERSHIP_DISABLED"
  | "FEATURE_NOT_INCLUDED"
  | "QUOTA_EXHAUSTED";

export function isMembershipFeature(value: string): value is MembershipFeature {
  return (MEMBERSHIP_FEATURES as readonly string[]).includes(value);
}

export function membershipDenialMessage(code: MembershipDenialCode, feature: MembershipFeature): string {
  const name = MEMBERSHIP_FEATURE_LABELS[feature];
  if (code === "MEMBERSHIP_REQUIRED") return `还没有开通会员，不能提交${name}。请联系管理员开通后再试。`;
  if (code === "MEMBERSHIP_EXPIRED") return `会员已到期，不能提交新的${name}。已完成的作品仍可查看。`;
  if (code === "MEMBERSHIP_DISABLED") return `会员已停用，不能提交新的${name}。已完成的作品仍可查看。`;
  if (code === "FEATURE_NOT_INCLUDED") return `当前套餐不包含${name}。`;
  return `${name}额度已用完，本次没有提交。`;
}

export interface MembershipWindow {
  status: "active" | "disabled";
  startsAt: number;
  endsAt: number;
}

export type QuotaHoldStatus = "held" | "committed" | "released" | "unknown";

export type ReserveDecision =
  | { action: "replay" }
  | { action: "hold" }
  | { action: "rehold" }
  | { action: "deny"; code: MembershipDenialCode };

/**
 * Same idempotency key never debits twice while the hold is still held, committed, or unknown.
 * A released hold may be taken again. Denial happens before any provider call.
 */
export function decideReserve(input: {
  now: number;
  membership: MembershipWindow | null;
  featureEnabled: boolean;
  remaining: number;
  units: number;
  existing: { status: QuotaHoldStatus } | null;
}): ReserveDecision {
  if (input.existing && input.existing.status !== "released") return { action: "replay" };
  if (!input.membership) return { action: "deny", code: "MEMBERSHIP_REQUIRED" };
  if (input.membership.status !== "active") return { action: "deny", code: "MEMBERSHIP_DISABLED" };
  if (input.now < input.membership.startsAt || input.now >= input.membership.endsAt) {
    return { action: "deny", code: "MEMBERSHIP_EXPIRED" };
  }
  if (!input.featureEnabled) return { action: "deny", code: "FEATURE_NOT_INCLUDED" };
  if (!Number.isFinite(input.remaining) || input.remaining < input.units) {
    return { action: "deny", code: "QUOTA_EXHAUSTED" };
  }
  if (input.existing?.status === "released") return { action: "rehold" };
  return { action: "hold" };
}

export function addCalendarMonths(start: Date, months: number): Date {
  const whole = Math.trunc(months);
  const next = new Date(start.getTime());
  const day = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + whole);
  const last = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, last));
  return next;
}

export function creatorAccountIdFromActor(actorId: string): string | null {
  if (!actorId.startsWith("creator:")) return null;
  const id = actorId.slice("creator:".length);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : null;
}

export function membershipStatusLabel(status: "none" | "active" | "expired" | "disabled"): string {
  if (status === "active") return "生效中";
  if (status === "expired") return "已到期";
  if (status === "disabled") return "已停用";
  return "未开通";
}
