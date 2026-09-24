import { Inject, Injectable } from "@nestjs/common";
import { SERVICE_NAME, type WorkerLiveResponse, type WorkerReadyResponse } from "@ai-drama/contracts";
import { SERVICE_VERSION } from "../version";
import { POSTGRES_PROBE, QUEUE_PROBE, REDIS_PROBE } from "./tokens";

export interface DependencyProbe {
  check(): Promise<"ok" | "down">;
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(POSTGRES_PROBE) private readonly postgres: DependencyProbe,
    @Inject(REDIS_PROBE) private readonly redis: DependencyProbe,
    @Inject(QUEUE_PROBE) private readonly queue: DependencyProbe,
  ) {}

  live(): WorkerLiveResponse {
    return {
      service: SERVICE_NAME.worker,
      status: "ok",
      version: SERVICE_VERSION,
      timestamp: new Date().toISOString(),
    };
  }

  async ready(): Promise<WorkerReadyResponse> {
    const [postgres, redis, queue] = await Promise.all([
      this.postgres.check(),
      this.redis.check(),
      this.queue.check(),
    ]);
    const ready = postgres === "ok" && redis === "ok" && queue === "ok";
    return {
      service: SERVICE_NAME.worker,
      status: ready ? "ok" : "degraded",
      version: SERVICE_VERSION,
      timestamp: new Date().toISOString(),
      dependencies: {
        postgres: { status: postgres },
        redis: { status: redis },
        queue: { status: queue },
      },
    };
  }
}
