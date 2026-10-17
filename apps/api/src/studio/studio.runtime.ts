import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { isAbsolute } from "node:path";
import {
  JobPersistenceService,
  CharacterReferenceStore,
  MediaAssetStore,
  MockTextService,
  PostgresTitleWritingStore,
  PostgresWritingCandidateStore,
  RuntimeStore,
  TextChainService,
  closePostgresPool,
  createPostgresPool,
  type PostgresPool,
} from "@ai-drama/database";
import { sampleVideoGenerationEnabled, type TitleRunKind } from "@ai-drama/contracts";
import { TitleWritingEngine, WritingCandidateExecutor, createFetchTransport, titleWritingProviderConfigs } from "@ai-drama/providers";
import type { ApiEnv } from "../config/env";
import { siteAuthFromEnv } from "../auth/site-auth.config";
import { ScriptBreakdownService } from "./script-breakdown.service";
import { StudioService } from "./studio.service";
import { TitleWritingService } from "./title-writing.service";
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
      adminModels = admin ? await AdminModelsService.open(env, admin, async () => {
        // storageReady() deliberately reports both absent schema and transient probe failures as false.
        // Activation must distinguish those cases: only a successful absence check proves no runs exist.
        const presence = await pool.query(
          "SELECT to_regclass('title_writing_run') IS NULL AS missing",
        ) as { rows: { missing: boolean }[] };
        if (presence.rows[0]?.missing === true) return true;
        if (presence.rows[0]?.missing !== false) throw new Error("Title writing activation probe unavailable");
        const result = await pool.query(
          "SELECT EXISTS(SELECT 1 FROM title_writing_run WHERE workspace_id = $1 AND state = 'running') AS running",
          [workspaceId],
        ) as { rows: { running: boolean }[] };
        if (result.rows[0]?.running !== false) return false;
        // An open online candidate is sending with the active configuration too: activation waits for it as well.
        const candidates = await pool.query(
          "SELECT to_regclass('writing_candidate_request') IS NULL AS missing",
        ) as { rows: { missing: boolean }[] };
        if (candidates.rows[0]?.missing === true) return true;
        if (candidates.rows[0]?.missing !== false) throw new Error("Writing candidate activation probe unavailable");
        const open = await pool.query(
          "SELECT EXISTS(SELECT 1 FROM writing_candidate_request WHERE workspace_id = $1 AND state IN ('reserved', 'submitted')) AS open",
          [workspaceId],
        ) as { rows: { open: boolean }[] };
        return open.rows[0]?.open === false;
      }, { enabled: titleWritingEnabled, productionBlocked: !nonProduction && !titleWritingAllowProduction, siteOperator: siteLoginValid },
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
      adminModels, admin?.enabled ?? false, scriptBreakdown, writingCandidates);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.titleMaintenance) clearInterval(this.titleMaintenance);
    if (this.candidateMaintenance) clearInterval(this.candidateMaintenance);
    await closePostgresPool(this.pool);
  }
}
