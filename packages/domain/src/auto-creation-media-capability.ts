import {
  isAutoStoryboardImageConfiguration,
  type RealMediaConfiguration,
} from "@ai-drama/contracts";

/**
 * Honest auto-creation media capability reporting (phase 2–3).
 * OpenAI sunburst image, MiniMax speech-2.8-hd, DashScope wan2.6 video, and local compose/export.
 * Never treat writing OPENAI_API_KEY, ELEVENLABS_TTS_API_KEY, or Bailian TTS as official voice auth.
 */

export const AUTO_CREATION_OPENAI_IMAGE_PROVIDER = "openai-media" as const;
export const AUTO_CREATION_MINIMAX_TTS_PROVIDER = "minimax-tts" as const;
export const AUTO_CREATION_VIDEO_PROVIDER = "dashscope-media" as const;
export const AUTO_CREATION_OFFICIAL_TTS_MODEL = "speech-2.8-hd" as const;
export const AUTO_CREATION_OFFICIAL_VIDEO_MODEL = "wan2.6-i2v-flash" as const;

/**
 * @deprecated Phase 3 reports concrete gaps instead of these hard-coded demo strings.
 * Kept only so older callers that still reference the labels can be updated.
 */
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

/**
 * Budget / unit-price gate shared by MiniMax TTS and DashScope video quotes.
 * For `unitType=second` (video), compare the cap against unitPrice × configured duration —
 * the same estimate RealMediaStore.createQuote uses — not the bare per-second price.
 */
export function passesOfficialMediaPriceGate(
  configuration: RealMediaConfiguration | null | undefined,
): configuration is RealMediaConfiguration {
  if (!configuration?.enabled) return false;
  const limit = configuration.maximumOperationAmount ?? configuration.unitPrice;
  const limitUnits = amountUnits(limit);
  const priceUnits = amountUnits(configuration.unitPrice);
  if (priceUnits === null || priceUnits <= 0n || limitUnits === null) return false;
  if (configuration.unitType === "second") {
    const duration = Number(configuration.parameters.duration ?? 5);
    if (!Number.isInteger(duration) || duration < 1 || duration > 100_000) return false;
    return limitUnits >= priceUnits * BigInt(duration);
  }
  return limitUnits >= priceUnits;
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

/**
 * Official MiniMax speech-2.8-hd probe. Key may only be MINIMAX_API_KEY.
 * Never treat ELEVENLABS_TTS_API_KEY, writing OPENAI_API_KEY, or Bailian TTS as a substitute.
 */
export interface AutoOfficialVoiceProbe {
  minimaxApiKeyPresent: boolean;
  unitPricePresent: boolean;
  priceVersionPresent: boolean;
  /** False when MINIMAX_TTS_BASE_URL is set but fails canonical MiniMax origin rules. */
  baseUrlCompliant: boolean;
  /**
   * Enabled speech-2.8-hd configuration from minimaxTtsConfiguration() that passed DB enablement.
   * Null when the runtime closed the configuration (missing key/price/baseUrl/model).
   */
  configuration: RealMediaConfiguration | null;
  /**
   * True only when the website speech catalog/quote/generate path accepts minimax-tts
   * (not the Bailian configurationFor("audio.tts") path, and not assertRealMediaInput rejection).
   */
  webPathAcceptsMinimax: boolean;
}

/** Official DashScope wan2.6-i2v-flash video + local compose/export for finished video. */
export interface AutoOfficialVideoProbe {
  dashscopeApiKeyPresent: boolean;
  unitPricePresent: boolean;
  priceVersionPresent: boolean;
  /** Enabled wan2.6-i2v-flash configuration that passed DB enablement (or null). */
  configuration: RealMediaConfiguration | null;
  /** Code enforces Chinese video prompts before quote/submit. */
  chinesePromptGateReady: boolean;
  /**
   * Process `M3_CHARACTER_REFERENCE_GATE`. Strict mode rejects video.generate in RealMediaService
   * and the worker; must not advertise video as connected.
   */
  characterReferenceGate: "legacy" | "strict";
  /** Local shot compose path is switched on (same conditions as /providers/capabilities). */
  shotComposeEnabled: boolean;
  /** Local episode compose / export path is switched on. */
  episodeComposeEnabled: boolean;
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

/** Gaps that keep official MiniMax voice disconnected. Empty means connected. */
export function diagnoseAutoOfficialVoiceGaps(probe: AutoOfficialVoiceProbe): string[] {
  const gaps: string[] = [];
  if (!probe.minimaxApiKeyPresent) {
    gaps.push("正式配音未接通：缺少 MINIMAX_API_KEY（不得用 ELEVENLABS_TTS_API_KEY、写作 OPENAI_API_KEY 或百炼 TTS 替补）");
  }
  if (!probe.unitPricePresent) {
    gaps.push("正式配音未接通：缺少已冻结的 MINIMAX_TTS_PRICE_CHARACTER 单价快照（尚未计价，不能显示为 0）");
  }
  if (!probe.priceVersionPresent) {
    gaps.push("正式配音未接通：缺少 REAL_MEDIA_PRICE_VERSION");
  }
  if (!probe.baseUrlCompliant) {
    gaps.push("正式配音未接通：MINIMAX_TTS_BASE_URL 不合规（须为 https MiniMax 源站，不能指向 ElevenLabs/DashScope/OpenAI）");
  }
  if (!probe.webPathAcceptsMinimax) {
    gaps.push("正式配音未接通：网页主路径仍拒绝 minimax-tts（仍走百炼或 Worker 拒绝官方路径）");
  }
  const config = probe.configuration;
  if (
    !config
    || config.providerKey !== AUTO_CREATION_MINIMAX_TTS_PROVIDER
    || config.model !== AUTO_CREATION_OFFICIAL_TTS_MODEL
    || config.capability !== "audio.tts"
    || !config.enabled
  ) {
    gaps.push("正式配音未接通：缺少启用中的 MiniMax speech-2.8-hd（provider minimax-tts）配置");
  } else if (!passesOfficialMediaPriceGate(config)) {
    gaps.push("正式配音未接通：单次费用上限低于单价，或单价快照无法核实");
  }
  return [...new Set(gaps)];
}

export function isAutoOfficialVoiceConnected(probe: AutoOfficialVoiceProbe): boolean {
  return diagnoseAutoOfficialVoiceGaps(probe).length === 0;
}

/** Gaps for official video generation and finished-video compose/export. */
export function diagnoseAutoOfficialVideoGaps(probe: AutoOfficialVideoProbe): string[] {
  const gaps: string[] = [];
  if (!probe.dashscopeApiKeyPresent) {
    gaps.push("真实视频生成未接通：缺少 DASHSCOPE_MEDIA_API_KEY（填写密钥并部署前不能真实生成）");
  }
  if (!probe.unitPricePresent) {
    gaps.push("真实视频生成未接通：缺少已冻结的 DASHSCOPE_MEDIA_PRICE_VIDEO_SECOND 单价快照（尚未计价，不能显示为 0）");
  }
  if (!probe.priceVersionPresent) {
    gaps.push("真实视频生成未接通：缺少 REAL_MEDIA_PRICE_VERSION");
  }
  if (!probe.chinesePromptGateReady) {
    gaps.push("真实视频生成未接通：视频生成提示词尚未强制要求中文");
  }
  if (probe.characterReferenceGate === "strict") {
    gaps.push("真实视频生成未接通：M3_CHARACTER_REFERENCE_GATE=strict（固定首帧视频路径无法证明严格角色参考，报价与生成一律拒绝）");
  }
  const config = probe.configuration;
  if (
    !config
    || config.providerKey !== AUTO_CREATION_VIDEO_PROVIDER
    || config.model !== AUTO_CREATION_OFFICIAL_VIDEO_MODEL
    || config.capability !== "video.generate"
    || !config.enabled
  ) {
    gaps.push("真实视频生成未接通：缺少启用中的 wan2.6-i2v-flash（provider dashscope-media）配置");
  } else if (!passesOfficialMediaPriceGate(config)) {
    gaps.push("真实视频生成未接通：单次费用上限低于整段时长估价（单价×秒数），或单价快照无法核实");
  }
  if (!probe.shotComposeEnabled) {
    gaps.push("成片合成未接通：镜头本地合成未开启（填写配置并部署前不能真实合成）");
  }
  if (!probe.episodeComposeEnabled) {
    gaps.push("成片导出未接通：整集本地合成/导出未开启（填写配置并部署前不能真实导出）");
  }
  return gaps;
}

export function isAutoOfficialVideoConnected(probe: AutoOfficialVideoProbe): boolean {
  return diagnoseAutoOfficialVideoGaps(probe).length === 0;
}

/** True when video generate is ready even if compose/export still missing. */
export function isAutoOfficialVideoGenerateConnected(probe: AutoOfficialVideoProbe): boolean {
  return diagnoseAutoOfficialVideoGaps({
    ...probe,
    shotComposeEnabled: true,
    episodeComposeEnabled: true,
  }).length === 0;
}

export interface AutoCreationMediaProbes {
  image: AutoStoryboardImageProbe;
  voice: AutoOfficialVoiceProbe;
  video: AutoOfficialVideoProbe;
}

/**
 * Options.media for the auto-creation start page.
 * Connected providers appear in realProviders; missing lists concrete gaps only.
 */
export function resolveAutoCreationMediaOptions(
  imageOrProbes: AutoStoryboardImageProbe | AutoCreationMediaProbes,
  voice?: AutoOfficialVoiceProbe,
  video?: AutoOfficialVideoProbe,
): AutoCreationMediaOptions {
  const probes: AutoCreationMediaProbes = "image" in imageOrProbes && "voice" in imageOrProbes
    ? imageOrProbes
    : {
      image: imageOrProbes as AutoStoryboardImageProbe,
      voice: voice ?? {
        minimaxApiKeyPresent: false,
        unitPricePresent: false,
        priceVersionPresent: false,
        baseUrlCompliant: false,
        configuration: null,
        webPathAcceptsMinimax: false,
      },
      video: video ?? {
        dashscopeApiKeyPresent: false,
        unitPricePresent: false,
        priceVersionPresent: false,
        configuration: null,
        chinesePromptGateReady: false,
        characterReferenceGate: "legacy",
        shotComposeEnabled: false,
        episodeComposeEnabled: false,
      },
    };

  const imageGaps = diagnoseAutoStoryboardImageGaps(probes.image);
  const voiceGaps = diagnoseAutoOfficialVoiceGaps(probes.voice);
  const videoGaps = diagnoseAutoOfficialVideoGaps(probes.video);
  const realProviders: string[] = [];
  if (imageGaps.length === 0) realProviders.push(AUTO_CREATION_OPENAI_IMAGE_PROVIDER);
  if (voiceGaps.length === 0) realProviders.push(AUTO_CREATION_MINIMAX_TTS_PROVIDER);
  if (isAutoOfficialVideoGenerateConnected(probes.video)) realProviders.push(AUTO_CREATION_VIDEO_PROVIDER);

  return {
    realProviders,
    mockOnly: realProviders.length === 0,
    missing: [...imageGaps, ...voiceGaps, ...videoGaps, AUTO_CREATION_SCRIPT_BREAKDOWN_MISSING],
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

/** Start/result page line for official MiniMax voice. */
export function formatAutoOfficialVoiceConnectionNote(connected: boolean, missing: readonly string[] = []): string {
  if (connected) {
    return "正式配音已接通（MiniMax speech-2.8-hd）。选声后先报价，确认费用后才生成；试听选用不等于人工审核通过。";
  }
  const detail = missing.find((item) => item.includes("正式配音") || item.includes("语音") || item.includes("minimax"));
  return detail
    ? `${detail}。填写 MINIMAX_API_KEY 与单价并部署前不能真实配音；不会改走 ElevenLabs 或百炼。`
    : "还没有接通正式配音（MiniMax speech-2.8-hd）。填写密钥与单价并部署前不能真实配音；不会改走 ElevenLabs 或百炼。";
}

/** Start/result page line for video generate + finished compose/export. */
export function formatAutoOfficialVideoConnectionNote(
  videoGenerateConnected: boolean,
  finishedConnected: boolean,
  missing: readonly string[] = [],
): string {
  if (finishedConnected) {
    return "真实视频与成片已接通（wan2.6-i2v-flash + 本地合成/导出）。每步先报价，确认费用后才生成；角色与分镜审核前不能做视频，成片导出前须再审核。";
  }
  if (videoGenerateConnected) {
    const composeGap = missing.find((item) => item.includes("成片"));
    return composeGap
      ? `视频生成已接通（wan2.6-i2v-flash），但${composeGap.replace(/^成片/, "")}。提示词须为中文；不会回退到演示素材。`
      : "视频生成已接通（wan2.6-i2v-flash），成片合成/导出尚未接通。提示词须为中文；不会回退到演示素材。";
  }
  const detail = missing.find((item) => item.includes("真实视频") || item.includes("成片"));
  return detail
    ? `${detail}。填写密钥并部署前不能真实生成或导出；不会回退到演示素材或其他模型。`
    : "还没有接通真实视频与成片。填写密钥并部署前不能真实生成或导出；不会回退到演示素材或其他模型。";
}

/** Delivery summary on the start-page confirm list. */
export function formatAutoCreationMediaDeliveryNote(media: AutoCreationMediaOptions): string {
  const image = media.realProviders.includes(AUTO_CREATION_OPENAI_IMAGE_PROVIDER);
  const voice = media.realProviders.includes(AUTO_CREATION_MINIMAX_TTS_PROVIDER);
  const video = media.realProviders.includes(AUTO_CREATION_VIDEO_PROVIDER);
  const finished = !media.missing.some((item) => item.includes("成片合成") || item.includes("成片导出"));
  const parts = ["本次先交付故事正文和分集剧本", "分镜图另行报价确认"];
  if (voice) parts.push("正式配音已接通时可在网页选声、报价、确认后生成");
  else parts.push("正式配音尚未接通（见上方缺失项）");
  if (video && finished) parts.push("真实视频与成片已接通时可在审核后报价确认再生成/导出");
  else if (video) parts.push("真实视频生成已接通，成片合成/导出仍见缺失项");
  else parts.push("真实视频与成片尚未接通（见上方缺失项）");
  if (!image) parts.push("OpenAI 生图尚未接通时不能出图");
  return `${parts.join("。")}。`;
}

/** Result-page video/finished status — never claims publishable. */
export function formatAutoCreationVideoStatusNote(media: AutoCreationMediaOptions | null | undefined): string {
  if (!media) return "视频成片：未开始。之后可以去生成配音、动态和成片（仍须人工审核，机器检查通过不等于可发布）。";
  const voice = media.realProviders.includes(AUTO_CREATION_MINIMAX_TTS_PROVIDER);
  const video = media.realProviders.includes(AUTO_CREATION_VIDEO_PROVIDER);
  const finished = !media.missing.some((item) => item.includes("成片合成") || item.includes("成片导出"));
  if (voice && video && finished) {
    return "视频成片：未开始。配音与成片已接通；剧本须人工审核并写入分集，角色与分镜审核后才能视频生成，成片导出前须再审核。";
  }
  if (voice || video) {
    return "视频成片：未开始。部分媒体已接通，其余仍见开始页缺失项；未审核内容不得当作可发布。";
  }
  return "视频成片：未开始。正式配音与成片尚未接通；填写密钥并部署前不能真实生成或导出。";
}

/** Video prompts must include Chinese characters; English-only prompts are refused. */
export function isChineseVideoPrompt(text: string): boolean {
  return /[\u4e00-\u9fff]/u.test(text);
}
