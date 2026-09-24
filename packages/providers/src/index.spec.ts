import { describe, expect, it } from "vitest";
import { MockProvider } from "./index";

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
