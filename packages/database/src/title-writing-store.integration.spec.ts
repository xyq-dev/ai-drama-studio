import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TitleCallRecord, TitleRunRecord } from "@ai-drama/contracts";
import { runMigrations } from "./migrations";
import { TextChainService } from "./text-chain";
import { PostgresTitleWritingStore } from "./title-writing-store";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required for PostgreSQL integration tests");

/**
 * The title writing tables are an unapplied draft. Their tests run only on an isolated database after the draft SQL
 * was explicitly authorized for that environment; CI does not set this variable.
 */
const draftAuthorized = process.env.TITLE_WRITING_DRAFT_SQL_AUTHORIZED === "true";

const pool = new Pool({ connectionString: databaseUrl, max: 8 });
const store = new PostgresTitleWritingStore(pool, new TextChainService(pool));

beforeAll(async () => {
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await runMigrations(pool);
});

afterAll(async () => {
  await pool.end();
});

describe("PostgresTitleWritingStore without the draft tables", () => {
  it("reports storage unavailable on the applied migrations", async () => {
    expect(await store.storageReady()).toBe(false);
  });
});

describe.runIf(draftAuthorized)("PostgresTitleWritingStore on the authorized draft tables", () => {
  let workspaceId: string;
  let projectId: string;
  let otherProjectId: string;

  beforeAll(async () => {
    const draft = await readFile(join(__dirname, "..", "prisma", "drafts", "20261008000100_title_writing.sql"), "utf8");
    await pool.query(draft);
    workspaceId = (await pool.query<{ id: string }>("INSERT INTO workspace (name) VALUES ('title') RETURNING id")).rows[0]!.id;
    projectId = (await pool.query<{ id: string }>("INSERT INTO project (workspace_id, title) VALUES ($1, 'a') RETURNING id", [workspaceId])).rows[0]!.id;
    otherProjectId = (await pool.query<{ id: string }>("INSERT INTO project (workspace_id, title) VALUES ($1, 'b') RETURNING id", [workspaceId])).rows[0]!.id;
  });

  function run(key: string, project = projectId, hash = "ab".repeat(32)): TitleRunRecord {
    const now = new Date().toISOString();
    return {
      id: randomUUID(), workspaceId, projectId: project, actorId: "server-owner", idempotencyKey: key, inputHash: hash,
      input: { schema: "ads.title-writing.input.v1", promptVersion: "ads.title-writing.prompt.v1", title: "剧名",
        settings: { episodeCount: 3, episodeSeconds: 90, style: "" }, providerKey: "qwen", model: "q-1" },
      state: "running", errorCode: null, cancelRequestedAt: null, executorId: null, leaseUntil: null, callCap: 8, callsUsed: 0,
      storySave: "pending", storyRevisionId: null, createdAt: now, updatedAt: now,
    };
  }

  function call(runId: string, executorId: string, stepKey: TitleCallRecord["stepKey"] = "concept"): TitleCallRecord {
    return {
      id: randomUUID(), runId, workspaceId, stepKey, attemptNo: 1, providerKey: "qwen", model: "q-1", requestHash: "cd".repeat(32),
      state: "reserved", executorId, providerRequestId: null, responseModel: null,
      usage: { status: "unknown", inputTokens: null, outputTokens: null, totalTokens: null }, errorCode: null,
      createdAt: new Date().toISOString(), finishedAt: null,
    };
  }

  const later = (ms: number) => new Date(Date.now() + ms).toISOString();
  const wide = { sinceIso: "2000-01-01T00:00:00.000Z", maxCallsPerDay: 1000 };

  it("is ready, replays the same key, refuses a different input and admits one running run per project", async () => {
    expect(await store.storageReady()).toBe(true);
    const first = run("k1");
    expect((await store.createRun(first, { maxActiveRuns: 5 })).kind).toBe("created");
    expect((await store.createRun({ ...run("k1"), inputHash: first.inputHash }, { maxActiveRuns: 5 })).kind).toBe("existing");
    expect((await store.createRun(run("k1", projectId, "ef".repeat(32)), { maxActiveRuns: 5 })).kind).toBe("conflict");
    expect((await store.createRun(run("k2"), { maxActiveRuns: 5 })).kind).toBe("active");
    const bundle = await store.getRun(workspaceId, projectId, first.id);
    expect(bundle?.steps.map((step) => step.stepKey)).toEqual(["concept", "outline", "episode:1", "episode:2", "episode:3"]);
  });

  it("admits one start when different projects race on the workspace cap", async () => {
    await pool.query("UPDATE title_writing_run SET state = 'failed', executor_id = NULL, lease_until = NULL WHERE state = 'running'");
    const results = await Promise.all([run("r1"), run("r2", otherProjectId)].map((item) => store.createRun(item, { maxActiveRuns: 1 })));
    expect(results.filter((result) => result.kind === "created")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "blocked")).toHaveLength(1);
  });

  it("fences calls to the owning executor and recovers a sent call as unknown", async () => {
    await pool.query("UPDATE title_writing_run SET state = 'failed', executor_id = NULL, lease_until = NULL WHERE state = 'running'");
    const record = run("fence");
    await store.createRun(record, { maxActiveRuns: 5 });
    const now = new Date().toISOString();
    expect(await store.claimRun(record.id, "a", now, later(60_000))).toBe(true);
    expect(await store.claimRun(record.id, "b", now, later(60_000))).toBe(false);
    const first = call(record.id, "a");
    expect(await store.reserveCall(first, wide, now, later(60_000))).toEqual({ kind: "reserved" });
    expect(await store.markCallSubmitted(first.id, "b", now, later(60_000))).toBe(false);
    expect(await store.markCallSubmitted(first.id, "a", now, later(1))).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await store.recoverExpired(new Date().toISOString())).toBe(1);
    const late = await store.finishCall(first.id, "a", { state: "completed", errorCode: null, providerRequestId: null, responseModel: null,
      usage: first.usage, output: null, outputHash: null }, new Date().toISOString());
    expect(late).toBe(false);
    const bundle = (await store.getRunById(record.id))!;
    expect(bundle.run).toMatchObject({ state: "needs_attention", errorCode: "executor_lost", executorId: null });
    expect(bundle.calls[0]).toMatchObject({ state: "unknown", errorCode: "executor_lost" });
    expect(bundle.steps[0]).toMatchObject({ state: "unknown" });
  });

  it("enforces the workspace daily call cap atomically", async () => {
    await pool.query("UPDATE title_writing_run SET state = 'failed', executor_id = NULL, lease_until = NULL WHERE state = 'running'");
    const record = run("cap");
    await store.createRun(record, { maxActiveRuns: 5 });
    const now = new Date().toISOString();
    await store.claimRun(record.id, "a", now, later(60_000));
    const used = Number((await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM title_writing_call")).rows[0]!.n);
    expect(await store.reserveCall(call(record.id, "a"), { ...wide, maxCallsPerDay: used }, now, later(60_000)))
      .toEqual({ kind: "blocked", code: "TITLE_WRITING_DAILY_CAP" });
  });

  it("saves the story as a DRAFT revision once and reports a conflict when a story already exists", async () => {
    await pool.query("UPDATE title_writing_run SET state = 'failed', executor_id = NULL, lease_until = NULL WHERE state = 'running'");
    const fresh = (await pool.query<{ id: string }>("INSERT INTO project (workspace_id, title) VALUES ($1, 'c') RETURNING id", [workspaceId])).rows[0]!.id;
    const record = run("story", fresh);
    await store.createRun(record, { maxActiveRuns: 5 });
    const now = new Date().toISOString();
    await store.claimRun(record.id, "a", now, later(60_000));
    expect(await store.saveStory(record.id, "a", "故事正文", "server-owner", now)).toBe("saved");
    expect(await store.saveStory(record.id, "a", "故事正文", "server-owner", now)).toBe("saved");
    const stories = await pool.query<{ review_status: string; content_json: unknown }>(
      "SELECT review_status, content_json FROM story_revision WHERE project_id = $1", [fresh]);
    expect(stories.rows).toEqual([{ review_status: "DRAFT", content_json: { text: "故事正文" } }]);
    expect((await store.placeScripts(workspaceId, fresh, record.id, { acceptStoryChanged: false }, "a", now)).kind).toBe("not_ready");
    await store.finishRun(record.id, "a", "completed", null, now);
    expect((await store.placeScripts(workspaceId, fresh, record.id, { acceptStoryChanged: false }, "a", now)).kind).toBe("story_not_approved");

    const second = run("story-2", fresh, "12".repeat(32));
    await store.createRun(second, { maxActiveRuns: 5 });
    await store.claimRun(second.id, "a", now, later(60_000));
    expect(await store.saveStory(second.id, "a", "另一份", "server-owner", now)).toBe("conflict");
    expect((await pool.query("SELECT 1 FROM story_revision WHERE project_id = $1", [fresh])).rowCount).toBe(1);
  });
});
