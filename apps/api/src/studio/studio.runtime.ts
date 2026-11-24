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
  ShortSequelStore,
  TextChainService,
  VimaxPreviewSourceStore,
  VimaxCandidateStore,
  closePostgresPool,
  createPostgresPool,
  openStorageSettingsStore, storageSettingsOptions,
  type PostgresPool,
} from "@ai-drama/database";
import { BAILIAN_COMPATIBLE_BASE_URL, featureWritingSdkAdapter, sampleVideoGenerationEnabled, realMediaAccessAllowed, storyboardProviderForVendor, writingProviderForVendor, type ComfyUiAdminCheck, type TitleRunKind } from "@ai-drama/contracts";
import {
  ANTHROPIC_MESSAGES_URL, AutoCreationEngine, DEEPSEEK_CHAT_COMPLETIONS_URL, OPENAI_RESPONSES_URL, SeriesWritingEngine, TitleWritingEngine, WritingCandidateExecutor, createFetchTransport, createResearchFetcher, titleWritingProviderConfigs,
} from "@ai-drama/providers";
import { AUTO_CREATION_DEFAULT_ALLOWED_HOSTS, OCEAN_ENGINE_ENTRY_URLS } from "@ai-drama/domain";
import { AutoCreationService } from "./auto-creation.service";
import { ShortSequelAiService } from "./short-sequel-ai.service";
import { SeriesWritingService } from "./series-writing.service";
import type { ApiEnv } from "../config/env";
import { siteAuthFromEnv } from "../auth/site-auth.config";
import { ScriptBreakdownService } from "./script-breakdown.service";
import { VimaxPreviewService } from "./vimax-preview.service";
import { VimaxCandidateService } from "./vimax-candidate.service";
import { StudioService } from "./studio.service";
import { TitleWritingService } from "./title-writing.service";
import { writingWorkspaceIdle } from "./writing-activation";
import { WritingCandidateService } from "./writing-candidate.service";
import { adminBootstrap } from "../admin/admin-bootstrap";
import { AdminModelsService, managedProviderConfigs } from "../admin/admin-models.service";
import { AdminMediaKeysService } from "../admin/admin-media-keys.service";
import { FeatureConfigService } from "../admin/feature-config.service";
import { featureWritingProbe } from "../admin/feature-writing-probe";
import { FeatureConfigVault, featureVaultPath } from "../admin/feature-config-vault";
import { FeatureUsageStore, featureUsagePath } from "../admin/feature-usage-store";
import { OperationLogStore, operationLogPath, setOperationJournal } from "../admin/operation-log-store";
import { readSkillRuns } from "../admin/skill-run-reader";
import { legacyLiveFor, legacySecretFor } from "../admin/feature-config.legacy";
import {
  PostgresVimaxPlanningStore, RealMediaStore, PostgresSpeechStore, PostgresSpeechBatchStore, PostgresVoiceComposeStore,
  UploadSessionStore,
} from "@ai-drama/database";
import { VimaxPlanningExecutor, ServerRealMediaRuntime, MediaS3Client, ManagedStorageRouter, readVerifiedS3MediaObject, readVerifiedUploadObject, canonicalMiniMaxTtsBaseUrl, applyManagedMediaKeys } from "@ai-drama/providers";
import { StorageSettingsService } from "../admin/storage-settings.service";
import { VimaxPlanningService } from "./vimax-planning.service";
import { RealMediaService } from "./real-media.service";
import { SpeechService } from "./speech.service";
import { VoiceComposeService } from "./voice-compose.service";
import { AssetUploadService } from "./asset-upload.service";

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
  private readonly planningMaintenance: NodeJS.Timeout | null;

  constructor(
    readonly pool: PostgresPool,
    service: StudioService,
    store: RuntimeStore,
    titleWriting: TitleWritingService | null = null,
    readonly adminModels: AdminModelsService | null = null,
    /** Media-key console (sibling vault); same MODEL_ADMIN_* bootstrap as writing models. */
    readonly adminMediaKeys: AdminMediaKeysService | null = null,
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
    /** Imported candidates and two explicit local writes. No provider or maintenance loop. */
    readonly vimaxCandidates: VimaxCandidateService | null = null,
    readonly vimaxPlanning: VimaxPlanningService | null = null,
    readonly realMedia: RealMediaService | null = null,
    readonly speech: SpeechService | null = null,
    readonly voiceCompose: VoiceComposeService | null = null,
    private readonly closeMediaStorage: (() => void) | null = null,
    readonly storageSettings: StorageSettingsService | null = null,
    readonly checkComfyUi: (() => Promise<ComfyUiAdminCheck>) | null = null,
    readonly shortSequelAi: ShortSequelAiService | null = null,
    /** Image uploads for storyboard/source; uses object storage without image-provider keys. */
    readonly assetUpload: AssetUploadService | null = null,
    /** Per-feature drafts. Null when the encrypted admin directory is not configured. */
    readonly featureConfig: FeatureConfigService | null = null,
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
    this.planningMaintenance = vimaxPlanning
      ? setInterval(() => { void vimaxPlanning.maintain().catch(() => undefined); }, TITLE_WRITING_MAINTENANCE_MS)
      : null;
    this.planningMaintenance?.unref();
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
    const legacyStorage = { provider: "s3" as const, prefix: "", endpoint: env.S3_ENDPOINT, region: env.S3_REGION,
      bucket: env.S3_BUCKET, accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY, forcePathStyle: env.S3_FORCE_PATH_STYLE };
    let storageAuthority: Awaited<ReturnType<typeof openStorageSettingsStore>>;
    try { storageAuthority = await openStorageSettingsStore(pool, workspaceId, env, legacyStorage); }
    catch (error) { await closePostgresPool(pool); throw error; }
    const storageOptions = storageSettingsOptions(env);
    const storageSettings = storageAuthority && storageOptions.enabled ? new StorageSettingsService(storageAuthority, storageOptions) : null;
    const jobs = new JobPersistenceService(pool);
    const textChain = new TextChainService(pool);
    const absoluteDir = env.MOCK_OBJECT_DIR && isAbsolute(env.MOCK_OBJECT_DIR) ? env.MOCK_OBJECT_DIR : null;
    const nonProduction = env.NODE_ENV !== "production";
    const siteLoginValid = siteAuthFromEnv(env).kind === "enabled";
    const realAccessAllowed=realMediaAccessAllowed({nodeEnv:env.NODE_ENV,siteAuthConfigured:siteLoginValid,
      allowProduction:env.REAL_MEDIA_ENV?.REAL_MEDIA_ALLOW_PRODUCTION==="true"});
    const processMediaEnv = env.REAL_MEDIA_ENV ?? {};
    const realRuntime = new ServerRealMediaRuntime(workspaceId, processMediaEnv, realAccessAllowed);
    // Media keys share MODEL_ADMIN path/master; open before probes so a saved vault key is already effective.
    let adminMediaKeys: AdminMediaKeysService | null = null;
    if (admin) {
      try {
        adminMediaKeys = await AdminMediaKeysService.open(admin, processMediaEnv, realRuntime);
      } catch (error) {
        await closePostgresPool(pool);
        throw error;
      }
    }
    const checkComfyUi = async (): Promise<ComfyUiAdminCheck> => {
      const health = await realRuntime.probeComfyUi();
      return {
        status: health.status,
        generationEnabled: realRuntime.comfyUiConfiguration()?.enabled === true,
        missingNodeCount: health.missingNodes.length,
        missingModelCount: health.missingModels.length,
      };
    };
    const titleWritingAllowProduction = env.TITLE_WRITING_ALLOW_PRODUCTION && siteLoginValid;
    const titleWritingEnabled = env.TITLE_WRITING_ENABLED && (nonProduction || titleWritingAllowProduction);
    // Script breakdown has its own switch: turning on title writing never starts or resumes a breakdown.
    const scriptBreakdownEnabled = nonProduction && env.TITLE_WRITING_ENABLED && env.SCRIPT_BREAKDOWN_ENABLED;
    const mockImageEnabled = nonProduction && env.M3_MOCK_IMAGE_ENABLED && Boolean(absoluteDir);
    const mockAvEnabled = nonProduction && env.M3_MOCK_AV_ENABLED && Boolean(absoluteDir);
    const mockSmEnabled = nonProduction && env.M3_MOCK_SUBTITLE_MUSIC_ENABLED && Boolean(absoluteDir);
    const realComposeAllowed = realAccessAllowed && Boolean(realRuntime.receiptCipher);
    const configuredComposeDir = env.M4_COMPOSE_OBJECT_DIR;
    const composeObjectDir = (nonProduction || realComposeAllowed) && configuredComposeDir && isAbsolute(configuredComposeDir)
      ? configuredComposeDir : null;
    const localComposeEnabled = env.M4_LOCAL_COMPOSE_ENABLED && Boolean(composeObjectDir && (absoluteDir || realComposeAllowed));
    const episodeComposeEnabled = env.M4_LOCAL_EPISODE_COMPOSE_ENABLED && Boolean(composeObjectDir);
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
    const legacySnapshots = async () => {
      const settings = adminModels?.runtimeSettings() ?? null;
      const managedKeys = adminMediaKeys ? await adminMediaKeys.runtimeSettings() : null;
      const effective = applyManagedMediaKeys(processMediaEnv, managedKeys);
      const present = (value: string | undefined) => typeof value === "string" && value.length >= 8 && value.length <= 512 && !/\s/.test(value) ? value : null;
      return {
        models: settings ? { defaultProvider: settings.defaultProvider, providers: settings.providers } : null,
        media: {
          dashscopeApiKey: present(effective.DASHSCOPE_MEDIA_API_KEY),
          openaiMediaApiKey: present(effective.OPENAI_MEDIA_API_KEY),
          minimaxApiKey: present(effective.MINIMAX_API_KEY),
        },
      };
    };
    let featureConfig: FeatureConfigService | null = null;
    if (admin) {
      try {
        featureConfig = await FeatureConfigService.open({
          vault: await FeatureConfigVault.open({ path: featureVaultPath(admin.path), masterKey: admin.masterKey }),
          usage: new FeatureUsageStore(featureUsagePath(admin.path)),
          probe: featureWritingProbe(globalThis.fetch),
          homeWorkspaceId: workspaceId,
          legacy: {
            live: async () => {
              const snapshot = await legacySnapshots();
              return {
                writing: legacyLiveFor("writing", snapshot.models, snapshot.media),
                storyboard: legacyLiveFor("storyboard", snapshot.models, snapshot.media),
                voice: legacyLiveFor("voice", snapshot.models, snapshot.media),
              };
            },
            secret: async (feature, vendor) => {
              const snapshot = await legacySnapshots();
              return legacySecretFor(feature, vendor, snapshot.models, snapshot.media);
            },
            vendorSecret: async (feature, vendor) => {
              if (feature === "writing" && adminModels && (vendor === "openai" || vendor === "deepseek" || vendor === "bailian" || vendor === "anthropic")) {
                return adminModels.vendorSecret(vendor);
              }
              const snapshot = await legacySnapshots();
              return legacySecretFor(feature, vendor, snapshot.models, snapshot.media);
            },
          },
          policy: {
            readSkillRuns: () => readSkillRuns(pool, workspaceId),
            bailianWritingStorageReady: () => titleStore.bailianStorageReady(),
            writingAllowlist: async (vendor) => {
              const settings = adminModels?.runtimeSettings();
              return settings && vendor === "openai" ? settings.providers.openai.models : null;
            },
          },
        });
      } catch (error) {
        await closePostgresPool(pool);
        throw error;
      }
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
    const writingUrl = { openai: OPENAI_RESPONSES_URL, anthropic: ANTHROPIC_MESSAGES_URL, deepseek: DEEPSEEK_CHAT_COMPLETIONS_URL };
    const { installCreatorMembership } = await import("../membership/creator-task-guard");
    const { PostgresMembershipStore } = await import("../membership/membership-store");
    const membership = new PostgresMembershipStore(pool);
    installCreatorMembership(membership, workspaceId);
    const titleEngine = new TitleWritingEngine({
      workspaceId,
      store: titleStore,
      providers: titleProviders,
      transport: createFetchTransport(),
      sdkFetch: globalThis.fetch,
      maxCallsPerDay,
      allowedRunKinds,
      ...(featureConfig ? {
        featureCredential: async (run) => {
          const locked = await featureConfig!.credentialForTask("writing", workspaceId, run.id);
          const providerKey = writingProviderForVendor(locked?.vendor ?? "");
          if (!locked || !providerKey || providerKey !== run.providerKey || locked.model !== run.model) return null;
          const url = providerKey === "bailian" ? BAILIAN_COMPATIBLE_BASE_URL : writingUrl[providerKey];
          return { apiKey: locked.apiKey, url, models: [locked.model] };
        },
        onProductionExchange: async (event) => {
          const locked = await featureConfig!.credentialForTask("writing", workspaceId, event.runId);
          const usage = event.usage.status === "present" && event.usage.totalTokens !== null
            ? { status: "present" as const, amount: event.usage.totalTokens, unit: "token" as const }
            : { status: "unknown" as const };
          await featureConfig!.recordExecution({
            feature: "writing",
            workspaceId,
            projectId: event.projectId,
            projectLabel: event.projectId,
            episodeId: null,
            episodeLabel: "整部作品",
            taskId: event.runId,
            actorId: event.actorId,
            vendor: locked?.vendor ?? event.providerKey,
            model: event.model,
            configVersion: locked?.versionId ?? null,
            credentialRef: locked?.credentialRef ?? null,
            vendorRequestId: event.vendorRequestId,
            result: event.ok ? "succeeded" : "failed",
            usage,
            cost: { status: "pending" },
          });
        },
      } : {}),
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
      ...(featureConfig ? { featureWritingLock: async () => {
        const binding = await featureConfig!.readBinding("writing");
        if (!binding || binding.source !== "enabled") return null;
        const providerKey = writingProviderForVendor(binding.vendor);
        if (!providerKey) return null;
        const providerAdapter = featureWritingSdkAdapter(binding.vendor);
        return {
          providerKey,
          model: binding.model,
          configVersion: binding.configVersion,
          credentialRef: binding.credentialRef,
          apiKey: binding.secret,
          ...(providerAdapter ? { providerAdapter } : {}),
        };
      }, featureWritingCommit: async (input) => {
        const binding = await featureConfig!.readBinding("writing");
        if (!binding || binding.source !== "enabled" || binding.credentialRef !== input.credentialRef) return;
        await featureConfig!.rememberLock({
          workspaceId,
          taskId: input.runId,
          feature: "writing",
          versionId: input.configVersion,
          credentialRef: input.credentialRef,
          vendor: binding.vendor,
          model: input.model,
          projectId: input.projectId,
          episodeId: null,
        });
      } } : {}),
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
      ...(featureConfig && { skillEnabled: (id) => featureConfig!.skillEnabled(id) }),
      workspaceId,
      nodeEnv: env.NODE_ENV,
      enabled: titleWritingEnabled,
      allowProduction: titleWritingAllowProduction,
      operatorToken: env.TITLE_WRITING_OPERATOR_TOKEN ?? null,
      siteOperator: siteLoginValid,
      defaultProvider,
      providers: titleProviders,
      store: candidateStore,
      creatorMembership: membership,
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
    // Shared with RealMediaService below: options.media must use the same enabled sunburst config path.
    const mediaStore = new RealMediaStore(pool, realRuntime.receiptCipher ? { receiptCipher: realRuntime.receiptCipher } : {});
    const autoCreation = new AutoCreationService({
      workspaceId,
      creatorMembership: membership,
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
      mediaImageProbe: async () => {
        // Hot-reloaded admin media keys live in the runtime env — never only the process snapshot.
        const mediaEnv = realRuntime.mediaEnvironment();
        const resolve = async (providerKey: "openai-media" | "dashscope-media") => {
          try {
            const resolved = await realRuntime.configurationForImageProvider(providerKey);
            return resolved && await mediaStore.configurationStillEnabled(resolved) ? resolved : null;
          } catch {
            return null;
          }
        };
        const openaiConfiguration = await resolve("openai-media");
        const dashscopeConfiguration = await resolve("dashscope-media");
        return {
          processImageProvider: mediaEnv.REAL_MEDIA_IMAGE_PROVIDER,
          // Legacy fields kept for older readers — OpenAI only.
          imageProvider: mediaEnv.REAL_MEDIA_IMAGE_PROVIDER,
          mediaApiKeyPresent: Boolean(mediaEnv.OPENAI_MEDIA_API_KEY),
          configuration: openaiConfiguration,
          openai: {
            providerKey: "openai-media" as const,
            // Writing OPENAI_API_KEY is intentionally ignored — only the media key counts.
            mediaApiKeyPresent: Boolean(mediaEnv.OPENAI_MEDIA_API_KEY),
            unitPricePresent: Boolean(mediaEnv.OPENAI_MEDIA_PRICE_IMAGE),
            priceVersionPresent: Boolean(mediaEnv.REAL_MEDIA_PRICE_VERSION),
            configuration: openaiConfiguration,
          },
          dashscope: {
            providerKey: "dashscope-media" as const,
            // Image media key only — never Bailian TTS or writing keys.
            mediaApiKeyPresent: Boolean(mediaEnv.DASHSCOPE_MEDIA_API_KEY),
            unitPricePresent: Boolean(mediaEnv.DASHSCOPE_MEDIA_PRICE_IMAGE),
            priceVersionPresent: Boolean(mediaEnv.REAL_MEDIA_PRICE_VERSION),
            configuration: dashscopeConfiguration,
          },
        };
      },
      mediaVoiceProbe: async () => {
        const mediaEnv = realRuntime.mediaEnvironment();
        let configuration;
        try {
          const resolved = await realRuntime.minimaxTtsConfiguration();
          configuration = resolved && await mediaStore.configurationStillEnabled(resolved) ? resolved : null;
        } catch {
          configuration = null;
        }
        let baseUrlCompliant = true;
        try {
          canonicalMiniMaxTtsBaseUrl(mediaEnv.MINIMAX_TTS_BASE_URL ?? "https://api.minimaxi.com");
        } catch {
          baseUrlCompliant = false;
        }
        return {
          // Only MINIMAX_API_KEY counts — never ELEVENLABS_TTS_API_KEY or writing OPENAI_API_KEY.
          minimaxApiKeyPresent: Boolean(mediaEnv.MINIMAX_API_KEY),
          unitPricePresent: Boolean(mediaEnv.MINIMAX_TTS_PRICE_CHARACTER),
          priceVersionPresent: Boolean(mediaEnv.REAL_MEDIA_PRICE_VERSION),
          baseUrlCompliant,
          configuration,
          // Phase 3 wires speech catalog/quote/generate onto MiniMax; assertRealMediaInput accepts minimaxSpeech.
          webPathAcceptsMinimax: true,
        };
      },
      mediaVideoProbe: async () => {
        const mediaEnv = realRuntime.mediaEnvironment();
        let configuration;
        try {
          const resolved = await realRuntime.configurationFor("video.generate");
          configuration = resolved && await mediaStore.configurationStillEnabled(resolved) ? resolved : null;
        } catch {
          configuration = null;
        }
        return {
          dashscopeApiKeyPresent: Boolean(mediaEnv.DASHSCOPE_MEDIA_API_KEY),
          unitPricePresent: Boolean(mediaEnv.DASHSCOPE_MEDIA_PRICE_VIDEO_SECOND),
          priceVersionPresent: Boolean(mediaEnv.REAL_MEDIA_PRICE_VERSION),
          configuration,
          chinesePromptGateReady: true,
          characterReferenceGate: env.M3_CHARACTER_REFERENCE_GATE,
          shotComposeEnabled: localComposeEnabled && (mockAvEnabled || realComposeAllowed),
          episodeComposeEnabled,
        };
      },
    });
    const shortSequelAi = new ShortSequelAiService({ workspaceId, enabled: autoCreationEnabled,
      operatorToken: env.TITLE_WRITING_OPERATOR_TOKEN ?? null, siteOperator: siteLoginValid, defaultProvider,
      providers: titleProviders, source: new ShortSequelStore(pool), store: candidateStore,
      transport: createFetchTransport(), maxCallsPerDay, maxActiveRuns });
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
    const vimaxProductionAllowed = env.VIMAX_ALLOW_PRODUCTION === true && siteLoginValid;
    const planningStore = new PostgresVimaxPlanningStore(pool);
    const vimaxPlanning = new VimaxPlanningService({ workspaceId, nodeEnv: env.NODE_ENV,
      ...(featureConfig && { skillEnabled: (id) => featureConfig!.skillEnabled(id) }),
      enabled: titleWritingEnabled && env.VIMAX_PLANNING_ENABLED === true,
      allowProduction: vimaxProductionAllowed, siteAuthRequired: siteLoginValid, siteOperator: siteLoginValid,
      operatorToken: env.TITLE_WRITING_OPERATOR_TOKEN ?? null, defaultProvider, providers: titleProviders,
      store: planningStore, executor: new VimaxPlanningExecutor({ workspaceId, store: planningStore, providers: titleProviders,
        transport: createFetchTransport() }), maxCallsPerDay, maxActiveRuns });

    const mediaAssets = new MediaAssetStore(pool);
    // Object store is independent of image-provider keys / receipt cipher so uploads work without openai/dashscope.
    const objectStore = storageAuthority
      ? new ManagedStorageRouter(storageAuthority, storageOptions)
      : new MediaS3Client(legacyStorage);
    const mediaClient = realRuntime.receiptCipher ? objectStore : null;
    const assetUpload = new AssetUploadService({
      workspaceId,
      store: new UploadSessionStore(pool),
      objects: objectStore,
    });
    const realMedia = new RealMediaService({ workspaceId, enabled: realRuntime.enabled, readEnabled:realAccessAllowed, characterReferenceGate:env.M3_CHARACTER_REFERENCE_GATE, store: mediaStore, jobs, assets: mediaAssets,
      configurationFor: async (capability, client) => {
        const configuration = await realRuntime.configurationFor(capability);
        return configuration && await mediaStore.configurationStillEnabled(configuration, client) ? configuration : null;
      },
      configurationForImageProvider: async (providerKey, client) => {
        const configuration = await realRuntime.configurationForImageProvider(providerKey);
        return configuration && await mediaStore.configurationStillEnabled(configuration, client) ? configuration : null;
      },
      comfyUiConfigurationFor: async client => {
        const configuration = realRuntime.comfyUiConfiguration();
        return configuration?.enabled && await mediaStore.configurationStillEnabled(configuration, client) ? configuration : null;
      },
      comfyUiReadiness: () => realRuntime.checkComfyUi(),
      ...(featureConfig ? {
        featureImageProvider: async () => {
          const binding = await featureConfig!.readBinding("storyboard");
          if (!binding || binding.source !== "enabled") return null;
          return storyboardProviderForVendor(binding.vendor);
        },
        featureVoiceVendor: async () => {
          const binding = await featureConfig!.readBinding("voice");
          if (!binding || binding.source !== "enabled") return null;
          if (binding.vendor === "bailian") return "bailian" as const;
          if (binding.vendor === "minimax") return "minimax" as const;
          return null;
        },
        onFeatureMediaTask: async (input) => {
          const execution = await mediaStore.loadExecution(workspaceId, input.jobId);
          const capability = execution?.inputSnapshot.capability;
          const feature = capability === "image.generate" ? "storyboard" as const : capability === "audio.tts" ? "voice" as const : null;
          if (!feature) return;
          const binding = await featureConfig!.readBinding(feature);
          if (!binding || binding.source !== "enabled") return;
          const found = await pool.query(
            `SELECT e.id AS episode_id, e.episode_no
               FROM shot_revision r
               JOIN shot sh ON sh.id = r.shot_id AND sh.workspace_id = r.workspace_id
               JOIN episode e ON e.id = sh.episode_id AND e.workspace_id = sh.workspace_id
              WHERE r.id = $1 AND r.workspace_id = $2 AND r.project_id = $3`,
            [input.shotRevisionId, workspaceId, input.projectId],
          ) as { rows: Array<{ episode_id: string }> };
          const episode = found.rows[0];
          await featureConfig!.rememberLock({
            workspaceId,
            taskId: input.jobId,
            feature,
            versionId: binding.configVersion,
            credentialRef: binding.credentialRef,
            vendor: binding.vendor,
            model: binding.model,
            projectId: input.projectId,
            episodeId: episode?.episode_id ?? null,
          });
        },
      } : {}),
      minimaxTtsConfigurationFor: async client => {
        const configuration = await realRuntime.minimaxTtsConfiguration();
        return configuration && await mediaStore.configurationStillEnabled(configuration, client) ? configuration : null;
      },
      speechCatalog: async () => {
        const binding = featureConfig ? await featureConfig.readBinding("voice") : null;
        const bailian = binding?.source === "enabled" && binding.vendor === "bailian";
        if (bailian) {
          const configuration = await realRuntime.configurationFor("audio.tts");
          return configuration && await mediaStore.configurationStillEnabled(configuration)
            ? realRuntime.speechCatalog()
            : { available: false, reasonCode: "SPEECH_PROVIDER_NOT_CONFIGURED" as const, catalogVersion: "none", voices: [] };
        }
        // Official website voice is MiniMax speech-2.8-hd. Bailian is used only after an explicit enable.
        const configuration = await realRuntime.minimaxTtsConfiguration();
        return configuration && await mediaStore.configurationStillEnabled(configuration)
          ? realRuntime.minimaxSpeechCatalog()
          : { available: false, reasonCode: "SPEECH_PROVIDER_NOT_CONFIGURED" as const, catalogVersion: "none", voices: [] };
      },
      ...(objectStore ? { objects: {
        // Generated media reads still prefer the receipt-gated client; uploads work without image keys / receipt cipher.
        readVerified: mediaClient
          ? (asset, scope) => readVerifiedS3MediaObject(mediaClient, asset, scope)
          : async () => { throw new Error("MEDIA_OBJECT_CONTENT_INVALID"); },
        readUpload: (asset, scope) => readVerifiedUploadObject(objectStore, asset, scope),
      } } : {}) });
    const speechStore = new PostgresSpeechStore(pool, jobs);
    const speech = new SpeechService({ workspaceId, store: speechStore, batchStore: new PostgresSpeechBatchStore(pool, jobs), generation: realMedia.speechPort() });
    const voiceCompose = new VoiceComposeService({ workspaceId,
      enabled: realComposeAllowed && env.M4_LOCAL_COMPOSE_ENABLED && Boolean(composeObjectDir), jobs,
      store: new PostgresVoiceComposeStore(pool, jobs), speech: speechStore });
    if (admin) setOperationJournal(new OperationLogStore(operationLogPath(admin.path)));
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
        env.M3_CHARACTER_REFERENCE_GATE, realComposeAllowed && localComposeEnabled, !nonProduction,
        featureConfig ? () => featureConfig.skillEnabled("qc-skill") : undefined), store, titleWriting,
      adminModels, adminMediaKeys, admin?.enabled ?? false, scriptBreakdown, writingCandidates, autoCreation, seriesWriting,
      new VimaxPreviewService({ workspaceId, nodeEnv: env.NODE_ENV, allowProduction: vimaxProductionAllowed, source: new VimaxPreviewSourceStore(pool) }),
      new VimaxCandidateService({ workspaceId, nodeEnv: env.NODE_ENV, allowProduction: vimaxProductionAllowed, store: new VimaxCandidateStore(pool, textChain) }),
      vimaxPlanning, realMedia, speech, voiceCompose, () => objectStore.destroy(), storageSettings, checkComfyUi,
      shortSequelAi, assetUpload, featureConfig);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.titleMaintenance) clearInterval(this.titleMaintenance);
    if (this.candidateMaintenance) clearInterval(this.candidateMaintenance);
    if (this.autoMaintenance) clearInterval(this.autoMaintenance);
    if (this.seriesMaintenance) clearInterval(this.seriesMaintenance);
    if (this.planningMaintenance) clearInterval(this.planningMaintenance);
    this.closeMediaStorage?.();
    await closePostgresPool(this.pool);
  }
}
