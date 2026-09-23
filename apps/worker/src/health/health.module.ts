import { Module, type DynamicModule } from "@nestjs/common";
import type { WorkerEnv } from "../config/env";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";
import { PostgresHealth } from "./postgres.health";
import { RedisHealth } from "./redis.health";
import { POSTGRES_PROBE, REDIS_PROBE, WORKER_ENV } from "./tokens";

@Module({})
export class HealthModule {
  static register(env: WorkerEnv): DynamicModule {
    return {
      module: HealthModule,
      controllers: [HealthController],
      providers: [
        { provide: WORKER_ENV, useValue: env },
        PostgresHealth,
        RedisHealth,
        { provide: POSTGRES_PROBE, useExisting: PostgresHealth },
        { provide: REDIS_PROBE, useExisting: RedisHealth },
        HealthService,
      ],
    };
  }
}
