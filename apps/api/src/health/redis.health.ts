import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { RedisHealthProbe } from "@ai-drama/health";
import type { ApiEnv } from "../config/env";
import { API_ENV } from "./tokens";

@Injectable()
export class RedisHealth implements OnModuleDestroy {
  private readonly probe: RedisHealthProbe;

  constructor(@Inject(API_ENV) private readonly env: ApiEnv) {
    this.probe = new RedisHealthProbe({
      redisUrl: env.REDIS_URL,
      timeoutMs: env.HEALTH_CHECK_TIMEOUT_MS,
    });
  }

  check(): Promise<"ok" | "down"> {
    return this.probe.check();
  }

  async onModuleDestroy(): Promise<void> {
    await this.probe.shutdown();
  }
}
