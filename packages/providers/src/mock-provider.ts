export const MOCK_OUTCOMES = [
  "success",
  "retryable_failure",
  "terminal_failure",
  "cancel",
  "delayed",
] as const;

export type MockOutcome = (typeof MOCK_OUTCOMES)[number];

export type MockRequestState = "ACTIVE" | "SUCCEEDED" | "FAILED" | "CANCELED" | "UNKNOWN";

export interface MockSubmitInput {
  clientRequestKey: string;
  outcome: MockOutcome;
  cancelRequested?: boolean;
}

export type MockSubmitResult =
  | { kind: "succeeded"; providerRequestId: string; output: { outcome: "success" } }
  | { kind: "failed"; providerRequestId: string; retryable: boolean; errorCode: string; errorMessage: string }
  | { kind: "canceled"; providerRequestId: string }
  | { kind: "waiting"; providerRequestId: string; nextPollAt: string };

interface StoredRequest {
  state: Exclude<MockRequestState, "UNKNOWN">;
  outcome: MockOutcome;
}

export class MockProvider {
  private readonly requests = new Map<string, StoredRequest>();

  requestIdFor(clientRequestKey: string): string {
    return `mock:${clientRequestKey}`;
  }

  submit(input: MockSubmitInput): MockSubmitResult {
    const providerRequestId = this.requestIdFor(input.clientRequestKey);
    if (input.outcome === "cancel" || input.cancelRequested) {
      this.requests.set(providerRequestId, { state: "CANCELED", outcome: input.outcome });
      return { kind: "canceled", providerRequestId };
    }
    if (input.outcome === "success") {
      this.requests.set(providerRequestId, { state: "SUCCEEDED", outcome: input.outcome });
      return { kind: "succeeded", providerRequestId, output: { outcome: "success" } };
    }
    if (input.outcome === "retryable_failure") {
      this.requests.set(providerRequestId, { state: "FAILED", outcome: input.outcome });
      return {
        kind: "failed",
        providerRequestId,
        retryable: true,
        errorCode: "MOCK_RETRYABLE",
        errorMessage: "Mock provider requested a retry",
      };
    }
    if (input.outcome === "terminal_failure") {
      this.requests.set(providerRequestId, { state: "FAILED", outcome: input.outcome });
      return {
        kind: "failed",
        providerRequestId,
        retryable: false,
        errorCode: "MOCK_TERMINAL",
        errorMessage: "Mock provider failed terminally",
      };
    }
    this.requests.set(providerRequestId, { state: "ACTIVE", outcome: "delayed" });
    return {
      kind: "waiting",
      providerRequestId,
      nextPollAt: new Date(Date.now() + 60_000).toISOString(),
    };
  }

  inspect(providerRequestId: string): MockRequestState {
    return this.requests.get(providerRequestId)?.state ?? "UNKNOWN";
  }

  completeDelayed(providerRequestId: string): void {
    const current = this.requests.get(providerRequestId);
    if (!current || current.state !== "ACTIVE") {
      throw new Error("Delayed mock request is not active");
    }
    this.requests.set(providerRequestId, { ...current, state: "SUCCEEDED" });
  }

  capabilities(): { providerKey: "mock"; capability: "mock.generate"; outcomes: readonly MockOutcome[] } {
    return { providerKey: "mock", capability: "mock.generate", outcomes: MOCK_OUTCOMES };
  }
}
