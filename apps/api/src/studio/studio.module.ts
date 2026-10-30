import { Module, type DynamicModule } from "@nestjs/common";
import type { ApiEnv } from "../config/env";
import { EventsController, StudioController } from "./studio.controller";
import { StudioRuntime } from "./studio.runtime";
import { ScriptBreakdownController } from "./script-breakdown.controller";
import { TitleWritingController } from "./title-writing.controller";
import { WritingCandidateController } from "./writing-candidate.controller";
import { AutoCreationController } from "./auto-creation.controller";
import { SeriesWritingController } from "./series-writing.controller";
import { VimaxPreviewController } from "./vimax-preview.controller";
import { VimaxCandidateController } from "./vimax-candidate.controller";
import {
  AUTO_CREATION_SERVICE, RUNTIME_STORE, SCRIPT_BREAKDOWN_SERVICE, SERIES_WRITING_SERVICE, STUDIO_RUNTIME, STUDIO_SERVICE, TITLE_WRITING_SERVICE,
  WRITING_CANDIDATE_SERVICE, VIMAX_PREVIEW_SERVICE, VIMAX_CANDIDATE_SERVICE,
} from "./tokens";
import { ADMIN_MODELS_SERVICE, AdminModelsController } from "../admin/admin-models.controller";

@Module({})
export class StudioModule {
  static register(env: ApiEnv): DynamicModule {
    return {
      module: StudioModule,
      controllers: [
        StudioController, EventsController, TitleWritingController, ScriptBreakdownController, WritingCandidateController,
        AdminModelsController, AutoCreationController, SeriesWritingController, VimaxPreviewController, VimaxCandidateController,
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
          provide: WRITING_CANDIDATE_SERVICE,
          inject: [STUDIO_RUNTIME],
          useFactory: (runtime: StudioRuntime) => runtime.writingCandidates,
        },
        {
          provide: AUTO_CREATION_SERVICE,
          inject: [STUDIO_RUNTIME],
          useFactory: (runtime: StudioRuntime) => runtime.autoCreation,
        },
        {
          provide: SERIES_WRITING_SERVICE,
          inject: [STUDIO_RUNTIME],
          useFactory: (runtime: StudioRuntime) => runtime.seriesWriting,
        },
        {
          provide: VIMAX_PREVIEW_SERVICE,
          inject: [STUDIO_RUNTIME],
          useFactory: (runtime: StudioRuntime) => runtime.vimaxPreview,
        },
        {
          provide: VIMAX_CANDIDATE_SERVICE,
          inject: [STUDIO_RUNTIME],
          useFactory: (runtime: StudioRuntime) => runtime.vimaxCandidates,
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
