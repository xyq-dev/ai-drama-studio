import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SAMPLE_VIDEO_DESCRIPTIONS, SAMPLE_VIDEO_SCHEMA } from "@ai-drama/contracts";
import { MOCK_VIDEO_FIXTURE, MockMediaAdapter, MockProvider, MockTextAdapter, sampleVideoBytes } from "./index";

describe("MockProvider", () => {
  it("returns deterministic request ids and the requested outcome", () => {
    const provider = new MockProvider();
    const first = provider.submit({ clientRequestKey: "job:1", outcome: "success" });
    const second = provider.submit({ clientRequestKey: "job:1", outcome: "success" });
    expect(first.kind).toBe("succeeded");
    expect(first.providerRequestId).toBe("mock|success|job:1");
    expect(second.providerRequestId).toBe(first.providerRequestId);
    expect(provider.inspect(first.providerRequestId)).toBe("SUCCEEDED");
    expect(new MockProvider().inspect(first.providerRequestId)).toBe("SUCCEEDED");
  });

  it("records retryable, terminal, canceled, and delayed requests", () => {
    const provider = new MockProvider();
    const retryable = provider.submit({ clientRequestKey: "a", outcome: "retryable_failure" });
    const terminal = provider.submit({ clientRequestKey: "b", outcome: "terminal_failure" });
    const canceled = provider.submit({ clientRequestKey: "c", outcome: "success", cancelRequested: true });
    const delayed = provider.submit({ clientRequestKey: "d", outcome: "delayed" });
    expect(retryable).toMatchObject({ kind: "failed", retryable: true, errorCode: "MOCK_RETRYABLE" });
    expect(terminal).toMatchObject({ kind: "failed", retryable: false, errorCode: "MOCK_TERMINAL" });
    expect(canceled.kind).toBe("canceled");
    expect(delayed.kind).toBe("waiting");
    expect(provider.inspect(delayed.providerRequestId)).toBe("ACTIVE");
    provider.completeDelayed(delayed.providerRequestId);
    expect(provider.inspect(delayed.providerRequestId)).toBe("SUCCEEDED");
    expect(new MockProvider().inspect(delayed.providerRequestId)).toBe("SUCCEEDED");
    expect(provider.inspect("missing")).toBe("UNKNOWN");
  });
});

describe("MockTextAdapter", () => {
  it("is replay-safe and returns deterministic structured output from complete frozen content", async () => {
    const adapter = new MockTextAdapter();
    const request = { schema: "m2.text.request.v1" as const, kind: "SCENES" as const,
      projectId: "22222222-2222-4222-8222-222222222222", sources: [1, 2, 3].map((episodeNo) => ({
        episodeId: `${episodeNo}1111111-1111-4111-8111-111111111111`, episodeNo,
        episodeVersion: 1, scriptRevisionId: `${episodeNo}2222222-2222-4222-8222-222222222222`,
        scriptContent: { episodeNo, line: `frozen-${episodeNo}` },
      })) };
    const context = { requestId: "mock|success|job:1", idempotencyKey: "hash", providerKey: "mock-text" };
    expect(adapter.replayPolicy).toBe("REPLAY_SAFE_SYNC");
    expect(await adapter.generate(request, context)).toEqual(await adapter.generate(request, context));
    expect((await adapter.generate(request, context))).toMatchObject({ kind: "succeeded",
      output: { schema: "m2.text.scenes.output.v1", scenes: [{ episodeNo: 1 }, { episodeNo: 2 }, { episodeNo: 3 }] } });
  });
});


describe("MockMediaAdapter", () => {
  const baseInput = {
    workspaceId: "11111111-1111-4111-8111-111111111111",
    projectId: "22222222-2222-4222-8222-222222222222",
    shotRevisionId: "33333333-3333-4333-8333-333333333333",
    generationJobId: "44444444-4444-4444-8444-444444444444",
    jobAttemptId: "55555555-5555-4555-8555-555555555555",
    providerConfigurationId: "66666666-6666-4666-8666-666666666666",
    inputHash: "ab".repeat(32),
    traceId: "trace-media",
  };

  it("returns retrievable deterministic outputs plus actual accounting", async () => {
    const adapter = new MockMediaAdapter();
    const input = {
      ...baseInput,
      clientRequestKey: "shot:1:image",
      inputSnapshot: { prompt: "frame" },
      capability: "image.generate" as const,
    };
    const first = await adapter.submit(input);
    const second = await adapter.submit(input);
    expect(first).toEqual(second);
    expect(first.kind).toBe("succeeded");
    if (first.kind !== "succeeded") throw new Error("expected mock media success");

    expect(first.providerRequestId).toBe("mock-media|image.generate|shot:1:image");
    expect(first.outputs).toHaveLength(1);
    expect(first.outputs[0]).toMatchObject({
      kind: "IMAGE",
      retrieval: { kind: "HANDLE" },
      mimeTypeHint: "image/png",
    });
    expect(first.accounting).toMatchObject({
      provider: "mock-media",
      model: "mock-v1",
      usage: { requests: 1 },
    });
    expect(first.accounting?.costs[0]).toMatchObject({
      kind: "ACTUAL",
      currency: "USD",
      basis: "PROVIDER_REPORTED",
    });

    const resolved = await adapter.resolveOutput(first.outputs[0]!);
    expect(resolved.uri).toMatch(/^data:image\/png;base64,/);
  });

  it.each([
    ["image.generate", "image/png"],
    ["video.generate", "video/mp4"],
    ["audio.tts", "audio/wav"],
    ["audio.music", "audio/wav"],
    ["subtitle.generate", "text/vtt"],
    ["media.compose_input_validate", "application/json"],
  ] as const)("returns a valid %s fixture for %s", async (capability, mimeType) => {
    const adapter = new MockMediaAdapter();
    const submitted = await adapter.submit({
      ...baseInput,
      capability,
      clientRequestKey: `fixture:${capability}`,
      inputSnapshot: {},
    });
    if (submitted.kind !== "succeeded") throw new Error("expected mock success");
    const output = submitted.outputs[0];
    const resolved = await adapter.resolveOutput(output);
    const polled = await adapter.inspect(submitted.providerRequestId);
    if (polled.state !== "SUCCEEDED") throw new Error("expected mock poll success");
    expect(await adapter.resolveOutput(polled.outputs[0])).toEqual(resolved);

    const prefix = `data:${mimeType};base64,`;
    expect(resolved.uri.startsWith(prefix)).toBe(true);
    const bytes = Buffer.from(resolved.uri.slice(prefix.length), "base64");
    expect(bytes.length).toBeGreaterThan(0);
    if (mimeType === "image/png") {
      expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(bytes.readUInt32BE(16)).toBe(1);
    } else if (mimeType === "video/mp4") {
      expect(bytes.toString("ascii", 4, 8)).toBe("ftyp");
      expect(bytes.includes(Buffer.from("avc1"))).toBe(true);
      expect(bytes.includes(Buffer.from("moov"))).toBe(true);
      expect(bytes.includes(Buffer.from("mdat"))).toBe(true);
      expect(bytes.length).toBe(1552);
      expect(createHash("sha256").update(bytes).digest("hex"))
        .toBe("6cbb357d0c5429c415430d0596dfc04417b9fa967eeb34e55186b0a3a9f590e3");
    } else if (mimeType === "audio/wav") {
      expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
      expect(bytes.toString("ascii", 8, 12)).toBe("WAVE");
      expect(bytes.readUInt32LE(4)).toBe(bytes.length - 8);
      expect(bytes.length).toBe(1644);
      expect(createHash("sha256").update(bytes).digest("hex"))
        .toBe("c726d333dd159a31423f3480dbb1c5c4a9dfcd30efe1f7e12ade390dc92e8908");
    } else if (mimeType === "application/json") {
      expect(JSON.parse(bytes.toString("utf8"))).toMatchObject({ valid: true });
    } else {
      expect(bytes.toString("utf8")).toMatch(/^WEBVTT\n\n00:00:00\.000 --> 00:00:00\.100/);
    }
  });

  it("normalizes delayed polls with distinct observation identities and accounting", async () => {
    const adapter = new MockMediaAdapter();
    const delayed = await adapter.submit({
      ...baseInput,
      clientRequestKey: "delayed",
      inputSnapshot: { outcome: "delayed" },
      capability: "video.generate",
    });
    expect(delayed.kind).toBe("waiting");
    if (delayed.kind !== "waiting") throw new Error("expected delayed result");
    expect(delayed.accounting?.costs[0]?.kind).toBe("ESTIMATED");

    const firstPoll = await adapter.inspect(delayed.providerRequestId);
    const secondPoll = await adapter.inspect(delayed.providerRequestId);
    expect(firstPoll.state).toBe("ACTIVE");
    expect(secondPoll.state).toBe("SUCCEEDED");
    expect(firstPoll.normalizedEventKey).not.toBe(secondPoll.normalizedEventKey);
    expect(firstPoll.responseHash).not.toBe(secondPoll.responseHash);
    expect(firstPoll.accounting?.costs[0]?.kind).toBe("ESTIMATED");
    expect(secondPoll.accounting?.costs[0]?.kind).toBe("ACTUAL");
    expect(secondPoll.outputs?.[0]).toMatchObject({
      kind: "VIDEO",
      retrieval: { kind: "HANDLE" },
      mimeTypeHint: "video/mp4",
    });

    const estimatedKey = delayed.accounting?.costs[0]?.idempotencyKey;
    expect(secondPoll.accounting?.costs[0]?.supersedesEstimateKey).toBe(estimatedKey);

    const restartedPoll = await new MockMediaAdapter().inspect(delayed.providerRequestId);
    expect(restartedPoll.state).toBe("SUCCEEDED");
    expect(restartedPoll.normalizedEventKey).toBe(secondPoll.normalizedEventKey);
    expect(restartedPoll.responseHash).toBe(secondPoll.responseHash);
  });

  it("keeps synchronous inspect accounting equivalent to submit without an estimate", async () => {
    const adapter = new MockMediaAdapter();
    const submitted = await adapter.submit({
      ...baseInput,
      clientRequestKey: "sync-video",
      inputSnapshot: { outcome: "success", executionMode: "sync" },
      capability: "video.generate",
    });
    if (submitted.kind !== "succeeded") throw new Error("expected sync success");
    expect(submitted.providerRequestId).toBe("mock-media|sync|video.generate|sync-video");
    expect(submitted.accounting?.costs[0]?.supersedesEstimateKey).toBeUndefined();
    const inspected = await new MockMediaAdapter().inspect(submitted.providerRequestId);
    expect(inspected.state).toBe("SUCCEEDED");
    expect(inspected.accounting).toEqual(submitted.accounting);
    expect(await adapter.inspect("mock-media|not-a-capability|x")).toMatchObject({ state: "UNKNOWN" });
  });

  it("requires normalized failure details on failed provider observations", () => {
    const failedObservation = {
      state: "FAILED" as const,
      normalizedEventKey: "poll:failed",
      responseHash: "ab".repeat(32),
      observedAt: new Date(0).toISOString(),
      retryable: true,
      errorCode: "MOCK_MEDIA_FAILED",
      errorMessage: "failed",
    };
    expect(failedObservation).toMatchObject({
      state: "FAILED",
      retryable: true,
      errorCode: "MOCK_MEDIA_FAILED",
      errorMessage: "failed",
    });
  });

  it("carries actual accounting for retryable, terminal and canceled outcomes", async () => {
    const adapter = new MockMediaAdapter();
    const retryable = await adapter.submit({
      ...baseInput,
      clientRequestKey: "retry",
      inputSnapshot: { outcome: "retryable_failure" },
      capability: "video.generate",
    });
    const terminal = await adapter.submit({
      ...baseInput,
      clientRequestKey: "terminal",
      inputSnapshot: { outcome: "terminal_failure" },
      capability: "video.generate",
    });
    const canceled = await adapter.submit({
      ...baseInput,
      clientRequestKey: "cancel",
      inputSnapshot: { outcome: "cancel" },
      capability: "video.generate",
    });
    expect(retryable).toMatchObject({ kind: "failed", retryable: true });
    expect(terminal).toMatchObject({ kind: "failed", retryable: false });
    expect(canceled.kind).toBe("canceled");
    expect(retryable.accounting?.costs[0]?.kind).toBe("ACTUAL");
    expect(terminal.accounting?.costs[0]?.kind).toBe("ACTUAL");
    expect(canceled.accounting?.costs[0]?.kind).toBe("ACTUAL");
  });
});


describe("MediaProviderObservation contract", () => {
  it("requires non-empty outputs for successful media observations", async () => {
    const adapter = new MockMediaAdapter();
    const delayed = await adapter.submit({
      workspaceId: "11111111-1111-4111-8111-111111111111",
      projectId: "22222222-2222-4222-8222-222222222222",
      generationJobId: "44444444-4444-4444-8444-444444444444",
      jobAttemptId: "55555555-5555-4555-8555-555555555555",
      providerConfigurationId: "66666666-6666-4666-8666-666666666666",
      clientRequestKey: "observation-success",
      inputHash: "ab".repeat(32),
      inputSnapshot: { outcome: "delayed" },
      traceId: "trace-observation",
      capability: "image.generate",
    });
    expect(delayed.kind).toBe("waiting");
    if (delayed.kind !== "waiting") throw new Error("expected waiting result");
    await adapter.inspect(delayed.providerRequestId);
    const success = await adapter.inspect(delayed.providerRequestId);
    expect(success.state).toBe("SUCCEEDED");
    if (success.state !== "SUCCEEDED") throw new Error("expected successful observation");
    expect(success.outputs.length).toBeGreaterThan(0);
  });
});

describe("sample video adapter", () => {
  const jobId = "44444444-4444-4444-8444-444444444444";
  const description = SAMPLE_VIDEO_DESCRIPTIONS["sample-15s-a-v1"];
  const snapshot = {
    schema: SAMPLE_VIDEO_SCHEMA,
    ...description,
    shotRevisionId: "33333333-3333-4333-8333-333333333333",
    outcome: "success",
    executionMode: "sync",
    capability: "video.generate",
    sourceText: "技术验收样片",
    sourceHash: "cd".repeat(32),
  };

  it("rebuilds the same fixture from the request id on a fresh adapter", async () => {
    const adapter = new MockMediaAdapter();
    const submitted = await adapter.submit({
      workspaceId: "11111111-1111-4111-8111-111111111111",
      projectId: "22222222-2222-4222-8222-222222222222",
      generationJobId: jobId,
      jobAttemptId: "55555555-5555-4555-8555-555555555555",
      providerConfigurationId: "66666666-6666-4666-8666-666666666666",
      clientRequestKey: `${jobId}:1`,
      inputHash: "ab".repeat(32),
      inputSnapshot: snapshot,
      traceId: "sample",
      capability: "video.generate",
    });
    expect(submitted.kind).toBe("succeeded");
    if (submitted.kind !== "succeeded") throw new Error("expected success");
    expect(submitted.providerRequestId).toBe(`mock-media|sample-sync-v1|video.generate|sample-15s-a-v1|${jobId}:1`);
    const fresh = new MockMediaAdapter();
    const inspected = await fresh.inspect(submitted.providerRequestId);
    expect(inspected.state).toBe("SUCCEEDED");
    if (inspected.state !== "SUCCEEDED") throw new Error("expected inspection success");
    const resolved = await fresh.resolveOutput(inspected.outputs[0]);
    const prefix = "data:video/mp4;base64,";
    expect(resolved.uri.startsWith(prefix)).toBe(true);
    const bytes = Buffer.from(resolved.uri.slice(prefix.length), "base64");
    expect(bytes.equals(sampleVideoBytes("sample-15s-a-v1"))).toBe(true);
    expect(bytes.equals(MOCK_VIDEO_FIXTURE.bytes)).toBe(false);
    await expect(fresh.inspect("mock-media|sample-sync-v1|video.generate|sample-15s-a-v1|not-a-job:1")).resolves.toMatchObject({ state: "UNKNOWN" });
    const mismatched = { ...inspected.outputs[0], metadata: { providerRequestId: submitted.providerRequestId, fixtureId: "sample-15s-b-v1" } };
    await expect(fresh.resolveOutput(mismatched)).rejects.toThrow(/canonical fixture/);
  });
});
