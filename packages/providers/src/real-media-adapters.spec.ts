import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { RealMediaConfiguration, RealMediaSnapshot } from "@ai-drama/contracts";
import { MediaSubmissionUnknownError, type MediaGenerationRequest } from "./media-adapter";
import { DashScopeMediaAdapter, ElevenLabsMusicAdapter, safeDashScopeMediaOutputUrl,
  type RealMediaHttpTransport, type RealMediaHttpResponse } from "./real-media-adapters";

const key = "test-media-key-never-live";
const url = "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/result/file.png?signature=private";
function config(capability: RealMediaConfiguration["capability"] = "image.generate"): RealMediaConfiguration {
  return { id: "00000000-0000-4000-8000-000000000001", version: "test-v1",
    providerKey: capability === "audio.music" ? "elevenlabs-media" : "dashscope-media",
    region: capability === "audio.music" ? "global" : "beijing", capability,
    model: { "image.generate": "qwen-image-3.0", "video.generate": "wan2.6-i2v-flash",
      "audio.tts": "qwen3-tts-flash", "audio.music": "music_v2" }[capability],
    credentialRef: "server:test", credentialVersion: "v1", enabled: true, queryAllowed: true,
    currency: capability === "audio.music" ? "USD" : "CNY", unitPrice: "1", unitType: "request",
    priceVersion: "test-price", parameters: { duration: 5 } };
}
function input(configuration = config()): MediaGenerationRequest {
  const snapshot: RealMediaSnapshot = { schema: "real-media.v1", capability: configuration.capability,
    shotRevisionId: "00000000-0000-4000-8000-000000000002", sourceText: "原创人物在书房发现一封信。",
    sourceHash: "a".repeat(64), configuration,
    budget: { authorizationId: "00000000-0000-4000-8000-000000000003", quoteId: "00000000-0000-4000-8000-000000000004",
      currency: configuration.currency, estimatedAmount: "1", maximumAmount: "2", priceVersion: "test-price",
      authorizedBy: "owner", authorizedAt: "2026-11-01T00:00:00.000Z", expiresAt: "2026-11-01T00:05:00.000Z" } };
  return { workspaceId: "00000000-0000-4000-8000-000000000005", projectId: "00000000-0000-4000-8000-000000000006",
    shotRevisionId: snapshot.shotRevisionId, generationJobId: "00000000-0000-4000-8000-000000000007",
    jobAttemptId: "00000000-0000-4000-8000-000000000008", providerConfigurationId: configuration.id,
    clientRequestKey: "one-operation", inputHash: "b".repeat(64), traceId: "test", inputSnapshot: snapshot,
    capability: configuration.capability };
}
function response(body: unknown, status = 200): RealMediaHttpResponse {
  return { status, headers: { "content-type": "application/json" }, bytes: Buffer.from(JSON.stringify(body)) };
}
describe("real media adapter protocol (no network)", () => {
  it("submits one watermarked image and only queries the original task", async () => {
    const transport = vi.fn<RealMediaHttpTransport>()
      .mockResolvedValueOnce(response({ output: { task_id: "task_1", task_status: "PENDING" }, request_id: "request_1" }))
      .mockResolvedValueOnce(response({ output: { task_id: "task_1", task_status: "SUCCEEDED", choices: [
        { finish_reason: "stop", message: { content: [{ image: url }] } },
      ] }, usage: { image_count: 1, api_key: "never-copy", total_tokens: -1 } }));
    const adapter = new DashScopeMediaAdapter(config(), key, transport);
    expect(await adapter.submit(input())).toMatchObject({ kind: "waiting", providerRequestId: "task_1" });
    const sent = transport.mock.calls[0]![0];
    expect(sent.url).toBe("https://dashscope.aliyuncs.com/api/v1/services/aigc/image-generation/generation");
    expect(sent.headers["X-DashScope-Async"]).toBe("enable");
    expect(JSON.parse(sent.body!)).toMatchObject({ model: "qwen-image-3.0", parameters: { n: 1, watermark: true, size: "720*1280" } });
    const result = await adapter.inspect("task_1");
    expect(result).toMatchObject({ state: "SUCCEEDED", accounting: { costs: [], usage: { image_count: 1 } } });
    expect(JSON.stringify(result)).not.toContain("never-copy");
    expect(transport.mock.calls.map(([r]) => r.method)).toEqual(["POST", "GET"]);
  });
  it("does not infer actual price from usage", async () => {
    const c = config("audio.tts"), transport = vi.fn<RealMediaHttpTransport>().mockResolvedValue(response({
      request_id: "tts_1", output: { finish_reason: "stop", audio: { url: url.replace("file.png", "file.wav") } }, usage: { characters: 22 },
    }));
    const result = await new DashScopeMediaAdapter(c, key, transport).submit(input(c));
    expect(result).toMatchObject({ kind: "succeeded", accounting: { costs: [], usage: { characters: 22 } } });
    expect(transport.mock.calls[0]![0].headers["X-DashScope-Async"]).toBeUndefined();
  });
  it("pins silent video and verifies the exact frozen first frame before any request", async () => {
    const c = config("video.generate"), request = input(c), bytes = Buffer.from("validated-image");
    const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
    (request.inputSnapshot as RealMediaSnapshot).sourceImage = { assetId: "00000000-0000-4000-8000-000000000009", checksumSha256 };
    request.resolvedSourceImage = { bytes, mimeType: "image/png", checksumSha256 };
    const transport = vi.fn<RealMediaHttpTransport>().mockResolvedValue(response({ output: { task_id: "video_1" } }));
    const adapter = new DashScopeMediaAdapter(c, key, transport);
    await adapter.submit(request);
    expect(JSON.parse(transport.mock.calls[0]![0].body!)).toMatchObject({
      parameters: { resolution: "720P", duration: 5, audio: false, watermark: true, shot_type: "single" },
      input: { img_url: "data:image/png;base64," + bytes.toString("base64") },
    });
    transport.mockClear();
    request.resolvedSourceImage.bytes = Buffer.from("changed");
    await expect(adapter.submit(request)).rejects.toThrow("MEDIA_SOURCE_IMAGE_CHANGED");
    expect(transport).not.toHaveBeenCalled();
  });
  it.each([408, 409, 500, 502, 503, 504])("marks HTTP %i as UNKNOWN without retry", async (status) => {
    const transport = vi.fn<RealMediaHttpTransport>().mockResolvedValue(response({}, status));
    await expect(new DashScopeMediaAdapter(config(), key, transport).submit(input())).rejects.toBeInstanceOf(MediaSubmissionUnknownError);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each([400, 401, 402, 403, 404, 413, 422, 429])("returns a definite HTTP %i rejection without retry", async (status) => {
    const transport = vi.fn<RealMediaHttpTransport>().mockResolvedValue(response({ message: key + " private vendor error" }, status));
    const result = await new DashScopeMediaAdapter(config(), key, transport).submit(input());
    expect(result).toMatchObject({ kind: "failed", retryable: false });
    expect(JSON.stringify(result)).not.toContain(key);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("does not hide a known remote task ID when the remaining response is unusable", async () => {
    const transport = vi.fn<RealMediaHttpTransport>().mockResolvedValue(response({ output: { task_id: "known_1" }, code: "Unexpected" }));
    await expect(new DashScopeMediaAdapter(config(), key, transport).submit(input())).rejects.toMatchObject({ providerRequestId: "known_1" });
  });
  it("treats disconnects as UNKNOWN and never copies transport errors", async () => {
    const transport = vi.fn<RealMediaHttpTransport>().mockRejectedValue(new Error(key + " signed-url"));
    const error = await new DashScopeMediaAdapter(config(), key, transport).submit(input()).catch(e => e);
    expect(error).toBeInstanceOf(MediaSubmissionUnknownError);
    expect(error.message).not.toContain(key);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("uses stable observation keys and rejects cross-task output", async () => {
    const transport = vi.fn<RealMediaHttpTransport>().mockResolvedValue(response({ output: { task_id: "other_1", task_status: "SUCCEEDED" } }));
    const adapter = new DashScopeMediaAdapter(config(), key, transport);
    const a = await adapter.inspect("task_1"), b = await adapter.inspect("task_1");
    expect(a.state).toBe("UNKNOWN");
    expect(a.normalizedEventKey).toBe(b.normalizedEventKey);
    expect(transport.mock.calls.every(([r]) => r.method === "GET")).toBe(true);
  });
  it.each(["https://localhost/a", "https://169.254.169.254/a", "http://user:pw@dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a",
    "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com.evil.com/a", "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com:444/a",
    "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a#fragment", "file:///tmp/a"])("rejects untrusted output %s", (value) => {
    expect(() => safeDashScopeMediaOutputUrl(value)).toThrow();
  });
  it("upgrades only an official OSS host before download", () => {
    expect(safeDashScopeMediaOutputUrl(url.replace("https:", "http:"))).toBe(url);
  });
  it("never queries synchronous TTS again", async () => {
    const c = config("audio.tts"), transport = vi.fn<RealMediaHttpTransport>();
    expect((await new DashScopeMediaAdapter(c, key, transport).inspect("tts_1")).state).toBe("UNKNOWN");
    expect(transport).not.toHaveBeenCalled();
  });
  it("makes one pure-instrumental music request and returns private bounded bytes", async () => {
    const c = config("audio.music");
    const transport = vi.fn<RealMediaHttpTransport>().mockResolvedValue({
      status: 200, headers: { "song-id": "song_1", "content-type": "audio/mpeg" }, bytes: Buffer.from("mp3 bytes"),
    });
    const adapter = new ElevenLabsMusicAdapter(c, key, transport), result = await adapter.submit(input(c));
    expect(result).toMatchObject({ kind: "succeeded", providerRequestId: "song_1", accounting: { costs: [] } });
    expect(JSON.parse(transport.mock.calls[0]![0].body!)).toEqual({
      model_id: "music_v2", prompt: "原创人物在书房发现一封信。", music_length_ms: 5000, force_instrumental: true,
    });
    expect((await adapter.inspect("song_1")).state).toBe("UNKNOWN");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("retains music exposure when a synchronous response has no reliable receipt ID", async () => {
    const c = config("audio.music"), transport = vi.fn<RealMediaHttpTransport>().mockResolvedValue({
      status: 200, headers: { "content-type": "audio/mpeg" }, bytes: Buffer.from("mp3"),
    });
    await expect(new ElevenLabsMusicAdapter(c, key, transport).submit(input(c))).rejects.toBeInstanceOf(MediaSubmissionUnknownError);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("rejects frozen configuration substitutions before submit", async () => {
    const request = input(), transport = vi.fn<RealMediaHttpTransport>();
    (request.inputSnapshot as RealMediaSnapshot).configuration = { ...config(), credentialVersion: "other" };
    await expect(new DashScopeMediaAdapter(config(), key, transport).submit(request)).rejects.toThrow("MEDIA_SNAPSHOT_MISMATCH");
    expect(transport).not.toHaveBeenCalled();
  });
  it("never accepts reflected credentials as a public request ID or a download URL", async () => {
    const transport = vi.fn<RealMediaHttpTransport>().mockResolvedValue(response({ output: { task_id: key } }));
    const error = await new DashScopeMediaAdapter(config(), key, transport).submit(input()).catch(e => e);
    expect(error).toBeInstanceOf(MediaSubmissionUnknownError);
    expect(error.providerRequestId).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain(key);
    const adapter = new DashScopeMediaAdapter(config(), key, transport);
    await expect(adapter.resolveOutput({ kind: "IMAGE", retrieval: { kind: "URI", uri: url + "&key=" + key } })).rejects.toThrow();
    const music = config("audio.music");
    const mt = vi.fn<RealMediaHttpTransport>().mockResolvedValue({ status: 200,
      headers: { "song-id": key, "content-type": "audio/mpeg" }, bytes: Buffer.from("music") });
    const me = await new ElevenLabsMusicAdapter(music, key, mt).submit(input(music)).catch(e => e);
    expect(me.providerRequestId).toBeUndefined();
    expect(JSON.stringify(me)).not.toContain(key);
  });
});
