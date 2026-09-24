import { Module, type DynamicModule } from "@nestjs/common";
import type { ApiEnv } from "./config/env";
import { HealthModule } from "./health/health.module";
import { StudioModule } from "./studio/studio.module";

@Module({})
export class AppModule {
  static register(env: ApiEnv): DynamicModule {
    return {
      module: AppModule,
      imports: [HealthModule.register(env), StudioModule.register(env)],
    };
  }
}
