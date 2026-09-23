import { describe, expect, it, vi } from "vitest";
import { RedisHealthProbe, type RedisProbeClient } from "./index";

function createClient(overrides: Partial<RedisProbeClient> = {}): RedisProbeClient {
  return {
    status: "ready",
    connect: vi.fn().mockResolvedValue(undefined),
    ping: vi.fn().mockResolvedValue("PONG"),
    quit: vi.fn().mockResolvedValue("OK"),
    disconnect: vi.fn(),
    on: vi.fn(),
    ...overrides,
  };
}

describe("RedisHealthProbe", () => {
  it("reports ok when Redis responds", async () => {
    const client = createClient();
    const probe = new RedisHealthProbe({ redisUrl: "redis://redacted", timeoutMs: 100 }, () => client);

    await expect(probe.check()).resolves.toBe("ok");
  });

  it("reports down without exposing a Redis error", async () => {
    const client = createClient({ ping: vi.fn().mockRejectedValue(new Error("redis://secret@host")) });
    const probe = new RedisHealthProbe({ redisUrl: "redis://secret@host", timeoutMs: 100 }, () => client);

    await expect(probe.check()).resolves.toBe("down");
  });

  it("bounds the complete check with a strict timeout", async () => {
    vi.useFakeTimers();
    try {
      const client = createClient({ ping: vi.fn().mockReturnValue(new Promise(() => undefined)) });
      const probe = new RedisHealthProbe({ redisUrl: "redis://redacted", timeoutMs: 25 }, () => client);
      const result = probe.check();

      await vi.advanceTimersByTimeAsync(25);

      await expect(result).resolves.toBe("down");
      expect(client.disconnect).toHaveBeenCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("explicitly reconnects on the check after a failure", async () => {
    let status: RedisProbeClient["status"] = "ready";
    const client = createClient({
      ping: vi.fn().mockImplementationOnce(async () => {
        status = "end";
        throw new Error("connection lost");
      }).mockResolvedValueOnce("PONG"),
      connect: vi.fn().mockImplementation(async () => {
        status = "ready";
      }),
    });
    Object.defineProperty(client, "status", { get: () => status });
    const probe = new RedisHealthProbe({ redisUrl: "redis://redacted", timeoutMs: 100 }, () => client);

    await expect(probe.check()).resolves.toBe("down");
    await expect(probe.check()).resolves.toBe("ok");
    expect(client.connect).toHaveBeenCalledOnce();
  });

  it("shuts down safely and remains down afterwards", async () => {
    const client = createClient({ quit: vi.fn().mockRejectedValue(new Error("already closed")) });
    const probe = new RedisHealthProbe({ redisUrl: "redis://redacted", timeoutMs: 100 }, () => client);

    await probe.shutdown();
    await probe.shutdown();

    expect(client.quit).toHaveBeenCalledOnce();
    expect(client.disconnect).toHaveBeenCalledOnce();
    await expect(probe.check()).resolves.toBe("down");
  });
});
