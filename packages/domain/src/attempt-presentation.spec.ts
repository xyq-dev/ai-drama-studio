import { describe, expect, it } from "vitest";
import { presentStoredAttempt } from "./attempt-presentation";

describe("attempt presentation", () => {
  it("shows duration from timestamps and leaves an unpriced attempt unknown", () => {
    const view = presentStoredAttempt({
      attemptNo: 2,
      providerKey: "mock-media",
      model: "mock-image",
      startedAt: "2026-10-05T00:00:00.000Z",
      finishedAt: "2026-10-05T00:00:01.500Z",
      errorCode: null,
      inputHash: "ab".repeat(32),
      requestBytes: 40,
      costAmount: null,
      costCurrency: null,
      costKind: null,
    });
    expect(view.status).toBe("finished");
    expect(view.durationMs).toBe(1500);
    expect(view.cost).toEqual({ status: "unknown", amount: null, currency: null, kind: null });
  });

  it("passes through a recorded ledger amount without inventing zero", () => {
    const view = presentStoredAttempt({
      attemptNo: 1,
      providerKey: null,
      model: null,
      startedAt: null,
      finishedAt: null,
      errorCode: "TIMEOUT",
      inputHash: null,
      requestBytes: 0,
      costAmount: "1.25000000",
      costCurrency: "USD",
      costKind: "ACTUAL",
    });
    expect(view.status).toBe("running");
    expect(view.durationMs).toBeNull();
    expect(view.cost).toEqual({ status: "recorded", amount: "1.25000000", currency: "USD", kind: "ACTUAL" });
  });
});
