import {
  JobPersistenceService,
  MediaAssetStore,
  RuntimeStore,
  TextChainService,
  createPostgresPool,
  closePostgresPool,
  type PostgresPool,
} from "@ai-drama/database";
import { MockMediaAdapter, MockProvider, type MockRequestState } from "@ai-drama/providers";
import { isAbsolute } from "node:path";
import { BullMqQueue, startBullWorker, type QueueMessage } from "./bullmq-queue";
import { MockJobConsumer } from "./consumer";
import { OutboxDispatcher } from "./dispatcher";
import { RuntimeReconciler } from "./reconciler";
import { startStaleRecalculationPolling } from "./stale-recalculation";
import { LocalMockObjects } from "./local-mock-objects";
import { runMockImageJob } from "./mock-image-generation";
import { MockMediaRecovery } from "./mock-media-recovery";

export interface QueueRuntimeStatus {
  running: boolean;
}

export interface RuntimeHandle {
  status: QueueRuntimeStatus;
  shutdown(): Promise<void>;
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
  const connection = { url: options.redisUrl, maxRetriesPerRequest: null };
  const prefix = "ai-drama";
  const queue = new BullMqQueue(connection, prefix);
  const dispatcher = new OutboxDispatcher(store, queue);
  const consumer = new MockJobConsumer(jobs, store, provider, `worker:${process.pid}`, options.leaseMs ?? 30_000);
  const assets = new MediaAssetStore(pool);
  const mockMedia = new MockMediaAdapter();
  const objects = options.mockObjectDir ? new LocalMockObjects(options.mockObjectDir) : null;
  const mediaRecovery = objects ? new MockMediaRecovery(jobs, assets, store, mockMedia, objects) : null;
  const reconciler = new RuntimeReconciler(jobs, store, provider, dispatcher,
    options.orphanGraceMs ?? 30_000, mediaRecovery ? () => mediaRecovery.reconcileOnce() : undefined);
  const status: QueueRuntimeStatus = { running: false };
  const worker = startBullWorker(
    { url: options.redisUrl, maxRetriesPerRequest: null },
    prefix,
    async (message: QueueMessage) => {
      const media = await store.loadMockImageExecution(message.workspaceId, message.jobId);
      if (media) {
        if (media.state === "SUCCEEDED" || media.state === "FAILED" || media.state === "CANCELED") return;
        if (!objects || !media.shotRevisionId || !media.providerConfigurationId) {
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
        await runMockImageJob({ workspaceId: message.workspaceId, projectId: media.projectId,
          shotRevisionId: media.shotRevisionId, jobId: message.jobId,
          dispatchSeq: message.dispatchSeq, providerConfigurationId: media.providerConfigurationId,
          inputHash: media.inputHash, inputSnapshot: media.inputSnapshot,
          traceId: `worker:mock-image:${message.jobId}` },
        { jobs, assets, adapter: mockMedia, objects });
        return;
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
      clearInterval(dispatchTimer);
      clearInterval(reconcileTimer);
      await staleRecalculation.shutdown();
      await worker.close();
      await queue.close();
      await closePostgresPool(pool);
    },
  };
}
