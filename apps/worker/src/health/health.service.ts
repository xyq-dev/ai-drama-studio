import { Inject, Injectable } from "@nestjs/common";
import { SERVICE_NAME, type WorkerLiveResponse, type WorkerReadyResponse } from "@ai-drama/contracts";
import { SERVICE_VERSION } from "../version";
import { POSTGRES_PROBE, REDIS_PROBE } from "./tokens";

export interface DependencyProbe {
  check(): Promise<"ok" | "down">;
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(POSTGRES_PROBE) private readonly postgres: DependencyProbe,
    @Inject(REDIS_PROBE) private readonly redis: DependencyProbe,
  ) {}

  live(): WorkerLiveResponse {
    return {
      service: SERVICE_NAME.worker,
      status: "ok",
      version: SERVICE_VERSION,
      timestamp: new Date().toISOString(),
      queueConsumer: "disabled",
    };
  }

  async ready(): Promise<WorkerReadyResponse> {
    const [postgres, redis] = await Promise.all([this.postgres.check(), this.redis.check()]);
    return {
      service: SERVICE_NAME.worker,
      status: postgres === "ok" && redis === "ok" ? "ok" : "degraded",
      version: SERVICE_VERSION,
      timestamp: new Date().toISOString(),
      queueConsumer: "disabled",
      dependencies: {
        postgres: { status: postgres },
        redis: { status: redis },
      },
    };
  }
}
