import { describe, expect, it } from "vitest";
import type { RealMediaConfiguration } from "@ai-drama/contracts";
import {
  AUTO_CREATION_MINIMAX_TTS_PROVIDER,
  AUTO_CREATION_OPENAI_IMAGE_PROVIDER,
  AUTO_CREATION_VIDEO_PROVIDER,
  diagnoseAutoOfficialVideoGaps,
  diagnoseAutoOfficialVoiceGaps,
  diagnoseAutoStoryboardImageGaps,
  formatAutoCreationMediaDeliveryNote,
  formatAutoCreationVideoStatusNote,
  formatAutoOfficialVideoConnectionNote,
  formatAutoOfficialVoiceConnectionNote,
  formatAutoStoryboardImageConnectionNote,
  formatAutoStoryboardKeepIsNotReviewNote,
  isAutoOfficialVideoConnected,
  isAutoOfficialVoiceConnected,
  isAutoStoryboardImageConnected,
  isChineseVideoPrompt,
  resolveAutoCreationMediaOptions,
  type AutoOfficialVideoProbe,
  type AutoOfficialVoiceProbe,
} from "./auto-creation-media-capability";

function sunburst(overrides: Partial<RealMediaConfiguration> = {}): RealMediaConfiguration {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    version: "v1",
    providerKey: "openai-media",
    capability: "image.generate",
    model: "gpt-image-2.5-sunburst",
    region: "image.example.test",
    credentialRef: "env:openai-media",
    credentialVersion: "v1",
    enabled: true,
    queryAllowed: true,
    priceVersion: "fixture-v1",
    currency: "USD",
    unitPrice: "0.04",
    unitType: "image",
    parameters: { baseUrl: "https://image.example.test", quality: "max", size: "1024x1536" },
    ...overrides,
  };
}

function minimax(overrides: Partial<RealMediaConfiguration> = {}): RealMediaConfiguration {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    version: "mm-v1",
    providerKey: "minimax-tts",
    capability: "audio.tts",
    model: "speech-2.8-hd",
    region: "api.minimaxi.com",
    credentialRef: "env:minimax-tts",
    credentialVersion: "v1",
    enabled: true,
    queryAllowed: true,
    priceVersion: "fixture-v1",
    currency: "CNY",
    unitPrice: "0.0002",
    unitType: "character",
    maximumOperationAmount: "10",
    parameters: { baseUrl: "https://api.minimaxi.com", outputFormat: "wav", sampleRate: 44100, drySpeech: true },
    ...overrides,
  };
}

function wanVideo(overrides: Partial<RealMediaConfiguration> = {}): RealMediaConfiguration {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    version: "video-v1",
    providerKey: "dashscope-media",
    capability: "video.generate",
    model: "wan2.6-i2v-flash",
    region: "beijing",
    credentialRef: "env:dashscope-media",
    credentialVersion: "v1",
    enabled: true,
    queryAllowed: true,
    priceVersion: "fixture-v1",
    currency: "CNY",
    unitPrice: "0.05",
    unitType: "second",
    maximumOperationAmount: "10",
    parameters: { duration: 5 },
    ...overrides,
  };
}

function voiceProbe(overrides: Partial<AutoOfficialVoiceProbe> = {}): AutoOfficialVoiceProbe {
  return {
    minimaxApiKeyPresent: true,
    unitPricePresent: true,
    priceVersionPresent: true,
    baseUrlCompliant: true,
    configuration: minimax(),
    webPathAcceptsMinimax: true,
    ...overrides,
  };
}

function videoProbe(overrides: Partial<AutoOfficialVideoProbe> = {}): AutoOfficialVideoProbe {
  return {
    dashscopeApiKeyPresent: true,
    unitPricePresent: true,
    priceVersionPresent: true,
    configuration: wanVideo(),
    chinesePromptGateReady: true,
    characterReferenceGate: "legacy",
    shotComposeEnabled: true,
    episodeComposeEnabled: true,
    ...overrides,
  };
}

describe("auto-creation media capability (phase 2 image)", () => {
  it("reports disconnected when key or sunburst config is missing (process provider is not a hard gate)", () => {
    expect(isAutoStoryboardImageConnected({
      processImageProvider: undefined, mediaApiKeyPresent: false, configuration: null,
      openai: {
        providerKey: "openai-media", mediaApiKeyPresent: false, unitPricePresent: false,
        priceVersionPresent: false, configuration: null,
      },
      dashscope: {
        providerKey: "dashscope-media", mediaApiKeyPresent: false, unitPricePresent: false,
        priceVersionPresent: false, configuration: null,
      },
    })).toBe(false);
    const gaps = diagnoseAutoStoryboardImageGaps({
      processImageProvider: "dashscope-media", mediaApiKeyPresent: false, configuration: null,
      openai: {
        providerKey: "openai-media", mediaApiKeyPresent: false, unitPricePresent: false,
        priceVersionPresent: false, configuration: null,
      },
      dashscope: {
        providerKey: "dashscope-media", mediaApiKeyPresent: false, unitPricePresent: false,
        priceVersionPresent: false, configuration: null,
      },
    });
    // Process REAL_MEDIA_IMAGE_PROVIDER no longer blocks OpenAI as a selectable option.
    expect(gaps.some((item) => item.includes("REAL_MEDIA_IMAGE_PROVIDER"))).toBe(false);
    expect(gaps.some((item) => item.includes("OPENAI_MEDIA_API_KEY"))).toBe(true);
    expect(gaps.some((item) => item.includes("gpt-image-2.5-sunburst") || item.includes("尚未计价"))).toBe(true);
    expect(gaps.join("\n")).toContain("不是写作 OPENAI_API_KEY");
    expect(gaps.join("\n")).not.toMatch(/sk-|api[_-]?key\s*=/i);
  });

  it("marks openai-media connected only for an enabled sunburst configuration", () => {
    const openaiReady = {
      providerKey: "openai-media" as const, mediaApiKeyPresent: true, unitPricePresent: true,
      priceVersionPresent: true, configuration: sunburst(),
    };
    const dashscopeMissing = {
      providerKey: "dashscope-media" as const, mediaApiKeyPresent: false, unitPricePresent: false,
      priceVersionPresent: false, configuration: null,
    };
    const connected = resolveAutoCreationMediaOptions({
      processImageProvider: AUTO_CREATION_OPENAI_IMAGE_PROVIDER,
      openai: openaiReady,
      dashscope: dashscopeMissing,
    }, voiceProbe({ minimaxApiKeyPresent: false, configuration: null, webPathAcceptsMinimax: false }), videoProbe({
      dashscopeApiKeyPresent: false, configuration: null, shotComposeEnabled: false, episodeComposeEnabled: false,
    }));
    expect(connected.realProviders).toEqual([AUTO_CREATION_OPENAI_IMAGE_PROVIDER]);
    expect(connected.imageProviders).toHaveLength(2);
    expect(connected.imageProviders.find((item) => item.providerKey === "openai-media")).toMatchObject({
      connected: true, model: "gpt-image-2.5-sunburst", unitPrice: "0.04",
    });
    expect(connected.imageProviders.find((item) => item.providerKey === "dashscope-media")?.connected).toBe(false);
    expect(connected.mockOnly).toBe(false);
    expect(connected.missing.some((item) => item.includes("正式配音"))).toBe(true);
    expect(connected.missing.some((item) => item.includes("真实视频") || item.includes("成片"))).toBe(true);
    expect(connected.missing.every((item) => !item.includes("OpenAI 生图未接通"))).toBe(true);
    expect(isAutoStoryboardImageConnected({
      processImageProvider: AUTO_CREATION_OPENAI_IMAGE_PROVIDER,
      openai: openaiReady, dashscope: dashscopeMissing,
    })).toBe(true);

    expect(isAutoStoryboardImageConnected({
      processImageProvider: AUTO_CREATION_OPENAI_IMAGE_PROVIDER,
      openai: { ...openaiReady, configuration: sunburst({ model: "gpt-image-2.5-flare" }) },
      dashscope: dashscopeMissing,
    })).toBe(false);
    expect(isAutoStoryboardImageConnected({
      processImageProvider: AUTO_CREATION_OPENAI_IMAGE_PROVIDER,
      openai: { ...openaiReady, configuration: sunburst({ unitPrice: "0.04", maximumOperationAmount: "0.01" }) },
      dashscope: dashscopeMissing,
    })).toBe(false);
  });

  it("keeps start-page and keep≠review copy honest", () => {
    expect(formatAutoStoryboardImageConnectionNote(false)).toContain("还没有接通 OpenAI 生图");
    expect(formatAutoStoryboardImageConnectionNote(true)).toContain("确认费用后才出图");
    const keep = formatAutoStoryboardKeepIsNotReviewNote();
    expect(keep).toContain("不等于分镜审核通过");
  });
});

describe("auto-creation media capability (phase 3 voice + video)", () => {
  it("marks MiniMax connected only with key, price, compliant baseUrl, web path, and speech-2.8-hd", () => {
    expect(isAutoOfficialVoiceConnected(voiceProbe())).toBe(true);
    expect(diagnoseAutoOfficialVoiceGaps(voiceProbe({ minimaxApiKeyPresent: false })).join("\n"))
      .toContain("MINIMAX_API_KEY");
    expect(diagnoseAutoOfficialVoiceGaps(voiceProbe({ minimaxApiKeyPresent: false })).join("\n"))
      .toContain("不得用 ELEVENLABS_TTS_API_KEY");
    expect(diagnoseAutoOfficialVoiceGaps(voiceProbe({ unitPricePresent: false })).join("\n"))
      .toContain("尚未计价");
    expect(diagnoseAutoOfficialVoiceGaps(voiceProbe({ baseUrlCompliant: false })).join("\n"))
      .toContain("BASE_URL");
    expect(diagnoseAutoOfficialVoiceGaps(voiceProbe({ webPathAcceptsMinimax: false })).join("\n"))
      .toContain("网页主路径仍拒绝 minimax-tts");
    expect(diagnoseAutoOfficialVoiceGaps(voiceProbe({ configuration: minimax({ model: "speech-02-hd" }) })).join("\n"))
      .toContain("speech-2.8-hd");
    expect(diagnoseAutoOfficialVoiceGaps(voiceProbe({
      configuration: minimax({ unitPrice: "0.0002", maximumOperationAmount: "0.0001" }),
    })).join("\n")).toContain("单次费用上限");

    const media = resolveAutoCreationMediaOptions({
      image: { imageProvider: undefined, mediaApiKeyPresent: false, configuration: null },
      voice: voiceProbe(),
      video: videoProbe({ dashscopeApiKeyPresent: false, configuration: null, shotComposeEnabled: false, episodeComposeEnabled: false }),
    });
    expect(media.realProviders).toEqual([AUTO_CREATION_MINIMAX_TTS_PROVIDER]);
    expect(media.mockOnly).toBe(false);
    expect(media.missing.every((item) => !item.includes("正式配音未接通"))).toBe(true);
    expect(media.missing.some((item) => item.includes("真实视频") || item.includes("成片"))).toBe(true);
    expect(JSON.stringify(media)).not.toMatch(/sk-|api[_-]?key\s*=/i);
  });

  it("never treats Bailian or ElevenLabs config as official MiniMax voice", () => {
    expect(isAutoOfficialVoiceConnected(voiceProbe({
      configuration: minimax({ providerKey: "dashscope-media", model: "qwen3-tts-flash" }),
    }))).toBe(false);
    expect(isAutoOfficialVoiceConnected(voiceProbe({
      configuration: minimax({ providerKey: "elevenlabs-tts", model: "eleven_v4", currency: "USD" }),
    }))).toBe(false);
  });

  it("marks video + finished compose connected only for wan2.6 with Chinese gate and compose flags", () => {
    expect(isAutoOfficialVideoConnected(videoProbe())).toBe(true);
    expect(diagnoseAutoOfficialVideoGaps(videoProbe({ dashscopeApiKeyPresent: false })).join("\n"))
      .toContain("DASHSCOPE_MEDIA_API_KEY");
    expect(diagnoseAutoOfficialVideoGaps(videoProbe({ chinesePromptGateReady: false })).join("\n"))
      .toContain("中文");
    expect(diagnoseAutoOfficialVideoGaps(videoProbe({ configuration: wanVideo({ model: "wanx-v1" }) })).join("\n"))
      .toContain("wan2.6-i2v-flash");
    expect(diagnoseAutoOfficialVideoGaps(videoProbe({ shotComposeEnabled: false })).join("\n"))
      .toContain("镜头本地合成");
    expect(diagnoseAutoOfficialVideoGaps(videoProbe({ episodeComposeEnabled: false })).join("\n"))
      .toContain("整集本地合成/导出");
    // Cap must cover the full clip (unitPrice × duration), not only the per-second unit price.
    expect(diagnoseAutoOfficialVideoGaps(videoProbe({
      configuration: wanVideo({ unitPrice: "1", maximumOperationAmount: "2", parameters: { duration: 5 } }),
    })).join("\n")).toContain("整段时长估价");
    expect(isAutoOfficialVideoConnected(videoProbe({
      configuration: wanVideo({ unitPrice: "1", maximumOperationAmount: "5", parameters: { duration: 5 } }),
    }))).toBe(true);
    expect(diagnoseAutoOfficialVideoGaps(videoProbe({ characterReferenceGate: "strict" })).join("\n"))
      .toContain("M3_CHARACTER_REFERENCE_GATE=strict");

    const media = resolveAutoCreationMediaOptions({
      image: {
        processImageProvider: AUTO_CREATION_OPENAI_IMAGE_PROVIDER,
        mediaApiKeyPresent: true,
        configuration: sunburst(),
        openai: {
          providerKey: "openai-media", mediaApiKeyPresent: true, unitPricePresent: true,
          priceVersionPresent: true, configuration: sunburst(),
        },
        dashscope: {
          providerKey: "dashscope-media", mediaApiKeyPresent: true, unitPricePresent: true,
          priceVersionPresent: true,
          configuration: {
            id: "44444444-4444-4444-8444-444444444444", version: "qwen-v1", providerKey: "dashscope-media",
            capability: "image.generate", model: "qwen-image-3.0", region: "beijing",
            credentialRef: "env:dashscope-media", credentialVersion: "v1", enabled: true, queryAllowed: true,
            priceVersion: "fixture-v1", currency: "CNY", unitPrice: "0.18", unitType: "image",
            maximumOperationAmount: "10", parameters: {},
          },
        },
      },
      voice: voiceProbe(),
      video: videoProbe(),
    });
    expect(media.realProviders).toEqual([
      AUTO_CREATION_OPENAI_IMAGE_PROVIDER,
      AUTO_CREATION_MINIMAX_TTS_PROVIDER,
      AUTO_CREATION_VIDEO_PROVIDER,
    ]);
    expect(media.imageProviders.every((item) => item.connected)).toBe(true);
    expect(media.mockOnly).toBe(false);
    expect(media.missing).toEqual(["剧本拆解功能（服务端关闭，不会写入分镜生产数据）"]);
  });

  it("keeps delivery and status copy honest for connected and disconnected states", () => {
    expect(formatAutoOfficialVoiceConnectionNote(true)).toContain("确认费用后才生成");
    expect(formatAutoOfficialVoiceConnectionNote(false)).toContain("不会改走 ElevenLabs 或百炼");
    expect(formatAutoOfficialVideoConnectionNote(true, true)).toContain("成片导出前须再审核");
    expect(formatAutoOfficialVideoConnectionNote(false, false)).toContain("不会回退到演示素材");
    expect(isChineseVideoPrompt("镜头缓推，女主回眸。")).toBe(true);
    expect(isChineseVideoPrompt("slow push in on heroine")).toBe(false);

    const disconnected = resolveAutoCreationMediaOptions({
      imageProvider: undefined, mediaApiKeyPresent: false, configuration: null,
    });
    expect(formatAutoCreationMediaDeliveryNote(disconnected)).toContain("正式配音尚未接通");
    expect(formatAutoCreationMediaDeliveryNote(disconnected)).toContain("真实视频与成片尚未接通");
    expect(formatAutoCreationMediaDeliveryNote(disconnected)).not.toContain("配音、动态和成片不在本次任务内");
    expect(formatAutoCreationVideoStatusNote(disconnected)).toContain("尚未接通");
    expect(formatAutoCreationVideoStatusNote(resolveAutoCreationMediaOptions({
      image: { imageProvider: undefined, mediaApiKeyPresent: false, configuration: null },
      voice: voiceProbe(),
      video: videoProbe(),
    }))).toContain("配音与成片已接通");
  });
});
