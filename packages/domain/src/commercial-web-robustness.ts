/**
 * Pre-public commercial robustness (phase 5): session-expiry progress retention,
 * unconfirmed/expired paid clicks are not billed failures, and unreviewed drafts
 * must never be presented as publishable or one-click external publish.
 *
 * Browser-safe: no node:fs. Import via `@ai-drama/domain/commercial-web-robustness`.
 */

/** Labels that must never appear as a publish CTA on creator pages. */
export const EXTERNAL_PLATFORM_PUBLISH_FORBIDDEN_LABELS = [
  "一键发布",
  "发布到红果",
  "发布到抖音",
  "自动发布到红果",
  "自动发布到抖音",
  "自动外发",
] as const;

/**
 * Completed auto-creation headline. Machine pass is never worded as ready to publish.
 */
export function formatAutoCreationCompletedHeadline(
  quality: "passed" | "needs_work" | "pending" | string,
): string {
  if (quality === "passed") return "剧本包已完成（机器检查通过，仍需人工审核）";
  return "剧本包已完成（待完善）";
}

/**
 * Status-line note: machine checks, storyboard keep, and voice preview selection
 * are not human review and do not unlock publishing.
 */
export function formatUnreviewedDraftNotPublishableNote(): string {
  return "机器检查通过、分镜「保留」或配音试听选用，都不等于人工审核通过，也不能当作可发布成品。本页不提供一键发布到红果、抖音或其他外部平台。";
}

/**
 * Creator UI must never treat these signals as a publishable affordance.
 * External platform auto-publish is out of product scope for this phase.
 */
export function draftShowsPublishableAffordance(input: {
  humanReviewApproved?: boolean;
  machineQualityPassed?: boolean;
  storyboardKept?: boolean;
  voicePreviewSelected?: boolean;
}): boolean {
  void input;
  return false;
}

/** Automatic publishing to Hongguo, Douyin, or any other external platform is disabled. */
export function externalPlatformAutoPublishEnabled(): boolean {
  return false;
}

/**
 * A click that never received fee confirmation (or whose session was already invalid)
 * is not a billed failure and must not be auto-retried as one.
 */
export function unconfirmedOrExpiredPaidClickIsBilledFailure(): boolean {
  return false;
}

/** Fee unknown or not yet confirmed → do not auto-resend paid generation/revise. */
export function mayAutoResendWhenFeeUnknownOrUnconfirmed(): boolean {
  return false;
}

/**
 * Login expiry must keep already-saved tab recovery data so re-login can return
 * to the same auto-creation / workbench state. Explicit logout may clear drafts.
 */
export function sessionExpiryShouldRetainSavedProgress(): boolean {
  return true;
}

/** sessionStorage key prefixes retained across AUTH_SESSION_EXPIRED (not cleared by goToLogin). */
export const SESSION_EXPIRY_RETAINED_PROGRESS_PREFIXES = [
  "auto-creation:",
  "auto-creation:start",
  "auto-creation:resume:",
  "auto-creation:user-revise:",
  "ads-workbench-draft:",
  "ads.real-media.pending.v1",
  "ads.storyboard.image-batch.v1:",
] as const;
