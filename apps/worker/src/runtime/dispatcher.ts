import type { OutboxDispatchRow, RuntimeStore } from "@ai-drama/database";

export interface DispatchMessage {
  workspaceId: string;
  jobId: string;
  dispatchSeq: number;
  outboxId: string;
}

export interface JobEnqueuer {
  enqueue(message: DispatchMessage): Promise<"enqueued" | "duplicate">;
  hasDispatch(jobId: string, dispatchSeq: number): Promise<boolean>;
}

export function dispatchJobId(jobId: string, dispatchSeq: number): string {
  return `${jobId}__${dispatchSeq}`;
}

export class OutboxDispatcher {
  constructor(
    private readonly store: RuntimeStore,
    private readonly queue: JobEnqueuer,
  ) {}

  async dispatchOnce(limit = 50): Promise<number> {
    const rows = await this.store.listUndispatched(limit);
    return this.enqueueRows(rows);
  }

  async hasDispatch(jobId: string, dispatchSeq: number): Promise<boolean> {
    return this.queue.hasDispatch(jobId, dispatchSeq);
  }

  private async enqueueRows(rows: readonly OutboxDispatchRow[]): Promise<number> {
    let delivered = 0;
    for (const row of rows) {
      try {
        await this.queue.enqueue({
          workspaceId: row.workspaceId,
          jobId: row.jobId,
          dispatchSeq: row.dispatchSeq,
          outboxId: row.id,
        });
        await this.store.markDispatched(row.id);
        delivered += 1;
      } catch (error) {
        const message = error instanceof Error ? error.name : "EnqueueFailed";
        await this.store.recordDispatchFailure(row.id, message);
      }
    }
    return delivered;
  }
}
