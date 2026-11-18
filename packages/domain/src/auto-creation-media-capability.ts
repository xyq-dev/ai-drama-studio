import {
  isAutoStoryboardImageConfiguration,
  type RealMediaConfiguration,
} from "@ai-drama/contracts";

/**
 * Honest auto-creation media capability reporting (phase 2): OpenAI sunburst image only.
 * Voice and finished video stay disconnected until phase 3. Never treat writing OPENAI_API_KEY as media auth.
 */

export const AUTO_CREATION_OPENAI_IMAGE_PROVIDER = "openai-media" as const;

/** Voice / video remain phase 3; script breakdown stays listed until separately ready. */
export const AUTO_CREATION_MEDIA_PHASE3_MISSING = [
  "真实语音合成服务（当前只有演示素材）",
  "真实视频生成服务（当前只有演示素材）",
] as const;

export const AUTO_CREATION_SCRIPT_BREAKDOWN_MISSING =
  "剧本拆解功能（服务端关闭，不会写入分镜生产数据）";

const AMOUNT_SCALE = 100_000_000n;

/** Browser-safe amount units (same scale as realMediaAmountUnits; no node:crypto import). */
function amountUnits(value: string): bigint | null {
  if (!/^(0|[1-9]\d{0,7})(\.\d{1,8})?$/.test(value)) return null;
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * AMOUNT_SCALE + BigInt(fraction.padEnd(8, "0"));
}

/**
 * Same quote readiness gate as RealMediaService.autoStoryboardConfiguration (budget + origin/region),
 * after isAutoStoryboardImageConfiguration. Callers that also have providers should still require
 * canonicalOpenAiImageBaseUrl(url) === url.
 */
export function passesAutoStoryboardImageRuntimeGate(
  configuration: RealMediaConfiguration | null | undefined,
): configuration is RealMediaConfiguration {
  if (!isAutoStoryboardImageConfiguration(configuration)) return false;
  try {
    const url = String(configuration.parameters.baseUrl);
    const parsed = new URL(url);
    const limit = configuration.maximumOperationAmount ?? configuration.unitPrice;
    const limitUnits = amountUnits(limit);
    const priceUnits = amountUnits(configuration.unitPrice);
    return parsed.origin === url
      && parsed.protocol === "https:"
      && parsed.hostname === configuration.region
      && limitUnits !== null
      && priceUnits !== null
      && limitUnits >= priceUnits;
  } catch {
    return false;
  }
}

export interface AutoStoryboardImageProbe {
  /** Process `REAL_MEDIA_IMAGE_PROVIDER` (undefined when unset). */
  imageProvider: string | undefined;
  /** Whether process `OPENAI_MEDIA_API_KEY` is present (boolean only — never the secret). */
  mediaApiKeyPresent: boolean;
  /**
   * Enabled sunburst configuration that already passed DB enablement (or null).
   * Must not be inferred from writing `OPENAI_API_KEY`.
   */
  configuration: RealMediaConfiguration | null;
}

export type AutoCreationMediaOptions = {
  realProviders: string[];
  mockOnly: boolean;
  missing: string[];
};

/** Gaps that keep OpenAI storyboard images disconnected. Empty means connected. */
export function diagnoseAutoStoryboardImageGaps(probe: AutoStoryboardImageProbe): string[] {
  const gaps: string[] = [];
  if (probe.imageProvider !== AUTO_CREATION_OPENAI_IMAGE_PROVIDER) {
    gaps.push("OpenAI 生图未接通：REAL_MEDIA_IMAGE_PROVIDER 不是 openai-media");
  }
  if (!probe.mediaApiKeyPresent) {
    gaps.push("OpenAI 生图未接通：缺少 OPENAI_MEDIA_API_KEY（媒体密钥，不是写作 OPENAI_API_KEY）");
  }
  if (!isAutoStoryboardImageConfiguration(probe.configuration)) {
    gaps.push(
      "OpenAI 生图未接通：缺少启用中的 gpt-image-2.5-sunburst 配置（需 quality=max、size=1024x1536、USD 单价快照）",
    );
  } else if (!passesAutoStoryboardImageRuntimeGate(probe.configuration)) {
    gaps.push("OpenAI 生图未接通：单次费用上限低于单价，或 baseUrl/region 与报价门槛不一致");
  }
  return gaps;
}

/** True only when provider, media key, and sunburst config all pass the storyboard gate. */
export function isAutoStoryboardImageConnected(probe: AutoStoryboardImageProbe): boolean {
  return diagnoseAutoStoryboardImageGaps(probe).length === 0;
}

/**
 * Options.media for the auto-creation start page.
 * Connected → `openai-media` in realProviders and mockOnly false; voice/video stay in missing.
 */
export function resolveAutoCreationMediaOptions(probe: AutoStoryboardImageProbe): AutoCreationMediaOptions {
  const imageGaps = diagnoseAutoStoryboardImageGaps(probe);
  const connected = imageGaps.length === 0;
  const missing = [
    ...(connected ? [] : imageGaps),
    ...AUTO_CREATION_MEDIA_PHASE3_MISSING,
    AUTO_CREATION_SCRIPT_BREAKDOWN_MISSING,
  ];
  return {
    realProviders: connected ? [AUTO_CREATION_OPENAI_IMAGE_PROVIDER] : [],
    mockOnly: !connected,
    missing,
  };
}

/** Start-page line next to the storyboard checkbox. */
export function formatAutoStoryboardImageConnectionNote(connected: boolean): string {
  return connected
    ? "OpenAI 生图已接通（gpt-image-2.5-sunburst）。勾选只表示之后自动打开报价，确认费用后才出图。"
    : "还没有接通 OpenAI 生图。仍可勾选（表示将来审核并备好镜头后打开报价），但在填写媒体密钥并完成部署之前不能出图。";
}

/** 「保留」 means keep that image draft — not storyboard-review approval. */
export function formatAutoStoryboardKeepIsNotReviewNote(): string {
  return "「保留」只表示保留该图，不等于分镜审核通过；未审核不得进入后续受控制作。";
}
