import Redis from "ioredis";

type RedisStatus = "wait" | "reconnecting" | "connecting" | "connect" | "ready" | "close" | "end";

export interface RedisProbeClient {
  readonly status: RedisStatus;
  connect(): Promise<void>;
  ping(): Promise<string>;
  quit(): Promise<unknown>;
  disconnect(reconnect?: boolean): void;
  on(event: "error", listener: () => void): unknown;
}

export interface RedisHealthProbeOptions {
  redisUrl: string;
  timeoutMs: number;
}

type RedisClientFactory = (options: RedisHealthProbeOptions) => RedisProbeClient;

function createRedisClient(options: RedisHealthProbeOptions): RedisProbeClient {
  return new Redis(options.redisUrl, {
    lazyConnect: true,
    connectTimeout: options.timeoutMs,
    commandTimeout: options.timeoutMs,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });
}

export class RedisHealthProbe {
  private readonly client: RedisProbeClient;
  private readonly timeoutMs: number;
  private closed = false;
  private activeCheck: Promise<"ok" | "down"> | undefined;

  constructor(options: RedisHealthProbeOptions, clientFactory: RedisClientFactory = createRedisClient) {
    this.timeoutMs = options.timeoutMs;
    this.client = clientFactory(options);
    this.client.on("error", () => undefined);
  }

  check(): Promise<"ok" | "down"> {
    if (this.closed) return Promise.resolve("down");
    this.activeCheck ??= this.runCheck().finally(() => {
      this.activeCheck = undefined;
    });
    return this.activeCheck;
  }

  private async runCheck(): Promise<"ok" | "down"> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Redis health check timed out")), this.timeoutMs);
    });

    try {
      const result = await Promise.race([this.connectAndPing(), timeout]);
      return result === "PONG" ? "ok" : "down";
    } catch {
      // End an in-flight connection attempt so the next check starts from a clean,
      // reconnectable state instead of inheriting a permanently ended client.
      this.client.disconnect(false);
      return "down";
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async connectAndPing(): Promise<string> {
    if (this.client.status === "wait" || this.client.status === "end") {
      await this.client.connect();
    }
    return this.client.ping();
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect(false);
    }
  }
}
