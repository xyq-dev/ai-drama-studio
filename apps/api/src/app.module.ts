import { Module, type DynamicModule } from "@nestjs/common";
import { AuthModule } from "./auth/auth.module";
import type { ApiEnv } from "./config/env";
import { HealthModule } from "./health/health.module";
import { StudioModule } from "./studio/studio.module";

@Module({})
export class AppModule {
  static register(env: ApiEnv): DynamicModule {
    return {
      module: AppModule,
      // AuthModule first: its session check applies to every route of the application.
      imports: [AuthModule.register(env), HealthModule.register(env), StudioModule.register(env)],
    };
  }
}
