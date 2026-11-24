import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  COMPOSE_JOB_SCHEMA,
  EPISODE_COMPOSE_JOB_SCHEMA,
  EPISODE_COMPOSE_OUTPUT_SCHEMA,
} from "@ai-drama/domain";
import { AdminOpsStore } from "./admin-ops-store";

if (!process.env.DATABASE_URL) throw new Error("An isolated integration DATABASE_URL is required");
const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const store = new AdminOpsStore(db);
const ws = randomUUID(),
  work = randomUUID(),
  episode1 = randomUUID(),
  episode2 = randomUUID(),
  shot = randomUUID(),
  shot2 = randomUUID(),
  revision = randomUUID(),
  revision2 = randomUUID();

beforeAll(async () => {
  // Session-local projection fixtures: no migrations or application data are needed.
  await db.query(`SET search_path TO pg_temp;
    CREATE TEMP TABLE project (id uuid, workspace_id uuid, title text, episode_count int, status text DEFAULT 'ACTIVE', archived_at timestamptz, updated_at timestamptz DEFAULT now());
    CREATE TEMP TABLE episode (id uuid, workspace_id uuid, project_id uuid, episode_no int);
    CREATE TEMP TABLE shot (id uuid, workspace_id uuid, episode_id uuid);
    CREATE TEMP TABLE shot_revision (id uuid, workspace_id uuid, shot_id uuid, ordinal int);
    CREATE TEMP TABLE generation_job (id uuid, workspace_id uuid, project_id uuid, kind text, state text DEFAULT 'SUCCEEDED', input_snapshot jsonb, source_shot_revision_id uuid, updated_at timestamptz DEFAULT now(), error_code text);
    CREATE TEMP TABLE asset (id uuid PRIMARY KEY, workspace_id uuid, project_id uuid, kind text, storage_provider text DEFAULT 'local-compose', mime_type text DEFAULT 'video/mp4', created_at timestamptz DEFAULT now(), source_shot_revision_id uuid, source_generation_job_id uuid, metadata_json jsonb, status text DEFAULT 'ACTIVE', review_status text DEFAULT 'DRAFT', source_kind text DEFAULT 'LOCAL_JOB');`);
  await db.query(
    "INSERT INTO project(id,workspace_id,title,episode_count) VALUES($1,$2,'末班车',2)",
    [work, ws],
  );
  await db.query("INSERT INTO episode VALUES($1,$2,$3,1),($4,$2,$3,2)", [
    episode1,
    ws,
    work,
    episode2,
  ]);
  await db.query("INSERT INTO shot VALUES($1,$2,$3),($4,$2,$5)", [
    shot,
    ws,
    episode1,
    shot2,
    episode2,
  ]);
  await db.query("INSERT INTO shot_revision VALUES($1,$2,$3,3),($4,$2,$5,1)", [
    revision,
    ws,
    shot,
    revision2,
    shot2,
  ]);
});
afterAll(() => db.end());

async function job(kind: string, snapshot: unknown, source: string | null = null) {
  const id = randomUUID();
  await db.query(
    "INSERT INTO generation_job(id,workspace_id,project_id,kind,input_snapshot,source_shot_revision_id) VALUES($1,$2,$3,$4,$5,$6)",
    [id, ws, work, kind, JSON.stringify(snapshot), source],
  );
  return id;
}

async function composite(jobId: string, meta: unknown, source: string | null = null) {
  const id = randomUUID();
  await db.query(
    "INSERT INTO asset(id,workspace_id,project_id,kind,metadata_json,source_generation_job_id,source_shot_revision_id) VALUES($1,$2,$3,'COMPOSITE',$4,$5,$6)",
    [id, ws, work, JSON.stringify(meta), jobId, source],
  );
  return id;
}

it("requires real episode composites for every planned episode and labels demo shot and episode assets and jobs", async () => {
  const makeShot = async (storageProvider: string, shotRevision = revision) =>
    composite(
      await job(
        "MEDIA_COMPOSE",
        {
          schema: COMPOSE_JOB_SCHEMA,
          input: { sourceObjects: [{ storageProvider }] },
        },
        shotRevision,
      ),
      {},
      shotRevision,
    );
  const episode = async (episodeId: string, sources: string[]) =>
    composite(
      await job("MEDIA_COMPOSE", {
        schema: EPISODE_COMPOSE_JOB_SCHEMA,
        input: { episodeId, sourceObjects: sources.map((assetId) => ({ assetId })) },
      }),
      { schema: EPISODE_COMPOSE_OUTPUT_SCHEMA, episodeId },
    );
  const realShot = await makeShot("s3"),
    demoShot = await makeShot("mock-object-store");
  expect((await store.listWorks(ws, { status: "producing" })).total).toBe(1);
  expect(await store.getAsset(ws, demoShot)).toMatchObject({
    episodeNo: 1,
    shotOrdinal: 3,
    jobType: "shot_compose",
    isDemo: true,
  });
  const demoEpisode = await episode(episode1, [realShot, demoShot]);
  expect(await store.getAsset(ws, demoEpisode)).toMatchObject({
    episodeNo: 1,
    shotOrdinal: null,
    jobType: "episode_compose",
    isDemo: true,
  });
  expect((await store.getWork(ws, work))?.completedEpisodeCount).toBe(0);
  await episode(episode1, [realShot]);
  await episode(episode1, [realShot]);
  await episode(episode2, [randomUUID()]);
  await episode(episode2, [realShot, "malformed-legacy-asset-id"]);
  expect(await store.getWork(ws, work)).toMatchObject({
    completedEpisodeCount: 1,
    productionStatus: "producing",
  });
  await episode(episode2, [await makeShot("s3", revision2)]);
  expect((await store.listWorks(ws, { status: "finished" })).items[0]).toMatchObject({
    completedEpisodeCount: 2,
    productionStatus: "finished",
  });
  expect(
    (await store.listJobs(ws, { type: "episode_compose" })).items.some(
      (row) => row.isDemo && row.episodeNo === 1,
    ),
  ).toBe(true);
  expect(
    (await store.listAssets(ws, { type: "video" })).items.find((row) => row.id === demoEpisode),
  ).toEqual(await store.getAsset(ws, demoEpisode));
});

it("uses real task kinds and capabilities for labels, filters and demo flags", async () => {
  for (const [kind, type] of [
    ["MOCK_TEXT_SCENES", "scene"],
    ["MOCK_TEXT_SHOTS", "shot"],
    ["MEDIA_TTS", "voice"],
    ["MEDIA_IMAGE", "image"],
    ["MEDIA_VIDEO", "video"],
    ["MEDIA_SUBTITLE", "subtitle"],
    ["MEDIA_MUSIC", "music"],
  ] as const) {
    const id = await job(kind, { schema: "m3.mock.test.v1" });
    expect(await store.getJob(ws, id)).toMatchObject({ jobType: type, isDemo: true });
    expect((await store.listJobs(ws, { type })).items.some((row) => row.id === id)).toBe(true);
  }
  const id = await job("CAPABILITY_TASK", { schema: "real-media.v1", capability: "audio.tts" });
  expect(await store.getJob(ws, id)).toMatchObject({ jobType: "voice", isDemo: false });
});
