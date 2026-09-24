import { Module, type DynamicModule } from "@nestjs/common";
import type { ApiEnv } from "../config/env";
import { EventsController, StudioController } from "./studio.controller";
import { StudioRuntime } from "./studio.runtime";
import { RUNTIME_STORE, STUDIO_RUNTIME, STUDIO_SERVICE } from "./tokens";

@Module({})
export class StudioModule {
  static register(env: ApiEnv): DynamicModule {
    return {
      module: StudioModule,
      controllers: [StudioController, EventsController],
      providers: [
        {
          provide: STUDIO_RUNTIME,
          useFactory: () => StudioRuntime.open(env),
        },
        {
          provide: STUDIO_SERVICE,
          inject: [STUDIO_RUNTIME],
          useFactory: (runtime: StudioRuntime) => runtime.service,
        },
        {
          provide: RUNTIME_STORE,
          inject: [STUDIO_RUNTIME],
          useFactory: (runtime: StudioRuntime) => runtime.store,
        },
      ],
    };
  }
}
