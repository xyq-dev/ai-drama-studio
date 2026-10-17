/**
 * Script breakdown replacement → media STALE → compose and export gates, over real HTTP, real PostgreSQL, a real Worker
 * process, real Redis, the existing Mock video and local FFmpeg compose. NOT part of `test` or `integration`: run only
 * with `pnpm --filter @ai-drama/api script-breakdown:media-acceptance` against a newly created, empty, disposable
 * database (the title writing acceptance guard and variables) and a loopback Redis named by
 * SCRIPT_BREAKDOWN_MEDIA_ACCEPTANCE_REDIS_URL.
 *
 * What is real: the Nest application with its real controllers and services on a local port; the PostgreSQL store,
 * text chain and media store; the built Worker (apps/worker/dist/main.js) started here as a child process, which runs
 * the queued Mock video jobs, the stale propagation and the FFmpeg compose. What is not: the model. The breakdown
 * service the controller uses is built here with a stub transport that answers from the script copy in the prompt and
 * never opens a network connection (the same double as script-breakdown.acceptance.spec.ts).
 *
 * Every state change goes through a business route. SQL here is read-only (counts, statuses, edges), apart from the
 * workspace row and the Mock provider rows the existing provisioning writes into the new database before the API starts.
 */
import "reflect-metadata";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ScriptBreakdownPlacementOutcome, ScriptBreakdownRunView } from "@ai-drama/contracts";
import {
  PostgresTitleWritingStore,
  SCRIPT_BREAKDOWN_MIGRATION,
  WRITING_CANDIDATE_DEEPSEEK_MIGRATION,
  WRITING_CANDIDATE_MIGRATION,
  WRITING_PROVIDER_MIGRATION,
  TextChainService,
  checkTitleWritingAcceptanceEnv,
  closePostgresPool,
  createPostgresPool,
  provisionMockAvProviders,
  runMigrations,
  verifyTitleWritingAcceptanceDatabase,
} from "@ai-drama/database";
import { TitleWritingEngine, titleWritingProviderConfigs, type WritingTransport } from "@ai-drama/providers";
import { breakdownPromptParts, messagesAnswer, fixtureBreakdownFromPrompt } from "@ai-drama/providers/title-writing-fixtures";
import { AppModule } from "../app.module";
import { loadApiEnv } from "../config/env";
import { SafeExceptionFilter } from "../http/safe-exception.filter";
import { ScriptBreakdownService } from "./script-breakdown.service";
import type { StudioRuntime } from "./studio.runtime";
import { SCRIPT_BREAKDOWN_SERVICE, STUDIO_RUNTIME } from "./tokens";

const decision = checkTitleWritingAcceptanceEnv(process.env);
if (!decision.ok) throw new Error(`Script breakdown media acceptance refused: ${decision.reason}`);
const acceptanceUrl = decision.url;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
if (!LOOPBACK.has(new URL(acceptanceUrl).hostname)) throw new Error("Script breakdown media acceptance refused: the database is not on loopback.");
const redisUrl = process.env.SCRIPT_BREAKDOWN_MEDIA_ACCEPTANCE_REDIS_URL ?? "";
if (!/^redis:\/\//.test(redisUrl) || !LOOPBACK.has(new URL(redisUrl).hostname)) {
  throw new Error("Script breakdown media acceptance refused: SCRIPT_BREAKDOWN_MEDIA_ACCEPTANCE_REDIS_URL must be a loopback redis:// URL.");
}

const REPO = resolve(__dirname, "../../../..");
const WORKSPACE = randomUUID();
const OPERATOR_TOKEN = `acceptance-${randomUUID()}`;
const STUB_KEY = `sk-ant-api03-stub-not-a-provider-key-${randomUUID()}`;
const STUB_MODEL = "claude-acceptance-stub";
const WORKER_PORT = "3112";
const POLL_MS = 500;

const pool = createPostgresPool({ connectionString: acceptanceUrl, connectionTimeoutMs: 2_000, statementTimeoutMs: 10_000, queryTimeoutMs: 10_000 });
async function q<T>(sql: string, values: unknown[] = []): Promise<T[]> {
  return (await pool.query(sql, values) as { rows: T[] }).rows;
}
/** Read-only: every statement after setup is a SELECT. */
async function read<T>(sql: string, values: unknown[] = []): Promise<T[]> {
  if (!/^\s*(select|with)\b/i.test(sql)) throw new Error("acceptance SQL after setup is read-only");
  return q<T>(sql, values);
}

const evidence: Record<string, unknown> = {};
const exchanges: Array<{ method: string; path: string; status: number; code: string | null }> = [];

// Model double: answers each breakdown prompt from the script copy inside it.
const sent: Array<{ episodeNo: number; keyMatches: boolean; endpoint: string }> = [];
const transport: WritingTransport = async (request) => {
  const body = JSON.parse(request.body) as { messages?: Array<{ role: string; content: string }>; input?: string };
  // Claude carries the prompt in messages, OpenAI in input.
  const user = body.messages?.find((message) => message.role === "user")?.content ?? body.input ?? "";
  const parts = breakdownPromptParts(user);
  const headers = request.headers as Record<string, string>;
  const endpoint = new URL(request.url);
  sent.push({ episodeNo: parts.episodeNo, keyMatches: (headers["x-api-key"] === STUB_KEY || (headers.Authorization ?? headers.authorization) === `Bearer ${STUB_KEY}`),
    endpoint: `${endpoint.host}${endpoint.pathname}` });
  return {
    status: 200,
    headers: { get: (name: string) => ["x-request-id", "request-id"].includes(name.toLowerCase()) ? `stub-${String(sent.length)}` : null },
    body: new TextEncoder().encode(JSON.stringify(messagesAnswer(fixtureBreakdownFromPrompt(user)))),
  };
};

function breakdownService(runtime: StudioRuntime): ScriptBreakdownService {
  const providers = titleWritingProviderConfigs({ ANTHROPIC_API_KEY: STUB_KEY, TITLE_WRITING_ANTHROPIC_MODELS: STUB_MODEL });
  const store = new PostgresTitleWritingStore(runtime.pool, new TextChainService(runtime.pool));
  return new ScriptBreakdownService({
    workspaceId: WORKSPACE, nodeEnv: "test", enabled: true, operatorToken: OPERATOR_TOKEN, defaultProvider: "anthropic", providers, store,
    engine: new TitleWritingEngine({ workspaceId: WORKSPACE, store, providers, transport, maxCallsPerDay: 50, timeoutMs: 1_500 }),
    projects: runtime.store, maxCallsPerDay: 50, maxActiveRuns: 10,
  });
}

interface Dirs { root: string; mock: string; composeWork: string; composeObjects: string; evidence: string | null }
let dirs: Dirs;
let app: INestApplication;
let base: string;
let worker: ChildProcess | null = null;
let workerExit: { code: number | null; signal: string | null } | null = null;

function mediaEnv(): Record<string, string> {
  return {
    M3_MOCK_AV_ENABLED: "true", MOCK_OBJECT_DIR: dirs.mock,
    M4_LOCAL_COMPOSE_ENABLED: "true", M4_LOCAL_EPISODE_COMPOSE_ENABLED: "true",
    M4_COMPOSE_WORK_DIR: dirs.composeWork, M4_COMPOSE_OBJECT_DIR: dirs.composeObjects,
  };
}

async function bootApi(): Promise<void> {
  const env = loadApiEnv({
    NODE_ENV: "test", DATABASE_URL: acceptanceUrl, REDIS_URL: redisUrl, S3_ENDPOINT: "http://127.0.0.1:59000",
    S3_REGION: "us-east-1", S3_BUCKET: "ai-drama-dev", S3_ACCESS_KEY_ID: "test", S3_SECRET_ACCESS_KEY: "test", APP_WORKSPACE_ID: WORKSPACE,
    ...mediaEnv(),
  });
  expect(env.TITLE_WRITING_ENABLED).toBe(false);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule.register(env)] })
    .overrideProvider(SCRIPT_BREAKDOWN_SERVICE)
    .useFactory({ inject: [STUDIO_RUNTIME], factory: (runtime: StudioRuntime) => breakdownService(runtime) })
    .compile();
  app = moduleRef.createNestApplication();
  app.setGlobalPrefix("api/v1");
  app.useGlobalFilters(new SafeExceptionFilter());
  await app.init();
  await app.listen(0, "127.0.0.1");
  base = await app.getUrl();
}

/** The built Worker, as `pnpm --filter @ai-drama/worker start` runs it, with only the variables it needs. */
async function startWorker(): Promise<void> {
  const inherited: Record<string, string> = {};
  for (const name of ["PATH", "Path", "HOME", "USERPROFILE", "SYSTEMROOT", "SystemRoot", "TEMP", "TMP", "TMPDIR", "LANG"]) {
    const value = process.env[name];
    if (value !== undefined) inherited[name] = value;
  }
  const child = spawn(process.execPath, [join(REPO, "apps/worker/dist/main.js")], {
    cwd: REPO,
    env: { ...inherited, NODE_ENV: "development", BIND_HOST: "127.0.0.1", WORKER_HEALTH_PORT: WORKER_PORT, DATABASE_URL: acceptanceUrl,
      REDIS_URL: redisUrl, HEALTH_CHECK_TIMEOUT_MS: "2000", M4_COMPOSE_PYTHON: process.platform === "win32" ? "python" : "python3", ...mediaEnv() },
    stdio: ["ignore", "pipe", "pipe"],
  });
  worker = child;
  const log: string[] = [];
  const keep = (chunk: Buffer) => { log.push(chunk.toString("utf8")); if (log.length > 400) log.shift(); };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  child.once("exit", (code, signal) => { workerExit = { code, signal }; });
  evidence.workerLogTail = log;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (workerExit) throw new Error(`worker exited before ready: ${JSON.stringify(workerExit)}\n${log.join("").slice(-2000)}`);
    try {
      const response = await fetch(`http://127.0.0.1:${WORKER_PORT}/health/ready`, { signal: AbortSignal.timeout(2_000) });
      const body = await response.json() as { status?: string; dependencies?: Record<string, { status?: string }> };
      if (response.status === 200 && body.dependencies?.postgres?.status === "ok" && body.dependencies.queue?.status === "ok") {
        evidence.workerReady = body;
        return;
      }
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`worker did not become ready\n${log.join("").slice(-2000)}`);
    await sleep(POLL_MS);
  }
}

async function stopWorker(): Promise<void> {
  const child = worker;
  if (!child || workerExit) return;
  child.kill("SIGTERM");
  const deadline = Date.now() + 15_000;
  while (!workerExit && Date.now() < deadline) await sleep(200);
  if (!workerExit) child.kill("SIGKILL");
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

async function http(method: "GET" | "POST", path: string, options: { body?: unknown; headers?: Record<string, string> } = {}) {
  const response = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: { accept: "application/json", ...(options.body !== undefined ? { "content-type": "application/json" } : {}), ...options.headers },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  let body: Json;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 200) }; }
  exchanges.push({ method, path: path.split("?")[0]!, status: response.status, code: body?.error?.code ?? null });
  return { status: response.status, body };
}

async function bytes(path: string): Promise<{ status: number; body: Buffer; code: string | null; type: string | null }> {
  const response = await fetch(`${base}/api/v1${path}`);
  const body = Buffer.from(await response.arrayBuffer());
  let code: string | null = null;
  if (response.status !== 200) {
    try { code = (JSON.parse(body.toString("utf8")) as { error?: { code?: string } }).error?.code ?? null; } catch { code = null; }
  }
  exchanges.push({ method: "GET", path: path.split("?")[0]!, status: response.status, code });
  return { status: response.status, body, code, type: response.headers.get("content-type") };
}

const key = () => ({ "idempotency-key": randomUUID() });
const operator = () => ({ "x-operator-token": OPERATOR_TOKEN, "idempotency-key": randomUUID() });
const sha256 = (value: Buffer) => createHash("sha256").update(value).digest("hex");

function ok(result: { status: number; body: Json }, status: number) {
  expect(result.status, JSON.stringify(result.body)).toBe(status);
  return result.body;
}

/** A refusal must be the named business error: never a 5xx, an auth refusal or a switched-off feature. */
function refused(result: { status: number; body: Json }, status: number, code: string) {
  expect([result.status, result.body?.error?.code], JSON.stringify(result.body)).toEqual([status, code]);
  return { status: result.status, code };
}

async function review(path: string, ifMatch: number, expectedReviewVersion: number, to: "IN_REVIEW" | "APPROVED") {
  return ok(await http("POST", path, { body: { to, expectedReviewVersion }, headers: { ...key(), "if-match": String(ifMatch) } }), 200) as
    { reviewVersion: number; rowVersion: number };
}

async function approveRevision(path: string, rowVersion: number, reviewVersion: number) {
  const inReview = await review(path, rowVersion, reviewVersion, "IN_REVIEW");
  return review(path, inReview.rowVersion, inReview.reviewVersion, "APPROVED");
}

async function episodesOf(projectId: string) {
  return ok(await http("GET", `/projects/${projectId}/episodes`), 200).items as Array<{ id: string; episodeNo: number; rowVersion: number }>;
}

function scriptOf(episodeNo: number, marker: string): string {
  return [`第 ${String(episodeNo)} 集`, `标记：${marker}`, `场 1 地点${String(episodeNo)} 夜`, `林夏在第 ${String(episodeNo)} 集停下。`,
    `林夏：第 ${String(episodeNo)} 集的一句。`].join("\n");
}

/** Project with two planned episodes, an approved story, and an approved `{ text }` script per episode. */
async function work() {
  const created = ok(await http("POST", "/projects", { body: { title: "拆解媒体验收", premise: "", episodeCount: 2, targetEpisodeSeconds: 60 },
    headers: key() }), 201);
  const projectId = String(created.id);
  const story = ok(await http("POST", `/projects/${projectId}/stories`, { body: { content: { text: "故事" } },
    headers: { ...key(), "if-match": String(created.version) } }), 201);
  await approveRevision(`/projects/${projectId}/stories/${String(story.revisionId)}/review`, story.rowVersion, 1);
  const scripts: Record<number, string> = {};
  for (const episode of await episodesOf(projectId)) {
    const script = ok(await http("POST", `/projects/${projectId}/episodes/${episode.id}/scripts`, {
      body: { sourceStoryRevisionId: story.revisionId, content: { text: scriptOf(episode.episodeNo, `media-${String(episode.episodeNo)}`) } },
      headers: { ...key(), "if-match": String(episode.rowVersion) } }), 201);
    await approveRevision(`/projects/${projectId}/episodes/${episode.id}/scripts/${String(script.revisionId)}/review`, script.rowVersion, 1);
    scripts[episode.episodeNo] = String(script.revisionId);
  }
  const episodes = await episodesOf(projectId);
  return { projectId, episodes, scripts };
}

interface ShotMedia { sceneId: string; shotId: string; revisionId: string; videoId: string }
interface Composite { assetId: string; checksum: string; jobId: string; inputHash: string }

const scenePath = (projectId: string, episodeId: string, sceneId: string) => `/projects/${projectId}/episodes/${episodeId}/scenes/${sceneId}`;

async function sceneAggregate(projectId: string, episodeId: string, sceneId: string) {
  return ok(await http("GET", `${scenePath(projectId, episodeId, sceneId)}/revisions`), 200) as
    { aggregate: { rowVersion: number; currentRevisionId: string; approvedRevisionId: string | null }; items: Json[] };
}

/** A person's scene with two approved shots, written through the editor routes (the scenes R2 will replace). */
async function personScene(projectId: string, episodeId: string, scriptRevisionId: string): Promise<{ sceneId: string; shots: string[][] }> {
  const episode = (await episodesOf(projectId)).find((item) => item.id === episodeId)!;
  const scene = ok(await http("POST", `/projects/${projectId}/episodes/${episodeId}/scenes`, {
    body: { sourceScriptRevisionId: scriptRevisionId, ordinal: 1, heading: "INT. 旧场景", summary: "人工写的旧场景" },
    headers: { ...key(), "if-match": String(episode.rowVersion) } }), 201);
  const sceneId = String(scene.entityId);
  await approveRevision(`${scenePath(projectId, episodeId, sceneId)}/revisions/${String(scene.revisionId)}/review`, scene.rowVersion, 1);
  const shots: string[][] = [];
  for (const ordinal of [1, 2]) {
    const aggregate = await sceneAggregate(projectId, episodeId, sceneId);
    const shot = ok(await http("POST", `${scenePath(projectId, episodeId, sceneId)}/shots`, {
      body: { sourceSceneRevisionId: String(scene.revisionId), ordinal, shotType: "wide", camera: "static", action: `旧镜头 ${String(ordinal)}`,
        promptText: "fixed black frame for audit", dialogue: "fixed silence for audit" },
      headers: { ...key(), "if-match": String(aggregate.aggregate.rowVersion) } }), 201);
    await approveRevision(`${scenePath(projectId, episodeId, sceneId)}/shots/${String(shot.entityId)}/revisions/${String(shot.revisionId)}/review`,
      shot.rowVersion, 1);
    shots.push([String(shot.entityId), String(shot.revisionId)]);
  }
  return { sceneId, shots };
}

async function pollJob(jobId: string, timeoutMs = 180_000): Promise<Json> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = ok(await http("GET", `/generation-jobs/${jobId}`), 200);
    if (["SUCCEEDED", "FAILED", "CANCELED"].includes(String(job.state))) return job;
    if (workerExit) throw new Error(`worker exited while job ${jobId} was ${String(job.state)}: ${JSON.stringify(workerExit)}`);
    if (Date.now() > deadline) throw new Error(`job ${jobId} stayed ${String(job.state)}`);
    await sleep(POLL_MS);
  }
}

async function shotAssets(revisionId: string) {
  return ok(await http("GET", `/shot-revisions/${revisionId}/assets`), 200).items as
    Array<{ id: string; kind: string; status: string; reviewStatus: string; checksumSha256: string; rowVersion: number; sourceGenerationJobId: string | null }>;
}

async function video(revisionId: string): Promise<string> {
  const accepted = ok(await http("POST", `/shot-revisions/${revisionId}/generate-video`, { body: { seed: `r2-media-${revisionId}` }, headers: key() }), 202);
  const done = await pollJob(String(accepted.jobId), 90_000);
  expect([done.state, done.errorCode ?? null]).toEqual(["SUCCEEDED", null]);
  const asset = (await shotAssets(revisionId)).find((item) => item.kind === "VIDEO" && item.sourceGenerationJobId === accepted.jobId);
  expect(asset, "video asset").toBeTruthy();
  return asset!.id;
}

async function approveComposite(assetId: string, rowVersion: number, checksum: string) {
  return ok(await http("POST", `/assets/${assetId}/review`, { body: { decision: "APPROVE", note: "r2 media acceptance", contentHash: checksum },
    headers: { ...key(), "if-match": String(rowVersion) } }), 200);
}

async function shotComposite(revisionId: string, videoId: string): Promise<Composite> {
  const preflight = ok(await http("POST", `/shot-revisions/${revisionId}/compose-preflight`, { body: { videoAssetId: videoId } }), 200);
  const accepted = ok(await http("POST", `/shot-revisions/${revisionId}/compose`, {
    body: { videoAssetId: videoId, expectedInputHash: preflight.inputHash }, headers: key() }), 202);
  const done = await pollJob(String(accepted.jobId));
  expect([done.state, done.errorCode ?? null]).toEqual(["SUCCEEDED", null]);
  const asset = (await shotAssets(revisionId)).find((item) => item.kind === "COMPOSITE" && item.sourceGenerationJobId === accepted.jobId)!;
  expect(asset).toMatchObject({ status: "ACTIVE", reviewStatus: "DRAFT" });
  await approveComposite(asset.id, asset.rowVersion, asset.checksumSha256);
  return { assetId: asset.id, checksum: asset.checksumSha256, jobId: String(accepted.jobId), inputHash: String(preflight.inputHash) };
}

async function episodeComposites(projectId: string, episodeId: string) {
  return ok(await http("GET", `/projects/${projectId}/episodes/${episodeId}/composites?limit=50`), 200).items as
    Array<{ assetId: string; status: string; reviewStatus: string; rowVersion: number; checksumSha256: string; sourceGenerationJobId: string | null;
      segments: Array<{ position: number; assetId: string; shotId: string }> }>;
}

async function episodeComposite(projectId: string, episodeId: string, ids: string[]): Promise<Composite> {
  const preflight = ok(await http("POST", `/projects/${projectId}/episodes/${episodeId}/compose-preflight`, { body: { compositeAssetIds: ids } }), 200);
  const accepted = ok(await http("POST", `/projects/${projectId}/episodes/${episodeId}/compose`, {
    body: { compositeAssetIds: ids, expectedInputHash: preflight.inputHash }, headers: key() }), 202);
  const done = await pollJob(String(accepted.jobId));
  expect([done.state, done.errorCode ?? null]).toEqual(["SUCCEEDED", null]);
  const item = (await episodeComposites(projectId, episodeId)).find((entry) => entry.sourceGenerationJobId === accepted.jobId)!;
  expect(item).toMatchObject({ status: "ACTIVE", reviewStatus: "DRAFT" });
  expect(item.segments.map((segment) => segment.assetId)).toEqual(ids);
  await approveComposite(item.assetId, item.rowVersion, item.checksumSha256);
  return { assetId: item.assetId, checksum: item.checksumSha256, jobId: String(accepted.jobId), inputHash: String(preflight.inputHash) };
}

const downloadPath = (projectId: string, episodeId: string, assetId: string, hash: string) =>
  `/projects/${projectId}/episodes/${episodeId}/composites/${assetId}/download?expectedContentHash=${hash}`;
const manifestPath = (projectId: string, episodeId: string, assetId: string, hash: string) =>
  `/projects/${projectId}/episodes/${episodeId}/composites/${assetId}/export-manifest?expectedContentHash=${hash}`;

/** Formal export of an approved episode composite: bytes, hash, manifest, and the manifest against the stored edges. */
async function exported(projectId: string, episodeId: string, composite: Composite, shots: Composite[], name: string) {
  const mp4 = await bytes(downloadPath(projectId, episodeId, composite.assetId, composite.checksum));
  expect([mp4.status, mp4.type]).toEqual([200, "video/mp4"]);
  expect(sha256(mp4.body)).toBe(composite.checksum);
  const manifestRead = await bytes(manifestPath(projectId, episodeId, composite.assetId, composite.checksum));
  expect(manifestRead.status).toBe(200);
  const manifest = JSON.parse(manifestRead.body.toString("utf8")) as Json;
  expect(manifest).toMatchObject({ schema: "m4.episode.export.manifest.v1", asset: { checksumSha256: composite.checksum, byteSize: mp4.body.length },
    compose: { jobId: composite.jobId, preflightInputHash: composite.inputHash } });
  expect((manifest.segments as Array<{ shotAssetId: string }>).map((segment) => segment.shotAssetId)).toEqual(shots.map((shot) => shot.assetId));
  const edges = await read<{ source: string }>(
    "SELECT source_asset_id::text AS source FROM asset_dependency WHERE dependent_asset_id = $1 ORDER BY source_asset_id", [composite.assetId]);
  expect(edges.map((edge) => edge.source)).toEqual(shots.map((shot) => shot.assetId).sort());
  if (dirs.evidence) {
    await writeFile(join(dirs.evidence, `${name}.mp4`), mp4.body);
    await writeFile(join(dirs.evidence, `${name}.manifest.json`), manifestRead.body);
  }
  return { bytes: mp4.body.length, sha256: sha256(mp4.body), manifestSha256: sha256(manifestRead.body), segments: manifest.segments.length };
}

/** Rows that a refused submit must not add: jobs, attempts, workflow runs, outbox rows, costs, assets, model calls. */
async function ledger(projectId: string) {
  const [row] = await read<Record<string, number>>(
    `SELECT (SELECT count(*)::int FROM generation_job WHERE project_id = $1) AS generation_job,
            (SELECT count(*)::int FROM job_attempt attempt JOIN generation_job job ON job.id = attempt.generation_job_id WHERE job.project_id = $1) AS job_attempt,
            (SELECT count(*)::int FROM workflow_run WHERE project_id = $1) AS workflow_run,
            (SELECT count(*)::int FROM dispatch_outbox WHERE workspace_id = $2) AS dispatch_outbox,
            (SELECT count(*)::int FROM cost_ledger WHERE project_id = $1) AS cost_ledger,
            (SELECT count(*)::int FROM asset WHERE project_id = $1) AS asset,
            (SELECT count(*)::int FROM title_writing_call call JOIN title_writing_run run ON run.id = call.run_id WHERE run.project_id = $1) AS model_call`,
    [projectId, WORKSPACE]);
  return row!;
}

async function assetStates(ids: string[]) {
  const rows = await read<{ id: string; status: string; review_status: string; source_shot_revision_id: string | null }>(
    "SELECT id::text AS id, status, review_status, source_shot_revision_id::text AS source_shot_revision_id FROM asset WHERE id = ANY($1::uuid[])", [ids]);
  return Object.fromEntries(ids.map((id) => {
    const row = rows.find((item) => item.id === id)!;
    return [id, { status: row.status, reviewStatus: row.review_status, sourceShotRevisionId: row.source_shot_revision_id }];
  }));
}

async function dependencyEdges(ids: string[]) {
  return read<{ source: string; dependent: string }>(
    `SELECT source_asset_id::text AS source, dependent_asset_id::text AS dependent FROM asset_dependency
      WHERE dependent_asset_id = ANY($1::uuid[]) ORDER BY dependent_asset_id, source_asset_id`, [ids]);
}

async function propagationSettled(projectId: string) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const [pending] = await read<{ n: number }>(
      "SELECT count(*)::int AS n FROM stale_recalculation WHERE project_id = $1 AND status IN ('PENDING', 'RUNNING')", [projectId]);
    if (pending!.n === 0) return;
    if (Date.now() > deadline) throw new Error("stale propagation did not finish");
    await sleep(POLL_MS);
  }
}

const breakdownBase = (projectId: string, episodeId: string) => `/projects/${projectId}/episodes/${episodeId}/script-breakdowns`;

async function settled(projectId: string, episodeId: string): Promise<ScriptBreakdownRunView> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const run = ok(await http("GET", `${breakdownBase(projectId, episodeId)}/latest`), 200).run as ScriptBreakdownRunView | null;
    if (run && run.state !== "running") return run;
    if (Date.now() > deadline) throw new Error(`breakdown did not settle: ${JSON.stringify(run?.state)}`);
    await sleep(100);
  }
}

async function liveScenes(projectId: string, episodeId: string) {
  return ok(await http("GET", `/projects/${projectId}/episodes/${episodeId}/scenes`), 200).items as
    Array<{ entityId: string; rowVersion: number; currentRevisionId: string; currentRevision: { reviewVersion: number; reviewStatus: string; freshnessStatus: string } }>;
}

// Shared world, filled stage by stage. Each stage depends on the one before it.
interface World {
  projectId: string;
  target: { id: string; scriptId: string; sceneId: string; shots: ShotMedia[]; composites: Composite[]; episode: Composite; preflight: { shot: string; episode: string } };
  other: { id: string; scriptId: string; sceneId: string; shots: ShotMedia[]; composites: Composite[]; episode: Composite; preflightHash: string; exportSha: string };
  run?: ScriptBreakdownRunView;
  fresh?: { sceneId: string; shots: ShotMedia[]; composites: Composite[]; episode: Composite };
}
let world: World;

async function prepareEpisode(projectId: string, episodeId: string, scriptId: string) {
  const scene = await personScene(projectId, episodeId, scriptId);
  const shots: ShotMedia[] = [];
  for (const [shotId, revisionId] of scene.shots) shots.push({ sceneId: scene.sceneId, shotId: shotId!, revisionId: revisionId!, videoId: await video(revisionId!) });
  const composites: Composite[] = [];
  for (const shot of shots) composites.push(await shotComposite(shot.revisionId, shot.videoId));
  const episode = await episodeComposite(projectId, episodeId, composites.map((item) => item.assetId));
  return { sceneId: scene.sceneId, shots, composites, episode };
}

beforeAll(async () => {
  const verified = await verifyTitleWritingAcceptanceDatabase({ query: async (sql, values) => ({ rows: await q<Record<string, unknown>>(sql, values) }) },
    decision.databaseName);
  if (!verified.ok) {
    await closePostgresPool(pool);
    throw new Error(`Script breakdown media acceptance refused: ${verified.reason}`);
  }
  const root = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), "r2-media-acceptance-"));
  const evidenceRoot = process.env.TITLE_WRITING_ACCEPTANCE_EVIDENCE_DIR;
  dirs = { root, mock: join(root, "mock"), composeWork: join(root, "compose-work"), composeObjects: join(root, "compose-objects"),
    evidence: evidenceRoot ? join(evidenceRoot, "script-breakdown-media") : null };
  for (const dir of [dirs.mock, dirs.composeWork, dirs.composeObjects, dirs.evidence]) if (dir) await mkdir(dir, { recursive: true });
  const applied = (await runMigrations(pool)).applied;
  expect(applied.slice(-4)).toEqual([SCRIPT_BREAKDOWN_MIGRATION, WRITING_PROVIDER_MIGRATION, WRITING_CANDIDATE_MIGRATION, WRITING_CANDIDATE_DEEPSEEK_MIGRATION]);
  evidence.database = { name: decision.databaseName, migrationsApplied: applied };
  // Acceptance data in the new database: the workspace row and the existing Mock video/speech provider provisioning.
  await q("INSERT INTO workspace (id, name, status) VALUES ($1, 'r2-media-acceptance', 'ACTIVE')", [WORKSPACE]);
  evidence.mockProviders = await provisionMockAvProviders(pool, WORKSPACE);
  await startWorker();
  await bootApi();
}, 120_000);

afterAll(async () => {
  if (app) await app.close();
  await stopWorker();
  await closePostgresPool(pool);
  evidence.worker = { exit: workerExit };
  evidence.stub = { totalSends: sent.length, everyEndpoint: [...new Set(sent.map((item) => item.endpoint))], everyKeyWasTheStubKey: sent.every((item) => item.keyMatches) };
  evidence.httpExchanges = { total: exchanges.length, refusals: exchanges.filter((item) => item.status >= 400) };
  if (dirs?.evidence) await writeFile(join(dirs.evidence, "script-breakdown-media-acceptance.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}, 60_000);

describe("R2 replacement → media STALE → compose and export gates (real API, PostgreSQL, Worker, Mock video, FFmpeg)", () => {
  it("A. before replacement: shot and episode compose, approval and formal export work for both episodes", async () => {
    const { projectId, episodes, scripts } = await work();
    const [first, second] = [episodes.find((item) => item.episodeNo === 1)!, episodes.find((item) => item.episodeNo === 2)!];
    const target = await prepareEpisode(projectId, first.id, scripts[1]!);
    const other = await prepareEpisode(projectId, second.id, scripts[2]!);
    // The same requests the gates are checked with later succeed now: preflight is read-only and answers 200.
    const shotPreflight = ok(await http("POST", `/shot-revisions/${target.shots[0]!.revisionId}/compose-preflight`,
      { body: { videoAssetId: target.shots[0]!.videoId } }), 200);
    const episodePreflight = ok(await http("POST", `/projects/${projectId}/episodes/${first.id}/compose-preflight`,
      { body: { compositeAssetIds: target.composites.map((item) => item.assetId) } }), 200);
    const otherPreflight = ok(await http("POST", `/projects/${projectId}/episodes/${second.id}/compose-preflight`,
      { body: { compositeAssetIds: other.composites.map((item) => item.assetId) } }), 200);
    const targetExport = await exported(projectId, first.id, target.episode, target.composites, "before-episode-1");
    const otherExport = await exported(projectId, second.id, other.episode, other.composites, "before-episode-2");
    const ids = [...target.shots.map((item) => item.videoId), ...target.composites.map((item) => item.assetId), target.episode.assetId];
    const states = await assetStates(ids);
    expect(Object.values(states).map((item) => item.status)).toEqual(ids.map(() => "ACTIVE"));
    world = {
      projectId,
      target: { id: first.id, scriptId: scripts[1]!, ...target, preflight: { shot: String(shotPreflight.inputHash), episode: String(episodePreflight.inputHash) } },
      other: { id: second.id, scriptId: scripts[2]!, ...other, preflightHash: String(otherPreflight.inputHash), exportSha: otherExport.sha256 },
    };
    evidence.before = {
      projectId, episodes: { target: first.id, other: second.id },
      target: { videos: target.shots.map((item) => item.videoId), shotComposites: target.composites, episodeComposite: target.episode, export: targetExport,
        shotPreflight: 200, episodePreflight: 200 },
      other: { shotComposites: other.composites, episodeComposite: other.episode, export: otherExport, episodePreflight: 200 },
      assetStates: states,
    };
  });

  it("B. R2 replaces the scenes only with consent; old scene and shots are archived, not deleted; new scenes wait for a person", async () => {
    const { projectId, target } = world;
    const sendsBefore = sent.length;
    const without = refused(await http("POST", breakdownBase(projectId, target.id), { body: {}, headers: operator() }), 409, "SCRIPT_BREAKDOWN_EXISTING_SCENES");
    expect(sent.length).toBe(sendsBefore);
    const edgesBefore = await dependencyEdges([...target.composites.map((item) => item.assetId), target.episode.assetId]);
    const started = await http("POST", breakdownBase(projectId, target.id), { body: { replaceExisting: true }, headers: operator() });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const run = await settled(projectId, target.id);
    expect(run).toMatchObject({ state: "completed", save: "saved", replacedScenes: 1, scriptRevisionId: target.scriptId, callsUsed: 1 });
    expect(sent.length - sendsBefore).toBe(1);
    world.run = run;
    // Old scene and shots: archived, history kept and readable through the history routes.
    const [scene] = await read<{ archived: boolean; revisions: number }>(
      `SELECT archived_at IS NOT NULL AS archived, (SELECT count(*)::int FROM scene_revision WHERE scene_id = scene.id) AS revisions FROM scene WHERE id = $1`,
      [target.sceneId]);
    expect(scene).toEqual({ archived: true, revisions: 1 });
    const shots = await read<{ id: string; archived: boolean; revisions: number }>(
      `SELECT id::text AS id, archived_at IS NOT NULL AS archived, (SELECT count(*)::int FROM shot_revision WHERE shot_id = shot.id) AS revisions
         FROM shot WHERE id = ANY($1::uuid[]) ORDER BY id`, [target.shots.map((item) => item.shotId)]);
    expect(shots.map((item) => [item.archived, item.revisions])).toEqual([[true, 1], [true, 1]]);
    const sceneHistory = await sceneAggregate(projectId, target.id, target.sceneId);
    expect(sceneHistory.items.map((item: { id: string }) => item.id)).toHaveLength(1);
    const shotHistory = ok(await http("GET", `${scenePath(projectId, target.id, target.sceneId)}/shots/${target.shots[0]!.shotId}/revisions`), 200);
    expect(shotHistory.items[0]).toMatchObject({ id: target.shots[0]!.revisionId });
    // New scenes are drafts; the live list shows only them.
    const live = await liveScenes(projectId, target.id);
    expect(live.map((item) => item.entityId)).toEqual(run.scenes.map((item) => item.sceneId));
    expect(live.map((item) => item.entityId)).not.toContain(target.sceneId);
    expect(live.map((item) => item.currentRevision.reviewStatus)).toEqual(live.map(() => "DRAFT"));
    await propagationSettled(projectId);
    const edgesAfter = await dependencyEdges([...target.composites.map((item) => item.assetId), target.episode.assetId]);
    expect(edgesAfter).toEqual(edgesBefore);
    evidence.replacement = {
      withoutConsent: without, runId: run.runId, state: run.state, save: run.save, replacedScenes: run.replacedScenes, callsUsed: run.callsUsed,
      oldScene: { id: target.sceneId, archived: true, revisionsKept: 1, historyRoute: 200 },
      oldShots: shots, newScenes: live.map((item) => ({ id: item.entityId, reviewStatus: item.currentRevision.reviewStatus })),
      dependencyEdgesUnchanged: edgesAfter.length,
    };
  });

  it("C. the old sources are STALE and refused for compose and formal export, with nothing new recorded; history stays readable", async () => {
    const { projectId, target } = world;
    const videos = target.shots.map((item) => item.videoId);
    const shotComposites = target.composites.map((item) => item.assetId);
    const states = await assetStates([...videos, ...shotComposites, target.episode.assetId]);
    for (const id of [...videos, ...shotComposites, target.episode.assetId]) expect(states[id]!.status, id).toBe("STALE");
    for (const id of [...shotComposites, target.episode.assetId]) expect(states[id]!.reviewStatus, id).toBe("APPROVED");
    for (const [index, shot] of target.shots.entries()) {
      expect(states[shot.videoId]!.sourceShotRevisionId).toBe(shot.revisionId);
      expect(states[shotComposites[index]!]!.sourceShotRevisionId).toBe(shot.revisionId);
    }
    // Through the business reads: the shot revision is STALE, its assets and the episode composite are listed as STALE.
    const shotHistory = ok(await http("GET", `${scenePath(projectId, target.id, target.sceneId)}/shots/${target.shots[0]!.shotId}/revisions`), 200);
    expect(shotHistory.items[0].freshnessStatus).toBe("STALE");
    const listedAssets = await shotAssets(target.shots[0]!.revisionId);
    expect(listedAssets.filter((item) => item.kind === "VIDEO" || item.kind === "COMPOSITE").map((item) => item.status)).toEqual(["STALE", "STALE"]);
    const listedEpisode = (await episodeComposites(projectId, target.id)).find((item) => item.assetId === target.episode.assetId)!;
    expect([listedEpisode.status, listedEpisode.reviewStatus]).toEqual(["STALE", "APPROVED"]);

    const before = await ledger(projectId);
    const shot = target.shots[0]!;
    const gates = {
      generateVideoOldShot: refused(await http("POST", `/shot-revisions/${shot.revisionId}/generate-video`, { body: { seed: "after-r2" }, headers: key() }),
        400, "REVIEW_REQUIRED"),
      shotPreflight: refused(await http("POST", `/shot-revisions/${shot.revisionId}/compose-preflight`, { body: { videoAssetId: shot.videoId } }),
        400, "REVIEW_REQUIRED"),
      shotSubmit: refused(await http("POST", `/shot-revisions/${shot.revisionId}/compose`, {
        body: { videoAssetId: shot.videoId, expectedInputHash: target.preflight.shot }, headers: key() }), 400, "REVIEW_REQUIRED"),
      episodePreflight: refused(await http("POST", `/projects/${projectId}/episodes/${target.id}/compose-preflight`,
        { body: { compositeAssetIds: shotComposites } }), 400, "REVIEW_REQUIRED"),
      episodeSubmit: refused(await http("POST", `/projects/${projectId}/episodes/${target.id}/compose`, {
        body: { compositeAssetIds: shotComposites, expectedInputHash: target.preflight.episode }, headers: key() }), 400, "REVIEW_REQUIRED"),
    };
    const download = await bytes(downloadPath(projectId, target.id, target.episode.assetId, target.episode.checksum));
    const manifest = await bytes(manifestPath(projectId, target.id, target.episode.assetId, target.episode.checksum));
    expect([download.status, download.code]).toEqual([400, "COMPOSE_INPUT_INVALID"]);
    expect([manifest.status, manifest.code]).toEqual([400, "COMPOSE_INPUT_INVALID"]);
    const after = await ledger(projectId);
    expect(after).toEqual(before);
    // Read-only history: the stored file is still served by the asset content route (STALE is not DELETED/FAILED).
    const history = await bytes(`/assets/${target.episode.assetId}/content`);
    expect([history.status, sha256(history.body)]).toEqual([200, target.episode.checksum]);
    const unchanged = await assetStates([target.episode.assetId]);
    expect(unchanged[target.episode.assetId]).toMatchObject({ status: "STALE", reviewStatus: "APPROVED" });
    evidence.afterReplacement = {
      assetStates: states,
      gates: { ...gates, episodeDownload: { status: download.status, code: download.code }, episodeManifest: { status: manifest.status, code: manifest.code } },
      ledgerBefore: before, ledgerAfter: after,
      historicalContent: { route: "/assets/:id/content", status: history.status, sha256: sha256(history.body) },
    };
  });

  it("D. the new scenes, after a person approves them, give shots, media, compose and a formal export; old composites cannot be mixed in", async () => {
    const { projectId, target } = world;
    const run = world.run!;
    const sceneId = run.scenes[0]!.sceneId;
    const runPath = `${breakdownBase(projectId, target.id)}/${run.runId}/shots`;
    const early = ok(await http("POST", runPath, { body: {}, headers: key() }), 200);
    expect((early.placement as ScriptBreakdownPlacementOutcome).awaitingApproval).toEqual(["S1"]);
    const scene = (await liveScenes(projectId, target.id)).find((item) => item.entityId === sceneId)!;
    await approveRevision(`${scenePath(projectId, target.id, sceneId)}/revisions/${scene.currentRevisionId}/review`, scene.rowVersion,
      scene.currentRevision.reviewVersion);
    const placed = ok(await http("POST", runPath, { body: {}, headers: key() }), 200);
    expect((placed.placement as ScriptBreakdownPlacementOutcome).placed).toEqual(["S1"]);
    const listed = ok(await http("GET", `${scenePath(projectId, target.id, sceneId)}/shots`), 200).items as
      Array<{ entityId: string; rowVersion: number; currentRevisionId: string; currentRevision: { reviewVersion: number; reviewStatus: string } }>;
    expect(listed).toHaveLength(2);
    const ordinals = new Map<string, number>();
    for (const item of listed) {
      const history = ok(await http("GET", `${scenePath(projectId, target.id, sceneId)}/shots/${item.entityId}/revisions`), 200);
      ordinals.set(item.entityId, Number(history.items[0].ordinal));
    }
    const shots: ShotMedia[] = [];
    const ordered = [...listed].sort((left, right) => ordinals.get(left.entityId)! - ordinals.get(right.entityId)!);
    expect(ordered.map((item) => ordinals.get(item.entityId))).toEqual([1, 2]);
    for (const item of ordered) {
      expect(item.currentRevision.reviewStatus).toBe("DRAFT");
      await approveRevision(`${scenePath(projectId, target.id, sceneId)}/shots/${item.entityId}/revisions/${item.currentRevisionId}/review`,
        item.rowVersion, item.currentRevision.reviewVersion);
      shots.push({ sceneId, shotId: item.entityId, revisionId: item.currentRevisionId, videoId: await video(item.currentRevisionId) });
    }
    const composites: Composite[] = [];
    for (const shot of shots) composites.push(await shotComposite(shot.revisionId, shot.videoId));
    // An old approved shot composite cannot be mixed with a new one: the episode gate still refuses it, and nothing is queued.
    const before = await ledger(projectId);
    const mixed = refused(await http("POST", `/projects/${projectId}/episodes/${target.id}/compose-preflight`,
      { body: { compositeAssetIds: [composites[0]!.assetId, target.composites[1]!.assetId] } }), 400, "REVIEW_REQUIRED");
    expect(await ledger(projectId)).toEqual(before);
    const episode = await episodeComposite(projectId, target.id, composites.map((item) => item.assetId));
    const freshExport = await exported(projectId, target.id, episode, composites, "after-new-source-episode-1");
    const states = await assetStates([...shots.map((item) => item.videoId), ...composites.map((item) => item.assetId), episode.assetId]);
    expect(Object.values(states).map((item) => item.status)).toEqual(Object.values(states).map(() => "ACTIVE"));
    const [lineage] = await read<{ n: number }>(
      `SELECT count(*)::int AS n FROM shot_revision WHERE id = ANY($1::uuid[]) AND source_scene_revision_id = $2 AND freshness_status = 'CURRENT'`,
      [shots.map((item) => item.revisionId), scene.currentRevisionId]);
    expect(lineage!.n).toBe(2);
    world.fresh = { sceneId, shots, composites, episode };
    evidence.newSource = {
      sceneId, sceneRevisionId: scene.currentRevisionId, placementBeforeApproval: early.placement, placementAfterApproval: placed.placement,
      shots: shots.map((item) => item.revisionId), videos: shots.map((item) => item.videoId), shotComposites: composites, episodeComposite: episode,
      export: freshExport, mixedOldAndNew: mixed, assetStates: states,
    };
  });

  it("E. the unrelated episode is neither archived nor STALE, and still composes and exports the same bytes", async () => {
    const { projectId, other } = world;
    const [scene] = await read<{ archived: boolean }>("SELECT archived_at IS NOT NULL AS archived FROM scene WHERE id = $1", [other.sceneId]);
    expect(scene!.archived).toBe(false);
    const shotRows = await read<{ archived: boolean; freshness: string }>(
      `SELECT shot.archived_at IS NOT NULL AS archived, revision.freshness_status AS freshness
         FROM shot JOIN shot_revision revision ON revision.id = shot.current_revision_id WHERE shot.id = ANY($1::uuid[])`,
      [other.shots.map((item) => item.shotId)]);
    expect(shotRows).toEqual([{ archived: false, freshness: "CURRENT" }, { archived: false, freshness: "CURRENT" }]);
    expect((await liveScenes(projectId, other.id)).map((item) => item.entityId)).toEqual([other.sceneId]);
    const ids = [...other.shots.map((item) => item.videoId), ...other.composites.map((item) => item.assetId), other.episode.assetId];
    const states = await assetStates(ids);
    expect(Object.values(states).map((item) => item.status)).toEqual(ids.map(() => "ACTIVE"));
    const preflight = ok(await http("POST", `/projects/${projectId}/episodes/${other.id}/compose-preflight`,
      { body: { compositeAssetIds: other.composites.map((item) => item.assetId) } }), 200);
    expect(preflight.inputHash).toBe(other.preflightHash);
    const again = await exported(projectId, other.id, other.episode, other.composites, "after-unrelated-episode-2");
    expect(again.sha256).toBe(other.exportSha);
    evidence.unrelatedEpisode = { episodeId: other.id, sceneArchived: false, shots: shotRows, assetStates: states, preflightHashUnchanged: true,
      exportShaUnchanged: again.sha256 };
  });

  it("never reaches a provider: every model send went to the stub with the stub key", () => {
    expect(sent.length).toBe(1);
    expect(sent.every((item) => item.keyMatches)).toBe(true);
  });
});
