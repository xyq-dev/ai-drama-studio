import { Module, type DynamicModule } from "@nestjs/common";
import type { AdapterEnv } from "../config/env";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";
import { ADAPTER_ENV } from "./tokens";

@Module({})
export class HealthModule {
  static register(env: AdapterEnv): DynamicModule {
    return {
      module: HealthModule,
      controllers: [HealthController],
      providers: [{ provide: ADAPTER_ENV, useValue: env }, HealthService],
    };
  }
}
