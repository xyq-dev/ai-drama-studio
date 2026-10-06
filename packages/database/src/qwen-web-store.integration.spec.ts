import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrations";
import { PostgresQwenWebStore, type QwenWebStoredRecord } from "./qwen-web-store";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for PostgreSQL integration tests");

/**
 * The draft table is not an applied migration. Its tests run only on an isolated database after the draft SQL
 * was explicitly authorized for that environment; CI does not set this variable.
 */
const draftAuthorized = process.env.QWEN_WEB_DRAFT_SQL_AUTHORIZED === "true";

const pool = new Pool({ connectionString: databaseUrl, max: 8 });
const store = new PostgresQwenWebStore(pool);

beforeAll(async () => {
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await runMigrations(pool);
});

afterAll(async () => {
  await pool.end();
});

describe("PostgresQwenWebStore without the draft table", () => {
  it("reports storage unavailable on the applied migrations", async () => {
    expect(await store.storageReady()).toBe(false);
  });
});

describe.runIf(draftAuthorized)("PostgresQwenWebStore on the authorized draft table", () => {
  let workspaceId: string;
  let projectId: string;

  beforeAll(async () => {
    const draft = await readFile(join(__dirname, "..", "prisma", "drafts", "20261005000100_qwen_web_writing.sql"), "utf8");
    await pool.query(draft);
    workspaceId = (await pool.query<{ id: string }>("INSERT INTO workspace (name) VALUES ('qwen') RETURNING id")).rows[0]!.id;
    projectId = (await pool.query<{ id: string }>(
      "INSERT INTO project (workspace_id, title) VALUES ($1, 'qwen') RETURNING id", [workspaceId])).rows[0]!.id;
  });

  function record(key: string, overrides: Partial<QwenWebStoredRecord> = {}): QwenWebStoredRecord {
    const now = new Date().toISOString();
    return {
      id: randomUUID(), workspaceId, projectId, actorId: "server-owner", idempotencyKey: key,
      inputHash: "ab".repeat(32), frozenInput: { schema: "qwen.writing.input.v1", mode: "story" },
      mode: "story", episodeNo: null, requestedModel: "qwen-test", state: "reserved", executorId: "executor-a",
      leaseUntil: new Date(Date.now() + 120_000).toISOString(), serverRequestId: null, errorCode: null,
      providerResult: null, candidateJson: null, candidateExpiresAt: null, billingStatus: "unknown",
      createdAt: now, updatedAt: now, ...overrides,
    };
  }

  const wide = { sinceIso: "2000-01-01T00:00:00.000Z", maxRequests: 1000, maxConcurrency: 1000 };

  it("is ready, replays the same key and refuses a different input with the same key", async () => {
    expect(await store.storageReady()).toBe(true);
    const first = await store.reserve(record("same-key"), wide);
    expect(first.kind).toBe("reserved");
    expect((await store.reserve(record("same-key"), wide)).kind).toBe("existing");
    const conflict = await store.reserve(record("same-key", { inputHash: "cd".repeat(32) }), wide);
    expect(conflict.kind).toBe("conflict");
  });

  it("admits one reservation when different keys race on the concurrency cap", async () => {
    await pool.query("UPDATE qwen_writing_request SET state = 'rejected' WHERE state IN ('reserved', 'submitted')");
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) =>
      store.reserve(record(`race-${index}`), { ...wide, maxConcurrency: 1 })));
    expect(results.filter((result) => result.kind === "reserved")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "blocked")).toHaveLength(5);
  });

  it("fences finish to the owning executor and recovers only expired leases", async () => {
    await pool.query("UPDATE qwen_writing_request SET state = 'rejected' WHERE state IN ('reserved', 'submitted')");
    const live = record("live");
    await store.reserve(live, wide);
    const now = new Date().toISOString();
    expect(await store.markSubmitted(live.id, "intruder", now, live.leaseUntil)).toBe(false);
    expect(await store.markSubmitted(live.id, "executor-a", now, live.leaseUntil)).toBe(true);
    const forged = await store.finish(live.id, "intruder", { state: "completed", serverRequestId: null, errorCode: null,
      providerResult: "completed", candidateJson: "{}", candidateExpiresAt: null, updatedAt: now });
    expect(forged.state).toBe("submitted");
    expect(await store.recoverExpired(now)).toBe(0);
    const expired = record("expired", { leaseUntil: new Date(Date.now() - 1000).toISOString() });
    await store.reserve(expired, wide);
    expect(await store.recoverExpired(new Date().toISOString())).toBe(1);
    expect((await store.findById(workspaceId, projectId, expired.id))?.state).toBe("rejected");
    expect((await store.findById(workspaceId, projectId, live.id))?.state).toBe("submitted");
    await pool.query("UPDATE qwen_writing_request SET lease_until = now() - interval '1 second' WHERE id = $1", [live.id]);
    expect(await store.recoverExpired(new Date().toISOString())).toBe(1);
    expect(await store.findById(workspaceId, projectId, live.id)).toMatchObject({
      state: "unknown", providerResult: "unknown", errorCode: "executor_lost", billingStatus: "unknown" });
    const late = await store.finish(live.id, "executor-a", { state: "completed", serverRequestId: "late",
      errorCode: null, providerResult: "completed", candidateJson: "{}", candidateExpiresAt: null, updatedAt: now });
    expect(late.state).toBe("unknown");
  });

  it("clears an expired candidate body and keeps the idempotency row", async () => {
    await pool.query("UPDATE qwen_writing_request SET state = 'rejected' WHERE state IN ('reserved', 'submitted')");
    const done = record("expiring");
    await store.reserve(done, wide);
    const now = new Date().toISOString();
    await store.markSubmitted(done.id, "executor-a", now, done.leaseUntil);
    await store.finish(done.id, "executor-a", { state: "completed", serverRequestId: "req", errorCode: null,
      providerResult: "completed", candidateJson: "{\"schema\":\"x\"}", candidateExpiresAt: now, updatedAt: now });
    expect(await store.expireCandidates(new Date(Date.now() + 1000).toISOString())).toBeGreaterThanOrEqual(1);
    expect(await store.findByKey(workspaceId, "server-owner", "expiring")).toMatchObject({
      state: "completed", candidateJson: null, idempotencyKey: "expiring" });
  });
});
