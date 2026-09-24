import { Module, type DynamicModule } from "@nestjs/common";
import type { ApiEnv } from "../config/env";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";
import { ObjectStorageHealth } from "./object-storage.health";
import { PostgresHealth } from "./postgres.health";
import { RedisHealth } from "./redis.health";
import { API_ENV, OBJECT_STORAGE_PROBE, POSTGRES_PROBE, REDIS_PROBE } from "./tokens";

@Module({})
export class HealthModule {
  static register(env: ApiEnv): DynamicModule {
    return {
      module: HealthModule,
      controllers: [HealthController],
      exports: [API_ENV],
      providers: [
        { provide: API_ENV, useValue: env },
        PostgresHealth,
        RedisHealth,
        ObjectStorageHealth,
        { provide: POSTGRES_PROBE, useExisting: PostgresHealth },
        { provide: REDIS_PROBE, useExisting: RedisHealth },
        { provide: OBJECT_STORAGE_PROBE, useExisting: ObjectStorageHealth },
        HealthService,
      ],
    };
  }
}
