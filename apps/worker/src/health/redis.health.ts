import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { RedisHealthProbe } from "@ai-drama/health";
import type { WorkerEnv } from "../config/env";
import { WORKER_ENV } from "./tokens";

@Injectable()
export class RedisHealth implements OnModuleDestroy {
  private readonly probe: RedisHealthProbe;

  constructor(@Inject(WORKER_ENV) private readonly env: WorkerEnv) {
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
