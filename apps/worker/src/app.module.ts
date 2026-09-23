import { Module, type DynamicModule } from "@nestjs/common";
import type { WorkerEnv } from "./config/env";
import { HealthModule } from "./health/health.module";

@Module({})
export class AppModule {
  static register(env: WorkerEnv): DynamicModule {
    return {
      module: AppModule,
      imports: [HealthModule.register(env)],
    };
  }
}
