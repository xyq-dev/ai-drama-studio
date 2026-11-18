import { describe, expect, it } from "vitest";
import {
  draftShowsPublishableAffordance,
  EXTERNAL_PLATFORM_PUBLISH_FORBIDDEN_LABELS,
  externalPlatformAutoPublishEnabled,
  formatAutoCreationCompletedHeadline,
  formatUnreviewedDraftNotPublishableNote,
  mayAutoResendWhenFeeUnknownOrUnconfirmed,
  SESSION_EXPIRY_RETAINED_PROGRESS_PREFIXES,
  sessionExpiryShouldRetainSavedProgress,
  unconfirmedOrExpiredPaidClickIsBilledFailure,
} from "./commercial-web-robustness";

describe("commercial-web-robustness (phase 5)", () => {
  it("worded completed headlines still require human review after machine pass", () => {
    const passed = formatAutoCreationCompletedHeadline("passed");
    expect(passed).toContain("机器检查通过");
    expect(passed).toContain("仍需人工审核");
    expect(passed).not.toMatch(/可发布|一键发布|已审核通过/);
    expect(formatAutoCreationCompletedHeadline("needs_work")).toBe("剧本包已完成（待完善）");
  });

  it("never presents machine pass, keep, or voice select as publishable", () => {
    expect(draftShowsPublishableAffordance({
      machineQualityPassed: true,
      storyboardKept: true,
      voicePreviewSelected: true,
      humanReviewApproved: false,
    })).toBe(false);
    // Even after human review, this product does not offer external publish affordances.
    expect(draftShowsPublishableAffordance({ humanReviewApproved: true })).toBe(false);
    const note = formatUnreviewedDraftNotPublishableNote();
    expect(note).toContain("不等于人工审核通过");
    expect(note).toContain("不能当作可发布成品");
    expect(note).toContain("不提供一键发布到红果、抖音");
  });

  it("disables automatic external platform publish", () => {
    expect(externalPlatformAutoPublishEnabled()).toBe(false);
    expect(EXTERNAL_PLATFORM_PUBLISH_FORBIDDEN_LABELS).toEqual(expect.arrayContaining([
      "一键发布", "发布到红果", "发布到抖音", "自动外发",
    ]));
  });

  it("treats unconfirmed or expired paid clicks as non-billed and non-auto-resend", () => {
    expect(unconfirmedOrExpiredPaidClickIsBilledFailure()).toBe(false);
    expect(mayAutoResendWhenFeeUnknownOrUnconfirmed()).toBe(false);
  });

  it("requires session expiry to retain saved progress prefixes", () => {
    expect(sessionExpiryShouldRetainSavedProgress()).toBe(true);
    expect(SESSION_EXPIRY_RETAINED_PROGRESS_PREFIXES).toEqual(expect.arrayContaining([
      "auto-creation:",
      "ads-workbench-draft:",
      "ads.real-media.pending.v1",
    ]));
  });
});
