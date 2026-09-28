import { afterEach, describe, expect, it, vi } from "vitest";
import { startStaleRecalculationPolling } from "./stale-recalculation";

afterEach(() => {
  vi.useRealTimers();
});

describe("stale recalculation polling", () => {
  it("starts immediately and retries a failed batch on the next interval", async () => {
    vi.useFakeTimers();
    const failure = new Error("transaction failed");
    const advance = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(true);
    const onError = vi.fn();
    const poller = startStaleRecalculationPolling(
      { continueStaleRecalculation: advance },
      100,
      onError,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(advance).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(failure);
    await vi.advanceTimersByTimeAsync(100);
    expect(advance).toHaveBeenCalledTimes(2);
    await poller.shutdown();
  });

  it("does not overlap batches and waits for the active transaction at shutdown", async () => {
    vi.useFakeTimers();
    let resolveBatch: ((value: boolean) => void) | undefined;
    const advance = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveBatch = resolve;
        }),
    );
    const poller = startStaleRecalculationPolling({ continueStaleRecalculation: advance }, 100);
    await vi.advanceTimersByTimeAsync(500);
    expect(advance).toHaveBeenCalledTimes(1);
    let stopped = false;
    const shutdown = poller.shutdown().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(stopped).toBe(false);
    resolveBatch?.(true);
    await shutdown;
    expect(stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(advance).toHaveBeenCalledTimes(1);
  });
});
