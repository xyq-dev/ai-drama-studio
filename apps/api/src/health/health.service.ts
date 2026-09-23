import { Inject, Injectable } from "@nestjs/common";
import { SERVICE_NAME, type ReadyHealthResponse, type ServiceHealthResponse } from "@ai-drama/contracts";
import { SERVICE_VERSION } from "../version";
import { OBJECT_STORAGE_PROBE, POSTGRES_PROBE, REDIS_PROBE } from "./tokens";

export interface DependencyProbe {
  check(): Promise<"ok" | "down">;
}

@Injectable()
export class HealthService {
  constructor(
    @Inject(POSTGRES_PROBE) private readonly postgres: DependencyProbe,
    @Inject(REDIS_PROBE) private readonly redis: DependencyProbe,
    @Inject(OBJECT_STORAGE_PROBE) private readonly objectStorage: DependencyProbe,
  ) {}

  live(): ServiceHealthResponse {
    return {
      service: SERVICE_NAME.api,
      status: "ok",
      version: SERVICE_VERSION,
      timestamp: new Date().toISOString(),
    };
  }

  async ready(): Promise<ReadyHealthResponse> {
    const [postgres, redis, objectStorage] = await Promise.all([
      this.postgres.check(),
      this.redis.check(),
      this.objectStorage.check(),
    ]);
    const status = postgres === "ok" && redis === "ok" && objectStorage === "ok" ? "ok" : "degraded";
    return {
      service: SERVICE_NAME.api,
      status,
      timestamp: new Date().toISOString(),
      dependencies: {
        postgres: { status: postgres },
        redis: { status: redis },
        objectStorage: { status: objectStorage },
      },
    };
  }
}
