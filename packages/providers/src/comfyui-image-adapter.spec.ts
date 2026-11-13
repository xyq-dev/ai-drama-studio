import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import type { RealMediaConfiguration } from "@ai-drama/contracts";
import { ComfyUiImageAdapter, canonicalComfyUiOrigin } from "./comfyui-image-adapter";
import { assertComfyUiSourceImage } from "./comfyui-image-bytes";
import {
  assertComfyUiImageInput,
  buildComfyUiPrompt,
  COMFYUI_IMAGE_MAX_BYTES,
  comfyUiRequiredNodes,
  comfyUiWorkflowDescriptors,
} from "./comfyui-workflows";
import {
  MediaSubmissionUnknownError,
  type MediaGenerationRequest,
  type MediaProviderOutput,
} from "./media-adapter";

const origin = "http://127.0.0.1:8188";
const promptId = "11111111-1111-4111-8111-111111111111";
const attemptId = "22222222-2222-4222-8222-222222222222";
const assetId = "33333333-3333-4333-8333-333333333333";
const otherId = "44444444-4444-4444-8444-444444444444";
const testCheckpoint = "protocol-test-only.safetensors";
const sourceText = "石铺清晨，一位老人走向石碑。";
const file = { filename: attemptId + "_00001_.png", subfolder: "ads-comfyui-v1", type: "output" };
const configuration: RealMediaConfiguration = {
  id: "config",
  version: "version",
  providerKey: "comfyui",
  capability: "image.generate",
  model: testCheckpoint,
  region: "self-hosted",
  credentialRef: "env:comfyui",
  credentialVersion: "v1",
  enabled: true,
  queryAllowed: true,
  priceVersion: "fixture",
  currency: "CNY",
  unitPrice: "0.10",
  unitType: "image",
  parameters: { checkpoint: testCheckpoint, workflows: comfyUiWorkflowDescriptors(testCheckpoint) },
};
const options = { baseUrl: origin, allowedOrigins: [origin] };

function crc32(buffer: Buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// A real, uniform one-channel PNG generated in memory for protocol tests.
function png(width = 512, height = 512) {
  const chunk = (name: string, data: Buffer) => {
    const type = Buffer.from(name);
    const entry = Buffer.alloc(12 + data.length);
    entry.writeUInt32BE(data.length);
    type.copy(entry, 4);
    data.copy(entry, 8);
    entry.writeUInt32BE(crc32(Buffer.concat([type, data])), entry.length - 4);
    return entry;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.alloc((width + 1) * height))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
function snapshot(reference = false) {
  return assertComfyUiImageInput(configuration, {
    workflowId: reference ? "sd15-img2img" : "sd15-txt2img",
    width: 512,
    height: 512,
    seed: 17,
    ...(reference ? { referenceAssetId: assetId } : {}),
  });
}
function input(reference = false): MediaGenerationRequest {
  const bytes = png();
  const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    workspaceId: "workspace",
    projectId: "project",
    generationJobId: "job",
    jobAttemptId: attemptId,
    shotRevisionId: "shot",
    providerConfigurationId: configuration.id,
    clientRequestKey: "job:1",
    inputHash: "hash",
    traceId: "trace",
    capability: "image.generate",
    inputSnapshot: {
      schema: "real-media.v1",
      shotRevisionId: "shot",
      capability: "image.generate",
      sourceText,
      configuration,
      comfyui: { ...snapshot(reference), sourceShotPromptHash: "frozen" },
      ...(reference ? { sourceImage: { assetId, checksumSha256, rowVersion: 1 } } : {}),
    },
    ...(reference
      ? { resolvedSourceImage: { bytes, checksumSha256, mimeType: "image/png" as const } }
      : {}),
  };
}
function graph(reference = false) {
  return buildComfyUiPrompt({
    configuration,
    frozen: snapshot(reference),
    sourceText,
    attemptId,
    ...(reference
      ? { referenceAssetId: assetId, uploadedImage: "ads-comfyui-v1-" + attemptId + ".png" }
      : {}),
  });
}
function history(overrides: Record<string, unknown> = {}) {
  return {
    [promptId]: {
      prompt: [1, promptId, graph(), {}, ["9"]],
      outputs: { "9": { images: [file] } },
      status: { completed: true, status_str: "success" },
      ...overrides,
    },
  };
}
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function transport(serve: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn<typeof fetch>(async (url, init) => serve(new URL(String(url)), init));
}
function queue(running: string[] = [], pending: string[] = []) {
  return json({
    queue_running: running.map((id) => [0, id]),
    queue_pending: pending.map((id) => [0, id]),
  });
}

describe("ComfyUI controlled image workflows", () => {
  it("maps only allowed text, seed and dimension parameters to the built-in graph", () => {
    const prompt = graph();
    expect(prompt["6"]?.inputs.text).toBe(sourceText);
    expect(prompt["3"]?.inputs).toMatchObject({
      seed: 17,
      steps: 20,
      denoise: 1,
      latent_image: ["5", 0],
    });
    expect(prompt["4"]?.inputs.ckpt_name).toBe(testCheckpoint);
    expect(prompt["5"]).toEqual({
      class_type: "EmptyLatentImage",
      inputs: { width: 512, height: 512, batch_size: 1 },
    });
    expect(prompt["9"]?.inputs.filename_prefix).toBe("ads-comfyui-v1/" + attemptId);
    expect(graph(true)["11"]?.inputs).toMatchObject({ width: 512, height: 512, image: ["10", 0] });
    expect(graph(true)["5"]?.class_type).toBe("VAEEncode");
    expect(graph(true)["3"]?.inputs.denoise).toBe(0.65);
  });

  it("rejects unapproved sizes, seed, file paths, templates and reference modes", () => {
    const valid = { workflowId: "sd15-txt2img", width: 512, height: 512, seed: 17 };
    for (const changes of [
      { width: 777 },
      { height: 4096 },
      { seed: -1 },
      { seed: 2 ** 32 },
      { workflowId: "custom" },
      { referenceAssetId: assetId },
      { workflowId: "sd15-img2img" },
    ]) {
      expect(() => assertComfyUiImageInput(configuration, { ...valid, ...changes })).toThrow();
    }
    expect(() => comfyUiWorkflowDescriptors("../a.safetensors")).toThrow();
    expect(() => comfyUiWorkflowDescriptors("anything.ckpt")).toThrow();
    expect(() =>
      buildComfyUiPrompt({
        configuration,
        frozen: { ...snapshot(), workflowHash: "altered" },
        sourceText,
        attemptId,
      }),
    ).toThrow();
    expect(() =>
      buildComfyUiPrompt({
        configuration,
        frozen: snapshot(),
        sourceText: "embedding:local",
        attemptId,
      }),
    ).toThrow("COMFYUI_PROMPT_INVALID");
    expect(() =>
      buildComfyUiPrompt({
        configuration,
        frozen: snapshot(true),
        sourceText,
        attemptId,
        referenceAssetId: assetId,
        uploadedImage: "../../a.png",
      }),
    ).toThrow();
  });

  it("requires a valid reference image container with bounded dimensions", () => {
    expect(assertComfyUiSourceImage(png(), "image/png")).toEqual({ width: 512, height: 512 });
    expect(() => assertComfyUiSourceImage(png().subarray(0, 42), "image/png")).toThrow();
    expect(() => assertComfyUiSourceImage(png(4097, 1), "image/png")).toThrow();
    expect(() => assertComfyUiSourceImage(png(), "image/jpeg")).toThrow();
    expect(() =>
      assertComfyUiSourceImage(Buffer.alloc(COMFYUI_IMAGE_MAX_BYTES + 1), "image/png"),
    ).toThrow();
  });
});

describe("ComfyUI self-hosted adapter", () => {
  it("rejects unsafe origins and never falls back to a different origin", () => {
    expect(canonicalComfyUiOrigin("http://127.0.0.1:8188/")).toBe(origin);
    for (const value of [
      "file:///tmp",
      "https://user:pass@comfy.local",
      origin + "/foo",
      origin + "/#test",
      origin + "/?x",
      " https://comfy.local",
      "http:\\comfy.local",
    ]) {
      expect(() => canonicalComfyUiOrigin(value)).toThrow();
    }
    expect(
      () =>
        new ComfyUiImageAdapter(configuration, {
          ...options,
          allowedOrigins: ["https://other.local"],
        }),
    ).toThrow("COMFYUI_ORIGIN_NOT_ALLOWED");
  });

  it("does a read-only readiness probe and distinguishes outages, missing nodes and missing model", async () => {
    let missing = false;
    let outage = false;
    const fetch = transport((url, init) => {
      expect(init?.method).toBe("GET");
      if (outage) throw new Error("instance offline");
      if (url.pathname === "/system_stats") return json({ system: {}, devices: [] });
      const name = url.pathname.split("/").at(-1)!;
      if (missing && name === "ImageScale") return json({}, 404);
      const required: Record<string, unknown> = Object.fromEntries(
        comfyUiRequiredNodes()[name]!.map((field) => [field, []]),
      );
      if (name === "CheckpointLoaderSimple") required.ckpt_name = [missing ? [] : [testCheckpoint]];
      return json({ [name]: { python_module: "nodes", input: { required } } });
    });
    const adapter = new ComfyUiImageAdapter(configuration, { ...options, fetch });
    expect(await adapter.checkReadiness()).toMatchObject({
      state: "READY",
      missingNodes: [],
      missingModels: [],
    });
    missing = true;
    expect(await adapter.checkReadiness()).toMatchObject({
      state: "DEPENDENCY_MISSING",
      missingNodes: ["ImageScale"],
      missingModels: [testCheckpoint],
    });
    outage = true;
    expect(await adapter.checkReadiness()).toMatchObject({ state: "UNREACHABLE" });
    expect(fetch.mock.calls.every(([url]) => !String(url).includes("/prompt"))).toBe(true);
  });

  it("uploads only frozen verified reference bytes before sending one prompt", async () => {
    const fetch = transport(async (url, init) => {
      expect(url.origin).toBe(origin);
      expect(init?.redirect).toBe("error");
      if (url.pathname === "/upload/image") {
        expect(init?.body).toBeInstanceOf(FormData);
        const form = init?.body as FormData;
        const image = form.get("image") as File;
        expect(form.get("type")).toBe("input");
        expect(image.name).toBe("ads-comfyui-v1-" + attemptId + ".png");
        expect(Buffer.from(await image.arrayBuffer())).toEqual(png());
        return json({ name: image.name, type: "input", subfolder: "" });
      }
      expect(url.pathname).toBe("/prompt");
      expect(JSON.parse(String(init?.body))).toEqual({ prompt: graph(true) });
      return json({ prompt_id: promptId, number: 1, node_errors: {} });
    });
    const adapter = new ComfyUiImageAdapter(configuration, {
      ...options,
      fetch,
      apiKey: "secret-for-test",
    });
    expect(await adapter.submit(input(true))).toMatchObject({
      kind: "waiting",
      providerRequestId: promptId,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(
      fetch.mock.calls.every(
        ([, init]) => new Headers(init?.headers).get("Authorization") === "Bearer secret-for-test",
      ),
    ).toBe(true);
  });

  it("does not send a prompt after missing, altered or rejected reference input", async () => {
    const fetch = transport((url) => {
      expect(url.pathname).toBe("/upload/image");
      return json({ name: "wrong.png", type: "input", subfolder: "" });
    });
    const adapter = new ComfyUiImageAdapter(configuration, { ...options, fetch });
    const original = input(true);
    expect(await adapter.submit({ ...original, resolvedSourceImage: undefined })).toMatchObject({
      kind: "failed",
      errorCode: "COMFYUI_REFERENCE_INVALID",
    });
    expect(
      await adapter.submit({
        ...original,
        resolvedSourceImage: { ...original.resolvedSourceImage!, bytes: png(513) },
      }),
    ).toMatchObject({ kind: "failed", errorCode: "COMFYUI_REFERENCE_INVALID" });
    expect(fetch).not.toHaveBeenCalled();
    expect(await adapter.submit(original)).toMatchObject({
      kind: "failed",
      errorCode: "COMFYUI_UPLOAD_FAILED",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("distinguishes a clear rejected request from response loss without resubmitting", async () => {
    const fetch = transport(() =>
      json({ error: { type: "prompt_outputs_failed_validation" }, node_errors: {} }, 400),
    );
    const adapter = new ComfyUiImageAdapter(configuration, { ...options, fetch });
    expect(await adapter.submit(input())).toMatchObject({
      kind: "failed",
      retryable: false,
      errorCode: "COMFYUI_PROMPT_REJECTED",
    });
    fetch.mockImplementationOnce(async () => {
      throw new Error("connection ended after writing");
    });
    await expect(adapter.submit(input())).rejects.toBeInstanceOf(MediaSubmissionUnknownError);
    fetch.mockResolvedValueOnce(json({ prompt_id: promptId, error: "ambiguous" }, 500));
    await expect(adapter.submit(input())).rejects.toMatchObject({ providerRequestId: promptId });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("recovers a prior id over HTTP and keeps missing history, queue and disconnects nonterminal", async () => {
    let stage = "queued";
    const fetch = transport((url) => {
      if (url.pathname === "/history/" + promptId)
        return stage === "completed" ? json(history()) : json({});
      expect(url.pathname).toBe("/queue");
      if (stage === "running") return queue([promptId]);
      if (stage === "queued") return queue([], [promptId, otherId]);
      if (stage === "disconnect") throw new Error("socket closed");
      return queue();
    });
    const adapter = new ComfyUiImageAdapter(
      { ...configuration, enabled: false },
      { ...options, fetch },
    );
    const first = await adapter.inspect(promptId);
    expect(first).toMatchObject({ state: "ACTIVE", metadata: { phase: "queued" } });
    expect((await adapter.inspect(promptId)).normalizedEventKey).toBe(first.normalizedEventKey);
    stage = "running";
    expect(await adapter.inspect(promptId)).toMatchObject({
      state: "ACTIVE",
      metadata: { phase: "running" },
    });
    for (stage of ["disconnect", "missing"]) {
      expect(await adapter.inspect(promptId)).toMatchObject({
        state: "UNKNOWN",
        metadata: { phase: "unavailable" },
      });
    }
    stage = "completed";
    expect(await adapter.inspect(promptId)).toMatchObject({
      state: "SUCCEEDED",
      outputs: [{ metadata: { comfyUiAttemptId: attemptId }, retrieval: { kind: "HANDLE" } }],
      accounting: { costs: [] },
    });
    expect(fetch.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });

  it("rejects no outputs, untrusted output paths and nonreviewed graphs", async () => {
    for (const changes of [
      { outputs: {} },
      { outputs: { "9": { images: [{ ...file, filename: "../other.png" }] } } },
      { outputs: { "9": { images: [{ ...file, subfolder: "../input" }] } } },
      { outputs: { "9": { images: [{ ...file, type: "input" }] } } },
      { outputs: { "9": { images: [{ ...file, filename: "https://other.local/image.png" }] } } },
      { outputs: { "9": { images: [{ ...file, filename: otherId + "_00001_.png" }] } } },
      {
        prompt: [
          1,
          promptId,
          { ...graph(), "20": { class_type: "CustomNode", inputs: {} } },
          {},
          ["9"],
        ],
      },
    ]) {
      const fetch = transport(() => json(history(changes)));
      const adapter = new ComfyUiImageAdapter(configuration, { ...options, fetch });
      expect(await adapter.inspect(promptId)).toMatchObject({
        state: "FAILED",
        errorCode: "COMFYUI_OUTPUT_INVALID",
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("retrieves the recorded PNG from the fixed /view origin and permits safe retrieval retries", async () => {
    const image = png();
    let phase = "network failure";
    const fetch = transport((url) => {
      if (url.pathname === "/history/" + promptId) return json(history());
      expect(url.origin).toBe(origin);
      expect(url.pathname).toBe("/view");
      expect(Object.fromEntries(url.searchParams)).toEqual(file);
      if (phase === "network failure") throw new Error("connection dropped");
      if (phase === "oversize")
        return new Response("", {
          headers: { "Content-Length": String(COMFYUI_IMAGE_MAX_BYTES + 1) },
        });
      if (phase === "wrong bytes")
        return new Response("fake", { headers: { "Content-Type": "image/png" } });
      if (phase === "wrong size")
        return new Response(Uint8Array.from(png(576, 1024)), {
          headers: { "Content-Type": "image/png" },
        });
      return new Response(Uint8Array.from(image), { headers: { "Content-Type": "image/png" } });
    });
    const adapter = new ComfyUiImageAdapter(configuration, { ...options, fetch });
    const result = await adapter.inspect(promptId);
    expect(result.state).toBe("SUCCEEDED");
    const output = result.outputs![0]!;
    await expect(adapter.resolveOutput(output)).rejects.toThrow("COMFYUI_OUTPUT_DOWNLOAD_FAILED");
    for (phase of ["oversize", "wrong bytes", "wrong size"]) {
      await expect(adapter.resolveOutput(output)).rejects.toThrow("COMFYUI_OUTPUT_INVALID");
    }
    phase = "valid";
    await expect(adapter.resolveOutput(output)).resolves.toEqual({
      uri: "data:image/png;base64," + image.toString("base64"),
    });
    const arbitrary: MediaProviderOutput = {
      ...output,
      retrieval: { kind: "URI", uri: "https://other.local/image.png" },
    };
    await expect(adapter.resolveOutput(arbitrary)).rejects.toThrow("COMFYUI_OUTPUT_INVALID");
    const handle = Buffer.from(
      JSON.stringify({ filename: "../other.png", width: 512, height: 512 }),
    ).toString("base64url");
    await expect(
      adapter.resolveOutput({ ...output, retrieval: { kind: "HANDLE", handle } }),
    ).rejects.toThrow("COMFYUI_OUTPUT_INVALID");
    expect(fetch.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
  });

  it("offers cancellation only for explicitly verified support and only targets the requested id", async () => {
    let targetPresent = true;
    const fetch = transport((url) => {
      if (url.pathname.startsWith("/history/")) return json({});
      if (url.pathname === "/queue")
        return queue([], targetPresent ? [promptId, otherId] : [otherId]);
      expect(url.pathname).toBe("/api/jobs/" + promptId + "/cancel");
      targetPresent = false;
      return json({ cancelled: true });
    });
    expect(new ComfyUiImageAdapter(configuration, { ...options, fetch }).cancel).toBeUndefined();
    const adapter = new ComfyUiImageAdapter(configuration, {
      ...options,
      fetch,
      targetedCancellation: true,
    });
    await expect(adapter.cancel!(promptId)).resolves.toBeUndefined();
    const posted = fetch.mock.calls
      .filter(([, init]) => init?.method === "POST")
      .map(([url]) => new URL(String(url)).pathname);
    expect(posted).toEqual(["/api/jobs/" + promptId + "/cancel"]);
    expect(await adapter.inspect(otherId)).toMatchObject({
      state: "ACTIVE",
      metadata: { phase: "queued" },
    });
  });

  it("waits for specific interruption history when the task was already running", async () => {
    let phase = "running";
    let ack = true;
    const fetch = transport((url) => {
      if (url.pathname.startsWith("/history/"))
        return phase === "interrupted"
          ? json(
              history({
                status: {
                  status_str: "error",
                  messages: [["execution_interrupted", { prompt_id: promptId }]],
                },
              }),
            )
          : json({});
      if (url.pathname === "/queue")
        return phase === "running" ? queue([promptId, otherId]) : queue([otherId]);
      expect(url.pathname).toBe("/api/jobs/" + promptId + "/cancel");
      return json({ cancelled: ack });
    });
    const adapter = new ComfyUiImageAdapter(configuration, {
      ...options,
      fetch,
      targetedCancellation: true,
    });
    await expect(adapter.cancel!(promptId)).rejects.toThrow("COMFYUI_CANCEL_NOT_CONFIRMED");
    ack = false;
    await expect(adapter.cancel!(promptId)).rejects.toThrow("COMFYUI_CANCEL_NOT_CONFIRMED");
    phase = "interrupted";
    await expect(adapter.cancel!(promptId)).resolves.toBeUndefined();
    expect(await adapter.inspect(promptId)).toMatchObject({ state: "CANCELED" });
    expect(await adapter.inspect(otherId)).toMatchObject({
      state: "ACTIVE",
      metadata: { phase: "running" },
    });
  });
});
