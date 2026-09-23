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
  private client: RedisProbeClient | undefined;
  private closed = false;
  private activeCheck: Promise<"ok" | "down"> | undefined;

  constructor(
    private readonly options: RedisHealthProbeOptions,
    private readonly clientFactory: RedisClientFactory = createRedisClient,
  ) {}

  check(): Promise<"ok" | "down"> {
    if (this.closed) return Promise.resolve("down");
    this.activeCheck ??= this.runCheck().finally(() => {
      this.activeCheck = undefined;
    });
    return this.activeCheck;
  }

  private async runCheck(): Promise<"ok" | "down"> {
    const client = this.getOrCreateClient();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Redis health check timed out")), this.options.timeoutMs);
    });

    try {
      const result = await Promise.race([this.connectAndPing(client), timeout]);
      if (result === "PONG") return "ok";
    } catch {
      // Readiness reports only the health state; Redis errors stay internal.
    } finally {
      if (timer) clearTimeout(timer);
    }

    this.discardClient(client);
    return "down";
  }

  private getOrCreateClient(): RedisProbeClient {
    if (!this.client) {
      this.client = this.clientFactory(this.options);
      this.client.on("error", () => undefined);
    }
    return this.client;
  }

  private async connectAndPing(client: RedisProbeClient): Promise<string> {
    if (client.status === "wait" || client.status === "end") {
      await client.connect();
    }
    return client.ping();
  }

  private discardClient(client: RedisProbeClient): void {
    if (this.client === client) this.client = undefined;
    try {
      client.disconnect(false);
    } catch {
      // Health checks must not expose Redis client teardown errors.
    }
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const client = this.client;
    this.client = undefined;
    if (!client) return;
    try {
      await client.quit();
    } catch {
      try {
        client.disconnect(false);
      } catch {
        // Shutdown is best-effort and must never expose Redis client errors.
      }
    }
  }
}
