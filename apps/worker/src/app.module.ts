import { Module, type DynamicModule } from "@nestjs/common";
import type { WorkerEnv } from "./config/env";
import { HealthModule } from "./health/health.module";
import type { QueueStatus } from "./health/queue.health";

@Module({})
export class AppModule {
  static register(env: WorkerEnv, queueStatus: QueueStatus): DynamicModule {
    return {
      module: AppModule,
      imports: [HealthModule.register(env, queueStatus)],
    };
  }
}
