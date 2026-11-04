import { describe, expect, it, vi } from "vitest";
import type { RealMediaConfiguration, RealMediaSnapshot } from "@ai-drama/contracts";
import { MediaSubmissionUnknownError, type MediaGenerationRequest } from "./media-adapter";
import {
  ELEVENLABS_TTS_MODEL_ID, ELEVENLABS_TTS_PROVIDER_KEY, ElevenLabsTtsAdapter, buildElevenLabsDialogueBody,
  elevenLabsDialogueUrl,
} from "./elevenlabs-tts-adapter";
import type { RealMediaHttpResponse, RealMediaHttpTransport } from "./real-media-adapters";

const key = "test-tts-key-never-live";
function config(format: "pcm_44100" | "wav_44100" = "pcm_44100"): RealMediaConfiguration {
  return { id: "00000000-0000-4000-8000-000000000011", version: "tts-v1", providerKey: ELEVENLABS_TTS_PROVIDER_KEY,
    region: "global", capability: "audio.tts", model: ELEVENLABS_TTS_MODEL_ID, credentialRef: "env:elevenlabs-tts",
    credentialVersion: "v1", enabled: true, queryAllowed: true, currency: "USD", unitPrice: "0.0001", unitType: "character",
    priceVersion: "tts-price", parameters: { outputFormat: format, languageCode: "zh", dryDialogue: true } };
}
function dialogue() {
  return { schema: "elevenlabs-tts.dialogue.v1" as const, languageCode: "zh",
    inputs: [
      { speaker: "阿岚", text: "师傅，末班车……还会开吗？", voiceId: "placeholder-alan-clear" },
      { speaker: "老周", text: "暗号对了，就开。", voiceId: "placeholder-zhou-low" },
    ] };
}
function input(configuration = config(), block = dialogue()): MediaGenerationRequest {
  const snapshot: RealMediaSnapshot = { schema: "real-media.v1", capability: "audio.tts",
    shotRevisionId: "00000000-0000-4000-8000-000000000012", sourceText: block.inputs.map((line) => line.text).join("\n"),
    sourceHash: "c".repeat(64), configuration, dialogue: block,
    budget: { authorizationId: "00000000-0000-4000-8000-000000000013", quoteId: "00000000-0000-4000-8000-000000000014",
      currency: "USD", estimatedAmount: "0.01", maximumAmount: "2", priceVersion: "tts-price",
      authorizedBy: "owner", authorizedAt: "2026-11-04T00:00:00.000Z", expiresAt: "2026-11-04T00:15:00.000Z" } };
  return { workspaceId: "00000000-0000-4000-8000-000000000015", projectId: "00000000-0000-4000-8000-000000000016",
    shotRevisionId: snapshot.shotRevisionId, generationJobId: "00000000-0000-4000-8000-000000000017",
    jobAttemptId: "00000000-0000-4000-8000-000000000018", providerConfigurationId: configuration.id,
    clientRequestKey: "scene-once", inputHash: "d".repeat(64), traceId: "test", inputSnapshot: snapshot, capability: "audio.tts" };
}
function aligned(audio = Buffer.from("pcm-bytes")): Record<string, unknown> {
  return { audio_base64: audio.toString("base64"),
    voice_segments: [
      { voice_id: "placeholder-alan-clear", start_time_seconds: 0, end_time_seconds: 0.4, character_start_index: 0, character_end_index: 2, dialogue_input_index: 0 },
      { voice_id: "placeholder-zhou-low", start_time_seconds: 0.4, end_time_seconds: 0.8, character_start_index: 2, character_end_index: 4, dialogue_input_index: 1 },
    ],
    alignment: { characters: ["师", "傅", "暗", "号"], character_start_times_seconds: [0, 0.2, 0.4, 0.6], character_end_times_seconds: [0.2, 0.4, 0.6, 0.8] } };
}
function response(body: unknown, status = 200, headers: Record<string, string> = { "content-type": "application/json", "request-id": "dlg_1" }): RealMediaHttpResponse {
  return { status, headers, bytes: Buffer.from(JSON.stringify(body)) };
}

describe("elevenlabs tts adapter (no network)", () => {
  it("sends one eleven_v4 dialogue request with lossless pcm and no unsupported controls", async () => {
    const transport = vi.fn<RealMediaHttpTransport>().mockResolvedValue(response(aligned()));
    const result = await new ElevenLabsTtsAdapter(config(), key, transport).submit(input());
    expect(result).toMatchObject({ kind: "succeeded", providerRequestId: "dlg_1", accounting: { provider: "elevenlabs-tts", model: "eleven_v4", costs: [] } });
    const sent = transport.mock.calls[0]![0];
    expect(sent.url).toBe(elevenLabsDialogueUrl("pcm_44100"));
    expect(sent.url).not.toContain("/v1/music");
    expect(sent.headers["xi-api-key"]).toBe(key);
    const body = JSON.parse(sent.body!);
    expect(body).toEqual({
      model_id: "eleven_v4", language_code: "zh", apply_text_normalization: "auto",
      inputs: [
        { text: "师傅，末班车……还会开吗？", voice_id: "placeholder-alan-clear" },
        { text: "暗号对了，就开。", voice_id: "placeholder-zhou-low" },
      ],
    });
    for (const forbidden of ["speed", "style", "voice_settings", "audio_effects", "next_text", "ssml", "similarity_boost"]) {
      expect(body[forbidden]).toBeUndefined();
    }
    expect(JSON.stringify(body)).not.toContain("eleven_multilingual_v2");
    expect(JSON.stringify(body)).not.toContain("music_v2");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("maps continuity context to previous_text and future_text", () => {
    const body = buildElevenLabsDialogueBody({ ...dialogue(), previousText: "雨还在下。", futureText: "车门开了。" }, "zh");
    expect(body.previous_text).toBe("雨还在下。");
    expect(body.future_text).toBe("车门开了。");
    expect(body.model_id).toBe("eleven_v4");
    expect("next_text" in body).toBe(false);
  });
  it("rejects SSML and overlong continuity before any request", async () => {
    const transport = vi.fn<RealMediaHttpTransport>();
    const ssml = dialogue();
    ssml.inputs[0]!.text = "<speak>师傅</speak>";
    await expect(new ElevenLabsTtsAdapter(config(), key, transport).submit(input(config(), ssml))).rejects.toThrow("ELEVENLABS_TTS_UNSUPPORTED_CONTROL");
    const long = dialogue();
    long.previousText = "雨".repeat(101);
    await expect(new ElevenLabsTtsAdapter(config(), key, transport).submit(input(config(), long))).rejects.toThrow("ELEVENLABS_TTS_PREVIOUS_TEXT_LIMIT");
    expect(transport).not.toHaveBeenCalled();
  });
  it("surfaces a model or tier rejection once and does not downgrade", async () => {
    const transport = vi.fn<RealMediaHttpTransport>().mockResolvedValue(response(
      { detail: { message: "model eleven_v4 is not enabled; pcm_44100 requires Pro" } }, 422));
    const result = await new ElevenLabsTtsAdapter(config(), key, transport).submit(input());
    expect(result).toMatchObject({ kind: "failed", retryable: false, errorCode: "ELEVENLABS_TTS_REJECTED" });
    expect(result.kind === "failed" && result.errorMessage).toContain("eleven_v4");
    expect(result.kind === "failed" && result.errorMessage).toContain("pcm_44100");
    expect(result.kind === "failed" && result.errorMessage).toContain("HTTP 422");
    expect(JSON.stringify(result)).not.toContain(key);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(JSON.parse(transport.mock.calls[0]![0].body!).model_id).toBe("eleven_v4");
  });
  it.each([408, 500, 503])("marks HTTP %i unknown without a second submit", async (status) => {
    const transport = vi.fn<RealMediaHttpTransport>().mockResolvedValue(response({}, status));
    await expect(new ElevenLabsTtsAdapter(config(), key, transport).submit(input())).rejects.toBeInstanceOf(MediaSubmissionUnknownError);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("fails closed when alignment cannot time every line", async () => {
    const payload = aligned();
    payload.voice_segments = [payload.voice_segments?.[0]];
    const transport = vi.fn<RealMediaHttpTransport>().mockResolvedValue(response(payload));
    const result = await new ElevenLabsTtsAdapter(config(), key, transport).submit(input());
    expect(result).toMatchObject({ kind: "failed", retryable: false, errorCode: "ELEVENLABS_TTS_ALIGNMENT_INSUFFICIENT", providerRequestId: "dlg_1" });
    expect(result.kind === "failed" && result.errorMessage).toContain("were invented");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("does not query a synchronous dialogue task or accept a music profile", async () => {
    const transport = vi.fn<RealMediaHttpTransport>();
    const adapter = new ElevenLabsTtsAdapter(config(), key, transport);
    expect((await adapter.inspect("dlg_1")).state).toBe("UNKNOWN");
    expect(transport).not.toHaveBeenCalled();
    expect(() => new ElevenLabsTtsAdapter({ ...config(), providerKey: "elevenlabs-media", model: "music_v2", capability: "audio.music" }, key, transport)).toThrow("MEDIA_CONFIGURATION_UNSUPPORTED");
    expect(() => new ElevenLabsTtsAdapter({ ...config(), model: "eleven_multilingual_v2" }, key, transport)).toThrow("MEDIA_CONFIGURATION_UNSUPPORTED");
    expect(() => new ElevenLabsTtsAdapter({ ...config(), parameters: { ...config().parameters, speed: 1.2 } }, key, transport)).toThrow("MEDIA_CONFIGURATION_UNSUPPORTED");
  });
  it("requires an explicit wav container when wav_44100 is configured", async () => {
    const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(8)]);
    const transport = vi.fn<RealMediaHttpTransport>().mockResolvedValue(response(aligned(wav)));
    const result = await new ElevenLabsTtsAdapter(config("wav_44100"), key, transport).submit(input(config("wav_44100")));
    expect(result.kind).toBe("succeeded");
    expect(transport.mock.calls[0]![0].url).toContain("output_format=wav_44100");
    const bad = vi.fn<RealMediaHttpTransport>().mockResolvedValue(response(aligned(Buffer.from("not-wav-data"))));
    await expect(new ElevenLabsTtsAdapter(config("wav_44100"), key, bad).submit(input(config("wav_44100")))).rejects.toBeInstanceOf(MediaSubmissionUnknownError);
  });
});
