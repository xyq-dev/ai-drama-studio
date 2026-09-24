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

export class MockProvider {
  private readonly firstDelayedPollPending = new Set<string>();

  requestIdFor(clientRequestKey: string, outcome: MockOutcome = "success"): string {
    return `mock|${outcome}|${clientRequestKey}`;
  }

  submit(input: MockSubmitInput): MockSubmitResult {
    const effectiveOutcome: MockOutcome = input.cancelRequested ? "cancel" : input.outcome;
    const providerRequestId = this.requestIdFor(input.clientRequestKey, effectiveOutcome);

    if (effectiveOutcome === "cancel") {
      return { kind: "canceled", providerRequestId };
    }
    if (effectiveOutcome === "success") {
      return { kind: "succeeded", providerRequestId, output: { outcome: "success" } };
    }
    if (effectiveOutcome === "retryable_failure") {
      return {
        kind: "failed",
        providerRequestId,
        retryable: true,
        errorCode: "MOCK_RETRYABLE",
        errorMessage: "Mock provider requested a retry",
      };
    }
    if (effectiveOutcome === "terminal_failure") {
      return {
        kind: "failed",
        providerRequestId,
        retryable: false,
        errorCode: "MOCK_TERMINAL",
        errorMessage: "Mock provider failed terminally",
      };
    }

    this.firstDelayedPollPending.add(providerRequestId);
    return {
      kind: "waiting",
      providerRequestId,
      nextPollAt: new Date().toISOString(),
    };
  }

  inspect(providerRequestId: string): MockRequestState {
    const outcome = parseRequestOutcome(providerRequestId);
    if (!outcome) return "UNKNOWN";
    if (outcome === "success") return "SUCCEEDED";
    if (outcome === "retryable_failure" || outcome === "terminal_failure") return "FAILED";
    if (outcome === "cancel") return "CANCELED";
    if (this.firstDelayedPollPending.delete(providerRequestId)) return "ACTIVE";
    return "SUCCEEDED";
  }

  completeDelayed(providerRequestId: string): void {
    if (parseRequestOutcome(providerRequestId) !== "delayed") {
      throw new Error("Delayed mock request is not active");
    }
    this.firstDelayedPollPending.delete(providerRequestId);
  }

  capabilities(): { providerKey: "mock"; capability: "mock.generate"; outcomes: readonly MockOutcome[] } {
    return { providerKey: "mock", capability: "mock.generate", outcomes: MOCK_OUTCOMES };
  }
}

function parseRequestOutcome(providerRequestId: string): MockOutcome | null {
  for (const outcome of MOCK_OUTCOMES) {
    if (providerRequestId.startsWith(`mock|${outcome}|`)) return outcome;
  }
  return null;
}
