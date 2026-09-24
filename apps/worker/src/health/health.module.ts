import { Module, type DynamicModule } from "@nestjs/common";
import type { WorkerEnv } from "../config/env";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";
import { PostgresHealth } from "./postgres.health";
import { QueueHealth, type QueueStatus } from "./queue.health";
import { RedisHealth } from "./redis.health";
import { POSTGRES_PROBE, QUEUE_PROBE, QUEUE_STATUS, REDIS_PROBE, WORKER_ENV } from "./tokens";

@Module({})
export class HealthModule {
  static register(env: WorkerEnv, queueStatus: QueueStatus): DynamicModule {
    return {
      module: HealthModule,
      controllers: [HealthController],
      providers: [
        { provide: WORKER_ENV, useValue: env },
        { provide: QUEUE_STATUS, useValue: queueStatus },
        PostgresHealth,
        RedisHealth,
        QueueHealth,
        { provide: POSTGRES_PROBE, useExisting: PostgresHealth },
        { provide: REDIS_PROBE, useExisting: RedisHealth },
        { provide: QUEUE_PROBE, useExisting: QueueHealth },
        HealthService,
      ],
    };
  }
}
