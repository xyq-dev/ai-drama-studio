import { describe, expect, it } from "vitest";
import {
  FEATURE_CAPABILITIES,
  featureChoiceBlock,
  featureDraftSaveSchema,
  featureTestRequestSchema,
  formatCost,
  formatUsage,
  officialVoiceRoute,
  storyboardProviderForVendor,
  sumPresentCost,
  sumPresentUsage,
  writingProviderForVendor,
} from "./feature-config";

describe("feature config catalog", () => {
  it("offers only connected, project-approved models and keeps official voice on MiniMax unless explicitly enabled", () => {
    expect(FEATURE_CAPABILITIES.writing.find((item) => item.vendor === "bailian")).toMatchObject({
      connected: true,
      models: [{ id: "qwen-plus", label: "通义千问 Plus" }],
    });
    expect(FEATURE_CAPABILITIES.storyboard.map((item) => item.vendor)).toEqual(["bailian", "openai", "google"]);
    expect(FEATURE_CAPABILITIES.storyboard.find((item) => item.vendor === "openai")?.models.map((item) => item.id)).toEqual(["gpt-image-2.5-sunburst"]);
    expect(FEATURE_CAPABILITIES.voice.find((item) => item.vendor === "minimax")?.models.map((item) => item.id)).toEqual(["speech-2.8-hd"]);
    expect(officialVoiceRoute(null)).toBe("minimax");
    expect(officialVoiceRoute("minimax")).toBe("minimax");
    expect(officialVoiceRoute("bailian")).toBe("bailian");
    expect(storyboardProviderForVendor("google")).toBeNull();
    expect(writingProviderForVendor("bailian")).toBe("bailian");
    expect(featureChoiceBlock({
      feature: "writing", vendor: "bailian", model: "qwen-plus", writingAllowlist: ["deepseek-flash"],
    }).ok).toBe(true);
  });

  it("blocks an unapproved model, an unconnected vendor, and an exhausted writing budget", () => {
    expect(featureChoiceBlock({ feature: "writing", vendor: "openai", model: "gpt-image-2.5-sunburst" }).ok).toBe(false);
    expect(featureChoiceBlock({ feature: "voice", vendor: "openai", model: "speech-2.8-hd" })).toMatchObject({ code: "FEATURE_VENDOR_UNCONNECTED" });
    expect(featureChoiceBlock({ feature: "storyboard", vendor: "google", model: "imagen" }).ok).toBe(false);
    expect(featureChoiceBlock({
      feature: "writing", vendor: "deepseek", model: "deepseek-flash", writingAllowlist: ["other-model"],
    })).toMatchObject({ code: "FEATURE_MODEL_NOT_APPROVED" });
    expect(featureChoiceBlock({
      feature: "writing", vendor: "deepseek", model: "deepseek-flash", writingCallsRemaining: 0,
    })).toMatchObject({ code: "FEATURE_BUDGET_BLOCKED" });
    expect(featureChoiceBlock({ feature: "storyboard", vendor: "bailian", model: "qwen-image-3.0", writingCallsRemaining: 0 }).ok).toBe(true);
    expect(featureDraftSaveSchema.safeParse({ expectedRevision: 0, vendor: "openai", model: "gpt-6-astra", secretAction: "keep", apiKey: "should-not" }).success).toBe(false);
    expect(featureTestRequestSchema.safeParse({ expectedRevision: 1, vendor: "openai", confirmCost: false }).success).toBe(false);
  });

  it("does not render unknown usage or cost as zero", () => {
    expect(formatUsage({ status: "unknown" })).toBe("未知");
    expect(formatUsage({ status: "pending" })).toBe("未知");
    expect(formatCost({ status: "pending" })).toBe("待回传费用");
    expect(formatCost({ status: "unknown" })).toBe("未知");
    expect(formatCost({ status: "estimated", rule: "目录价 × 1 次" })).toBe("估算 · 目录价 × 1 次");
    expect(sumPresentUsage([{ feature: "storyboard", usage: { status: "unknown" } }], "storyboard")).toBe("未知");
    expect(sumPresentCost([{ feature: "voice", cost: { status: "pending" } }], "voice")).toBe("待回传费用");
    expect(sumPresentUsage([
      { feature: "writing", usage: { status: "present", amount: 10, unit: "token" } },
      { feature: "writing", usage: { status: "present", amount: 5, unit: "token" } },
    ], "writing")).toBe("15 tokens");
  });
});
