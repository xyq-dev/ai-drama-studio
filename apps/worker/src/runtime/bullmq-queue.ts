import { Queue, Worker, type ConnectionOptions } from "bullmq";
import type { JobEnqueuer, DispatchMessage } from "./dispatcher";
import { dispatchJobId } from "./dispatcher";

export const GENERATION_QUEUE = "generation-jobs";

export interface QueueMessage {
  workspaceId: string;
  jobId: string;
  dispatchSeq: number;
}

function isDuplicate(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return message.toLowerCase().includes("already exists") || message.toLowerCase().includes("jobid");
}

export class BullMqQueue implements JobEnqueuer {
  readonly queue: Queue<QueueMessage>;

  constructor(connection: ConnectionOptions, prefix: string) {
    this.queue = new Queue<QueueMessage>(GENERATION_QUEUE, { connection, prefix });
  }

  async enqueue(message: DispatchMessage): Promise<"enqueued" | "duplicate"> {
    try {
      await this.queue.add(
        "dispatch",
        {
          workspaceId: message.workspaceId,
          jobId: message.jobId,
          dispatchSeq: message.dispatchSeq,
        },
        {
          jobId: dispatchJobId(message.jobId, message.dispatchSeq),
          removeOnComplete: 1000,
          removeOnFail: 1000,
        },
      );
      return "enqueued";
    } catch (error) {
      if (isDuplicate(error)) return "duplicate";
      throw error;
    }
  }

  async hasDispatch(jobId: string, dispatchSeq: number): Promise<boolean> {
    const job = await this.queue.getJob(dispatchJobId(jobId, dispatchSeq));
    if (!job) return false;
    const state = await job.getState();
    return state !== "failed" && state !== "completed" && state !== "unknown";
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

export function startBullWorker(
  connection: ConnectionOptions,
  prefix: string,
  handler: (message: QueueMessage) => Promise<void>,
): Worker<QueueMessage> {
  return new Worker<QueueMessage>(
    GENERATION_QUEUE,
    async (job) => {
      await handler(job.data);
    },
    { connection, prefix, concurrency: 4 },
  );
}
