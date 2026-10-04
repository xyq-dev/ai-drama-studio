import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePostgresPool, createPostgresPool, runMigrations, type PostgresPool } from "@ai-drama/database";
import {
  buildStoryPlanInstruction,
  canAdopt,
  formatWritingImport,
  freezeWritingContext,
  parseWritingImport,
  writingInputFingerprint,
  type StoryPlanCandidate,
} from "@ai-drama/domain";
import { AppModule } from "../app.module";
import { loadApiEnv } from "../config/env";
import { SafeExceptionFilter } from "../http/safe-exception.filter";

/**
 * Handwritten candidate used to exercise import, draft adoption, and a real save.
 * It is not a model result, and this test does not call a model.
 */
const STORY_PLAN: StoryPlanCandidate = {
  schema: "ads.writing.story-plan.v1",
  logline: "手写验收候选，不是模型结果",
  protagonistGoal: "守住班次记录",
  opposition: "店长能改时间",
  coreConflict: "解释会被当成承认",
  relationships: [{ name: "店员", pressure: "不能供出同事" }],
  episodes: [1, 2, 3].map((episodeNo) => ({
    episodeNo: episodeNo as 1 | 2 | 3,
    entryState: `进入${episodeNo}`,
    goal: `目标${episodeNo}`,
    action: `行动${episodeNo}`,
    turn: `转折${episodeNo}`,
    result: `结果${episodeNo}`,
    handoff: `交接${episodeNo}`,
  })),
};

const APP_WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
if (!databaseUrl || !redisUrl) {
  throw new Error("DATABASE_URL and REDIS_URL are required for the writing assistant API check");
}

const pool: PostgresPool = createPostgresPool({
  connectionString: databaseUrl,
  connectionTimeoutMs: 2_000,
  statementTimeoutMs: 10_000,
  queryTimeoutMs: 10_000,
});

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

let app: INestApplication | undefined;
let base: string;

beforeAll(async () => {
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await runMigrations(pool);
  await pool.query("INSERT INTO workspace (id, name, status) VALUES ($1, 'configured', 'ACTIVE')", [APP_WORKSPACE_ID]);
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

describe("writing assistant real API save", () => {
  it("imports a fixture, adopts it onto the original If-Match, saves, and rereads the draft revision", async () => {
    const projectResponse = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "writing-project" },
      body: JSON.stringify({ title: "编剧助手验收", premise: "夜班便利店" }),
    });
    expect(projectResponse.status).toBe(201);
    const project = (await projectResponse.json()) as { id: string; version: number };
    const request = {
      premise: "夜班便利店",
      genre: "",
      audience: "",
      characters: "",
      mustKeep: "班次记录是真的",
      mustNotChange: "",
      currentText: "",
    };
    const instruction = buildStoryPlanInstruction(request);
    expect(instruction).toContain("ads.writing.prompt.v1");
    const live = {
      projectId: project.id,
      entityKey: "story",
      mode: "story" as const,
      episodeNo: null,
      sourceRevisionId: null,
      ifMatch: project.version,
      draftFingerprint: "empty-editor",
      currentText: "",
      loaded: true as const,
    };
    const fingerprint = writingInputFingerprint(request);
    const frozen = freezeWritingContext(live, fingerprint);
    const imported = parseWritingImport(new TextEncoder().encode(JSON.stringify(STORY_PLAN)), { mode: "story", episodeNo: null });
    const formatted = formatWritingImport(imported);
    expect(canAdopt(frozen, live, fingerprint)).toEqual({ ok: true });
    const shifted = canAdopt(frozen, { ...live, ifMatch: project.version + 1 }, fingerprint);
    expect(shifted.ok).toBe(false);
    expect(frozen.ifMatch).toBe(project.version);

    const saved = await fetch(`${base}/api/v1/projects/${project.id}/stories`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "writing-story-save",
        "if-match": String(frozen.ifMatch),
      },
      body: JSON.stringify({ content: { text: formatted } }),
    });
    expect(saved.status).toBe(201);
    const created = (await saved.json()) as { revisionId: string; reviewStatus?: string };
    const replay = await fetch(`${base}/api/v1/projects/${project.id}/stories`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "writing-story-save",
        "if-match": String(frozen.ifMatch),
      },
      body: JSON.stringify({ content: { text: formatted } }),
    });
    expect(replay.status).toBe(201);
    expect((await replay.json()) as { revisionId: string }).toMatchObject({ revisionId: created.revisionId });

    const historyResponse = await fetch(`${base}/api/v1/projects/${project.id}/stories`);
    expect(historyResponse.status).toBe(200);
    const history = (await historyResponse.json()) as {
      items: Array<{ id: string; content: { text?: string }; reviewStatus: string }>;
    };
    expect(history.items[0]).toMatchObject({
      id: created.revisionId,
      content: { text: formatted },
      reviewStatus: "DRAFT",
    });
    expect(history.items[0]?.reviewStatus).not.toBe("APPROVED");
  });
});
