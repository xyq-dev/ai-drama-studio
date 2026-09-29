import { afterEach, describe, expect, it, vi } from "vitest";
import { retryAt } from "./retry";

afterEach(() => { vi.restoreAllMocks(); });

describe("retry timing", () => {
  it("preserves deterministic backoff when the provider hint is absent or shorter", () => {
    const now = 1_790_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const original = retryAt("same-job", 1);
    expect(original.getTime()).toBeGreaterThanOrEqual(now + 30_000);
    expect(original.getTime()).toBeLessThanOrEqual(now + 36_000);
    expect(retryAt("same-job", 1)).toEqual(original);
    expect(retryAt("same-job", 1, 0)).toEqual(original);
    expect(retryAt("same-job", 1, 1)).toEqual(original);
  });

  it("honors a provider cooldown even when it exceeds the repository backoff cap", () => {
    const now = 1_790_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    expect(retryAt("rate-limited-job", 8, 3_600_000).getTime()).toBe(now + 3_600_000);
  });
});
