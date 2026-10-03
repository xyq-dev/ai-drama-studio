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
} from "@ai-drama/database";
import { isSampleVideoSnapshot } from "@ai-drama/contracts";
import { MockMediaAdapter, MockProvider, MockTextAdapter, type MockRequestState } from "@ai-drama/providers";
import { isAbsolute } from "node:path";
import { BullMqQueue, startBullWorker, type QueueMessage } from "./bullmq-queue";
import { MockJobConsumer } from "./consumer";
import { OutboxDispatcher } from "./dispatcher";
import { RuntimeReconciler } from "./reconciler";
import { startStaleRecalculationPolling } from "./stale-recalculation";
import { LocalMockObjects } from "./local-mock-objects";
import { COMPOSE_JOB_SCHEMA, EPISODE_COMPOSE_JOB_SCHEMA } from "@ai-drama/domain";
import { runComposeJob, runEpisodeComposeJob, stopActiveComposeChildren, withSingleComposeRender } from "./compose-job";
import { runMockAvJob } from "./mock-av-generation";
import { runMockImageJob } from "./mock-image-generation";
import { runMockSmJob } from "./mock-sm-generation";
import { MockMediaRecovery } from "./mock-media-recovery";

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
}): Promise<RuntimeHandle> {
  if (options.mockObjectDir && (process.env.NODE_ENV === "production" || !isAbsolute(options.mockObjectDir))) {
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
  const mediaRecovery = new MockMediaRecovery(jobs, assets, store, mockMedia, objects, {
    mockImageEnabled: options.mockImageEnabled === true,
    mockAvEnabled: options.mockAvEnabled === true,
    mockSampleVideoEnabled: options.mockSampleVideoEnabled === true,
    mockSmEnabled: options.mockSmEnabled === true,
  });
  const reconciler = new RuntimeReconciler(jobs, store, provider, dispatcher,
    options.orphanGraceMs ?? 30_000, () => mediaRecovery.reconcileOnce(),
    mockText, textAdapter);
  const status: QueueRuntimeStatus = { running: false };
  const worker = startBullWorker(
    { url: options.redisUrl, maxRetriesPerRequest: null },
    prefix,
    async (message: QueueMessage) => {
      const kind = await store.readJobKind(message.workspaceId, message.jobId);
      if (kind === "MEDIA_COMPOSE") {
        const compose = await store.loadComposeJob(message.workspaceId, message.jobId);
        if (!compose) throw new Error("Compose job missed its loader");
        if (compose.state === "SUCCEEDED" || compose.state === "FAILED" || compose.state === "CANCELED") return;
        const snapshot = compose.inputSnapshot as { schema?: string; input?: { episodeId?: string } };
        const workDir = options.composeWorkDir;
        const objectDir = options.composeObjectDir;
        if (snapshot.schema === EPISODE_COMPOSE_JOB_SCHEMA) {
          const episodeId = snapshot.input?.episodeId;
          if (options.episodeComposeEnabled !== true || !workDir || !objectDir || !episodeId) {
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
        if (options.localComposeEnabled !== true || !mockObjectDir || !workDir || !objectDir || !shotRevisionId) {
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
          jobs, assets, mockObjectDir, workDir,
          objectDir, pythonBin: options.composePythonBin ?? "python3",
          pythonPath: options.composePythonPath ?? "", leaseOwner: `compose:${process.pid}`,
          leaseMs: options.composeLeaseMs ?? 30_000, holdBeforeCommitMs: options.composeHoldBeforeCommitMs ?? 0,
          failInsideCommit: options.composeFailInsideCommit === true,
        }));
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
      if (execution && (execution.kind === "MEDIA_COMPOSE" || isMockMediaJobKind(execution.kind))) {
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
  const reconcileTimer = setInterval(() => {
    void reconciler.reconcileOnce().catch(() => undefined);
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
      await closePostgresPool(pool);
    },
  };
}
