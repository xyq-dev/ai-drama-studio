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
  it("returns deterministic successful media assets", async () => {
    const adapter = new MockMediaAdapter();
    const input = {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      projectId: "22222222-2222-4222-8222-222222222222",
      shotRevisionId: "33333333-3333-4333-8333-333333333333",
      generationJobId: "44444444-4444-4444-8444-444444444444",
      jobAttemptId: "55555555-5555-4555-8555-555555555555",
      providerConfigurationId: "66666666-6666-4666-8666-666666666666",
      clientRequestKey: "shot:1:image",
      inputHash: "ab".repeat(32),
      inputSnapshot: { prompt: "frame" },
      traceId: "trace-media",
      capability: "image.generate" as const,
    };
    const first = await adapter.submit(input);
    const second = await adapter.submit(input);
    expect(first).toEqual(second);
    expect(first.kind).toBe("succeeded");
    if (first.kind === "succeeded") {
      expect(first.providerRequestId).toBe("mock-media|image.generate|shot:1:image");
      expect(first.assets[0]).toMatchObject({ kind: "IMAGE", mimeType: "image/png", byteSize: 1 });
    }
  });

  it("normalizes delayed, retryable, terminal and canceled outcomes", async () => {
    const adapter = new MockMediaAdapter();
    const base = {
      workspaceId: "11111111-1111-4111-8111-111111111111",
      projectId: "22222222-2222-4222-8222-222222222222",
      generationJobId: "44444444-4444-4444-8444-444444444444",
      jobAttemptId: "55555555-5555-4555-8555-555555555555",
      providerConfigurationId: "66666666-6666-4666-8666-666666666666",
      inputHash: "ab".repeat(32),
      traceId: "trace-media",
      capability: "video.generate" as const,
    };
    const delayed = await adapter.submit({ ...base, clientRequestKey: "delayed", inputSnapshot: { outcome: "delayed" } });
    const retryable = await adapter.submit({ ...base, clientRequestKey: "retry", inputSnapshot: { outcome: "retryable_failure" } });
    const terminal = await adapter.submit({ ...base, clientRequestKey: "terminal", inputSnapshot: { outcome: "terminal_failure" } });
    const canceled = await adapter.submit({ ...base, clientRequestKey: "cancel", inputSnapshot: { outcome: "cancel" } });
    expect(delayed.kind).toBe("waiting");
    if (delayed.kind === "waiting") {
      expect(await adapter.inspect(delayed.providerRequestId)).toBe("ACTIVE");
      expect(await adapter.inspect(delayed.providerRequestId)).toBe("SUCCEEDED");
    }
    expect(retryable).toMatchObject({ kind: "failed", retryable: true });
    expect(terminal).toMatchObject({ kind: "failed", retryable: false });
    expect(canceled.kind).toBe("canceled");
  });
});
