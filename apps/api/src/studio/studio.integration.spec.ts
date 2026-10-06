import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePostgresPool, createPostgresPool, runMigrations, type PostgresPool } from "@ai-drama/database";
import { AppModule } from "../app.module";
import { loadApiEnv } from "../config/env";
import { SafeExceptionFilter } from "../http/safe-exception.filter";

const APP_WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
if (!databaseUrl || !redisUrl) {
  throw new Error("DATABASE_URL and REDIS_URL are required for API and SSE integration tests");
}

const pool: PostgresPool = createPostgresPool({
  connectionString: databaseUrl,
  connectionTimeoutMs: 2_000,
  statementTimeoutMs: 10_000,
  queryTimeoutMs: 10_000,
});

async function seedApprovedScriptForTextEntity(label: string): Promise<{
  projectId: string; episodeId: string; scriptRevisionId: string;
}> {
  const project = (await sql<{ id: string }>(
    "INSERT INTO project (workspace_id, title) VALUES ($1, $2) RETURNING id",
    [APP_WORKSPACE_ID, label],
  )).rows[0]!;
  const hash = "ab".repeat(32);
  const story = (await sql<{ id: string }>(
    `INSERT INTO story_revision
      (workspace_id, project_id, revision_no, content_json, content_hash, review_status,
       reviewed_by, reviewed_at, reviewed_content_hash, created_by)
      VALUES ($1,$2,1,'{"premise":"seed"}'::jsonb,$3,'APPROVED','editor',now(),$3,'author') RETURNING id`,
    [APP_WORKSPACE_ID, project.id, hash],
  )).rows[0]!;
  await sql(
    "UPDATE project SET current_story_revision_id = $1, approved_story_revision_id = $1 WHERE id = $2",
    [story.id, project.id],
  );
  const episode = (await sql<{ id: string }>(
    "INSERT INTO episode (workspace_id, project_id, episode_no, title) VALUES ($1,$2,1,'Episode 1') RETURNING id",
    [APP_WORKSPACE_ID, project.id],
  )).rows[0]!;
  const script = (await sql<{ id: string }>(
    `INSERT INTO script_revision
      (workspace_id, project_id, episode_id, revision_no, source_story_revision_id,
       content_json, content_hash, review_status, reviewed_by, reviewed_at, reviewed_content_hash, created_by)
      VALUES ($1,$2,$3,1,$4,'{"scenes":[]}'::jsonb,$5,'APPROVED','editor',now(),$5,'author')
      RETURNING id`,
    [APP_WORKSPACE_ID, project.id, episode.id, story.id, hash],
  )).rows[0]!;
  await sql(
    "UPDATE episode SET current_script_revision_id = $1, approved_script_revision_id = $1 WHERE id = $2",
    [script.id, episode.id],
  );
  return { projectId: project.id, episodeId: episode.id, scriptRevisionId: script.id };
}

async function sql<T>(text: string, values: unknown[] = []): Promise<{ rows: T[] }> {
  return pool.query(text, values) as Promise<{ rows: T[] }>;
}
let app: INestApplication | undefined;
let base: string;

function env(): ReturnType<typeof loadApiEnv> {
  return loadApiEnv({
    DATABASE_URL: databaseUrl,
    REDIS_URL: redisUrl,
    S3_ENDPOINT: "http://127.0.0.1:59000",
    S3_REGION: "us-east-1",
    S3_BUCKET: "ai-drama-dev",
    S3_ACCESS_KEY_ID: "test",
    S3_SECRET_ACCESS_KEY: "test",
    APP_WORKSPACE_ID,
    M3_MOCK_IMAGE_ENABLED: "true",
    MOCK_OBJECT_DIR: "/tmp/m3-api-mock-objects",
    QWEN_WEB_WRITING_ENABLED: "true",
    QWEN_WEB_OPERATOR_TOKEN: QWEN_OPERATOR_TOKEN,
    // A syntactically valid placeholder only: the applied migrations have no request table, so nothing is sent.
    DASHSCOPE_API_KEY: "sk-integration-placeholder-key",
    BAILIAN_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  });
}

const QWEN_OPERATOR_TOKEN = "integration-operator-token-01";

async function readSse(url: string, headers?: Record<string, string>): Promise<{ status: number; text: string }> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(1500) });
  if (response.status !== 200) {
    return { status: response.status, text: await response.text() };
  }
  const reader = response.body?.getReader();
  if (!reader) return { status: response.status, text: "" };
  let text = "";
  const started = Date.now();
  while (Date.now() - started < 1200) {
    const next = await Promise.race([
      reader.read(),
      new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), 400),
      ),
    ]);
    if (next.done || !next.value) break;
    text += new TextDecoder().decode(next.value);
    if (text.includes("\n\n")) break;
  }
  await reader.cancel();
  return { status: 200, text };
}

beforeAll(async () => {
  await sql("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await runMigrations(pool);
  await sql("INSERT INTO workspace (id, name, status) VALUES ($1, 'configured', 'ACTIVE')", [APP_WORKSPACE_ID]);
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.register(env())],
  }).compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix("api/v1");
  app.useGlobalFilters(new SafeExceptionFilter());
  await app.init();
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
});

afterAll(async () => {
  if (app) await app.close();
  await closePostgresPool(pool);
});

describe("M1-C API and SSE integration", () => {
  it("refuses character reference images while the reference draft is not applied", async () => {
    const before = await sql<{ count: number }>("SELECT count(*)::int AS count FROM generation_job");
    const list = await fetch(`${base}/api/v1/characters/55555555-5555-4555-8555-555555555555/reference-images`);
    expect(list.status).toBe(503);
    expect(await list.json()).toMatchObject({ error: { code: "CHARACTER_REFERENCE_STORAGE_UNAVAILABLE" } });
    const generate = await fetch(`${base}/api/v1/character-revisions/66666666-6666-4666-8666-666666666666/reference-images/generate`, {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": "reference-generate" },
      body: JSON.stringify({}),
    });
    expect(generate.status).toBe(503);
    const select = await fetch(`${base}/api/v1/characters/55555555-5555-4555-8555-555555555555/reference-selection`, {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": "reference-select" },
      body: JSON.stringify({ assetId: "77777777-7777-4777-8777-777777777777", expectedSelectedAssetId: null }),
    });
    expect(select.status).toBe(503);
    const after = await sql<{ count: number }>("SELECT count(*)::int AS count FROM generation_job");
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it("refuses web Qwen requests before any send while the draft request table is absent", async () => {
    const project = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "qwen-web-project" },
      body: JSON.stringify({ title: "qwen web", premise: "storage gate" }),
    });
    const created = (await project.json()) as { id: string };
    const forbidden = await fetch(`${base}/api/v1/writing/qwen-candidates/status`, {
      headers: { "x-operator-token": "not-the-operator-token" },
    });
    expect(forbidden.status).toBe(403);
    const status = await fetch(`${base}/api/v1/writing/qwen-candidates/status`, {
      headers: { "x-operator-token": QWEN_OPERATOR_TOKEN },
    });
    expect(status.status).toBe(503);
    expect(status.headers.get("cache-control")).toBe("private, no-store");
    const statusBody = await status.json() as Record<string, unknown>;
    expect(statusBody).toMatchObject({ code: "QWEN_WEB_STORAGE_UNAVAILABLE", ready: false, model: null });
    expect(JSON.stringify(statusBody)).not.toContain("sk-integration-placeholder-key");
    const request = await fetch(`${base}/api/v1/projects/${created.id}/writing/qwen-candidates`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "qwen-web-1",
        "x-operator-token": QWEN_OPERATOR_TOKEN },
      body: JSON.stringify({ input: { schema: "qwen.writing.input.v1", mode: "story", premise: "p", genre: "g",
        audience: "a", characters: "c", mustKeep: "k", mustNotChange: "n", currentText: "" } }),
    });
    expect(request.status).toBe(503);
    expect(await request.json()).toEqual({ code: "QWEN_WEB_STORAGE_UNAVAILABLE" });
    const table = await sql<{ name: string | null }>("SELECT to_regclass('public.qwen_writing_request')::text AS name");
    expect(table.rows[0]?.name).toBeNull();
    const placeholder = await fetch(`${base}/api/v1/writing/qwen-candidates`, { method: "POST" });
    expect(placeholder.status).toBe(404);
  });

  it("replays an idempotency key and rejects a hash conflict", async () => {
    const first = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "project-1" },
      body: JSON.stringify({ title: "One", premise: "A" }),
    });
    const created = (await first.json()) as { id: string; workspaceId: string };
    expect(first.status).toBe(201);
    const replay = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "project-1" },
      body: JSON.stringify({ title: "One", premise: "A" }),
    });
    const replayed = (await replay.json()) as { id: string };
    expect(replayed.id).toBe(created.id);
    const conflict = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "project-1" },
      body: JSON.stringify({ title: "Two", premise: "B" }),
    });
    expect(conflict.status).toBe(409);
    const body = (await conflict.json()) as { error: { code: string } };
    expect(body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");

    const other = await sql<{ id: string }>(
      "INSERT INTO workspace (name) VALUES ('other') RETURNING id",
    );
    const otherWorkspace = other.rows[0]?.id;
    const hidden = await sql<{ id: string }>(
      "INSERT INTO project (workspace_id, title) VALUES ($1, 'hidden') RETURNING id",
      [otherWorkspace],
    );
    const hiddenId = hidden.rows[0]?.id;
    const denied = await fetch(`${base}/api/v1/projects/${hiddenId ?? ""}`);
    expect(denied.status).toBe(404);
    const listed = (await (await fetch(`${base}/api/v1/projects`)).json()) as { items: { id: string }[] };
    expect(listed.items.some((item) => item.id === hiddenId)).toBe(false);
    expect(created.workspaceId).toBe(APP_WORKSPACE_ID);
    const rejected = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "project-client-workspace" },
      body: JSON.stringify({ title: "One", premise: "A", workspaceId: "client-supplied" }),
    });
    expect(rejected.status).toBe(400);
  });

  it("replays cancel and manual retry mutations without duplicating business writes", async () => {
    const projectResponse = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "project-mutations" },
      body: JSON.stringify({ title: "Mutations" }),
    });
    const project = (await projectResponse.json()) as { id: string };
    const workflowResponse = await fetch(`${base}/api/v1/projects/${project.id}/workflows/mock`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "mock-mutations" },
      body: JSON.stringify({ outcome: "success" }),
    });
    const original = (await workflowResponse.json()) as { workflowRunId: string; jobId: string };

    const cancel = await fetch(`${base}/api/v1/generation-jobs/${original.jobId}/cancel`, {
      method: "POST",
      headers: { "idempotency-key": "cancel-mutation" },
    });
    const canceled = (await cancel.json()) as { jobId: string; state: string };
    expect(cancel.status).toBe(200);
    expect(canceled).toMatchObject({ jobId: original.jobId, state: "CANCELED" });

    const cancelReplay = await fetch(`${base}/api/v1/generation-jobs/${original.jobId}/cancel`, {
      method: "POST",
      headers: { "idempotency-key": "cancel-mutation" },
    });
    expect(cancelReplay.status).toBe(200);
    expect(await cancelReplay.json()).toEqual(canceled);

    const canceledEvents = await sql<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM domain_event WHERE aggregate_id = $1 AND event_type = 'job.canceled'",
      [original.jobId],
    );
    expect(canceledEvents.rows[0]?.count).toBe(1);

    const retry = await fetch(`${base}/api/v1/generation-jobs/${original.jobId}/retry`, {
      method: "POST",
      headers: { "idempotency-key": "retry-mutation" },
    });
    const retried = (await retry.json()) as { workflowRunId: string; jobId: string; dispatchSeq: number };
    expect(retry.status).toBe(202);
    expect(retried.jobId).not.toBe(original.jobId);
    expect(retried.workflowRunId).not.toBe(original.workflowRunId);

    const retryReplay = await fetch(`${base}/api/v1/generation-jobs/${original.jobId}/retry`, {
      method: "POST",
      headers: { "idempotency-key": "retry-mutation" },
    });
    expect(retryReplay.status).toBe(202);
    expect(await retryReplay.json()).toEqual(retried);

    const retryRuns = await sql<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM workflow_run WHERE project_id = $1",
      [project.id],
    );
    expect(retryRuns.rows[0]?.count).toBe(2);
  });

  it("rejects malformed UUID route parameters without reaching PostgreSQL", async () => {
    const response = await fetch(`${base}/api/v1/projects/not-a-uuid`);
    expect(response.status).toBe(400);
  });

  it("rejects malformed project cursors before PostgreSQL casts", async () => {
    const malformedTimestamp = await fetch(
      `${base}/api/v1/projects?cursor=${encodeURIComponent("not-a-date|11111111-1111-4111-8111-111111111111")}`,
    );
    expect(malformedTimestamp.status).toBe(400);
    const timestampBody = (await malformedTimestamp.json()) as { error: { code: string } };
    expect(timestampBody.error.code).toBe("VALIDATION_ERROR");

    const malformedUuid = await fetch(
      `${base}/api/v1/projects?cursor=${encodeURIComponent("2026-09-27T00:00:00.000Z|not-a-uuid")}`,
    );
    expect(malformedUuid.status).toBe(400);
    const uuidBody = (await malformedUuid.json()) as { error: { code: string } };
    expect(uuidBody.error.code).toBe("VALIDATION_ERROR");

    const outOfRangeTimestamp = await fetch(
      `${base}/api/v1/projects?cursor=${encodeURIComponent("-010000-01-01T00:00:00.000Z|11111111-1111-4111-8111-111111111111")}`,
    );
    expect(outOfRangeTimestamp.status).toBe(400);
    const outOfRangeTimestampBody = (await outOfRangeTimestamp.json()) as { error: { code: string } };
    expect(outOfRangeTimestampBody.error.code).toBe("VALIDATION_ERROR");
  });

  it("replays DomainEvents, supports reconnect, and expires an old cursor", async () => {
    const project = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "project-sse" },
      body: JSON.stringify({ title: "SSE" }),
    });
    const created = (await project.json()) as { id: string };
    const workflow = await fetch(`${base}/api/v1/projects/${created.id}/workflows/mock`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "mock-sse" },
      body: JSON.stringify({ outcome: "success" }),
    });
    expect(workflow.status).toBe(202);
    const first = await readSse(`${base}/api/v1/events`);
    expect(first.status).toBe(200);
    expect(first.text).toContain("job.queued");
    const ids = [...first.text.matchAll(/^id: (\d+)$/gm)].map((match) => match[1] ?? "");
    const cursor = ids[0];
    expect(cursor).toBeTruthy();
    const replay = await readSse(`${base}/api/v1/events`, { "last-event-id": cursor ?? "0" });
    const replayIds = [...replay.text.matchAll(/^id: (\d+)$/gm)].map((match) => match[1] ?? "");
    expect(replayIds).not.toContain(cursor);
    const reconnect = await readSse(`${base}/api/v1/events`, { "last-event-id": cursor ?? "0" });
    expect(reconnect.status).toBe(200);
    await sql("UPDATE domain_event SET retention_until = now() - interval '1 day' WHERE id = $1", [cursor]);
    const expired = await fetch(`${base}/api/v1/events`, { headers: { "last-event-id": cursor ?? "0" } });
    expect(expired.status).toBe(409);
    const error = (await expired.json()) as { error: { code: string } };
    expect(error.error.code).toBe("EVENT_CURSOR_EXPIRED");
  });
  it("creates story revisions idempotently and exposes story history plus episodes", async () => {
    const projectResponse = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "m2c-project" },
      body: JSON.stringify({ title: "M2-C API", premise: "text chain" }),
    });
    expect(projectResponse.status).toBe(201);
    const project = (await projectResponse.json()) as { id: string; version: number };
    const body = JSON.stringify({
      content: { schema: "m2.story.revision.v1", premise: "three episode story" },
    });

    const first = await fetch(`${base}/api/v1/projects/${project.id}/stories`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "m2c-story-1",
        "if-match": String(project.version),
      },
      body,
    });
    expect(first.status).toBe(201);
    const created = (await first.json()) as {
      revisionId: string;
      revisionNo: number;
      rowVersion: number;
      contentHash: string;
    };
    expect(created.revisionNo).toBe(1);
    expect(created.rowVersion).toBe(2);

    const replay = await fetch(`${base}/api/v1/projects/${project.id}/stories`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "m2c-story-1",
        "if-match": String(project.version),
      },
      body,
    });
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(created);

    const staleVersion = await fetch(`${base}/api/v1/projects/${project.id}/stories`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "m2c-story-stale-version",
        "if-match": String(project.version),
      },
      body: JSON.stringify({ content: { schema: "m2.story.revision.v1", premise: "must conflict" } }),
    });
    expect(staleVersion.status).toBe(409);

    const missingEtag = await fetch(`${base}/api/v1/projects/${project.id}/stories`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "m2c-story-missing-etag",
      },
      body,
    });
    expect(missingEtag.status).toBe(400);

    const outOfRangeEtag = await fetch(`${base}/api/v1/projects/${project.id}/stories`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "m2c-story-out-of-range-etag",
        "if-match": "2147483648",
      },
      body,
    });
    expect(outOfRangeEtag.status).toBe(400);

    const historyResponse = await fetch(`${base}/api/v1/projects/${project.id}/stories`);
    expect(historyResponse.status).toBe(200);
    const history = (await historyResponse.json()) as {
      items: Array<{ id: string; revisionNo: number; reviewStatus: string; freshnessStatus: string }>;
      nextCursor: string | null;
    };
    expect(history.items).toHaveLength(1);
    expect(history.items[0]).toMatchObject({
      id: created.revisionId,
      revisionNo: 1,
      reviewStatus: "DRAFT",
      freshnessStatus: "CURRENT",
    });

    const episodesResponse = await fetch(`${base}/api/v1/projects/${project.id}/episodes`);
    expect(episodesResponse.status).toBe(200);
    const episodes = (await episodesResponse.json()) as { items: unknown[] };
    expect(episodes.items).toEqual([]);
  });

  it("rejects invalid and non-finite story content", async () => {
    const projectResponse = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "m2c-invalid-project" },
      body: JSON.stringify({ title: "Invalid story" }),
    });
    const project = (await projectResponse.json()) as { id: string; version: number };

    const forbidden = await fetch(`${base}/api/v1/projects/${project.id}/stories`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "m2c-invalid-story",
        "if-match": String(project.version),
      },
      body: JSON.stringify({ content: { rowVersion: 2 } }),
    });
    expect(forbidden.status).toBe(400);

    const nonFinite = await fetch(`${base}/api/v1/projects/${project.id}/stories`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "m2c-non-finite-story",
        "if-match": String(project.version),
      },
      body: '{"content":{"budget":1e400}}',
    });
    expect(nonFinite.status).toBe(400);
    const body = (await nonFinite.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_STORY");

    const nulString = await fetch(`${base}/api/v1/projects/${project.id}/stories`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "m2c-nul-story",
        "if-match": String(project.version),
      },
      body: '{"content":{"text":"\\u0000"}}',
    });
    expect(nulString.status).toBe(400);
    const nulBody = (await nulString.json()) as { error: { code: string } };
    expect(nulBody.error.code).toBe("INVALID_STORY");

    const loneSurrogate = await fetch(`${base}/api/v1/projects/${project.id}/stories`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "m2c-surrogate-story",
        "if-match": String(project.version),
      },
      body: '{"content":{"text":"\\ud800"}}',
    });
    expect(loneSurrogate.status).toBe(400);
    const surrogateBody = (await loneSurrogate.json()) as { error: { code: string } };
    expect(surrogateBody.error.code).toBe("INVALID_STORY");

    const invalidKey = await fetch(`${base}/api/v1/projects/${project.id}/stories`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "m2c-invalid-key-story",
        "if-match": String(project.version),
      },
      body: '{"content":{"\\u0000":"x"}}',
    });
    expect(invalidKey.status).toBe(400);
    const invalidKeyBody = (await invalidKey.json()) as { error: { code: string } };
    expect(invalidKeyBody.error.code).toBe("INVALID_STORY");

    const count = await sql<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM story_revision WHERE project_id = $1",
      [project.id],
    );
    expect(count.rows[0]?.count).toBe(0);
  });

  it("paginates story revision history with a bounded cursor", async () => {
    const projectResponse = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "m2c-page-project" },
      body: JSON.stringify({ title: "History paging" }),
    });
    const project = (await projectResponse.json()) as { id: string; version: number };
    let version = project.version;

    for (let revision = 1; revision <= 21; revision += 1) {
      const response = await fetch(`${base}/api/v1/projects/${project.id}/stories`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `m2c-page-story-${revision}`,
          "if-match": String(version),
        },
        body: JSON.stringify({ content: { schema: "m2.story.revision.v1", revision } }),
      });
      expect(response.status).toBe(201);
      const created = (await response.json()) as { rowVersion: number };
      version = created.rowVersion;
    }

    const firstResponse = await fetch(`${base}/api/v1/projects/${project.id}/stories`);
    const first = (await firstResponse.json()) as {
      items: Array<{ revisionNo: number }>;
      nextCursor: string | null;
    };
    expect(first.items).toHaveLength(20);
    expect(first.nextCursor).toBe("2");

    const secondResponse = await fetch(
      `${base}/api/v1/projects/${project.id}/stories?cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
    );
    const second = (await secondResponse.json()) as {
      items: Array<{ revisionNo: number }>;
      nextCursor: string | null;
    };
    expect(second.items.map((item) => item.revisionNo)).toEqual([1]);

    const invalidCursor = await fetch(
      `${base}/api/v1/projects/${project.id}/stories?cursor=not-a-revision`,
    );
    expect(invalidCursor.status).toBe(400);

    const outOfRangeCursor = await fetch(
      `${base}/api/v1/projects/${project.id}/stories?cursor=2147483648`,
    );
    expect(outOfRangeCursor.status).toBe(400);
  });

  it("creates script revisions idempotently from the current approved story", async () => {
    const projectResponse = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "m2c-script-project" },
      body: JSON.stringify({ title: "Script API" }),
    });
    const project = (await projectResponse.json()) as { id: string; version: number };

    const storyResponse = await fetch(`${base}/api/v1/projects/${project.id}/stories`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "m2c-script-story",
        "if-match": String(project.version),
      },
      body: JSON.stringify({ content: { schema: "m2.story.revision.v1", premise: "approved source" } }),
    });
    expect(storyResponse.status).toBe(201);
    const story = (await storyResponse.json()) as { revisionId: string; rowVersion: number };

    const episode = await sql<{ id: string; row_version: number }>(
      `INSERT INTO episode (workspace_id, project_id, episode_no, title)
       VALUES ($1, $2, 1, 'Episode 1')
       RETURNING id, row_version`,
      [APP_WORKSPACE_ID, project.id],
    );
    const episodeId = episode.rows[0]?.id;
    const episodeVersion = episode.rows[0]?.row_version;
    if (!episodeId || !episodeVersion) throw new Error("episode missing");

    const body = JSON.stringify({
      storyRevisionId: story.revisionId.toUpperCase(),
      content: { schema: "m2.script.revision.v1", episode: 1, scenes: [] },
    });
    const unapprovedSource = await fetch(`${base}/api/v1/episodes/${episodeId}/scripts`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "m2c-script-unapproved-source",
        "if-match": String(episodeVersion),
      },
      body,
    });
    expect(unapprovedSource.status).toBe(400);
    const sourceError = (await unapprovedSource.json()) as { error: { code: string } };
    expect(sourceError.error.code).toBe("SOURCE_STORY_REQUIRED");

    await sql(
      `UPDATE story_revision
          SET review_status = 'APPROVED',
              review_version = review_version + 1,
              reviewed_by = 'integration',
              reviewed_at = now(),
              reviewed_content_hash = content_hash
        WHERE id = $1`,
      [story.revisionId],
    );
    await sql(
      "UPDATE project SET approved_story_revision_id = $1 WHERE id = $2",
      [story.revisionId, project.id],
    );
    const first = await fetch(
      `${base}/api/v1/episodes/${episodeId.toUpperCase()}/scripts`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "m2c-script-1",
          "if-match": String(episodeVersion),
        },
        body,
      },
    );
    expect(first.status).toBe(201);
    const created = (await first.json()) as {
      revisionId: string;
      revisionNo: number;
      rowVersion: number;
    };
    expect(created.revisionNo).toBe(1);
    expect(created.rowVersion).toBe(2);

    const replay = await fetch(
      `${base}/api/v1/episodes/${episodeId}/scripts`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "m2c-script-1",
          "if-match": String(episodeVersion),
        },
        body,
      },
    );
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(created);

    const otherProjectResponse = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "m2c-script-other-project" },
      body: JSON.stringify({ title: "Other project" }),
    });
    const otherProject = (await otherProjectResponse.json()) as { id: string };
    const wrongNestedReplay = await fetch(
      `${base}/api/v1/projects/${otherProject.id}/episodes/${episodeId}/scripts`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "m2c-script-1",
          "if-match": String(episodeVersion),
        },
        body,
      },
    );
    expect(wrongNestedReplay.status).toBe(404);

    const listed = await fetch(
      `${base}/api/v1/episodes/${episodeId}/scripts`,
    );
    expect(listed.status).toBe(200);
    const history = (await listed.json()) as {
      items: Array<{ id: string; revisionNo: number; sourceStoryRevisionId: string }>;
    };
    expect(history.items).toHaveLength(1);
    expect(history.items[0]).toMatchObject({
      id: created.revisionId,
      revisionNo: 1,
      sourceStoryRevisionId: story.revisionId,
    });

    const uppercaseNested = await fetch(
      `${base}/api/v1/projects/${project.id}/episodes/${episodeId.toUpperCase()}/scripts`,
    );
    expect(uppercaseNested.status).toBe(200);

  });

  it("returns 404 for script history when the nested episode does not exist", async () => {
    const projectResponse = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "m2c-missing-episode-project" },
      body: JSON.stringify({ title: "Missing episode" }),
    });
    const project = (await projectResponse.json()) as { id: string };
    const response = await fetch(
      `${base}/api/v1/projects/${project.id}/episodes/11111111-1111-4111-8111-111111111111/scripts`,
    );
    expect(response.status).toBe(404);
  });

  it("reviews and approves story plus script revisions through idempotent API gates", async () => {
    const projectResponse = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "m2c-review-project" },
      body: JSON.stringify({ title: "Review API" }),
    });
    const project = (await projectResponse.json()) as { id: string; version: number };

    const storyResponse = await fetch(`${base}/api/v1/projects/${project.id}/stories`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "m2c-review-story",
        "if-match": String(project.version),
      },
      body: JSON.stringify({ content: { schema: "m2.story.revision.v1", premise: "review me" } }),
    });
    const story = (await storyResponse.json()) as { revisionId: string; rowVersion: number };
    expect(storyResponse.status).toBe(201);

    const otherProjectResponse = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "m2c-review-other-project" },
      body: JSON.stringify({ title: "Other project" }),
    });
    const otherProject = (await otherProjectResponse.json()) as { id: string };

    const wrongStoryScope = await fetch(
      `${base}/api/v1/projects/${otherProject.id}/stories/${story.revisionId}/review`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "m2c-story-review-wrong-project",
          "if-match": String(story.rowVersion),
        },
        body: JSON.stringify({ to: "IN_REVIEW", expectedReviewVersion: 1 }),
      },
    );
    expect(wrongStoryScope.status).toBe(404);

    const invalidStoryTransition = await fetch(
      `${base}/api/v1/projects/${project.id}/stories/${story.revisionId}/review`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "m2c-story-review-invalid-transition",
          "if-match": String(story.rowVersion),
        },
        body: JSON.stringify({ to: "REJECTED", expectedReviewVersion: 1 }),
      },
    );
    expect(invalidStoryTransition.status).toBe(409);
    const invalidStoryTransitionBody = (await invalidStoryTransition.json()) as {
      error: { code: string };
    };
    expect(invalidStoryTransitionBody.error.code).toBe("REVIEW_CONFLICT");

    const storyInReview = await fetch(
      `${base}/api/v1/projects/${project.id.toUpperCase()}/stories/${story.revisionId.toUpperCase()}/review`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "m2c-story-review-in",
          "if-match": String(story.rowVersion),
          "x-trace-id": "trace-story-review-in",
        },
        body: JSON.stringify({ to: "IN_REVIEW", expectedReviewVersion: 1 }),
      },
    );
    expect(storyInReview.status).toBe(200);
    const inReview = (await storyInReview.json()) as { reviewVersion: number; rowVersion: number };
    expect(inReview).toEqual({ reviewVersion: 2, rowVersion: 3 });

    const staleReviewVersion = await fetch(
      `${base}/api/v1/projects/${project.id}/stories/${story.revisionId}/review`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "m2c-story-review-stale-review-version",
          "if-match": String(inReview.rowVersion),
        },
        body: JSON.stringify({ to: "REJECTED", expectedReviewVersion: 1 }),
      },
    );
    expect(staleReviewVersion.status).toBe(409);
    const staleReviewBody = (await staleReviewVersion.json()) as { error: { code: string } };
    expect(staleReviewBody.error.code).toBe("REVIEW_CONFLICT");

    const storyInReviewReplay = await fetch(
      `${base}/api/v1/projects/${project.id}/stories/${story.revisionId}/review`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "m2c-story-review-in",
          "if-match": String(story.rowVersion),
          "x-trace-id": "trace-story-review-in",
        },
        body: JSON.stringify({ to: "IN_REVIEW", expectedReviewVersion: 1 }),
      },
    );
    expect(storyInReviewReplay.status).toBe(200);
    expect(await storyInReviewReplay.json()).toEqual(inReview);

    const storyApproved = await fetch(
      `${base}/api/v1/projects/${project.id}/stories/${story.revisionId}/review`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "m2c-story-review-approved",
          "if-match": String(inReview.rowVersion),
          "x-trace-id": "trace-story-review-approved",
        },
        body: JSON.stringify({
          to: "APPROVED",
          expectedReviewVersion: inReview.reviewVersion,
          reviewNote: "story approved note",
        }),
      },
    );
    expect(storyApproved.status).toBe(200);
    const approvedStory = (await storyApproved.json()) as { reviewVersion: number; rowVersion: number };
    expect(approvedStory).toEqual({ reviewVersion: 3, rowVersion: 4 });

    const episodesResponse = await fetch(`${base}/api/v1/projects/${project.id}/episodes`);
    const episodes = (await episodesResponse.json()) as {
      items: Array<{ id: string; episodeNo: number; rowVersion: number }>;
    };
    expect(episodes.items.map((episode) => episode.episodeNo)).toEqual([1, 2, 3]);
    const episode = episodes.items[0];
    if (!episode) throw new Error("episode missing");

    const scriptResponse = await fetch(
      `${base}/api/v1/projects/${project.id}/episodes/${episode.id}/scripts`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "m2c-review-script",
          "if-match": String(episode.rowVersion),
        },
        body: JSON.stringify({
          sourceStoryRevisionId: story.revisionId,
          content: { schema: "m2.script.revision.v1", episode: 1, scenes: [] },
        }),
      },
    );
    expect(scriptResponse.status).toBe(201);
    const script = (await scriptResponse.json()) as { revisionId: string; rowVersion: number };

    const wrongScriptScope = await fetch(
      `${base}/api/v1/projects/${otherProject.id}/episodes/${episode.id}/scripts/${script.revisionId}/review`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "m2c-script-review-wrong-project",
          "if-match": String(script.rowVersion),
        },
        body: JSON.stringify({ to: "IN_REVIEW", expectedReviewVersion: 1 }),
      },
    );
    expect(wrongScriptScope.status).toBe(404);

    const otherEpisode = episodes.items[1];
    if (!otherEpisode) throw new Error("second episode missing");
    const wrongEpisodeScope = await fetch(
      `${base}/api/v1/projects/${project.id}/episodes/${otherEpisode.id}/scripts/${script.revisionId}/review`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "m2c-script-review-wrong-episode",
          "if-match": String(script.rowVersion),
        },
        body: JSON.stringify({ to: "IN_REVIEW", expectedReviewVersion: 1 }),
      },
    );
    expect(wrongEpisodeScope.status).toBe(404);

    const scriptInReview = await fetch(
      `${base}/api/v1/projects/${project.id.toUpperCase()}/episodes/${episode.id.toUpperCase()}/scripts/${script.revisionId.toUpperCase()}/review`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "m2c-script-review-in",
          "if-match": String(script.rowVersion),
          "x-trace-id": "trace-script-review-in",
        },
        body: JSON.stringify({ to: "IN_REVIEW", expectedReviewVersion: 1 }),
      },
    );
    expect(scriptInReview.status).toBe(200);
    const scriptReview = (await scriptInReview.json()) as { reviewVersion: number; rowVersion: number };
    expect(scriptReview).toEqual({ reviewVersion: 2, rowVersion: 3 });

    const scriptApproved = await fetch(
      `${base}/api/v1/projects/${project.id}/episodes/${episode.id}/scripts/${script.revisionId}/review`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "m2c-script-review-approved",
          "if-match": String(scriptReview.rowVersion),
          "x-trace-id": "trace-script-review-approved",
        },
        body: JSON.stringify({
          to: "APPROVED",
          expectedReviewVersion: scriptReview.reviewVersion,
          reviewNote: "script approved note",
        }),
      },
    );
    expect(scriptApproved.status).toBe(200);
    expect(await scriptApproved.json()).toEqual({ reviewVersion: 3, rowVersion: 4 });

    const events = await sql<{ trace_id: string; event_type: string }>(
      `SELECT trace_id, event_type
         FROM domain_event
        WHERE aggregate_id = $1
          AND event_type = 'revision.review'
        ORDER BY id`,
      [script.revisionId],
    );
    expect(events.rows.map((row) => row.trace_id)).toEqual([
      "trace-script-review-in",
      "trace-script-review-approved",
    ]);

    const notes = await sql<{ id: string; review_note: string | null }>(
      `SELECT id, review_note FROM story_revision WHERE id = $1
       UNION ALL
       SELECT id, review_note FROM script_revision WHERE id = $2`,
      [story.revisionId, script.revisionId],
    );
    expect(Object.fromEntries(notes.rows.map((row) => [row.id, row.review_note]))).toEqual({
      [story.revisionId]: "story approved note",
      [script.revisionId]: "script approved note",
    });
  });

  for (const kind of ["character", "location"] as const) {
    it(`scopes ${kind} revision and review idempotency to the project, including uppercase UUIDs`, async () => {
      const firstProject = await seedApprovedScriptForTextEntity(`${kind}-first`);
      const secondProject = await seedApprovedScriptForTextEntity(`${kind}-second`);
      const plural = `${kind}s`;
      const createKey = `m2-entity-${kind}-create-shared`;
      const firstBody = JSON.stringify({
        name: "First", sourceScriptRevisionId: firstProject.scriptRevisionId.toUpperCase(),
        content: { role: "lead" },
      });
      const firstCreate = await fetch(
        `${base}/api/v1/projects/${firstProject.projectId.toUpperCase()}/${plural}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": createKey, "if-match": "1" },
          body: firstBody,
        },
      );
      expect(firstCreate.status).toBe(201);
      const first = (await firstCreate.json()) as { entityId: string; revisionId: string; rowVersion: number };
      const createReplay = await fetch(
        `${base}/api/v1/projects/${firstProject.projectId}/${plural}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": createKey, "if-match": "1" },
          body: JSON.stringify({
            name: "First", sourceScriptRevisionId: firstProject.scriptRevisionId,
            content: { role: "lead" },
          }),
        },
      );
      expect(createReplay.status).toBe(201);
      expect(await createReplay.json()).toEqual(first);
      const secondCreate = await fetch(
        `${base}/api/v1/projects/${secondProject.projectId}/${plural}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": createKey, "if-match": "1" },
          body: JSON.stringify({
            name: "Second", sourceScriptRevisionId: secondProject.scriptRevisionId,
            content: { role: "lead" },
          }),
        },
      );
      expect(secondCreate.status).toBe(201);
      const second = (await secondCreate.json()) as { entityId: string };
      expect(second.entityId).not.toBe(first.entityId);

      const revisionKey = `m2-entity-${kind}-revision-shared`;
      const revisionBody = JSON.stringify({
        sourceScriptRevisionId: firstProject.scriptRevisionId, content: { role: "support" },
      });
      const revisionPath = `/${plural}/${first.entityId}/revisions`;
      const revise = await fetch(
        `${base}/api/v1/projects/${firstProject.projectId.toUpperCase()}${revisionPath.replace(first.entityId, first.entityId.toUpperCase())}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": revisionKey,
            "if-match": String(first.rowVersion) },
          body: revisionBody,
        },
      );
      expect(revise.status).toBe(201);
      const revision = (await revise.json()) as { revisionId: string; rowVersion: number };
      const reviseReplay = await fetch(
        `${base}/api/v1/projects/${firstProject.projectId}${revisionPath}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": revisionKey,
            "if-match": String(first.rowVersion) },
          body: revisionBody,
        },
      );
      expect(reviseReplay.status).toBe(201);
      expect(await reviseReplay.json()).toEqual(revision);
      const wrongRevisionScope = await fetch(
        `${base}/api/v1/projects/${secondProject.projectId}${revisionPath}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": revisionKey,
            "if-match": String(first.rowVersion) },
          body: revisionBody,
        },
      );
      expect(wrongRevisionScope.status).toBe(404);

      const reviewKey = `m2-entity-${kind}-review-shared`;
      const reviewPath = `${revisionPath}/${revision.revisionId}/review`;
      const reviewBody = JSON.stringify({ to: "IN_REVIEW", expectedReviewVersion: 1 });
      const review = await fetch(
        `${base}/api/v1/projects/${firstProject.projectId.toUpperCase()}${reviewPath
          .replace(first.entityId, first.entityId.toUpperCase())
          .replace(revision.revisionId, revision.revisionId.toUpperCase())}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": reviewKey,
            "if-match": String(revision.rowVersion) },
          body: reviewBody,
        },
      );
      expect(review.status).toBe(200);
      const reviewed = await review.json();
      const reviewReplay = await fetch(
        `${base}/api/v1/projects/${firstProject.projectId}${reviewPath}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": reviewKey,
            "if-match": String(revision.rowVersion) },
          body: reviewBody,
        },
      );
      expect(reviewReplay.status).toBe(200);
      expect(await reviewReplay.json()).toEqual(reviewed);
      const wrongReviewScope = await fetch(
        `${base}/api/v1/projects/${secondProject.projectId}${reviewPath}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": reviewKey,
            "if-match": String(revision.rowVersion) },
          body: reviewBody,
        },
      );
      expect(wrongReviewScope.status).toBe(404);
    });
  }

  it("runs the project-scoped Scene to Shot text API with replay and review gates", async () => {
    const source = await seedApprovedScriptForTextEntity("scene-shot-http");
    const other = await seedApprovedScriptForTextEntity("scene-shot-other");
    const scenes = `/projects/${source.projectId}/episodes/${source.episodeId}/scenes`;
    const sceneBody = JSON.stringify({
      sourceScriptRevisionId: source.scriptRevisionId.toUpperCase(),
      ordinal: 1, heading: "Opening", summary: "On the court",
    });
    const createScene = await fetch(`${base}/api/v1${scenes}`, {
      method: "POST", headers: {
        "content-type": "application/json", "if-match": "1", "idempotency-key": "m2-scene-create",
      }, body: sceneBody,
    });
    expect(createScene.status).toBe(201);
    const scene = (await createScene.json()) as { entityId: string; revisionId: string; rowVersion: number };
    const sceneReplay = await fetch(
      `${base}/api/v1/projects/${source.projectId.toUpperCase()}/episodes/${source.episodeId.toUpperCase()}/scenes`,
      {
        method: "POST", headers: {
          "content-type": "application/json", "if-match": "1", "idempotency-key": "m2-scene-create",
        }, body: JSON.stringify({
          sourceScriptRevisionId: source.scriptRevisionId,
          ordinal: 1, heading: "Opening", summary: "On the court",
        }),
      },
    );
    expect(sceneReplay.status).toBe(201);
    expect(await sceneReplay.json()).toEqual(scene);
    const wrongScene = await fetch(
      `${base}/api/v1/projects/${other.projectId}/episodes/${source.episodeId}/scenes/${scene.entityId}/revisions`,
    );
    expect(wrongScene.status).toBe(404);
    const reviewScenePath = `${scenes}/${scene.entityId}/revisions/${scene.revisionId}/review`;
    const sceneInReview = await fetch(`${base}/api/v1${reviewScenePath}`, {
      method: "POST", headers: {
        "content-type": "application/json", "if-match": String(scene.rowVersion),
        "idempotency-key": "m2-scene-review-in",
      }, body: JSON.stringify({ to: "IN_REVIEW", expectedReviewVersion: 1 }),
    });
    expect(sceneInReview.status).toBe(200);
    const sceneReview = (await sceneInReview.json()) as { rowVersion: number; reviewVersion: number };
    const sceneApproved = await fetch(`${base}/api/v1${reviewScenePath}`, {
      method: "POST", headers: {
        "content-type": "application/json", "if-match": String(sceneReview.rowVersion),
        "idempotency-key": "m2-scene-review-approved",
      }, body: JSON.stringify({ to: "APPROVED", expectedReviewVersion: sceneReview.reviewVersion }),
    });
    expect(sceneApproved.status).toBe(200);
    const approvedScene = (await sceneApproved.json()) as { rowVersion: number };
    const shotBody = JSON.stringify({
      sourceSceneRevisionId: scene.revisionId, ordinal: 1, shotType: "WIDE",
      camera: "static", action: "run", promptText: "court",
    });
    const shotBase = `${scenes}/${scene.entityId}/shots`;
    const shotResponse = await fetch(`${base}/api/v1${shotBase}`, {
      method: "POST", headers: {
        "content-type": "application/json", "if-match": String(approvedScene.rowVersion),
        "idempotency-key": "m2-shot-create",
      }, body: shotBody,
    });
    expect(shotResponse.status).toBe(201);
    const shot = (await shotResponse.json()) as { entityId: string; revisionId: string; rowVersion: number };
    const imagePath = `/shot-revisions/${shot.revisionId}/generate-image`;
    const unapprovedImage = await fetch(`${base}/api/v1${imagePath}`, {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": "m3-image-unapproved" },
      body: JSON.stringify({ seed: "first" }),
    });
    expect(unapprovedImage.status).toBe(400);
    const history = await fetch(
      `${base}/api/v1${shotBase}/${shot.entityId}/revisions`,
    );
    expect(history.status).toBe(200);
    expect((await history.json()) as { items: unknown[] }).toMatchObject({
      items: [{ id: shot.revisionId, sourceSceneRevisionId: scene.revisionId }],
    });
    const wrongReview = await fetch(
      `${base}/api/v1/projects/${other.projectId}/episodes/${source.episodeId}/scenes/${scene.entityId}/shots/${shot.entityId}/revisions/${shot.revisionId}/review`,
      {
        method: "POST", headers: {
          "content-type": "application/json", "if-match": String(shot.rowVersion),
          "idempotency-key": "m2-shot-review-in",
        }, body: JSON.stringify({ to: "IN_REVIEW", expectedReviewVersion: 1 }),
      },
    );
    expect(wrongReview.status).toBe(404);
    const reviewShotPath = `${shotBase}/${shot.entityId}/revisions/${shot.revisionId}/review`;
    const shotInReview = await fetch(`${base}/api/v1${reviewShotPath}`, {
      method: "POST", headers: {
        "content-type": "application/json", "if-match": String(shot.rowVersion),
        "idempotency-key": "m2-shot-review-in",
      }, body: JSON.stringify({ to: "IN_REVIEW", expectedReviewVersion: 1 }),
    });
    expect(shotInReview.status).toBe(200);
    const shotReview = (await shotInReview.json()) as { rowVersion: number; reviewVersion: number };
    const shotApproved = await fetch(`${base}/api/v1${reviewShotPath}`, {
      method: "POST", headers: {
        "content-type": "application/json", "if-match": String(shotReview.rowVersion),
        "idempotency-key": "m2-shot-review-approved",
      }, body: JSON.stringify({ to: "APPROVED", expectedReviewVersion: shotReview.reviewVersion }),
    });
    expect(shotApproved.status).toBe(200);
    await sql(`INSERT INTO provider_configuration
      (workspace_id, provider_key, capability, default_timeout_ms)
      VALUES ($1,'mock-media','image.generate',30000)`, [APP_WORKSPACE_ID]);
    const generate = await fetch(`${base}/api/v1${imagePath}`, {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": "m3-image-create" },
      body: JSON.stringify({ seed: "first" }),
    });
    expect(generate.status).toBe(202);
    const createdImage = (await generate.json()) as { jobId: string; workflowRunId: string; dispatchSeq: number };
    const replay = await fetch(`${base}/api/v1/shot-revisions/${shot.revisionId.toUpperCase()}/generate-image`, {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": "m3-image-create" },
      body: JSON.stringify({ seed: "first" }),
    });
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual(createdImage);
    const conflicting = await fetch(`${base}/api/v1${imagePath}`, {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": "m3-image-create" },
      body: JSON.stringify({ seed: "different" }),
    });
    expect(conflicting.status).toBe(409);
    const queued = await sql<{ project_id: string; source_shot_revision_id: string; state: string }>(
      "SELECT project_id, source_shot_revision_id, state FROM generation_job WHERE id = $1",
      [createdImage.jobId],
    );
    expect(queued.rows[0]).toMatchObject({ project_id: source.projectId,
      source_shot_revision_id: shot.revisionId, state: "QUEUED" });
    const cancelImage = await fetch(`${base}/api/v1/generation-jobs/${createdImage.jobId}/cancel`, {
      method: "POST", headers: { "idempotency-key": "m3-image-cancel" },
    });
    expect(cancelImage.status).toBe(200);
    const retryImage = await fetch(`${base}/api/v1/generation-jobs/${createdImage.jobId}/retry`, {
      method: "POST", headers: { "idempotency-key": "m3-image-retry" },
    });
    expect(retryImage.status).toBe(202);
    const retried = (await retryImage.json()) as {
      jobId: string; workflowRunId: string; retry: { sourceJobId: string; rootJobId: string; manualRetryCount: number };
    };
    expect(retried.jobId).not.toBe(createdImage.jobId);
    expect(retried.retry).toEqual({ sourceJobId: createdImage.jobId, rootJobId: createdImage.jobId, manualRetryCount: 1 });
    const retryReplay = await fetch(`${base}/api/v1/generation-jobs/${createdImage.jobId}/retry`, {
      method: "POST", headers: { "idempotency-key": "m3-image-retry" },
    });
    expect(retryReplay.status).toBe(202);
    expect(await retryReplay.json()).toEqual(retried);
    const secondRetry = await fetch(`${base}/api/v1/generation-jobs/${createdImage.jobId}/retry`, {
      method: "POST", headers: { "idempotency-key": "m3-image-retry-second" },
    });
    expect(secondRetry.status).toBe(409);
    expect(await secondRetry.json()).toMatchObject({ error: {
      code: "JOB_NOT_RETRYABLE", details: { retryJobId: retried.jobId, rootJobId: createdImage.jobId },
    } });
    const mediaJobs = await sql<{ id: string; state: string; input_hash: string }>(
      "SELECT id, state, input_hash FROM generation_job WHERE source_shot_revision_id = $1 ORDER BY created_at",
      [shot.revisionId],
    );
    expect(mediaJobs.rows.map((row) => row.state).sort()).toEqual(["CANCELED", "QUEUED"]);
    expect(new Set(mediaJobs.rows.map((row) => row.input_hash)).size).toBe(1);
    const canceledRetry = await fetch(`${base}/api/v1/generation-jobs/${retried.jobId}/cancel`, {
      method: "POST", headers: { "idempotency-key": "m3-image-retry-cancel" },
    });
    expect(canceledRetry.status).toBe(200);
    const emptyAssets = await fetch(`${base}/api/v1/shot-revisions/${shot.revisionId}/assets`);
    expect(emptyAssets.status).toBe(200);
    expect(await emptyAssets.json()).toEqual({ items: [] });
    const siblingShot = (await sql<{ id: string }>(
      `INSERT INTO shot (workspace_id, project_id, episode_id, scene_id)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [APP_WORKSPACE_ID, source.projectId, source.episodeId, scene.entityId],
    )).rows[0]!;
    const siblingRevision = (await sql<{ id: string }>(
      `INSERT INTO shot_revision
       (workspace_id, project_id, scene_id, shot_id, revision_no,
        source_scene_revision_id, ordinal, shot_type, camera, action, prompt_text,
        content_hash, created_by)
       VALUES ($1,$2,$3,$4,1,$5,2,'WIDE','static','run','other',$6,'test') RETURNING id`,
      [APP_WORKSPACE_ID, source.projectId, scene.entityId, siblingShot.id,
        scene.revisionId, "cd".repeat(32)],
    )).rows[0]!;
    await sql(`INSERT INTO asset
      (workspace_id, project_id, kind, storage_provider, object_key, mime_type,
       byte_size, checksum_sha256, source_kind, source_shot_revision_id)
      VALUES ($1,$2,'IMAGE','mock-test','shot-primary.png','image/png',1,$3,'UPLOAD',$4)`,
    [APP_WORKSPACE_ID, source.projectId, "ab".repeat(32), shot.revisionId]);
    await sql(`INSERT INTO asset
      (workspace_id, project_id, kind, storage_provider, object_key, mime_type,
       byte_size, checksum_sha256, source_kind, source_shot_revision_id)
      VALUES ($1,$2,'IMAGE','mock-test','shot-sibling.png','image/png',1,$3,'UPLOAD',$4)`,
    [APP_WORKSPACE_ID, source.projectId, "cd".repeat(32), siblingRevision.id]);
    const listed = await fetch(`${base}/api/v1/shot-revisions/${shot.revisionId}/assets`);
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as {
      items: Array<{ objectKey: string; providerRequestId: string | null }>;
    };
    expect(listedBody.items).toMatchObject([{ objectKey: "shot-primary.png", providerRequestId: null }]);
    const unknownAssets = await fetch(`${base}/api/v1/shot-revisions/00000000-0000-4000-8000-000000000000/assets`);
    expect(unknownAssets.status).toBe(404);
  });
});

describe("M2 aggregate discovery HTTP", () => {
  it("discovers current entities, binds cursors to scope, and returns history aggregate versions", async () => {
    const first = await seedApprovedScriptForTextEntity("discovery-a");
    const second = await seedApprovedScriptForTextEntity("discovery-b");
    const created = await fetch(`${base}/api/v1/projects/${first.projectId}/characters`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "discover-character", "if-match": "1" },
      body: JSON.stringify({ name: "Hero", sourceScriptRevisionId: first.scriptRevisionId, content: { role: "lead" } }),
    });
    expect(created.status).toBe(201);
    const entity = (await created.json()) as { entityId: string; revisionId: string; rowVersion: number };

    const pageResponse = await fetch(`${base}/api/v1/projects/${first.projectId}/characters?limit=1`);
    expect(pageResponse.status).toBe(200);
    const page = (await pageResponse.json()) as { items: Array<Record<string, unknown>>; nextCursor: string | null };
    expect(page.items).toEqual([expect.objectContaining({
      entityId: entity.entityId, projectId: first.projectId, rowVersion: entity.rowVersion,
      currentRevisionId: entity.revisionId, approvedRevisionId: null,
      currentRevision: { reviewVersion: 1, reviewStatus: "DRAFT", freshnessStatus: "CURRENT" },
    })]);

    const historyResponse = await fetch(
      `${base}/api/v1/projects/${first.projectId}/characters/${entity.entityId}/revisions`,
    );
    expect(historyResponse.status).toBe(200);
    expect(await historyResponse.json()).toEqual(expect.objectContaining({
      aggregate: expect.objectContaining({ entityId: entity.entityId, projectId: first.projectId,
        rowVersion: entity.rowVersion, currentRevisionId: entity.revisionId, approvedRevisionId: null }),
      items: [expect.objectContaining({ id: entity.revisionId })],
    }));

    const empty = await fetch(`${base}/api/v1/projects/${second.projectId}/characters`);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ items: [], nextCursor: null });
    const invalid = await fetch(`${base}/api/v1/projects/${first.projectId}/characters?cursor=invalid`);
    expect(invalid.status).toBe(400);
    const versions = await sql<{ row_version: number }>("SELECT row_version FROM character WHERE id=$1", [entity.entityId]);
    expect(versions.rows[0]?.row_version).toBe(entity.rowVersion);
  });
});

describe("M2 collection keyset boundaries", () => {
  function cursor(value: Record<string, unknown>): string {
    return Buffer.from(JSON.stringify({ v: 1, ...value })).toString("base64url");
  }

  it("rejects semantic timestamp and ordinal cursor errors as validation errors", async () => {
    const source = await seedApprovedScriptForTextEntity("invalid-cursors");
    const id = "30000000-0000-4000-8000-000000000001";
    for (const sort of ["0000-01-01T00:00:00.000000Z", "2026-13-01T00:00:00.000000Z", "2026-02-30T00:00:00.000000Z",
      "2025-02-29T00:00:00.000000Z", "2026-01-01T24:00:00.000000Z"]) {
      const value = cursor({ kind: "character", workspaceId: APP_WORKSPACE_ID,
        projectId: source.projectId, sort, id });
      const response = await fetch(`${base}/api/v1/projects/${source.projectId}/characters?cursor=${value}`);
      expect(response.status, `${sort}: ${await response.clone().text()}`).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    }
    for (const sort of ["0001-01-01T00:00:00.000000Z", "2024-02-29T23:59:59.999999Z"]) {
      const value = cursor({ kind: "character", workspaceId: APP_WORKSPACE_ID,
        projectId: source.projectId, sort, id });
      const response = await fetch(`${base}/api/v1/projects/${source.projectId}/characters?cursor=${value}`);
      expect(response.status, `${sort}: ${await response.clone().text()}`).toBe(200);
    }
    for (const sort of ["0:0", "0:2147483648", "0:999999999999999999999", "1:1"]) {
      const value = cursor({ kind: "scene", workspaceId: APP_WORKSPACE_ID,
        projectId: source.projectId, episodeId: source.episodeId, sort, id });
      const response = await fetch(
        `${base}/api/v1/projects/${source.projectId}/episodes/${source.episodeId}/scenes?cursor=${value}`,
      );
      expect(response.status, `${sort}: ${await response.clone().text()}`).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    }
  });

  it("preserves timestamptz microseconds and terminates without duplicate entities", async () => {
    const source = await seedApprovedScriptForTextEntity("microsecond-cursors");
    const ids = [
      "10000000-0000-4000-8000-000000000001",
      "10000000-0000-4000-8000-000000000002",
      "10000000-0000-4000-8000-000000000003",
    ];
    await sql(`INSERT INTO character (id,workspace_id,project_id,name,created_at) VALUES
      ($1,$4,$5,'a','2026-09-28 12:00:00.123456+00'),
      ($2,$4,$5,'b','2026-09-28 12:00:00.123789+00'),
      ($3,$4,$5,'c','2026-09-28 12:00:00.123789+00')`,
    [...ids, APP_WORKSPACE_ID, source.projectId]);
    const found: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      expect(++pages).toBeLessThanOrEqual(4);
      const response = await fetch(`${base}/api/v1/projects/${source.projectId}/characters?limit=1${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(response.status).toBe(200);
      const page = (await response.json()) as { items: Array<{ entityId: string }>; nextCursor: string | null };
      found.push(...page.items.map((item) => item.entityId));
      cursor = page.nextCursor;
    } while (cursor);
    expect(found).toEqual(ids);
    expect(new Set(found).size).toBe(ids.length);
  });

  it("paginates current and revision-less scenes with a null-safe stable order", async () => {
    const source = await seedApprovedScriptForTextEntity("null-current-scenes");
    const ids = [
      "20000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000002",
      "20000000-0000-4000-8000-000000000003",
    ];
    await sql(`INSERT INTO scene (id,workspace_id,project_id,episode_id) VALUES
      ($1,$4,$5,$6),($2,$4,$5,$6),($3,$4,$5,$6)`,
    [...ids, APP_WORKSPACE_ID, source.projectId, source.episodeId]);
    const revision = (await sql<{ id: string }>(`INSERT INTO scene_revision
      (workspace_id,project_id,episode_id,scene_id,revision_no,source_script_revision_id,
       ordinal,heading,summary,content_hash,created_by)
      VALUES ($1,$2,$3,$4,1,$5,7,'current','current',$6,'test') RETURNING id`,
    [APP_WORKSPACE_ID, source.projectId, source.episodeId, ids[1], source.scriptRevisionId, "ef".repeat(32)])).rows[0]!;
    await sql("UPDATE scene SET current_revision_id=$1,row_version=2 WHERE id=$2", [revision.id, ids[1]]);
    const found: Array<{ entityId: string; currentRevision: unknown }> = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      expect(++pages).toBeLessThanOrEqual(4);
      const response = await fetch(`${base}/api/v1/projects/${source.projectId}/episodes/${source.episodeId}/scenes?limit=1${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      expect(response.status).toBe(200);
      const page = (await response.json()) as { items: typeof found; nextCursor: string | null };
      found.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    expect(found.map((item) => item.entityId)).toEqual([ids[1], ids[0], ids[2]]);
    expect(found.map((item) => item.currentRevision)).toEqual([
      { reviewVersion: 1, reviewStatus: "DRAFT", freshnessStatus: "CURRENT" }, null, null,
    ]);
  });
});

describe("M2 collection scope and archive boundaries", () => {
  it("enforces project/workspace/episode/scene cursor scopes and preserves archived history", async () => {
    const source = await seedApprovedScriptForTextEntity("scope-owner");
    const other = await seedApprovedScriptForTextEntity("scope-other-project");
    const hiddenWorkspace = "44444444-4444-4444-8444-444444444444";
    await sql("INSERT INTO workspace (id,name,status) VALUES ($1,'hidden','ACTIVE')", [hiddenWorkspace]);
    const hiddenProject = (await sql<{ id: string }>(
      "INSERT INTO project (workspace_id,title) VALUES ($1,'hidden') RETURNING id", [hiddenWorkspace])).rows[0]!;
    expect((await fetch(`${base}/api/v1/projects/${hiddenProject.id}/characters`)).status).toBe(404);

    const empty = await fetch(`${base}/api/v1/projects/${source.projectId}/locations`);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ items: [], nextCursor: null });
    const created = await fetch(`${base}/api/v1/projects/${source.projectId}/characters`, {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": "archive-character",
        "if-match": "1" },
      body: JSON.stringify({ name: "Archived", sourceScriptRevisionId: source.scriptRevisionId, content: { role: "old" } }),
    });
    expect(created.status).toBe(201);
    const entity = (await created.json()) as { entityId: string; revisionId: string };
    await sql("UPDATE character SET archived_at=now() WHERE id=$1", [entity.entityId]);
    expect(await (await fetch(`${base}/api/v1/projects/${source.projectId}/characters`)).json())
      .toEqual({ items: [], nextCursor: null });
    const history = await fetch(
      `${base}/api/v1/projects/${source.projectId}/characters/${entity.entityId}/revisions`,
    );
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({ aggregate: { entityId: entity.entityId },
      items: [{ id: entity.revisionId }] });
    expect((await fetch(`${base}/api/v1/projects/${other.projectId}/characters/${entity.entityId}/revisions`)).status)
      .toBe(404);

    const episode2 = (await sql<{ id: string }>(
      "INSERT INTO episode (workspace_id,project_id,episode_no,title) VALUES ($1,$2,2,'other') RETURNING id",
      [APP_WORKSPACE_ID, source.projectId])).rows[0]!;
    const scene = (await sql<{ id: string }>(
      "INSERT INTO scene (workspace_id,project_id,episode_id) VALUES ($1,$2,$3) RETURNING id",
      [APP_WORKSPACE_ID, source.projectId, source.episodeId])).rows[0]!;
    expect((await fetch(`${base}/api/v1/projects/${source.projectId}/episodes/${episode2.id}/scenes/${scene.id}/revisions`)).status)
      .toBe(404);
    const shot = (await sql<{ id: string }>(
      "INSERT INTO shot (workspace_id,project_id,episode_id,scene_id) VALUES ($1,$2,$3,$4) RETURNING id",
      [APP_WORKSPACE_ID, source.projectId, source.episodeId, scene.id])).rows[0]!;
    const otherScene = (await sql<{ id: string }>(
      "INSERT INTO scene (workspace_id,project_id,episode_id) VALUES ($1,$2,$3) RETURNING id",
      [APP_WORKSPACE_ID, source.projectId, source.episodeId])).rows[0]!;
    expect((await fetch(`${base}/api/v1/projects/${source.projectId}/episodes/${source.episodeId}/scenes/${otherScene.id}/shots/${shot.id}/revisions`)).status)
      .toBe(404);

    const id = "30000000-0000-4000-8000-000000000002";
    const crossProject = Buffer.from(JSON.stringify({ v: 1, kind: "character", workspaceId: APP_WORKSPACE_ID,
      projectId: source.projectId, sort: "2026-09-28T12:00:00.000000Z", id })).toString("base64url");
    expect((await fetch(`${base}/api/v1/projects/${other.projectId}/characters?cursor=${crossProject}`)).status).toBe(400);
    expect((await fetch(`${base}/api/v1/projects/${source.projectId}/locations?cursor=${crossProject}`)).status).toBe(400);
    const scoped = Buffer.from(JSON.stringify({ v: 1, kind: "scene", workspaceId: APP_WORKSPACE_ID,
      projectId: source.projectId, episodeId: source.episodeId, sort: "1:0", id })).toString("base64url");
    expect((await fetch(`${base}/api/v1/projects/${source.projectId}/episodes/${episode2.id}/scenes?cursor=${scoped}`)).status)
      .toBe(400);
    const shotCursor = Buffer.from(JSON.stringify({ v: 1, kind: "shot", workspaceId: APP_WORKSPACE_ID,
      projectId: source.projectId, episodeId: source.episodeId, sceneId: scene.id, sort: "1:0", id })).toString("base64url");
    expect((await fetch(`${base}/api/v1/projects/${source.projectId}/episodes/${source.episodeId}/scenes/${otherScene.id}/shots?cursor=${shotCursor}`)).status)
      .toBe(400);
  });

  it("paginates mixed current and revision-less shots with limit one", async () => {
    const source = await seedApprovedScriptForTextEntity("null-current-shots");
    const scene = (await sql<{ id: string }>(
      "INSERT INTO scene (workspace_id,project_id,episode_id) VALUES ($1,$2,$3) RETURNING id",
      [APP_WORKSPACE_ID, source.projectId, source.episodeId])).rows[0]!;
    const sceneRevision = (await sql<{ id: string }>(`INSERT INTO scene_revision
      (workspace_id,project_id,episode_id,scene_id,revision_no,source_script_revision_id,ordinal,heading,summary,content_hash,created_by)
      VALUES ($1,$2,$3,$4,1,$5,1,'scene','scene',$6,'test') RETURNING id`,
    [APP_WORKSPACE_ID, source.projectId, source.episodeId, scene.id, source.scriptRevisionId, "aa".repeat(32)])).rows[0]!;
    await sql("UPDATE scene SET current_revision_id=$1 WHERE id=$2", [sceneRevision.id, scene.id]);
    const ids = ["50000000-0000-4000-8000-000000000001", "50000000-0000-4000-8000-000000000002",
      "50000000-0000-4000-8000-000000000003"];
    await sql(`INSERT INTO shot (id,workspace_id,project_id,episode_id,scene_id) VALUES
      ($1,$4,$5,$6,$7),($2,$4,$5,$6,$7),($3,$4,$5,$6,$7)`,
    [...ids, APP_WORKSPACE_ID, source.projectId, source.episodeId, scene.id]);
    const revision = (await sql<{ id: string }>(`INSERT INTO shot_revision
      (workspace_id,project_id,scene_id,shot_id,revision_no,source_scene_revision_id,ordinal,shot_type,camera,action,prompt_text,content_hash,created_by)
      VALUES ($1,$2,$3,$4,1,$5,9,'WIDE','fixed','action','prompt',$6,'test') RETURNING id`,
    [APP_WORKSPACE_ID, source.projectId, scene.id, ids[1], sceneRevision.id, "bb".repeat(32)])).rows[0]!;
    await sql("UPDATE shot SET current_revision_id=$1 WHERE id=$2", [revision.id, ids[1]]);
    const found: Array<{ entityId: string; currentRevision: unknown }> = [];
    let next: string | null = null;
    for (let pageNo = 0; pageNo < 4; pageNo += 1) {
      const response = await fetch(`${base}/api/v1/projects/${source.projectId}/episodes/${source.episodeId}/scenes/${scene.id}/shots?limit=1${next ? `&cursor=${next}` : ""}`);
      const page = (await response.json()) as { items: typeof found; nextCursor: string | null };
      found.push(...page.items); next = page.nextCursor;
      if (!next) break;
    }
    expect(next).toBeNull();
    expect(found.map((item) => item.entityId)).toEqual([ids[1], ids[0], ids[2]]);
    expect(found.map((item) => item.currentRevision)).toEqual([
      { reviewVersion: 1, reviewStatus: "DRAFT", freshnessStatus: "CURRENT" }, null, null,
    ]);
  });
});

describe("M2 collection route isolation matrix", () => {
  it("checks every new collection route and rejects replayed real cursors across scopes", async () => {
    const source = await seedApprovedScriptForTextEntity("matrix-source");
    const other = await seedApprovedScriptForTextEntity("matrix-other");
    const hiddenWorkspace = "66666666-6666-4666-8666-666666666666";
    await sql("INSERT INTO workspace (id,name,status) VALUES ($1,'matrix-hidden','ACTIVE')", [hiddenWorkspace]);
    const hiddenProject = (await sql<{ id: string }>(
      "INSERT INTO project (workspace_id,title) VALUES ($1,'hidden') RETURNING id", [hiddenWorkspace])).rows[0]!;
    const hiddenEpisode = (await sql<{ id: string }>(
      "INSERT INTO episode (workspace_id,project_id,episode_no,title) VALUES ($1,$2,1,'hidden') RETURNING id",
      [hiddenWorkspace, hiddenProject.id])).rows[0]!;
    const hiddenScene = (await sql<{ id: string }>(
      "INSERT INTO scene (workspace_id,project_id,episode_id) VALUES ($1,$2,$3) RETURNING id",
      [hiddenWorkspace, hiddenProject.id, hiddenEpisode.id])).rows[0]!;
    const hiddenPaths = [
      `/projects/${hiddenProject.id}/characters`, `/projects/${hiddenProject.id}/locations`,
      `/projects/${hiddenProject.id}/episodes/${hiddenEpisode.id}/scenes`,
      `/projects/${hiddenProject.id}/episodes/${hiddenEpisode.id}/scenes/${hiddenScene.id}/shots`,
    ];
    for (const path of hiddenPaths) expect((await fetch(`${base}/api/v1${path}`)).status).toBe(404);

    for (const kind of ["characters", "locations"]) {
      const response = await fetch(`${base}/api/v1/projects/${other.projectId}/${kind}`);
      expect(response.status).toBe(200); expect(await response.json()).toEqual({ items: [], nextCursor: null });
    }
    const emptyScenes = await fetch(`${base}/api/v1/projects/${other.projectId}/episodes/${other.episodeId}/scenes`);
    expect(await emptyScenes.json()).toEqual({ items: [], nextCursor: null });
    const otherScene = (await sql<{ id: string }>(
      "INSERT INTO scene (workspace_id,project_id,episode_id) VALUES ($1,$2,$3) RETURNING id",
      [APP_WORKSPACE_ID, other.projectId, other.episodeId])).rows[0]!;
    const emptyShots = await fetch(
      `${base}/api/v1/projects/${other.projectId}/episodes/${other.episodeId}/scenes/${otherScene.id}/shots`,
    );
    expect(await emptyShots.json()).toEqual({ items: [], nextCursor: null });

    expect((await fetch(`${base}/api/v1/projects/${source.projectId}/episodes/${other.episodeId}/scenes`)).status).toBe(404);
    expect((await fetch(`${base}/api/v1/projects/${other.projectId}/episodes/${source.episodeId}/scenes`)).status).toBe(404);
    const sourceScene = (await sql<{ id: string }>(
      "INSERT INTO scene (workspace_id,project_id,episode_id) VALUES ($1,$2,$3) RETURNING id",
      [APP_WORKSPACE_ID, source.projectId, source.episodeId])).rows[0]!;
    const sourceScene2 = (await sql<{ id: string }>(
      "INSERT INTO scene (workspace_id,project_id,episode_id) VALUES ($1,$2,$3) RETURNING id",
      [APP_WORKSPACE_ID, source.projectId, source.episodeId])).rows[0]!;
    expect((await fetch(`${base}/api/v1/projects/${source.projectId}/episodes/${other.episodeId}/scenes/${sourceScene.id}/shots`)).status).toBe(404);
    expect((await fetch(`${base}/api/v1/projects/${source.projectId}/episodes/${source.episodeId}/scenes/${otherScene.id}/shots`)).status).toBe(404);
    expect((await fetch(`${base}/api/v1/projects/${other.projectId}/episodes/${other.episodeId}/scenes/${sourceScene.id}/shots`)).status).toBe(404);

    await sql(`INSERT INTO character (workspace_id,project_id,name,created_at) VALUES
      ($1,$2,'matrix-a','2026-09-28 12:00:00.000001+00'),($1,$2,'matrix-b','2026-09-28 12:00:00.000002+00')`,
    [APP_WORKSPACE_ID, source.projectId]);
    const characterPage = await fetch(`${base}/api/v1/projects/${source.projectId}/characters?limit=1`);
    const characterCursor = ((await characterPage.json()) as { nextCursor: string }).nextCursor;
    expect(characterCursor).toBeTruthy();
    expect((await fetch(`${base}/api/v1/projects/${other.projectId}/characters?cursor=${characterCursor}`)).status).toBe(400);
    expect((await fetch(`${base}/api/v1/projects/${source.projectId}/locations?cursor=${characterCursor}`)).status).toBe(400);

    const scenePage = await fetch(`${base}/api/v1/projects/${source.projectId}/episodes/${source.episodeId}/scenes?limit=1`);
    const sceneCursor = ((await scenePage.json()) as { nextCursor: string }).nextCursor;
    expect(sceneCursor).toBeTruthy();
    expect((await fetch(`${base}/api/v1/projects/${other.projectId}/episodes/${other.episodeId}/scenes?cursor=${sceneCursor}`)).status).toBe(400);

    await sql(`INSERT INTO shot (workspace_id,project_id,episode_id,scene_id) VALUES
      ($1,$2,$3,$4),($1,$2,$3,$4)`, [APP_WORKSPACE_ID, source.projectId, source.episodeId, sourceScene.id]);
    const shotPage = await fetch(
      `${base}/api/v1/projects/${source.projectId}/episodes/${source.episodeId}/scenes/${sourceScene.id}/shots?limit=1`,
    );
    const shotCursor = ((await shotPage.json()) as { nextCursor: string }).nextCursor;
    expect(shotCursor).toBeTruthy();
    expect((await fetch(`${base}/api/v1/projects/${source.projectId}/episodes/${source.episodeId}/scenes/${sourceScene2.id}/shots?cursor=${shotCursor}`)).status).toBe(400);
    expect((await fetch(`${base}/api/v1/projects/${other.projectId}/episodes/${other.episodeId}/scenes/${otherScene.id}/shots?cursor=${shotCursor}`)).status).toBe(400);
  });
});
