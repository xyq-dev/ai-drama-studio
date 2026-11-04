import { describe, expect, it, vi } from "vitest";
import type { RealMediaConfiguration, RealMediaSnapshot } from "@ai-drama/contracts";
import { MediaSubmissionUnknownError, type MediaGenerationRequest } from "./media-adapter";
import {
  MINIMAX_TTS_DEFAULT_BASE_URL, MINIMAX_TTS_INSUFFICIENT_BALANCE, MINIMAX_TTS_INVALID_API_KEY, MINIMAX_TTS_MODEL_ID,
  MINIMAX_TTS_PROVIDER_KEY, MINIMAX_TTS_REJECTED, MiniMaxTtsAdapter, buildMiniMaxT2aBody, canonicalMiniMaxTtsBaseUrl, miniMaxT2aUrl,
} from "./minimax-tts-adapter";
import type { RealMediaHttpResponse, RealMediaHttpTransport } from "./real-media-adapters";

const key = "test-minimax-key-never-live";
const voiceId = "female-shaonv";
function wavBytes(): Buffer {
  const data = Buffer.alloc(8);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(44100, 24);
  header.writeUInt32LE(88200, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
function config(format: "wav" | "pcm" = "wav"): RealMediaConfiguration {
  return {
    id: "00000000-0000-4000-8000-000000000021", version: "mm-tts-v1", providerKey: MINIMAX_TTS_PROVIDER_KEY,
    region: "api.minimaxi.com", capability: "audio.tts", model: MINIMAX_TTS_MODEL_ID, credentialRef: "env:minimax-tts",
    credentialVersion: "v1", enabled: true, queryAllowed: true, currency: "CNY", unitPrice: "0.0002", unitType: "character",
    priceVersion: "mm-price", parameters: { outputFormat: format, sampleRate: 44100, baseUrl: MINIMAX_TTS_DEFAULT_BASE_URL },
  };
}
function speech(text = "师傅，末班车还会开吗？") {
  return { schema: "minimax-tts.speech.v1" as const, text, voiceId };
}
function input(configuration = config(), block = speech()): MediaGenerationRequest {
  const snapshot: RealMediaSnapshot = {
    schema: "real-media.v1", capability: "audio.tts", shotRevisionId: "00000000-0000-4000-8000-000000000022",
    sourceText: block.text, sourceHash: "a".repeat(64), configuration, minimaxSpeech: block,
    budget: {
      authorizationId: "00000000-0000-4000-8000-000000000023", quoteId: "00000000-0000-4000-8000-000000000024",
      currency: "CNY", estimatedAmount: "0.01", maximumAmount: "10", priceVersion: "mm-price",
      authorizedBy: "owner", authorizedAt: "2026-11-04T00:00:00.000Z", expiresAt: "2026-11-04T00:15:00.000Z",
    },
  };
  return {
    workspaceId: "00000000-0000-4000-8000-000000000025", projectId: "00000000-0000-4000-8000-000000000026",
    shotRevisionId: snapshot.shotRevisionId, generationJobId: "00000000-0000-4000-8000-000000000027",
    jobAttemptId: "00000000-0000-4000-8000-000000000028", providerConfigurationId: configuration.id,
    clientRequestKey: "mm-once", inputHash: "b".repeat(64), traceId: "test", inputSnapshot: snapshot, capability: "audio.tts",
  };
}
function payload(audio: Buffer, extra: Record<string, unknown> = { usage_characters: 10, audio_format: "wav", audio_sample_rate: 44100 }): Record<string, unknown> {
  return { data: { audio: audio.toString("hex"), status: 2 }, extra_info: extra, trace_id: "mm_trace_1", base_resp: { status_code: 0, status_msg: "success" } };
}
function response(body: unknown, status = 200, headers: Record<string, string> = { "content-type": "application/json" }): RealMediaHttpResponse {
  return { status, headers, bytes: Buffer.from(JSON.stringify(body)) };
}

describe("minimax tts adapter (no network)", () => {
  it("posts one domestic t2a_v2 speech-2.8-hd request and decodes hex wav", async () => {
    const transport = vi.fn<RealMediaHttpTransport>().mockResolvedValue(response(payload(wavBytes())));
    const result = await new MiniMaxTtsAdapter(config(), key, transport).submit(input());
    expect(result).toMatchObject({
      kind: "succeeded", providerRequestId: "mm_trace_1",
      accounting: { provider: "minimax-tts", model: "speech-2.8-hd", usage: { characters: 10 }, costs: [] },
    });
    expect(result.kind === "succeeded" && result.outputs[0].retrieval.kind === "URI" && result.outputs[0].retrieval.uri.startsWith("data:audio/wav;rate=44100;base64,")).toBe(true);
    const sent = transport.mock.calls[0]![0];
    expect(sent.url).toBe(miniMaxT2aUrl(MINIMAX_TTS_DEFAULT_BASE_URL));
    expect(sent.url).toBe("https://api.minimaxi.com/v1/t2a_v2");
    expect(sent.headers.Authorization).toBe(`Bearer ${key}`);
    expect(sent.headers["xi-api-key"]).toBeUndefined();
    expect(JSON.parse(sent.body!)).toEqual(buildMiniMaxT2aBody(speech(), "wav"));
    expect(JSON.parse(sent.body!).model).toBe("speech-2.8-hd");
    expect(JSON.stringify(sent)).not.toContain("elevenlabs");
    expect(JSON.stringify(sent)).not.toContain("eleven_v4");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("accepts uppercase hex and a header trace id", async () => {
    const wav = wavBytes();
    const body = payload(wav);
    (body.data as { audio: string }).audio = wav.toString("hex").toUpperCase();
    delete body.trace_id;
    const transport = vi.fn<RealMediaHttpTransport>().mockResolvedValue(response(body, 200, { "Trace-Id": "hdr_trace_9" }));
    const result = await new MiniMaxTtsAdapter(config(), key, transport).submit(input());
    expect(result).toMatchObject({ kind: "succeeded", providerRequestId: "hdr_trace_9" });
  });
  it("decodes pcm when that format is configured", async () => {
    const pcm = Buffer.from([0, 1, 2, 3, 4, 5]);
    const transport = vi.fn<RealMediaHttpTransport>().mockResolvedValue(response(payload(pcm, { audio_format: "pcm", audio_sample_rate: 44100, usage_characters: 2 })));
    const result = await new MiniMaxTtsAdapter(config("pcm"), key, transport).submit(input(config("pcm")));
    expect(result.kind).toBe("succeeded");
    expect(JSON.parse(transport.mock.calls[0]![0].body!).audio_setting).toEqual({ sample_rate: 44100, format: "pcm", channel: 1 });
    expect(result.kind === "succeeded" && result.outputs[0].retrieval.kind === "URI" && result.outputs[0].retrieval.uri.startsWith("data:audio/L16;rate=44100;base64,")).toBe(true);
  });
  it("maps base_resp 1008 to insufficient balance and does not send again", async () => {
    const transport = vi.fn<RealMediaHttpTransport>().mockResolvedValue(response({
      base_resp: { status_code: 1008, status_msg: `insufficient balance ${key}` }, trace_id: "bal_1",
    }));
    const result = await new MiniMaxTtsAdapter(config(), key, transport).submit(input());
    expect(result).toMatchObject({ kind: "failed", retryable: false, errorCode: MINIMAX_TTS_INSUFFICIENT_BALANCE, providerRequestId: "bal_1" });
    expect(result.kind === "failed" && result.errorMessage).toContain("1008");
    expect(result.kind === "failed" && result.errorMessage).toContain("insufficient balance");
    expect(result.kind === "failed" && result.errorMessage).toContain("Payment is required");
    expect(JSON.stringify(result)).not.toContain(key);
    expect(JSON.stringify(result)).not.toContain("elevenlabs");
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]![0].url).toBe("https://api.minimaxi.com/v1/t2a_v2");
  });
  it("maps base_resp 2049 to an invalid key or wrong host", async () => {
    const transport = vi.fn<RealMediaHttpTransport>().mockResolvedValue(response({
      base_resp: { status_code: "2049", status_msg: "invalid api key" },
    }, 401));
    const result = await new MiniMaxTtsAdapter(config(), key, transport).submit(input());
    expect(result).toMatchObject({ kind: "failed", retryable: false, errorCode: MINIMAX_TTS_INVALID_API_KEY });
    expect(result.kind === "failed" && result.errorMessage).toContain("2049");
    expect(result.kind === "failed" && result.errorMessage).toContain("invalid API key or wrong host");
    expect(result.kind === "failed" && result.errorMessage).toContain("api.minimaxi.com");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("keeps other definite rejections terminal", async () => {
    const transport = vi.fn<RealMediaHttpTransport>().mockResolvedValue(response({ base_resp: { status_code: 2013, status_msg: "invalid params" } }, 400));
    const result = await new MiniMaxTtsAdapter(config(), key, transport).submit(input());
    expect(result).toMatchObject({ kind: "failed", retryable: false, errorCode: MINIMAX_TTS_REJECTED });
    expect(result.kind === "failed" && result.errorMessage).toContain("was not replaced");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each([408, 500, 503])("marks HTTP %i unknown without a second submit", async (status) => {
    const transport = vi.fn<RealMediaHttpTransport>().mockResolvedValue(response({}, status));
    await expect(new MiniMaxTtsAdapter(config(), key, transport).submit(input())).rejects.toBeInstanceOf(MediaSubmissionUnknownError);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("marks a successful status without a trace, a url payload, or a non-wav body unknown", async () => {
    const missingTrace = vi.fn<RealMediaHttpTransport>().mockResolvedValue(response({ data: { audio: wavBytes().toString("hex"), status: 2 }, base_resp: { status_code: 0 } }));
    await expect(new MiniMaxTtsAdapter(config(), key, missingTrace).submit(input())).rejects.toBeInstanceOf(MediaSubmissionUnknownError);
    const urlAudio = vi.fn<RealMediaHttpTransport>().mockResolvedValue(response({
      data: { audio: "https://cdn.example/file.wav", status: 2 }, trace_id: "url_1", base_resp: { status_code: 0 },
    }));
    await expect(new MiniMaxTtsAdapter(config(), key, urlAudio).submit(input())).rejects.toBeInstanceOf(MediaSubmissionUnknownError);
    const mp3 = vi.fn<RealMediaHttpTransport>().mockResolvedValue(response(payload(wavBytes(), { audio_format: "mp3", audio_sample_rate: 44100 })));
    await expect(new MiniMaxTtsAdapter(config(), key, mp3).submit(input())).rejects.toBeInstanceOf(MediaSubmissionUnknownError);
    expect(missingTrace).toHaveBeenCalledTimes(1);
    expect(urlAudio).toHaveBeenCalledTimes(1);
    expect(mp3).toHaveBeenCalledTimes(1);
  });
  it("does not query a synchronous task or accept another provider or model", async () => {
    const transport = vi.fn<RealMediaHttpTransport>();
    const adapter = new MiniMaxTtsAdapter(config(), key, transport);
    expect((await adapter.inspect("mm_trace_1")).state).toBe("UNKNOWN");
    expect(transport).not.toHaveBeenCalled();
    expect(() => new MiniMaxTtsAdapter({ ...config(), providerKey: "elevenlabs-tts", model: "eleven_v4" }, key, transport)).toThrow("MEDIA_CONFIGURATION_UNSUPPORTED");
    expect(() => new MiniMaxTtsAdapter({ ...config(), model: "speech-02-hd" }, key, transport)).toThrow("MEDIA_CONFIGURATION_UNSUPPORTED");
    expect(() => new MiniMaxTtsAdapter({ ...config(), parameters: { ...config().parameters, outputFormat: "mp3" } }, key, transport)).toThrow("MEDIA_CONFIGURATION_UNSUPPORTED");
    expect(() => new MiniMaxTtsAdapter({ ...config(), parameters: { ...config().parameters, sampleRate: 32000 } }, key, transport)).toThrow("MEDIA_CONFIGURATION_UNSUPPORTED");
    expect(() => new MiniMaxTtsAdapter({ ...config(), parameters: { ...config().parameters, baseUrl: "https://api.elevenlabs.io" }, region: "api.elevenlabs.io" }, key, transport)).toThrow("MINIMAX_TTS_BASE_URL");
    expect(canonicalMiniMaxTtsBaseUrl("https://api.minimaxi.com/")).toBe("https://api.minimaxi.com");
    expect(() => canonicalMiniMaxTtsBaseUrl("http://api.minimaxi.com")).toThrow("MINIMAX_TTS_BASE_URL");
  });
  it("rejects controls and an elevenlabs dialogue snapshot before any request", async () => {
    const transport = vi.fn<RealMediaHttpTransport>();
    await expect(new MiniMaxTtsAdapter(config(), key, transport).submit(input(config(), speech("<speak>师傅</speak>")))).rejects.toThrow("MINIMAX_TTS_UNSUPPORTED_CONTROL");
    const request = input();
    (request.inputSnapshot as { dialogue: unknown }).dialogue = { schema: "elevenlabs-tts.dialogue.v1" };
    await expect(new MiniMaxTtsAdapter(config(), key, transport).submit(request)).rejects.toThrow("MEDIA_SNAPSHOT_MISMATCH");
    expect(transport).not.toHaveBeenCalled();
  });
  it("does not submit when the configuration is disabled", async () => {
    const transport = vi.fn<RealMediaHttpTransport>();
    await expect(new MiniMaxTtsAdapter({ ...config(), enabled: false }, key, transport).submit(input())).rejects.toThrow("MEDIA_SUBMIT_DISABLED");
    expect(transport).not.toHaveBeenCalled();
  });
});
