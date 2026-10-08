import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { isAbsolute } from "node:path";
import {
  JobPersistenceService,
  CharacterReferenceStore,
  MediaAssetStore,
  MockTextService,
  PostgresQwenWebStore,
  PostgresTitleWritingStore,
  RuntimeStore,
  TextChainService,
  closePostgresPool,
  createPostgresPool,
  type PostgresPool,
} from "@ai-drama/database";
import { sampleVideoGenerationEnabled, type QwenWritingInput } from "@ai-drama/contracts";
import { TitleWritingEngine, createQwenFetchTransport, qwenWebProviderConfig, titleWritingProviderConfigs } from "@ai-drama/providers";
import type { ApiEnv } from "../config/env";
import { QwenWebService } from "./qwen-web.service";
import { StudioService } from "./studio.service";
import { TitleWritingService } from "./title-writing.service";

const QWEN_WEB_MAINTENANCE_MS = 60_000;
/** Title writing recovery pass. Only expired leases are fenced, so a live run is never touched. */
const TITLE_WRITING_MAINTENANCE_MS = 15_000;

@Injectable()
export class StudioRuntime implements OnModuleDestroy {
  readonly store: RuntimeStore;
  readonly service: StudioService;
  readonly qwenWeb: QwenWebService;
  readonly titleWriting: TitleWritingService | null;
  private readonly maintenance: NodeJS.Timeout | null;
  private readonly titleMaintenance: NodeJS.Timeout | null;

  constructor(
    readonly pool: PostgresPool,
    service: StudioService,
    store: RuntimeStore,
    qwenWeb: QwenWebService,
    qwenWebActive = false,
    titleWriting: TitleWritingService | null = null,
  ) {
    this.service = service;
    this.store = store;
    this.qwenWeb = qwenWeb;
    this.titleWriting = titleWriting;
    // Recovery fences only expired executor leases, so a periodic pass cannot touch a live request.
    this.maintenance = qwenWebActive
      ? setInterval(() => { void qwenWeb.maintain().catch(() => undefined); }, QWEN_WEB_MAINTENANCE_MS)
      : null;
    this.maintenance?.unref();
    // After a restart, runs whose executor lease expired are fenced and, while the feature is on, continued.
    this.titleMaintenance = titleWriting
      ? setInterval(() => { void titleWriting.maintain().catch(() => undefined); }, TITLE_WRITING_MAINTENANCE_MS)
      : null;
    this.titleMaintenance?.unref();
  }

  static async open(env: ApiEnv): Promise<StudioRuntime> {
    const pool = createPostgresPool({
      connectionString: env.DATABASE_URL,
      connectionTimeoutMs: env.HEALTH_CHECK_TIMEOUT_MS,
      statementTimeoutMs: 10_000,
      queryTimeoutMs: 10_000,
    });
    const store = new RuntimeStore(pool);
    const workspaceId = await store.requireActiveWorkspace(env.APP_WORKSPACE_ID);
    const jobs = new JobPersistenceService(pool);
    const textChain = new TextChainService(pool);
    const absoluteDir = env.MOCK_OBJECT_DIR && isAbsolute(env.MOCK_OBJECT_DIR) ? env.MOCK_OBJECT_DIR : null;
    const nonProduction = env.NODE_ENV !== "production";
    const mockImageEnabled = nonProduction && env.M3_MOCK_IMAGE_ENABLED && Boolean(absoluteDir);
    const mockAvEnabled = nonProduction && env.M3_MOCK_AV_ENABLED && Boolean(absoluteDir);
    const mockSmEnabled = nonProduction && env.M3_MOCK_SUBTITLE_MUSIC_ENABLED && Boolean(absoluteDir);
    const composeObjectDir = env.M4_COMPOSE_OBJECT_DIR && isAbsolute(env.M4_COMPOSE_OBJECT_DIR) ? env.M4_COMPOSE_OBJECT_DIR : null;
    const composeSwitch = nonProduction && env.M4_LOCAL_COMPOSE_ENABLED;
    const localComposeEnabled = composeSwitch && Boolean(absoluteDir && composeObjectDir);
    const episodeComposeEnabled = composeSwitch && env.M4_LOCAL_EPISODE_COMPOSE_ENABLED && Boolean(composeObjectDir);
    const qwenWebEnabled = env.NODE_ENV !== "production" && env.QWEN_WEB_WRITING_ENABLED;
    const qwenProvider = qwenWebProviderConfig(env);
    const qwenWeb = new QwenWebService({
      workspaceId,
      nodeEnv: env.NODE_ENV,
      enabled: qwenWebEnabled,
      operatorToken: env.QWEN_WEB_OPERATOR_TOKEN ?? null,
      provider: qwenProvider,
      store: new PostgresQwenWebStore<QwenWritingInput>(pool),
      projects: store,
      transport: createQwenFetchTransport(),
    });
    const titleProviders = titleWritingProviderConfigs(env);
    const titleStore = new PostgresTitleWritingStore(pool, textChain);
    const titleWriting = new TitleWritingService({
      workspaceId,
      nodeEnv: env.NODE_ENV,
      enabled: env.NODE_ENV !== "production" && env.TITLE_WRITING_ENABLED,
      operatorToken: env.TITLE_WRITING_OPERATOR_TOKEN ?? null,
      defaultProvider: env.TITLE_WRITING_DEFAULT_PROVIDER ?? null,
      providers: titleProviders,
      store: titleStore,
      // Only the real fetch transport is wired. A missing configuration never falls back to a Mock answer.
      engine: new TitleWritingEngine({
        store: titleStore,
        providers: titleProviders,
        transport: createQwenFetchTransport(),
        maxCallsPerDay: env.TITLE_WRITING_MAX_CALLS_PER_DAY,
      }),
      projects: store,
      maxCallsPerDay: env.TITLE_WRITING_MAX_CALLS_PER_DAY,
      maxActiveRuns: env.TITLE_WRITING_MAX_ACTIVE_RUNS,
    });
    return new StudioRuntime(pool,
      new StudioService(jobs, store, textChain, workspaceId, new MockTextService(pool), new MediaAssetStore(pool),
        mockImageEnabled, absoluteDir, mockAvEnabled, mockSmEnabled, localComposeEnabled, composeObjectDir, episodeComposeEnabled,
        sampleVideoGenerationEnabled({
          nodeEnv: env.NODE_ENV,
          sampleFlag: env.M4_MOCK_SAMPLE_VIDEO_ENABLED,
          avFlag: env.M3_MOCK_AV_ENABLED,
          directoryReady: Boolean(absoluteDir),
        }),
        new CharacterReferenceStore(pool),
        env.M3_CHARACTER_REFERENCE_GATE), store, qwenWeb, qwenWebEnabled && qwenProvider.ok, titleWriting);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.maintenance) clearInterval(this.maintenance);
    if (this.titleMaintenance) clearInterval(this.titleMaintenance);
    await closePostgresPool(this.pool);
  }
}
