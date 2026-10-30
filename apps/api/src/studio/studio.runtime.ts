import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { isAbsolute } from "node:path";
import {
  JobPersistenceService,
  CharacterReferenceStore,
  MediaAssetStore,
  MockTextService,
  PostgresAutoCreationStore,
  PostgresSeriesWritingStore,
  PostgresTitleWritingStore,
  PostgresWritingCandidateStore,
  RuntimeStore,
  TextChainService,
  VimaxPreviewSourceStore,
  closePostgresPool,
  createPostgresPool,
  type PostgresPool,
} from "@ai-drama/database";
import { sampleVideoGenerationEnabled, type TitleRunKind } from "@ai-drama/contracts";
import {
  AutoCreationEngine, SeriesWritingEngine, TitleWritingEngine, WritingCandidateExecutor, createFetchTransport, createResearchFetcher, titleWritingProviderConfigs,
} from "@ai-drama/providers";
import { AUTO_CREATION_DEFAULT_ALLOWED_HOSTS, OCEAN_ENGINE_ENTRY_URLS } from "@ai-drama/domain";
import { AutoCreationService } from "./auto-creation.service";
import { SeriesWritingService } from "./series-writing.service";
import type { ApiEnv } from "../config/env";
import { siteAuthFromEnv } from "../auth/site-auth.config";
import { ScriptBreakdownService } from "./script-breakdown.service";
import { VimaxPreviewService } from "./vimax-preview.service";
import { StudioService } from "./studio.service";
import { TitleWritingService } from "./title-writing.service";
import { writingWorkspaceIdle } from "./writing-activation";
import { WritingCandidateService } from "./writing-candidate.service";
import { adminBootstrap } from "../admin/admin-bootstrap";
import { AdminModelsService, managedProviderConfigs } from "../admin/admin-models.service";

/** Title writing recovery pass. Only expired leases are fenced, so a live run is never touched. */
const TITLE_WRITING_MAINTENANCE_MS = 15_000;

@Injectable()
export class StudioRuntime implements OnModuleDestroy {
  readonly store: RuntimeStore;
  readonly service: StudioService;
  readonly titleWriting: TitleWritingService | null;
  private readonly titleMaintenance: NodeJS.Timeout | null;
  private readonly candidateMaintenance: NodeJS.Timeout | null;
  private readonly autoMaintenance: NodeJS.Timeout | null;
  private readonly seriesMaintenance: NodeJS.Timeout | null;

  constructor(
    readonly pool: PostgresPool,
    service: StudioService,
    store: RuntimeStore,
    titleWriting: TitleWritingService | null = null,
    readonly adminModels: AdminModelsService | null = null,
    /** Whether the model console routes are open (MODEL_ADMIN_ENABLED); access itself needs the site login. */
    readonly adminConsoleEnabled = false,
    /** Script breakdown: same switch, token, providers, quota and engine as title writing. */
    readonly scriptBreakdown: ScriptBreakdownService | null = null,
    /** Online candidates of the workbench writing assistant: same switch, operator, providers and daily cap. */
    readonly writingCandidates: WritingCandidateService | null = null,
    /** AI automatic creation: title writing's switch, operator, providers and limits, plus AUTO_CREATION_ENABLED. */
    readonly autoCreation: AutoCreationService | null = null,
    /** Series writing (1–60 episodes): title writing's switch, operator, providers and limits, plus SERIES_WRITING_ENABLED. */
    readonly seriesWriting: SeriesWritingService | null = null,
    /** Read-only single-scene candidate previews; no paid engine, task or persistence dependency. */
    readonly vimaxPreview: VimaxPreviewService | null = null,
  ) {
    this.service = service;
    this.store = store;
    this.titleWriting = titleWriting;
    // After a restart, runs whose executor lease expired are fenced and, while the feature is on, continued.
    this.titleMaintenance = titleWriting
      ? setInterval(() => { void titleWriting.maintain().catch(() => undefined); }, TITLE_WRITING_MAINTENANCE_MS)
      : null;
    this.titleMaintenance?.unref();
    // Expired candidate leases become rejected (never sent) or unknown (maybe sent); nothing is ever resent.
    this.candidateMaintenance = writingCandidates
      ? setInterval(() => { void writingCandidates.maintain().catch(() => undefined); }, TITLE_WRITING_MAINTENANCE_MS)
      : null;
    this.candidateMaintenance?.unref();
    // Automatic creation runs: expired leases are fenced always; runs continue only while the feature is on.
    this.autoMaintenance = autoCreation
      ? setInterval(() => { void autoCreation.maintain().catch(() => undefined); }, TITLE_WRITING_MAINTENANCE_MS)
      : null;
    this.autoMaintenance?.unref();
    // Series jobs: expired leases are fenced always; jobs continue only while the feature is on.
    this.seriesMaintenance = seriesWriting
      ? setInterval(() => { void seriesWriting.maintain().catch(() => undefined); }, TITLE_WRITING_MAINTENANCE_MS)
      : null;
    this.seriesMaintenance?.unref();
  }

  static async open(env: ApiEnv): Promise<StudioRuntime> {
    const admin = adminBootstrap(env);
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
    const siteLoginValid = siteAuthFromEnv(env).kind === "enabled";
    const titleWritingAllowProduction = env.TITLE_WRITING_ALLOW_PRODUCTION && siteLoginValid;
    const titleWritingEnabled = env.TITLE_WRITING_ENABLED && (nonProduction || titleWritingAllowProduction);
    // Script breakdown has its own switch: turning on title writing never starts or resumes a breakdown.
    const scriptBreakdownEnabled = nonProduction && env.TITLE_WRITING_ENABLED && env.SCRIPT_BREAKDOWN_ENABLED;
    const mockImageEnabled = nonProduction && env.M3_MOCK_IMAGE_ENABLED && Boolean(absoluteDir);
    const mockAvEnabled = nonProduction && env.M3_MOCK_AV_ENABLED && Boolean(absoluteDir);
    const mockSmEnabled = nonProduction && env.M3_MOCK_SUBTITLE_MUSIC_ENABLED && Boolean(absoluteDir);
    const composeObjectDir = env.M4_COMPOSE_OBJECT_DIR && isAbsolute(env.M4_COMPOSE_OBJECT_DIR) ? env.M4_COMPOSE_OBJECT_DIR : null;
    const composeSwitch = nonProduction && env.M4_LOCAL_COMPOSE_ENABLED;
    const localComposeEnabled = composeSwitch && Boolean(absoluteDir && composeObjectDir);
    const episodeComposeEnabled = composeSwitch && env.M4_LOCAL_EPISODE_COMPOSE_ENABLED && Boolean(composeObjectDir);
    const titleStore = new PostgresTitleWritingStore(pool, textChain);
    const candidateStore = new PostgresWritingCandidateStore(pool);
    let adminModels: AdminModelsService | null;
    try {
      // Activation waits until no paid text work of the workspace is sending with the active configuration.
      adminModels = admin ? await AdminModelsService.open(env, admin, () => writingWorkspaceIdle(pool, workspaceId),
        { enabled: titleWritingEnabled, productionBlocked: !nonProduction && !titleWritingAllowProduction, siteOperator: siteLoginValid },
      async () => ({
        titleWriting: await titleStore.storageReady(),
        claude: await titleStore.providerStorageReady("anthropic"),
        candidates: await candidateStore.storageReady(),
        deepseek: await candidateStore.providerStorageReady("deepseek"),
      })) : null;
    } catch (error) {
      await closePostgresPool(pool);
      throw error;
    }
    const managed = adminModels?.runtimeSettings();
    const titleProviders = managed ? managedProviderConfigs(managed) : titleWritingProviderConfigs(env);
    const maxCallsPerDay = managed?.maxCallsPerDay ?? env.TITLE_WRITING_MAX_CALLS_PER_DAY;
    const maxActiveRuns = managed?.maxActiveRuns ?? env.TITLE_WRITING_MAX_ACTIVE_RUNS;
    // The shared recovery engine must enforce the same authorization as the HTTP services, for each run kind.
    const allowedRunKinds: TitleRunKind[] = [];
    if (titleWritingEnabled) allowedRunKinds.push("title");
    if (scriptBreakdownEnabled) allowedRunKinds.push("script_breakdown");
    // Only the real fetch transport is wired. A missing configuration never falls back to a Mock answer. One engine
    // drives runs of both kinds, so recovery and the per-run in-process guard cover title writing and breakdowns alike.
    const titleEngine = new TitleWritingEngine({
      workspaceId,
      store: titleStore,
      providers: titleProviders,
      transport: createFetchTransport(),
      maxCallsPerDay,
      allowedRunKinds,
    });
    const defaultProvider = managed ? managed.defaultProvider : env.TITLE_WRITING_DEFAULT_PROVIDER ?? null;
    // Options say when the console holds saved settings this API has not applied yet (never a value, never a gate).
    const configurationPending = adminModels ? async () => await adminModels!.pendingRestart() : undefined;
    const titleWriting = new TitleWritingService({
      workspaceId,
      nodeEnv: env.NODE_ENV,
      enabled: titleWritingEnabled,
      allowProduction: titleWritingAllowProduction,
      operatorToken: env.TITLE_WRITING_OPERATOR_TOKEN ?? null,
      siteOperator: siteLoginValid,
      defaultProvider,
      providers: titleProviders,
      store: titleStore,
      engine: titleEngine,
      projects: store,
      maxCallsPerDay,
      maxActiveRuns,
      ...(configurationPending ? { configurationPending } : {}),
    });
    const scriptBreakdown = new ScriptBreakdownService({
      workspaceId,
      nodeEnv: env.NODE_ENV,
      enabled: scriptBreakdownEnabled,
      operatorToken: env.TITLE_WRITING_OPERATOR_TOKEN ?? null,
      siteOperator: siteLoginValid,
      defaultProvider,
      providers: titleProviders,
      store: titleStore,
      engine: titleEngine,
      projects: store,
      maxCallsPerDay,
      maxActiveRuns,
    });
    const writingCandidates = new WritingCandidateService({
      workspaceId,
      nodeEnv: env.NODE_ENV,
      enabled: titleWritingEnabled,
      allowProduction: titleWritingAllowProduction,
      operatorToken: env.TITLE_WRITING_OPERATOR_TOKEN ?? null,
      siteOperator: siteLoginValid,
      defaultProvider,
      providers: titleProviders,
      store: candidateStore,
      executor: new WritingCandidateExecutor({ workspaceId, store: candidateStore, providers: titleProviders, transport: createFetchTransport() }),
      projects: store,
      maxCallsPerDay,
      ...(configurationPending ? { configurationPending } : {}),
    });
    // AI automatic creation needs title writing to be active and its own switch. Public pages are read only when
    // AUTO_CREATION_RESEARCH_FETCH=true, and only from the allowed hosts (official Ocean Engine hosts by default).
    const autoCreationEnabled = titleWritingEnabled && env.AUTO_CREATION_ENABLED;
    const autoStore = new PostgresAutoCreationStore(pool, textChain);
    const allowedHosts = env.AUTO_CREATION_RESEARCH_HOSTS ? env.AUTO_CREATION_RESEARCH_HOSTS.split(",") : [...AUTO_CREATION_DEFAULT_ALLOWED_HOSTS];
    const autoEngine = new AutoCreationEngine({
      workspaceId,
      store: autoStore,
      providers: titleProviders,
      transport: createFetchTransport(),
      maxCallsPerDay,
      ...(env.AUTO_CREATION_RESEARCH_FETCH ? { fetchPages: createResearchFetcher({ allowedHosts }), defaultResearchUrls: [...OCEAN_ENGINE_ENTRY_URLS] } : {}),
    });
    const autoCreation = new AutoCreationService({
      workspaceId,
      enabled: autoCreationEnabled,
      operatorToken: env.TITLE_WRITING_OPERATOR_TOKEN ?? null,
      siteOperator: siteLoginValid,
      defaultProvider,
      providers: titleProviders,
      store: autoStore,
      engine: autoEngine,
      projects: store,
      maxCallsPerDay,
      maxActiveRuns,
      research: { fetchEnabled: env.AUTO_CREATION_RESEARCH_FETCH, allowedHosts },
      ...(configurationPending ? { configurationPending } : {}),
    });
    // Series writing needs title writing to be active and its own switch; research reads follow the automatic creation settings.
    const seriesStore = new PostgresSeriesWritingStore(pool, textChain);
    const seriesEngine = new SeriesWritingEngine({
      workspaceId,
      store: seriesStore,
      providers: titleProviders,
      transport: createFetchTransport(),
      maxCallsPerDay,
      maxActiveRuns,
      ...(env.AUTO_CREATION_RESEARCH_FETCH ? { fetchPages: createResearchFetcher({ allowedHosts }), defaultResearchUrls: [...OCEAN_ENGINE_ENTRY_URLS] } : {}),
    });
    const seriesWriting = new SeriesWritingService({
      workspaceId,
      enabled: titleWritingEnabled && env.SERIES_WRITING_ENABLED,
      operatorToken: env.TITLE_WRITING_OPERATOR_TOKEN ?? null,
      siteOperator: siteLoginValid,
      defaultProvider,
      providers: titleProviders,
      store: seriesStore,
      engine: seriesEngine,
      projects: store,
      maxCallsPerDay,
      maxActiveRuns,
      research: { fetchEnabled: env.AUTO_CREATION_RESEARCH_FETCH, allowedHosts },
      ...(configurationPending ? { configurationPending } : {}),
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
        env.M3_CHARACTER_REFERENCE_GATE), store, titleWriting,
      adminModels, admin?.enabled ?? false, scriptBreakdown, writingCandidates, autoCreation, seriesWriting,
      new VimaxPreviewService({ workspaceId, nodeEnv: env.NODE_ENV, source: new VimaxPreviewSourceStore(pool) }));
  }

  async onModuleDestroy(): Promise<void> {
    if (this.titleMaintenance) clearInterval(this.titleMaintenance);
    if (this.candidateMaintenance) clearInterval(this.candidateMaintenance);
    if (this.autoMaintenance) clearInterval(this.autoMaintenance);
    if (this.seriesMaintenance) clearInterval(this.seriesMaintenance);
    await closePostgresPool(this.pool);
  }
}
