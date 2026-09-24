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
    expect(replay.text.includes(`id: ${cursor ?? ""}`)).toBe(false);
    const reconnect = await readSse(`${base}/api/v1/events`, { "last-event-id": cursor ?? "0" });
    expect(reconnect.status).toBe(200);
    await sql("UPDATE domain_event SET retention_until = now() - interval '1 day' WHERE id = $1", [cursor]);
    const expired = await fetch(`${base}/api/v1/events`, { headers: { "last-event-id": cursor ?? "0" } });
    expect(expired.status).toBe(409);
    const error = (await expired.json()) as { error: { code: string } };
    expect(error.error.code).toBe("EVENT_CURSOR_EXPIRED");
  });
});
