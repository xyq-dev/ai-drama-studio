import { describe, expect, it, vi } from "vitest";
import { EPISODE_PLAN_MIGRATION, EpisodePlanStore } from "./episode-plan";
import type { DatabasePool } from "./job-service";

type Answer = { rows: Array<Record<string, unknown>> };

/** A pool whose one client answers the readiness queries in order. */
function poolAnswering(answers: Array<Answer | Error>) {
  const release = vi.fn();
  const query = vi.fn(async () => {
    const next = answers.shift();
    if (!next) throw new Error("unexpected query");
    if (next instanceof Error) throw next;
    return next;
  });
  const connect = vi.fn(async () => ({ query, release }));
  return { pool: { connect } as unknown as DatabasePool, connect, release };
}

const READY: Answer[] = [
  { rows: [{ present: true }] },
  { rows: [{ name: EPISODE_PLAN_MIGRATION }] },
  { rows: [{ column_name: "episode_count" }, { column_name: "target_episode_seconds" }] },
];

describe("episode plan readiness", () => {
  it("is false, not an error, when no connection can be made", async () => {
    const pool = { connect: vi.fn(async () => { throw new Error("no database"); }) } as unknown as DatabasePool;
    await expect(new EpisodePlanStore(pool).ready()).resolves.toBe(false);
  });

  it("is false when a readiness query fails, and the connection is released", async () => {
    const { pool, release } = poolAnswering([new Error("relation does not exist")]);
    await expect(new EpisodePlanStore(pool).ready()).resolves.toBe(false);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("is false without the migration record or without both columns", async () => {
    expect(await new EpisodePlanStore(poolAnswering([{ rows: [{ present: false }] }]).pool).ready()).toBe(false);
    expect(await new EpisodePlanStore(poolAnswering([{ rows: [{ present: true }] }, { rows: [] }]).pool).ready()).toBe(false);
    expect(await new EpisodePlanStore(poolAnswering([...READY.slice(0, 2), { rows: [{ column_name: "episode_count" }] }]).pool).ready()).toBe(false);
  });

  it("is true with the record and both columns, and remembers only that positive answer", async () => {
    const { pool, connect } = poolAnswering([...READY]);
    const store = new EpisodePlanStore(pool);
    expect(await store.ready()).toBe(true);
    expect(await store.ready()).toBe(true);
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
