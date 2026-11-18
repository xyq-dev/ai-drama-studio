import { describe, expect, it } from "vitest";
import type { RealMediaConfiguration } from "@ai-drama/contracts";
import {
  AUTO_CREATION_OPENAI_IMAGE_PROVIDER,
  diagnoseAutoStoryboardImageGaps,
  formatAutoStoryboardImageConnectionNote,
  formatAutoStoryboardKeepIsNotReviewNote,
  isAutoStoryboardImageConnected,
  resolveAutoCreationMediaOptions,
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

describe("auto-creation media capability (phase 2)", () => {
  it("reports disconnected when provider, key, or sunburst config is missing", () => {
    expect(isAutoStoryboardImageConnected({
      imageProvider: undefined, mediaApiKeyPresent: false, configuration: null,
    })).toBe(false);
    const gaps = diagnoseAutoStoryboardImageGaps({
      imageProvider: "dashscope-media", mediaApiKeyPresent: false, configuration: null,
    });
    expect(gaps.some((item) => item.includes("REAL_MEDIA_IMAGE_PROVIDER"))).toBe(true);
    expect(gaps.some((item) => item.includes("OPENAI_MEDIA_API_KEY"))).toBe(true);
    expect(gaps.some((item) => item.includes("gpt-image-2.5-sunburst"))).toBe(true);
    expect(gaps.join("\n")).toContain("不是写作 OPENAI_API_KEY");
    expect(gaps.join("\n")).not.toMatch(/sk-|api[_-]?key\s*=/i);

    const media = resolveAutoCreationMediaOptions({
      imageProvider: undefined, mediaApiKeyPresent: false, configuration: null,
    });
    expect(media).toMatchObject({ realProviders: [], mockOnly: true });
    expect(media.missing.some((item) => item.includes("语音"))).toBe(true);
    expect(media.missing.some((item) => item.includes("视频"))).toBe(true);
  });

  it("marks openai-media connected only for an enabled sunburst configuration", () => {
    const connected = resolveAutoCreationMediaOptions({
      imageProvider: AUTO_CREATION_OPENAI_IMAGE_PROVIDER,
      mediaApiKeyPresent: true,
      configuration: sunburst(),
    });
    expect(connected).toEqual({
      realProviders: [AUTO_CREATION_OPENAI_IMAGE_PROVIDER],
      mockOnly: false,
      missing: expect.arrayContaining([
        expect.stringContaining("语音"),
        expect.stringContaining("视频"),
        expect.stringContaining("剧本拆解"),
      ]),
    });
    expect(connected.missing.every((item) => !item.includes("OpenAI 生图未接通"))).toBe(true);
    expect(isAutoStoryboardImageConnected({
      imageProvider: AUTO_CREATION_OPENAI_IMAGE_PROVIDER,
      mediaApiKeyPresent: true,
      configuration: sunburst(),
    })).toBe(true);

    expect(isAutoStoryboardImageConnected({
      imageProvider: AUTO_CREATION_OPENAI_IMAGE_PROVIDER,
      mediaApiKeyPresent: true,
      configuration: sunburst({ model: "gpt-image-2.5-flare" }),
    })).toBe(false);
    expect(isAutoStoryboardImageConnected({
      imageProvider: AUTO_CREATION_OPENAI_IMAGE_PROVIDER,
      mediaApiKeyPresent: true,
      configuration: sunburst({ providerKey: "dashscope-media", model: "qwen-image-3.0", currency: "CNY" }),
    })).toBe(false);
    expect(isAutoStoryboardImageConnected({
      imageProvider: AUTO_CREATION_OPENAI_IMAGE_PROVIDER,
      mediaApiKeyPresent: true,
      configuration: sunburst({ unitPrice: "0" }),
    })).toBe(false);
  });

  it("keeps start-page and keep≠review copy honest", () => {
    expect(formatAutoStoryboardImageConnectionNote(false)).toContain("还没有接通 OpenAI 生图");
    expect(formatAutoStoryboardImageConnectionNote(false)).toContain("仍可勾选");
    expect(formatAutoStoryboardImageConnectionNote(true)).toContain("已接通");
    expect(formatAutoStoryboardImageConnectionNote(true)).toContain("确认费用后才出图");
    const keep = formatAutoStoryboardKeepIsNotReviewNote();
    expect(keep).toContain("不等于分镜审核通过");
    expect(keep).toContain("未审核不得进入后续受控制作");
  });
});
