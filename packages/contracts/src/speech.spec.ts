import { describe, expect, it } from "vitest";
import { speechGenerateSchema, speechMixRequestSchema, speechPlanPutSchema, speechVoiceSchema } from "./speech";

const id = "11111111-1111-4111-8111-111111111111";
describe("speech request boundaries", () => {
  it("rejects free pronunciation text, untrusted workspace and duplicate unknown controls", () => {
    const line = { lineId: id, speakerBindingRevisionId: id, sourceStart: 0, sourceEnd: 1, displayText: "你" };
    expect(speechPlanPutSchema.safeParse({ sourceDialogueHash: "a".repeat(64), lines: [{ ...line, spokenText: "另一段" }] }).success).toBe(false);
    expect(speechPlanPutSchema.safeParse({ sourceDialogueHash: "a".repeat(64), lines: [line], workspaceId: id }).success).toBe(false);
    expect(speechPlanPutSchema.parse({ sourceDialogueHash: "a".repeat(64), lines: [line] }).lines[0]).toMatchObject({ emotion: "neutral", speed: 1, pauseAfterMs: 0 });
  });
  it("requires an explicit existing budget authorization and rejects invented execution options", () => {
    expect(speechGenerateSchema.safeParse({ quoteId: "quote" }).success).toBe(false);
    expect(speechGenerateSchema.safeParse({ quoteId: "quote", budgetAuthorizationId: id, bypassBudget: true }).success).toBe(false);
    expect(speechMixRequestSchema.parse({ videoAssetId: id })).toMatchObject({ originalAudio: "mute", musicGain: 0.25, ducking: true });
  });
  it("rejects unsupported catalog ranges and secrets in voice snapshots", () => {
    const voice = { catalogVoiceId: "cherry", name: "Cherry", providerConfigurationId: id, providerConfigurationVersion: "v1",
      providerKey: "dashscope-media", model: "qwen3-tts-flash", modelVersion: "v1", voiceId: "Cherry", locale: "zh-CN", rightsRef: "preset-terms-v1",
      capabilities: { emotions: ["neutral"], speedMin: 1, speedMax: 1 } };
    expect(speechVoiceSchema.safeParse(voice).success).toBe(true);
    expect(speechVoiceSchema.safeParse({ ...voice, apiKey: "secret" }).success).toBe(false);
    expect(speechVoiceSchema.safeParse({ ...voice, capabilities: { emotions: ["neutral"], speedMin: 1.5, speedMax: 1 } }).success).toBe(false);
  });
});
