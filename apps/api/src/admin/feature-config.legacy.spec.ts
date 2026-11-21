import { describe, expect, it } from "vitest";
import { legacyLiveFor, legacySecretFor, type LegacyMediaSnapshot, type LegacyModelSnapshot } from "./feature-config.legacy";

const models: LegacyModelSnapshot = {
  defaultProvider: "deepseek",
  providers: {
    deepseek: { apiKey: "synthetic-legacy-writing-key", models: ["deepseek-flash"] },
    openai: { apiKey: "synthetic-legacy-openai-writing", models: ["gpt-6-astra"] },
    anthropic: { apiKey: "synthetic-legacy-claude-key", models: ["claude-opus-5-5"] },
  },
};
const media: LegacyMediaSnapshot = {
  dashscopeApiKey: "synthetic-legacy-dashscope-media",
  openaiMediaApiKey: "synthetic-legacy-openai-media",
  minimaxApiKey: "synthetic-legacy-minimax-key",
};

describe("legacy feature credentials stay in their original slot", () => {
  it("does not copy the DashScope media key onto writing or voice", () => {
    expect(legacyLiveFor("writing", models, media)).toMatchObject({ vendor: "deepseek", model: "deepseek-flash" });
    expect(legacyLiveFor("storyboard", models, media)).toMatchObject({ vendor: "bailian", model: "qwen-image-3.0" });
    expect(legacyLiveFor("voice", models, media)).toMatchObject({ vendor: "minimax", model: "speech-2.8-hd" });
    expect(legacySecretFor("writing", "bailian", models, media)).toBeNull();
    expect(legacySecretFor("voice", "bailian", models, media)).toBeNull();
    expect(legacySecretFor("storyboard", "bailian", models, media)).toBe(media.dashscopeApiKey);
    expect(legacySecretFor("writing", "deepseek", models, media)).toBe("synthetic-legacy-writing-key");
    expect(legacySecretFor("voice", "minimax", models, media)).toBe(media.minimaxApiKey);
  });

  it("uses the OpenAI media key for storyboard only when DashScope is absent", () => {
    expect(legacyLiveFor("storyboard", models, { ...media, dashscopeApiKey: null })).toMatchObject({ vendor: "openai" });
    expect(legacyLiveFor("voice", null, { ...media, minimaxApiKey: null })).toBeNull();
  });
});
