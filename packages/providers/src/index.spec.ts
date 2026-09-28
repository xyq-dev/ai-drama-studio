import { describe, expect, it } from "vitest";
import { MockMediaAdapter, MockProvider } from "./index";

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
