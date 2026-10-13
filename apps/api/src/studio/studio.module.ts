import { Module, type DynamicModule } from "@nestjs/common";
import type { ApiEnv } from "../config/env";
import { QwenWebController } from "./qwen-web.controller";
import { EventsController, StudioController } from "./studio.controller";
import { StudioRuntime } from "./studio.runtime";
import { ScriptBreakdownController } from "./script-breakdown.controller";
import { TitleWritingController } from "./title-writing.controller";
import {
  QWEN_WEB_SERVICE, RUNTIME_STORE, SCRIPT_BREAKDOWN_SERVICE, STUDIO_RUNTIME, STUDIO_SERVICE, TITLE_WRITING_SERVICE,
} from "./tokens";
import { ADMIN_MODELS_SERVICE, AdminModelsController } from "../admin/admin-models.controller";

@Module({})
export class StudioModule {
  static register(env: ApiEnv): DynamicModule {
    return {
      module: StudioModule,
      controllers: [
        StudioController, EventsController, QwenWebController, TitleWritingController, ScriptBreakdownController, AdminModelsController,
      ],
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
          provide: QWEN_WEB_SERVICE,
          inject: [STUDIO_RUNTIME],
          useFactory: (runtime: StudioRuntime) => runtime.qwenWeb,
        },
        {
          provide: TITLE_WRITING_SERVICE,
          inject: [STUDIO_RUNTIME],
          useFactory: (runtime: StudioRuntime) => runtime.titleWriting,
        },
        {
          provide: SCRIPT_BREAKDOWN_SERVICE,
          inject: [STUDIO_RUNTIME],
          useFactory: (runtime: StudioRuntime) => runtime.scriptBreakdown,
        },
        {
          provide: RUNTIME_STORE,
          inject: [STUDIO_RUNTIME],
          useFactory: (runtime: StudioRuntime) => runtime.store,
        },
        {
          provide: ADMIN_MODELS_SERVICE,
          inject: [STUDIO_RUNTIME],
          // The console routes exist only while MODEL_ADMIN_ENABLED=true; the runtime keeps using managed settings either way.
          useFactory: (runtime: StudioRuntime) => (runtime.adminConsoleEnabled ? runtime.adminModels : null),
        },
      ],
    };
  }
}
