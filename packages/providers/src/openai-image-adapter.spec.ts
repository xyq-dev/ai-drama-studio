import { describe, expect, it, vi } from "vitest";
import type { RealMediaConfiguration, RealMediaSnapshot } from "@ai-drama/contracts";
import { MediaSubmissionUnknownError, type MediaGenerationRequest } from "./media-adapter";
import {
  OPENAI_IMAGE_EDITS_PATH, OPENAI_IMAGE_GENERATIONS_PATH, OPENAI_IMAGE_MODEL_ID, OPENAI_IMAGE_QUALITY,
  OpenAiImageAdapter, openAiImageEditScaffold, type RealMediaHttpTransport,
} from "./real-media-adapters";

const key = "openai-media-test-key";
const baseUrl = "https://image.example.test";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
function config(patch: Partial<RealMediaConfiguration> = {}): RealMediaConfiguration {
  return { id: "00000000-0000-4000-8000-000000000011", version: "sunburst-test-v1",
    providerKey: "openai-media", capability: "image.generate", model: OPENAI_IMAGE_MODEL_ID,
    region: "image.example.test", credentialRef: "env:openai-media", credentialVersion: "v1",
    enabled: true, queryAllowed: true, currency: "USD", unitPrice: "0.04", unitType: "image",
    priceVersion: "operator-price", maximumOperationAmount: "2",
    parameters: { baseUrl, quality: "max", size: "1024x1536" }, ...patch };
}
function input(configuration = config()): MediaGenerationRequest {
  const snapshot: RealMediaSnapshot = { schema: "real-media.v1", capability: "image.generate",
    shotRevisionId: "00000000-0000-4000-8000-000000000012", sourceText: "原创人物在书房发现一封信。",
    sourceHash: "a".repeat(64), configuration,
    budget: { authorizationId: "00000000-0000-4000-8000-000000000013", quoteId: "00000000-0000-4000-8000-000000000014",
      currency: "USD", estimatedAmount: "0.04", maximumAmount: "2", priceVersion: "operator-price",
      authorizedBy: "owner", authorizedAt: "2026-11-04T00:00:00.000Z", expiresAt: "2026-11-04T00:05:00.000Z" } };
  return { workspaceId: "00000000-0000-4000-8000-000000000015", projectId: "00000000-0000-4000-8000-000000000016",
    shotRevisionId: snapshot.shotRevisionId, generationJobId: "00000000-0000-4000-8000-000000000017",
    jobAttemptId: "00000000-0000-4000-8000-000000000018", providerConfigurationId: configuration.id,
    clientRequestKey: "one-operation", inputHash: "b".repeat(64), traceId: "unpaid-fake-transport",
    inputSnapshot: snapshot, capability: "image.generate" };
}
describe("openai sunburst image adapter (unpaid fake transport)", () => {
  it("submits one max-quality sunburst generation and does not call the network again", async () => {
    const transport = vi.fn<RealMediaHttpTransport>().mockResolvedValue({ status: 200,
      headers: { "x-request-id": "req_sunburst_1", "content-type": "application/json" },
      bytes: Buffer.from(JSON.stringify({ data: [{ b64_json: png.toString("base64") }], usage: { total_tokens: 12, api_key: key } })) });
    const adapter = new OpenAiImageAdapter(config(), key, transport);
    const result = await adapter.submit(input());
    expect(result).toMatchObject({ kind: "succeeded", providerRequestId: "req_sunburst_1",
      accounting: { provider: "openai-media", model: OPENAI_IMAGE_MODEL_ID, costs: [], usage: { total_tokens: 12 } } });
    expect(result.kind === "succeeded" && result.outputs[0].retrieval.kind === "URI" && result.outputs[0].retrieval.uri)
      .toContain("data:image/png;base64,");
    const sent = transport.mock.calls[0]![0];
    expect(sent.url).toBe(baseUrl + OPENAI_IMAGE_GENERATIONS_PATH);
    expect(sent.url).not.toContain("api.openai.com");
    expect(sent.headers.Authorization).toBe("Bearer " + key);
    expect(sent.headers["Idempotency-Key"]).toBe("one-operation");
    expect(JSON.parse(sent.body!)).toEqual({ model: OPENAI_IMAGE_MODEL_ID, prompt: "原创人物在书房发现一封信。",
      n: 1, size: "1024x1536", quality: OPENAI_IMAGE_QUALITY, output_format: "png" });
    expect((await adapter.inspect("req_sunburst_1")).state).toBe("UNKNOWN");
    expect(transport).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(key);
  });
  it.each([408, 409, 500, 502, 503, 504])("marks HTTP %i UNKNOWN and does not resubmit", async (status) => {
    const transport = vi.fn<RealMediaHttpTransport>().mockResolvedValue({ status, headers: { "x-request-id": "req_unknown" },
      bytes: Buffer.from("{}") });
    const adapter = new OpenAiImageAdapter(config(), key, transport);
    await expect(adapter.submit(input())).rejects.toMatchObject({ name: "MediaSubmissionUnknownError", providerRequestId: "req_unknown" });
    expect((await adapter.inspect("req_unknown")).state).toBe("UNKNOWN");
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls.every(([request]) => request.method === "POST" && request.url.endsWith(OPENAI_IMAGE_GENERATIONS_PATH))).toBe(true);
  });
  it("treats a dropped connection as UNKNOWN without copying the secret or sending again", async () => {
    const transport = vi.fn<RealMediaHttpTransport>().mockRejectedValue(new Error("connect " + key));
    const error = await new OpenAiImageAdapter(config(), key, transport).submit(input()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MediaSubmissionUnknownError);
    expect((error as Error).message).not.toContain(key);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("keeps a 200 without a receipt id UNKNOWN instead of claiming success", async () => {
    const transport = vi.fn<RealMediaHttpTransport>().mockResolvedValue({ status: 200, headers: { "content-type": "application/json" },
      bytes: Buffer.from(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] })) });
    await expect(new OpenAiImageAdapter(config(), key, transport).submit(input())).rejects.toBeInstanceOf(MediaSubmissionUnknownError);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("returns a definite rejection once and does not fall back to another model", async () => {
    const transport = vi.fn<RealMediaHttpTransport>().mockResolvedValue({ status: 403, headers: { "x-request-id": "req_region" },
      bytes: Buffer.from(JSON.stringify({ error: { code: "unsupported_country_region_territory", message: key } })) });
    const result = await new OpenAiImageAdapter(config(), key, transport).submit(input());
    expect(result).toMatchObject({ kind: "failed", retryable: false, errorCode: "MEDIA_PROVIDER_REJECTED" });
    expect(JSON.stringify(result)).not.toContain(key);
    expect(JSON.stringify(transport.mock.calls)).not.toContain("gpt-image-2.5-flare");
    expect(JSON.stringify(transport.mock.calls)).not.toContain("qwen-image");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each(["gpt-image-2.5-flare", "qwen-image-3.0", "dall-e-3", "dall-e", "gpt-image-1"])("rejects model %s before any request", (model) => {
    const transport = vi.fn<RealMediaHttpTransport>();
    expect(() => new OpenAiImageAdapter(config({ model }), key, transport)).toThrow("MEDIA_CONFIGURATION_UNSUPPORTED");
    expect(transport).not.toHaveBeenCalled();
  });
  it.each(["low", "high", "auto", "standard"])("rejects quality %s before any request", (quality) => {
    const transport = vi.fn<RealMediaHttpTransport>();
    expect(() => new OpenAiImageAdapter(config({ parameters: { baseUrl, quality, size: "1024x1536" } }), key, transport)).toThrow("MEDIA_CONFIGURATION_UNSUPPORTED");
    expect(transport).not.toHaveBeenCalled();
  });
  it.each(["http://image.example.test", "https://localhost", "https://image.example.test/v1", "https://user:secret@image.example.test"])("rejects base %s", (value) => {
    expect(() => new OpenAiImageAdapter(config({ parameters: { baseUrl: value, quality: "max", size: "1024x1536" }, region: "image.example.test" }), key, vi.fn()))
      .toThrow("MEDIA_CONFIGURATION_UNSUPPORTED");
  });
  it("never accepts the credential as a receipt id or an output URI", async () => {
    const transport = vi.fn<RealMediaHttpTransport>().mockResolvedValue({ status: 200, headers: { "x-request-id": key },
      bytes: Buffer.from(JSON.stringify({ data: [{ b64_json: png.toString("base64") }] })) });
    const error = await new OpenAiImageAdapter(config(), key, transport).submit(input()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MediaSubmissionUnknownError);
    expect((error as MediaSubmissionUnknownError).providerRequestId).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain(key);
    const adapter = new OpenAiImageAdapter(config(), key, transport);
    await expect(adapter.resolveOutput({ kind: "IMAGE", retrieval: { kind: "URI", uri: "data:image/png;base64," + png.toString("base64") + key } })).rejects.toThrow("MEDIA_OUTPUT_INVALID");
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("does not send a reference edit and does not advertise it as a product", async () => {
    const transport = vi.fn<RealMediaHttpTransport>();
    const adapter = new OpenAiImageAdapter(config(), key, transport);
    expect(adapter.capabilities()).toEqual(["image.generate"]);
    expect(adapter.editScaffold()).toEqual(openAiImageEditScaffold());
    expect(openAiImageEditScaffold()).toMatchObject({ productized: false, path: OPENAI_IMAGE_EDITS_PATH, model: OPENAI_IMAGE_MODEL_ID, quality: "max" });
    expect(() => adapter.submitEdit()).toThrow("MEDIA_EDIT_NOT_PRODUCTIZED");
    const request = input();
    request.resolvedSourceImage = { bytes: png, mimeType: "image/png", checksumSha256: "c".repeat(64) };
    await expect(adapter.submit(request)).rejects.toThrow("MEDIA_EDIT_NOT_PRODUCTIZED");
    expect(transport).not.toHaveBeenCalled();
  });
});
