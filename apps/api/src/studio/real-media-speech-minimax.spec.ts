import { describe, expect, it, vi } from "vitest";
import type { RealMediaConfiguration, SpeechGenerationInput } from "@ai-drama/contracts";
import { RealMediaService, type RealMediaServiceOptions } from "./real-media.service";

vi.mock("@ai-drama/database", async (importOriginal) => ({
  ...await importOriginal<typeof import("@ai-drama/database")>(),
  assertSpeechGenerationInputInTransaction: vi.fn(async () => undefined),
}));

const minimax: RealMediaConfiguration = {
  id: "mm-provider", version: "mm-v1", providerKey: "minimax-tts", capability: "audio.tts", model: "speech-2.8-hd",
  region: "api.minimaxi.com", credentialRef: "env:minimax-tts", credentialVersion: "v1", enabled: true, queryAllowed: true,
  priceVersion: "fixture-v1", currency: "CNY", unitPrice: "0.0002", unitType: "character", maximumOperationAmount: "10",
  parameters: { baseUrl: "https://api.minimaxi.com", outputFormat: "wav", sampleRate: 44100, drySpeech: true },
};

const voice = {
  id: "voice-rev", bindingId: "binding", contentHash: "c".repeat(64), catalogVoiceId: "minimax:female-shaonv",
  name: "少女", providerConfigurationId: minimax.id, providerConfigurationVersion: minimax.version,
  providerKey: "minimax-tts", model: "speech-2.8-hd", modelVersion: minimax.version, voiceId: "female-shaonv",
  locale: "zh-CN", rightsRef: "https://platform.minimaxi.com/",
  capabilities: { emotions: ["neutral"], speedMin: 1, speedMax: 1, maxTextCharacters: 2_000 },
} as SpeechGenerationInput["voice"];

const speech: SpeechGenerationInput = {
  workspaceId: "workspace", projectId: "project", shotRevisionId: "shot", planRevisionId: "plan",
  lineId: "line", lineInputRevisionId: "line-input", inputHash: "a".repeat(64),
  displayText: "你好。", spokenText: "你好。", voice, emotion: "neutral", speed: 1,
};

describe("real-media official MiniMax speech port", () => {
  it("quotes MiniMax speech-2.8-hd with minimaxSpeech and never falls back to Bailian or ElevenLabs", async () => {
    const createQuote = vi.fn(async () => ({
      quoteId: "quote", inputHash: speech.inputHash, currency: "CNY", estimatedAmount: "0.00040000",
      maximumAmount: "10", expiresAt: "2099-01-01T00:00:00Z", providerConfigurationId: minimax.id,
      providerConfigurationVersion: minimax.version, priceVersion: "fixture-v1", uncertainJobIds: [],
    }));
    const options = {
      workspaceId: "workspace", enabled: true,
      store: {
        receiptReady: () => true, requireReady: async () => undefined, createQuote,
        transaction: async (work: (client: unknown) => Promise<unknown>) => work({}),
      },
      jobs: { createAndQueueWorkflowJob: vi.fn() },
      assets: { prepareRealShotGenerationInTransaction: async () => ({ dialogue: speech.spokenText }) },
      configurationFor: async () => ({ ...minimax, providerKey: "dashscope-media", model: "qwen3-tts-flash" }),
      minimaxTtsConfigurationFor: async () => minimax,
      speechCatalog: async () => ({
        available: true, reasonCode: null, catalogVersion: "minimax-voices.v1",
        voices: [{ ...voice, id: undefined, bindingId: undefined, contentHash: undefined }],
      }),
    } as unknown as RealMediaServiceOptions;
    const port = new RealMediaService(options).speechPort();
    const quote = await port.quote(speech);
    expect(quote.quoteId).toBe("quote");
    expect(createQuote).toHaveBeenCalledWith(expect.objectContaining({
      frozen: expect.objectContaining({
        configuration: expect.objectContaining({ providerKey: "minimax-tts", model: "speech-2.8-hd" }),
        speech,
        minimaxSpeech: { schema: "minimax-tts.speech.v1", text: "你好。", voiceId: "female-shaonv" },
      }),
    }));
    const frozen = createQuote.mock.calls[0]![0].frozen;
    expect(frozen.configuration.providerKey).not.toBe("dashscope-media");
    expect(frozen.configuration.providerKey).not.toBe("elevenlabs-tts");
    expect(frozen.dialogue).toBeUndefined();
  });

  it("refuses speech quote when MiniMax is unavailable even if Bailian configurationFor exists", async () => {
    const createQuote = vi.fn();
    const options = {
      workspaceId: "workspace", enabled: true,
      store: { receiptReady: () => true, requireReady: async () => undefined, createQuote, transaction: async () => undefined },
      jobs: { createAndQueueWorkflowJob: vi.fn() },
      assets: {},
      configurationFor: async () => ({ ...minimax, providerKey: "dashscope-media", model: "qwen3-tts-flash", enabled: true }),
      minimaxTtsConfigurationFor: async () => null,
    } as unknown as RealMediaServiceOptions;
    await expect(new RealMediaService(options).speechPort().quote(speech)).rejects.toMatchObject({ code: "REAL_MEDIA_PROVIDER_DISABLED" });
    expect(createQuote).not.toHaveBeenCalled();
  });
});
