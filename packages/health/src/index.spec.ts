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
    const factory = vi.fn(() => client);
    const probe = new RedisHealthProbe({ redisUrl: "redis://redacted", timeoutMs: 100 }, factory);

    await expect(probe.check()).resolves.toBe("ok");
    expect(factory).toHaveBeenCalledOnce();
  });

  it("reports down without exposing a Redis error", async () => {
    const client = createClient({ ping: vi.fn().mockRejectedValue(new Error("redis://secret@host")) });
    const probe = new RedisHealthProbe({ redisUrl: "redis://secret@host", timeoutMs: 100 }, () => client);

    await expect(probe.check()).resolves.toBe("down");
    expect(client.disconnect).toHaveBeenCalledWith(false);
  });

  it("creates a fresh client on the check after a failure", async () => {
    const failedClient = createClient({ ping: vi.fn().mockRejectedValue(new Error("connection lost")) });
    const recoveredClient = createClient();
    const factory = vi
      .fn()
      .mockReturnValueOnce(failedClient)
      .mockReturnValueOnce(recoveredClient);

    const probe = new RedisHealthProbe({ redisUrl: "redis://redacted", timeoutMs: 100 }, factory);

    await expect(probe.check()).resolves.toBe("down");
    await expect(probe.check()).resolves.toBe("ok");

    expect(failedClient.disconnect).toHaveBeenCalledWith(false);
    expect(recoveredClient.ping).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("discards the client when connect times out", async () => {
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

  it("discards the client when ping times out", async () => {
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

  it("deduplicates concurrent checks into one client operation", async () => {
    let resolvePing: ((value: string) => void) | undefined;
    const ping = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolvePing = resolve;
        }),
    );
    const client = createClient({ ping });
    const factory = vi.fn(() => client);
    const probe = new RedisHealthProbe({ redisUrl: "redis://redacted", timeoutMs: 100 }, factory);

    const first = probe.check();
    const second = probe.check();

    expect(first).toBe(second);
    expect(factory).toHaveBeenCalledOnce();
    expect(ping).toHaveBeenCalledOnce();

    resolvePing?.("PONG");

    await expect(first).resolves.toBe("ok");
    await expect(second).resolves.toBe("ok");
  });

  it("shuts down safely and never creates another client", async () => {
    const client = createClient({ quit: vi.fn().mockRejectedValue(new Error("already closed")) });
    const factory = vi.fn(() => client);
    const probe = new RedisHealthProbe({ redisUrl: "redis://redacted", timeoutMs: 100 }, factory);

    await expect(probe.check()).resolves.toBe("ok");
    await probe.shutdown();
    await probe.shutdown();

    expect(client.quit).toHaveBeenCalledOnce();
    expect(client.disconnect).toHaveBeenCalledOnce();
    await expect(probe.check()).resolves.toBe("down");
    expect(factory).toHaveBeenCalledOnce();
  });
});
