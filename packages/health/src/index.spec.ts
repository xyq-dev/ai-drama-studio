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
    expect(client.disconnect).toHaveBeenCalledWith(false);
  });

  it("discards a client whose connect times out", async () => {
    vi.useFakeTimers();
    try {
      const client = createClient({
        status: "wait",
        connect: vi.fn().mockReturnValue(new Promise(() => undefined)),
      });
      const probe = new RedisHealthProbe({ redisUrl: "redis://redacted", timeoutMs: 25 }, () => client);
      const result = probe.check();

      await vi.advanceTimersByTimeAsync(25);

      await expect(result).resolves.toBe("down");
      expect(client.disconnect).toHaveBeenCalledWith(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards a client whose ping times out", async () => {
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

  it("creates a fresh client on the check after a failure", async () => {
    const firstClient = createClient({ ping: vi.fn().mockRejectedValue(new Error("connection lost")) });
    const secondClient = createClient();
    const clientFactory = vi.fn()
      .mockReturnValueOnce(firstClient)
      .mockReturnValueOnce(secondClient);
    const probe = new RedisHealthProbe({ redisUrl: "redis://redacted", timeoutMs: 100 }, clientFactory);

    await expect(probe.check()).resolves.toBe("down");
    expect(firstClient.disconnect).toHaveBeenCalledWith(false);
    await expect(probe.check()).resolves.toBe("ok");
    expect(clientFactory).toHaveBeenCalledTimes(2);
    expect(secondClient.ping).toHaveBeenCalledOnce();
  });

  it("shares an active check and client between concurrent callers", async () => {
    let resolvePing: ((value: string) => void) | undefined;
    const client = createClient({
      ping: vi.fn().mockReturnValue(new Promise<string>((resolve) => {
        resolvePing = resolve;
      })),
    });
    const clientFactory = vi.fn(() => client);
    const probe = new RedisHealthProbe({ redisUrl: "redis://redacted", timeoutMs: 100 }, clientFactory);

    const firstCheck = probe.check();
    const secondCheck = probe.check();
    expect(secondCheck).toBe(firstCheck);
    expect(clientFactory).toHaveBeenCalledOnce();

    resolvePing?.("PONG");
    await expect(firstCheck).resolves.toBe("ok");
  });

  it("shuts down safely and remains down afterwards", async () => {
    const client = createClient({
      quit: vi.fn().mockRejectedValue(new Error("already closed")),
      disconnect: vi.fn(() => {
        throw new Error("disconnect failed");
      }),
    });
    const clientFactory = vi.fn(() => client);
    const probe = new RedisHealthProbe({ redisUrl: "redis://redacted", timeoutMs: 100 }, clientFactory);

    await expect(probe.check()).resolves.toBe("ok");

    await expect(probe.shutdown()).resolves.toBeUndefined();
    await expect(probe.shutdown()).resolves.toBeUndefined();

    expect(client.quit).toHaveBeenCalledOnce();
    expect(client.disconnect).toHaveBeenCalledOnce();
    await expect(probe.check()).resolves.toBe("down");
    expect(clientFactory).toHaveBeenCalledOnce();
  });

  it("does not create a client when shut down before the first check", async () => {
    const clientFactory = vi.fn(() => createClient());
    const probe = new RedisHealthProbe({ redisUrl: "redis://redacted", timeoutMs: 100 }, clientFactory);

    await probe.shutdown();

    await expect(probe.check()).resolves.toBe("down");
    expect(clientFactory).not.toHaveBeenCalled();
  });
});
