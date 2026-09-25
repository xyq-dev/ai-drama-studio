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
  });
}

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
    expect(project.version).toBe(1);

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
    expect(created.contentHash).toMatch(/^[0-9a-f]{64}$/);

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

    const count = await sql<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM story_revision WHERE project_id = $1",
      [project.id],
    );
    expect(count.rows[0]?.count).toBe(1);

    const staleVersion = await fetch(`${base}/api/v1/projects/${project.id}/stories`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "m2c-story-stale-version",
        "if-match": String(project.version),
      },
      body: JSON.stringify({
        content: { schema: "m2.story.revision.v1", premise: "must conflict" },
      }),
    });
    expect(staleVersion.status).toBe(409);
    const conflict = (await staleVersion.json()) as { error: { code: string } };
    expect(conflict.error.code).toBe("REVISION_CONFLICT");

    const missingEtag = await fetch(`${base}/api/v1/projects/${project.id}/stories`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "m2c-story-missing-etag",
      },
      body,
    });
    expect(missingEtag.status).toBe(400);

    const historyResponse = await fetch(`${base}/api/v1/projects/${project.id}/stories`);
    expect(historyResponse.status).toBe(200);
    const history = (await historyResponse.json()) as {
      items: Array<{ id: string; revisionNo: number; reviewStatus: string; freshnessStatus: string }>;
      nextCursor: string | null;
    };
    expect(history.items).toHaveLength(1);
    expect(history.nextCursor).toBeNull();
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


  it("returns INVALID_STORY instead of 500 for non-canonical story content", async () => {
    const projectResponse = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "m2c-canonical-project" },
      body: JSON.stringify({ title: "Canonical" }),
    });
    const project = (await projectResponse.json()) as { id: string; version: number };

    const invalid = await fetch(`${base}/api/v1/projects/${project.id}/stories`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "m2c-invalid-story",
        "if-match": String(project.version),
      },
      body: JSON.stringify({ content: { rowVersion: 2 } }),
    });
    expect(invalid.status).toBe(400);
    const body = (await invalid.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_STORY");
  });

  it("paginates story revision history with a stable bounded cursor", async () => {
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
        body: JSON.stringify({
          content: { schema: "m2.story.revision.v1", revision },
        }),
      });
      expect(response.status).toBe(201);
      const created = (await response.json()) as { rowVersion: number };
      version = created.rowVersion;
    }

    const firstResponse = await fetch(`${base}/api/v1/projects/${project.id}/stories`);
    expect(firstResponse.status).toBe(200);
    const first = (await firstResponse.json()) as {
      items: Array<{ revisionNo: number }>;
      nextCursor: string | null;
    };
    expect(first.items).toHaveLength(20);
    expect(first.items[0]?.revisionNo).toBe(21);
    expect(first.items.at(-1)?.revisionNo).toBe(2);
    expect(first.nextCursor).toBe("2");

    const secondResponse = await fetch(
      `${base}/api/v1/projects/${project.id}/stories?cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
    );
    expect(secondResponse.status).toBe(200);
    const second = (await secondResponse.json()) as {
      items: Array<{ revisionNo: number }>;
      nextCursor: string | null;
    };
    expect(second.items.map((item) => item.revisionNo)).toEqual([1]);
    expect(second.nextCursor).toBeNull();

    const invalidCursor = await fetch(
      `${base}/api/v1/projects/${project.id}/stories?cursor=not-a-revision`,
    );
    expect(invalidCursor.status).toBe(400);
    const invalidBody = (await invalidCursor.json()) as { error: { code: string } };
    expect(invalidBody.error.code).toBe("VALIDATION_ERROR");
  });

});
