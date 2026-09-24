import { describe, expect, it } from "vitest";
import type { OutboxDispatchRow, RuntimeStore } from "@ai-drama/database";
import { OutboxDispatcher, type JobEnqueuer } from "./dispatcher";

function memoryStore(rows: OutboxDispatchRow[]): RuntimeStore {
  const dispatched: string[] = [];
  const failures: string[] = [];
  return {
    listUndispatched: async () => rows.filter((row) => !dispatched.includes(row.id)),
    listOrphanQueued: async () => [],
    markDispatched: async (id: string) => {
      dispatched.push(id);
    },
    recordDispatchFailure: async (id: string) => {
      failures.push(id);
    },
    dispatched,
    failures,
  } as unknown as RuntimeStore & { dispatched: string[]; failures: string[] };
}

describe("OutboxDispatcher", () => {
  const row: OutboxDispatchRow = { id: "out-1", workspaceId: "ws", jobId: "job-1", dispatchSeq: 1 };

  it("marks dispatched only after enqueue succeeds", async () => {
    const store = memoryStore([row]) as RuntimeStore & { dispatched: string[] };
    const queue: JobEnqueuer = { enqueue: async () => "enqueued" };
    const count = await new OutboxDispatcher(store, queue).dispatchOnce();
    expect(count).toBe(1);
    expect(store.dispatched).toEqual(["out-1"]);
  });

  it("leaves the outbox undispatched when enqueue fails", async () => {
    const store = memoryStore([row]) as RuntimeStore & { dispatched: string[]; failures: string[] };
    const queue: JobEnqueuer = {
      enqueue: async () => {
        throw new Error("redis down");
      },
    };
    const count = await new OutboxDispatcher(store, queue).dispatchOnce();
    expect(count).toBe(0);
    expect(store.dispatched).toEqual([]);
    expect(store.failures).toEqual(["out-1"]);
  });

  it("treats a duplicate enqueue as delivered and still marks dispatched", async () => {
    const store = memoryStore([row]) as RuntimeStore & { dispatched: string[] };
    const queue: JobEnqueuer = { enqueue: async () => "duplicate" };
    await new OutboxDispatcher(store, queue).dispatchOnce();
    expect(store.dispatched).toEqual(["out-1"]);
  });
});
