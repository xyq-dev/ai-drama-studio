import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";
import type { ApiEnv } from "../config/env";
import { API_ENV } from "./tokens";

@Injectable()
export class RedisHealth implements OnModuleDestroy {
  private readonly client: Redis;

  constructor(@Inject(API_ENV) private readonly env: ApiEnv) {
    this.client = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      connectTimeout: env.HEALTH_CHECK_TIMEOUT_MS,
      commandTimeout: env.HEALTH_CHECK_TIMEOUT_MS,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: () => null,
    });
    this.client.on("error", () => undefined);
  }

  async check(): Promise<"ok" | "down"> {
    try {
      const result = await this.client.ping();
      return result === "PONG" ? "ok" : "down";
    } catch {
      return "down";
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}
