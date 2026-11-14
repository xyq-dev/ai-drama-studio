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
  WRITING_CANDIDATE_SERVICE, VIMAX_PREVIEW_SERVICE, VIMAX_CANDIDATE_SERVICE, PRODUCTION_STATE_READONLY_SERVICE,
} from "./tokens";
import { ADMIN_COMFYUI_CHECK, ADMIN_MODELS_SERVICE, AdminModelsController } from "../admin/admin-models.controller";
import { VIMAX_PLANNING_SERVICE, VimaxPlanningController } from "./vimax-planning.controller";
import { REAL_MEDIA_SERVICE, RealMediaController } from "./real-media.controller";
import { SPEECH_SERVICE, SpeechController } from "./speech.controller";
import { VOICE_COMPOSE_SERVICE, VoiceComposeController } from "./voice-compose.controller";
import { ProjectLibraryStore, ShortSequelStore } from "@ai-drama/database";
import { ProjectLibraryService } from "./project-library.service";
import { PROJECT_LIBRARY_SERVICE, ProjectLibraryController } from "./project-library.controller";
import { STORAGE_SETTINGS_SERVICE, StorageSettingsController } from "../admin/storage-settings.controller";
import { SCRIPT_WORKBENCH_SERVICE, ScriptWorkbenchController } from "./script-workbench.controller";
import { ScriptWorkbenchService } from "./script-workbench.service";
import { ProductionStateReadonlyController } from "./production-state-readonly.controller";
import { ProductionStateReadonlyService } from "./production-state-readonly.service";
import { SHORT_SEQUEL_STORE, SHORT_SEQUEL_WORKSPACE, ShortSequelController } from "./short-sequel.controller";
import { SHORT_SEQUEL_AI_SERVICE, ShortSequelAiController } from "./short-sequel-ai.controller";

@Module({})
export class StudioModule {
  static register(env: ApiEnv): DynamicModule {
    return {
      module: StudioModule,
      controllers: [
        StudioController, EventsController, TitleWritingController, ScriptBreakdownController, WritingCandidateController,
        AdminModelsController, AutoCreationController, SeriesWritingController, VimaxPreviewController, VimaxCandidateController,
        VimaxPlanningController, RealMediaController, SpeechController, VoiceComposeController,
        ProjectLibraryController, StorageSettingsController, ScriptWorkbenchController, ProductionStateReadonlyController,
        ShortSequelController, ShortSequelAiController,
      ],
      providers: [
        { provide: PRODUCTION_STATE_READONLY_SERVICE, useFactory: () => new ProductionStateReadonlyService(env.PRODUCTION_STATE_ROOT) },
        { provide: SHORT_SEQUEL_STORE, inject: [STUDIO_RUNTIME], useFactory: (runtime: StudioRuntime) => new ShortSequelStore(runtime.pool) },
        { provide: SHORT_SEQUEL_WORKSPACE, useValue: env.APP_WORKSPACE_ID },
        { provide: SHORT_SEQUEL_AI_SERVICE, inject: [STUDIO_RUNTIME], useFactory: (runtime: StudioRuntime) => runtime.shortSequelAi },
        { provide: ADMIN_COMFYUI_CHECK, inject: [STUDIO_RUNTIME], useFactory: (runtime: StudioRuntime) => runtime.checkComfyUi },
        { provide: SCRIPT_WORKBENCH_SERVICE, inject: [STUDIO_RUNTIME], useFactory: (runtime: StudioRuntime) => new ScriptWorkbenchService(runtime.pool, env.APP_WORKSPACE_ID) },
        { provide: PROJECT_LIBRARY_SERVICE, inject: [STUDIO_RUNTIME], useFactory: (runtime: StudioRuntime) => new ProjectLibraryService(new ProjectLibraryStore(runtime.pool), env.APP_WORKSPACE_ID) },
        { provide: STORAGE_SETTINGS_SERVICE, inject: [STUDIO_RUNTIME], useFactory: (runtime: StudioRuntime) => runtime.storageSettings },
        { provide: VIMAX_PLANNING_SERVICE, inject: [STUDIO_RUNTIME], useFactory: (runtime: StudioRuntime) => runtime.vimaxPlanning },
        { provide: REAL_MEDIA_SERVICE, inject: [STUDIO_RUNTIME], useFactory: (runtime: StudioRuntime) => runtime.realMedia },
        { provide: SPEECH_SERVICE, inject: [STUDIO_RUNTIME], useFactory: (runtime: StudioRuntime) => runtime.speech },
        { provide: VOICE_COMPOSE_SERVICE, inject: [STUDIO_RUNTIME], useFactory: (runtime: StudioRuntime) => runtime.voiceCompose },
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
