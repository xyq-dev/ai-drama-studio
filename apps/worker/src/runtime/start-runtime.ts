import {
  JobPersistenceService,
  MockTextService,
  MediaAssetStore,
  RuntimeStore,
  TextChainService,
  createPostgresPool,
  closePostgresPool,
  isMockMediaJobKind,
  type PostgresPool,
  CharacterReferenceStore,
} from "@ai-drama/database";
import { composeSourcesAllowed,isSampleVideoSnapshot,realMediaAccessAllowed } from "@ai-drama/contracts";
import { MockMediaAdapter, MockProvider, MockTextAdapter, type MockRequestState } from "@ai-drama/providers";
import { isAbsolute } from "node:path";
import { BullMqQueue, startBullWorker, type QueueMessage } from "./bullmq-queue";
import { MockJobConsumer } from "./consumer";
import { OutboxDispatcher } from "./dispatcher";
import { RuntimeReconciler } from "./reconciler";
import { startStaleRecalculationPolling } from "./stale-recalculation";
import { LocalMockObjects } from "./local-mock-objects";
import { CHARACTER_REFERENCE_JOB_KIND, COMPOSE_JOB_SCHEMA, EPISODE_COMPOSE_JOB_SCHEMA } from "@ai-drama/domain";
import { runComposeJob, runEpisodeComposeJob, stopActiveComposeChildren, withSingleComposeRender } from "./compose-job";
import { runMockAvJob } from "./mock-av-generation";
import { runMockImageJob } from "./mock-image-generation";
import { runMockSmJob } from "./mock-sm-generation";
import { MockMediaRecovery } from "./mock-media-recovery";
import { CharacterReferenceRecovery, runMockCharacterReferenceJob } from "./mock-character-reference";
import { describeRecoveryError, isProcessStopping, runRecoveryModules } from "./recovery-modules";
import { RealMediaStore, PostgresVoiceComposeStore } from "@ai-drama/database";
import { MediaS3Client, type ServerRealMediaRuntime, type MediaS3Configuration } from "@ai-drama/providers";
import { VOICE_COMPOSE_JOB_SCHEMA, type VoiceComposeJobSnapshot } from "@ai-drama/domain";
import { runRealMediaJob, RealMediaRecovery, type RealMediaWorkerDependencies } from "./real-media-job";
import { S3RealMediaObjects } from "./real-media-objects";
import { createRealMediaMaterializer, preflightRealMediaTools } from "./real-media-materializer";
import { runVoiceComposeJob } from "./voice-compose-job";

export interface QueueRuntimeStatus {
  running: boolean;
}

export interface RuntimeHandle {
  status: QueueRuntimeStatus;
  shutdown(): Promise<void>;
}

async function failComposeConfiguration(
  jobs: JobPersistenceService,
  message: QueueMessage,
  state: string,
  leaseMs: number | undefined,
  messageText: string,
): Promise<void> {
  if (state !== "QUEUED") throw new Error("Compose configuration missing for an already active attempt");
  const acquired = await jobs.acquireQueuedJob({
    workspaceId: message.workspaceId,
    jobId: message.jobId,
    dispatchSeq: message.dispatchSeq,
    leaseOwner: `compose-config:${process.pid}`,
    leaseMs: leaseMs ?? 30_000,
    traceId: `compose:missing-config:${message.jobId}`,
    providerConfigurationId: null,
  });
  if (!acquired) return;
  await jobs.failJob({
    workspaceId: message.workspaceId,
    jobId: message.jobId,
    attemptId: acquired.attemptId,
    traceId: `compose:missing-config:${message.jobId}`,
    errorCode: "CONFIGURATION_ERROR",
    errorMessage: messageText,
    retryable: false,
  });
}

function inspectState(state: MockRequestState): "ACTIVE" | "SUCCEEDED" | "FAILED" | "UNKNOWN" {
  if (state === "SUCCEEDED") return "SUCCEEDED";
  if (state === "FAILED" || state === "CANCELED") return "FAILED";
  if (state === "ACTIVE") return "ACTIVE";
  return "UNKNOWN";
}

export async function startQueueRuntime(options: {
  nodeEnv?:"development"|"test"|"production";
  realMediaSiteAuthConfigured?:boolean;
  realMediaAllowProduction?:boolean;
  characterReferenceGate?:"legacy"|"strict";
  databaseUrl: string;
  redisUrl: string;
  leaseMs?: number;
  orphanGraceMs?: number;
  dispatchIntervalMs?: number;
  reconcileIntervalMs?: number;
  staleRecalculationIntervalMs?: number;
  mockObjectDir?: string;
  mockImageEnabled?: boolean;
  mockAvEnabled?: boolean;
  mockSampleVideoEnabled?: boolean;
  mockSmEnabled?: boolean;
  localComposeEnabled?: boolean;
  episodeComposeEnabled?: boolean;
  composeWorkDir?: string;
  composeObjectDir?: string;
  composePythonBin?: string;
  composePythonPath?: string;
  composeHoldBeforeCommitMs?: number;
  composeLeaseMs?: number;
  composeFailInsideCommit?: boolean;
  /** Receives one line per failed recovery module or reconcile pass. Defaults to stderr. */
  onRecoveryError?: (message: string) => void;
  realMediaRuntime?: ServerRealMediaRuntime;
  realMediaS3?: MediaS3Configuration;
  voiceComposeEnabled?: boolean;
  voiceComposeFontPath?: string;
}): Promise<RuntimeHandle> {
  const nodeEnv=options.nodeEnv??process.env.NODE_ENV??"development";
  const realAccessAllowed=realMediaAccessAllowed({nodeEnv,siteAuthConfigured:options.realMediaSiteAuthConfigured===true,allowProduction:options.realMediaAllowProduction===true});
  if (options.mockObjectDir && (nodeEnv === "production" || !isAbsolute(options.mockObjectDir))) {
    throw new Error("Mock media requires an absolute local directory and is forbidden in production");
  }
  const pool: PostgresPool = createPostgresPool({
    connectionString: options.databaseUrl,
    connectionTimeoutMs: 2000,
    statementTimeoutMs: 10000,
    queryTimeoutMs: 10000,
  });
  const provider = new MockProvider();
  const jobs = new JobPersistenceService(pool, {
    inspect: ({ providerRequestId }) => Promise.resolve(inspectState(provider.inspect(providerRequestId))),
  });
  const store = new RuntimeStore(pool);
  const mockText = new MockTextService(pool);
  const textAdapter = new MockTextAdapter();
  const connection = { url: options.redisUrl, maxRetriesPerRequest: null };
  const prefix = "ai-drama";
  const queue = new BullMqQueue(connection, prefix);
  const dispatcher = new OutboxDispatcher(store, queue);
  const consumer = new MockJobConsumer(jobs, store, provider, `worker:${process.pid}`,
    options.leaseMs ?? 30_000, mockText, textAdapter);
  const assets = new MediaAssetStore(pool);
  const mockMedia = new MockMediaAdapter();
  const objects = options.mockObjectDir ? new LocalMockObjects(options.mockObjectDir) : null;
  const realStore = new RealMediaStore(pool, options.realMediaRuntime?.receiptCipher
    ? { receiptCipher: options.realMediaRuntime.receiptCipher } : {});
  const realClient = options.realMediaRuntime?.receiptCipher && options.realMediaS3 ? new MediaS3Client(options.realMediaS3) : null;
  const realObjects = realClient ? new S3RealMediaObjects(realClient) : null;
  const realDependencies: RealMediaWorkerDependencies | null = realObjects && options.realMediaRuntime && options.composeWorkDir
    ? { jobs, assets, store: realStore, objects: realObjects,characterReferenceGate:options.characterReferenceGate,
      adapterFor: (configuration, mode) => options.realMediaRuntime!.adapterFor(configuration, mode),
      materialize: createRealMediaMaterializer({ workDir: options.composeWorkDir }),
      preflightLocal: () => preflightRealMediaTools({ workDir: options.composeWorkDir! }) }
    : null;
  const realRecovery = realDependencies ? new RealMediaRecovery(realDependencies) : null;
  const voiceStore = new PostgresVoiceComposeStore(pool, jobs);
  const mediaRecovery = new MockMediaRecovery(jobs, assets, store, mockMedia, objects, {
    mockImageEnabled: options.mockImageEnabled === true,
    mockAvEnabled: options.mockAvEnabled === true,
    mockSampleVideoEnabled: options.mockSampleVideoEnabled === true,
    mockSmEnabled: options.mockSmEnabled === true,
  });
  const references = new CharacterReferenceStore(pool);
  const referenceRecovery = new CharacterReferenceRecovery(jobs, store,
    { references, adapter: mockMedia, objects }, options.mockImageEnabled === true);
  const status: QueueRuntimeStatus = { running: false };
  const reportRecovery = options.onRecoveryError ?? ((message: string) => { console.error(message); });
  // Shot media and character references recover in turn; a fault in one is reported and does not skip the other.
  const reconciler = new RuntimeReconciler(jobs, store, provider, dispatcher,
    options.orphanGraceMs ?? 30_000,
    async () => {
      await runRecoveryModules([
        { name: "mock-media", run: () => mediaRecovery.reconcileOnce() },
        { name: "character-reference", run: () => referenceRecovery.reconcileOnce() },
        ...(realRecovery ? [{ name: "real-media", run: () => realRecovery.reconcileOnce() }] : []),
      ], {
        running: () => status.running,
        report: (module, error) => reportRecovery(describeRecoveryError(module, error)),
      });
    },
    mockText, textAdapter);
  const worker = startBullWorker(
    { url: options.redisUrl, maxRetriesPerRequest: null },
    prefix,
    async (message: QueueMessage) => {
      const dispatch = await store.readJobDispatchMetadata(message.workspaceId, message.jobId);
      const kind = dispatch?.kind ?? null;
      if (dispatch?.schema === "real-media.v1") {
        // Leave the authorized Job queued for configuration repair, never fall through to Mock generation.
        if (!realAccessAllowed || !realDependencies || !options.realMediaRuntime?.enabled) return;
        const execution = await realStore.loadExecution(message.workspaceId, message.jobId);
        if (execution) await runRealMediaJob(execution, realDependencies);
        return;
      }
      if (kind === "MEDIA_COMPOSE") {
        const compose = await store.loadComposeJob(message.workspaceId, message.jobId);
        if (!compose) throw new Error("Compose job missed its loader");
        if (compose.state === "SUCCEEDED" || compose.state === "FAILED" || compose.state === "CANCELED") return;
        const snapshot = compose.inputSnapshot as { schema?: string; input?: { episodeId?: string } };
        const workDir = options.composeWorkDir;
        const objectDir = options.composeObjectDir;
        if (snapshot.schema === VOICE_COMPOSE_JOB_SCHEMA) {
          if (!realAccessAllowed || !options.voiceComposeEnabled || !workDir || !objectDir || !realObjects || !compose.shotRevisionId) {
            await failComposeConfiguration(jobs, message, compose.state, options.leaseMs, "Voice compose requires verified media storage and renderer configuration");
            return;
          }
          if (compose.state !== "QUEUED") return;
          await withSingleComposeRender(() => runVoiceComposeJob({ workspaceId: message.workspaceId, projectId: compose.projectId,
            shotRevisionId: compose.shotRevisionId!, jobId: message.jobId, dispatchSeq: message.dispatchSeq, inputHash: compose.inputHash,
            inputSnapshot: compose.inputSnapshot as VoiceComposeJobSnapshot, traceId: "worker:voice-compose:" + message.jobId },
          { jobs, voiceStore, objectReader: realObjects, workDir, objectDir,
            pythonBin: options.composePythonBin ?? "python3", pythonPath: options.composePythonPath ?? "",
            leaseOwner: "voice-compose:" + process.pid, leaseMs: options.composeLeaseMs ?? 30_000,
            ...(options.voiceComposeFontPath ? { fontPath: options.voiceComposeFontPath } : {}) }));
          return;
        }
        if (snapshot.schema === EPISODE_COMPOSE_JOB_SCHEMA) {
          const episodeId = snapshot.input?.episodeId;
          if (options.episodeComposeEnabled !== true || !workDir || !objectDir || !episodeId || (nodeEnv==="production"&&(!realAccessAllowed||!realObjects))) {
            await failComposeConfiguration(jobs, message, compose.state, options.leaseMs, "Episode compose requires the episode switch, work directory, and object directory");
            return;
          }
          if (compose.cancelRequested && compose.state === "QUEUED") {
            await jobs.cancelJob({ workspaceId: message.workspaceId, jobId: message.jobId, traceId: `episode-compose:cancel:${message.jobId}` });
            return;
          }
          if (compose.state === "RUNNING") {
            throw new Error("Compose attempt is in progress; lease recovery must finish before redelivery");
          }
          if(nodeEnv==="production"){
            const sources=(compose.inputSnapshot as {input?:{sourceObjects?:Array<{assetId:string}>}}).input?.sourceObjects;
            if(!Array.isArray(sources)||sources.length===0)throw new Error("Episode compose has no sources");
            await assets.preflightEpisodeCompose(message.workspaceId,compose.projectId,episodeId,sources.map(source=>source.assetId),{realOnly:true});
          }
          await withSingleComposeRender(() => runEpisodeComposeJob({
            workspaceId: message.workspaceId,
            projectId: compose.projectId,
            episodeId,
            jobId: message.jobId,
            dispatchSeq: message.dispatchSeq,
            inputHash: compose.inputHash,
            inputSnapshot: compose.inputSnapshot as never,
            traceId: `worker:episode-compose:${message.jobId}`,
          }, {
            jobs, assets, workDir, objectDir,
            pythonBin: options.composePythonBin ?? "python3",
            pythonPath: options.composePythonPath ?? "",
            leaseOwner: `episode-compose:${process.pid}`,
            leaseMs: options.composeLeaseMs ?? 30_000,
            holdBeforeCommitMs: options.composeHoldBeforeCommitMs ?? 0,
            failInsideCommit: options.composeFailInsideCommit === true,
          }));
          return;
        }
        if (snapshot.schema !== COMPOSE_JOB_SCHEMA) {
          await failComposeConfiguration(jobs, message, compose.state, options.leaseMs, "Compose snapshot schema is not a known local renderer");
          return;
        }
        const shotRevisionId = compose.shotRevisionId;
        const mockObjectDir = options.mockObjectDir;
        const sourceObjects=(compose.inputSnapshot as {input?:{sourceObjects?:unknown}}).input?.sourceObjects;
        const sourcesEnabled=composeSourcesAllowed(sourceObjects,{allowReal:realAccessAllowed&&Boolean(realObjects),
          allowMockAv:nodeEnv!=="production"&&Boolean(mockObjectDir)&&options.mockAvEnabled===true,
          allowMockSm:nodeEnv!=="production"&&Boolean(mockObjectDir)&&options.mockSmEnabled===true});
        if (options.localComposeEnabled !== true || !sourcesEnabled || !workDir || !objectDir || !shotRevisionId) {
          if (compose.state !== "QUEUED") throw new Error("Compose configuration missing for an already active attempt");
          const acquired = await jobs.acquireQueuedJob({
            workspaceId: message.workspaceId, jobId: message.jobId, dispatchSeq: message.dispatchSeq,
            leaseOwner: `compose-config:${process.pid}`, leaseMs: options.leaseMs ?? 30_000,
            traceId: `compose:missing-config:${message.jobId}`, providerConfigurationId: null,
          });
          if (acquired) {
            await jobs.failJob({
              workspaceId: message.workspaceId, jobId: message.jobId, attemptId: acquired.attemptId,
              traceId: `compose:missing-config:${message.jobId}`, errorCode: "CONFIGURATION_ERROR",
              errorMessage: "Local compose requires an absolute work directory, object directory, and mock sources",
              retryable: false,
            });
          }
          return;
        }
        if (compose.cancelRequested && compose.state === "QUEUED") {
          await jobs.cancelJob({ workspaceId: message.workspaceId, jobId: message.jobId, traceId: `compose:cancel:${message.jobId}` });
          return;
        }
        if (compose.state === "RUNNING") {
          throw new Error("Compose attempt is in progress; lease recovery must finish before redelivery");
        }
        await withSingleComposeRender(() => runComposeJob({
          workspaceId: message.workspaceId,
          projectId: compose.projectId,
          shotRevisionId,
          jobId: message.jobId,
          dispatchSeq: message.dispatchSeq,
          inputHash: compose.inputHash,
          inputSnapshot: compose.inputSnapshot as never,
          traceId: `worker:compose:${message.jobId}`,
        }, {
          jobs, assets, ...(mockObjectDir ? { mockObjectDir } : {}), workDir, ...(realObjects ? { objectReader: realObjects } : {}),
          objectDir, pythonBin: options.composePythonBin ?? "python3",
          pythonPath: options.composePythonPath ?? "", leaseOwner: `compose:${process.pid}`,
          leaseMs: options.composeLeaseMs ?? 30_000, holdBeforeCommitMs: options.composeHoldBeforeCommitMs ?? 0,
          failInsideCommit: options.composeFailInsideCommit === true,
        }));
        return;
      }
      if (kind === CHARACTER_REFERENCE_JOB_KIND) {
        const reference = await store.loadCharacterReferenceExecution(message.workspaceId, message.jobId);
        if (!reference) throw new Error("Character reference job missed its loader");
        if (reference.state === "SUCCEEDED" || reference.state === "FAILED" || reference.state === "CANCELED") return;
        if (reference.cancelRequested && reference.state === "QUEUED") {
          await jobs.cancelJob({ workspaceId: message.workspaceId, jobId: message.jobId,
            traceId: `worker:mock-reference:cancel:${message.jobId}` });
          return;
        }
        if (reference.state === "RUNNING" || reference.state === "WAITING_EXTERNAL") {
          throw new Error("Mock reference attempt is in progress; lease recovery must finish before redelivery");
        }
        if (options.mockImageEnabled !== true || !objects || !reference.providerConfigurationId) {
          const acquired = await jobs.acquireQueuedJob({ workspaceId: message.workspaceId,
            jobId: message.jobId, dispatchSeq: message.dispatchSeq,
            leaseOwner: `mock-reference-config:${process.pid}`, leaseMs: options.leaseMs ?? 30_000,
            traceId: `mock-reference:missing-config:${message.jobId}` });
          if (acquired) {
            await jobs.failJob({ workspaceId: message.workspaceId, jobId: message.jobId,
              attemptId: acquired.attemptId, traceId: `mock-reference:missing-config:${message.jobId}`,
              errorCode: "MOCK_MEDIA_NOT_CONFIGURED",
              errorMessage: "Mock reference images require local storage and provider configuration",
              retryable: false });
          }
          return;
        }
        await runMockCharacterReferenceJob({ workspaceId: message.workspaceId, projectId: reference.projectId,
          jobId: message.jobId, dispatchSeq: message.dispatchSeq,
          providerConfigurationId: reference.providerConfigurationId, inputHash: reference.inputHash,
          inputSnapshot: reference.inputSnapshot, traceId: `worker:mock-reference:${message.jobId}` },
        { jobs, references, adapter: mockMedia, objects });
        return;
      }
      const media = await store.loadMockMediaExecution(message.workspaceId, message.jobId);
      if (media) {
        if (media.state === "SUCCEEDED" || media.state === "FAILED" || media.state === "CANCELED") return;
        const sampleVideo = isSampleVideoSnapshot(media.inputSnapshot);
        const enabled = media.kind === "MEDIA_IMAGE" ? options.mockImageEnabled === true
          : (media.kind === "MEDIA_VIDEO" || media.kind === "MEDIA_TTS")
            ? options.mockAvEnabled === true && (!sampleVideo || options.mockSampleVideoEnabled === true)
            : (media.kind === "MEDIA_SUBTITLE" || media.kind === "MEDIA_MUSIC") && options.mockSmEnabled === true;
        if (!enabled || !objects || !media.shotRevisionId || !media.providerConfigurationId || !isMockMediaJobKind(media.kind)) {
          if (media.state !== "QUEUED") {
            throw new Error("Mock media configuration missing for an already active attempt");
          }
          const acquired = await jobs.acquireQueuedJob({ workspaceId: message.workspaceId,
            jobId: message.jobId, dispatchSeq: message.dispatchSeq,
            leaseOwner: `mock-media-config:${process.pid}`, leaseMs: options.leaseMs ?? 30_000,
            traceId: `mock-media:missing-config:${message.jobId}` });
          if (acquired) {
            await jobs.failJob({ workspaceId: message.workspaceId, jobId: message.jobId,
              attemptId: acquired.attemptId, traceId: `mock-media:missing-config:${message.jobId}`,
              errorCode: "MOCK_MEDIA_NOT_CONFIGURED",
              errorMessage: "Mock media requires local storage, shot and provider configuration",
              retryable: false });
          }
          return;
        }
        if (media.cancelRequested && media.state === "QUEUED") {
          await jobs.cancelJob({ workspaceId: message.workspaceId, jobId: message.jobId,
            traceId: `worker:mock-image:cancel:${message.jobId}` });
          return;
        }
        if (media.state === "RUNNING" || media.state === "WAITING_EXTERNAL") {
          throw new Error("Mock media attempt is in progress; lease recovery must finish before redelivery");
        }
        const traceId = `worker:mock-media:${message.jobId}`;
        if (media.kind === "MEDIA_IMAGE") {
          await runMockImageJob({ workspaceId: message.workspaceId, projectId: media.projectId,
            shotRevisionId: media.shotRevisionId, jobId: message.jobId,
            dispatchSeq: message.dispatchSeq, providerConfigurationId: media.providerConfigurationId,
            inputHash: media.inputHash, inputSnapshot: media.inputSnapshot, traceId },
          { jobs, assets, adapter: mockMedia, objects });
        } else if (media.kind === "MEDIA_SUBTITLE" || media.kind === "MEDIA_MUSIC") {
          await runMockSmJob({ workspaceId: message.workspaceId, projectId: media.projectId,
            shotRevisionId: media.shotRevisionId, jobId: message.jobId,
            dispatchSeq: message.dispatchSeq, providerConfigurationId: media.providerConfigurationId,
            inputHash: media.inputHash, inputSnapshot: media.inputSnapshot, traceId,
            capability: media.kind === "MEDIA_SUBTITLE" ? "subtitle.generate" : "audio.music" },
          { jobs, assets, adapter: mockMedia, objects });
        } else {
          await runMockAvJob({ workspaceId: message.workspaceId, projectId: media.projectId,
            shotRevisionId: media.shotRevisionId, jobId: message.jobId,
            dispatchSeq: message.dispatchSeq, providerConfigurationId: media.providerConfigurationId,
            inputHash: media.inputHash, inputSnapshot: media.inputSnapshot, traceId,
            capability: media.kind === "MEDIA_VIDEO" ? "video.generate" : "audio.tts" },
          { jobs, assets, adapter: mockMedia, objects });
        }
        return;
      }
      const execution = await store.loadExecution(message.workspaceId, message.jobId);
      if (execution && (execution.kind === "MEDIA_COMPOSE" || execution.kind === CHARACTER_REFERENCE_JOB_KIND
        || isMockMediaJobKind(execution.kind))) {
        throw new Error("Media job missed its dedicated route");
      }
      await consumer.handle(message);
    },
  );
  worker.on("error", () => undefined);
  status.running = true;
  const staleRecalculation = startStaleRecalculationPolling(
    new TextChainService(pool),
    options.staleRecalculationIntervalMs,
  );
  const dispatchTimer = setInterval(() => {
    void dispatcher.dispatchOnce().catch(() => undefined);
  }, options.dispatchIntervalMs ?? 1000);
  // One pass at a time: an overlapping pass would contend for the same attempts and leases.
  let reconciling = false;
  const reconcileTimer = setInterval(() => {
    if (reconciling) return;
    reconciling = true;
    void reconciler.reconcileOnce()
      .catch((error: unknown) => {
        // A pass cut short by shutdown is expected; anything else is reported and retried next interval.
        if (status.running && !isProcessStopping(error)) reportRecovery(describeRecoveryError("reconcile", error));
      })
      .finally(() => { reconciling = false; });
  }, options.reconcileIntervalMs ?? 5000);
  return {
    status,
    shutdown: async () => {
      status.running = false;
      stopActiveComposeChildren();
      clearInterval(dispatchTimer);
      clearInterval(reconcileTimer);
      await staleRecalculation.shutdown();
      await worker.close();
      await queue.close();
      realClient?.destroy();
      await closePostgresPool(pool);
    },
  };
}
