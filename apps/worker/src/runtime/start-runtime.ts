import { JobPersistenceService, RuntimeStore, createPostgresPool, closePostgresPool, type PostgresPool } from "@ai-drama/database";
import { MockProvider, type MockRequestState } from "@ai-drama/providers";
import { BullMqQueue, startBullWorker, type QueueMessage } from "./bullmq-queue";
import { MockJobConsumer } from "./consumer";
import { OutboxDispatcher } from "./dispatcher";
import { RuntimeReconciler } from "./reconciler";

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
}): Promise<RuntimeHandle> {
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
  const reconciler = new RuntimeReconciler(jobs, store, provider, dispatcher, options.orphanGraceMs ?? 30_000);
  const status: QueueRuntimeStatus = { running: false };
  const worker = startBullWorker({ url: options.redisUrl, maxRetriesPerRequest: null }, prefix, async (message: QueueMessage) => {
    await consumer.handle(message);
  });
  worker.on("error", () => undefined);
  status.running = true;
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
      await worker.close();
      await queue.close();
      await closePostgresPool(pool);
    },
  };
}
