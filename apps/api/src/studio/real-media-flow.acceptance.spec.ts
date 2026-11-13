/**
 * WRITE-ONLY until separately authorized by the disposable-database CI guard.
 * Real localhost HTTP, site sessions/CSRF and PostgreSQL; no Bull, provider HTTP, bucket or paid call.
 * The database must be brand new and empty. No business DATABASE_URL fallback or destructive reset.
 * Fixed PNG/WAV/MP4 fixtures replace ONLY the provider/materializer/S3 transport boundaries.
 * This proves orchestration and receipt lineage, not provider output quality, billing or FFmpeg rendering.
 * Local voice composition stops at its real HTTP queue entry. Review/export refusal routes are real;
 * successful rendering, approval and episode download bytes remain covered by their separate suites.
 */
import "reflect-metadata";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RealMediaCapability, RealMediaQuote, SpeechBinding, SpeechCapabilities, SpeechMixPreflight,
  SpeechPlanView, SpeechQuote, SpeechTakesPage, SpeechBatchInventory, SpeechBatchView, SpeechBatchConfirmation } from "@ai-drama/contracts";
import { JobPersistenceService, MediaAssetStore, PostgresSpeechStore, PostgresSpeechBatchStore, PostgresVoiceComposeStore,
  RealMediaStore, RuntimeStore, TextChainService, createPostgresPool, runMigrations, type RealMediaExecution } from "@ai-drama/database";
import { assertVoiceComposeSnapshot, VOICE_COMPOSE_JOB_SCHEMA } from "@ai-drama/domain";
import { assertComfyUiSourceImage, ComfyUiImageAdapter, comfyUiRequiredNodes, MediaSubmissionUnknownError, ServerRealMediaRuntime, type MediaProviderAdapter, type MediaProviderOutput } from "@ai-drama/providers";
import { checkRealMediaAcceptanceEnv, verifyRealMediaAcceptanceDatabase } from "../../../../packages/database/src/real-media-acceptance-guard";
import { RealMediaRecovery, runRealMediaJob, type RealMediaWorkerDependencies } from "../../../worker/src/runtime/real-media-job";
import { S3RealMediaObjects, type S3MediaClient } from "../../../worker/src/runtime/real-media-objects";
import type { VerifiedRealMedia } from "../../../worker/src/runtime/real-media-materializer";
import { AuthModule } from "../auth/auth.module";
import { SiteAuth } from "../auth/site-auth";
import { hashPassword } from "../auth/password-hash";
import type { ApiEnv } from "../config/env";
import { SafeExceptionFilter } from "../http/safe-exception.filter";
import { RealMediaService, type RealMediaServiceOptions } from "./real-media.service";
import { SpeechService } from "./speech.service";
import { VoiceComposeService } from "./voice-compose.service";
import { StudioModule } from "./studio.module";
import { StudioService } from "./studio.service";
import { STUDIO_RUNTIME } from "./tokens";

if (process.env.REAL_MEDIA_HTTP_ACCEPTANCE_AUTHORIZED !== "true") {
  throw new Error("Real-media HTTP acceptance refused before opening a connection: explicit HTTP authorization is required");
}
const decision = checkRealMediaAcceptanceEnv(process.env);
if (!decision.ok) throw new Error(`Real-media HTTP acceptance refused before opening a connection: ${decision.reason}`);
const pool = createPostgresPool({ connectionString: decision.url, connectionTimeoutMs: 5000,
  statementTimeoutMs: 15_000, queryTimeoutMs: 20_000 });
type Client = Awaited<ReturnType<typeof pool.connect>>;
async function q<T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<{ rows: T[] }> {
  return await pool.query(sql, values) as { rows: T[] };
}
const jobs = new JobPersistenceService(pool), assets = new MediaAssetStore(pool);
const speech = new PostgresSpeechStore(pool, jobs), batches = new PostgresSpeechBatchStore(pool, jobs), chain = new TextChainService(pool);
const apps: INestApplication[] = [];
const ORIGIN = "https://real-media-acceptance.example.test", PASSWORD = "fixture-http-only-password#42";
const dialogue = "旁白：你好。", spoken = "你好。", actor = "server-owner";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7u0AAAAASUVORK5CYII=", "base64");
let passwordHash: string, videoBytes: Buffer;
let externalSends = 0;

beforeAll(async () => {
  const safe = await verifyRealMediaAcceptanceDatabase({ query: sql => q(sql) }, decision.databaseName);
  if (!safe.ok) throw new Error(`Real-media HTTP acceptance refused before writes: ${safe.reason}`);
  await runMigrations(pool);
  expect(await speech.storageReady()).toBe(false); expect(await batches.storageReady()).toBe(false);
  await tx(async client => {
    for (const name of ["20261101000100_character_voice.sql", "20261101000200_real_media.sql", "20261101000300_speech_batch.sql", "20261113000100_comfyui_shot_image_selection.sql"]) {
      await client.query(await readFile(resolve(__dirname, "../../../../packages/database/prisma/drafts", name), "utf8"));
    }
  });
  expect(await speech.storageReady()).toBe(true); expect(await batches.storageReady()).toBe(true);
  expect((await runMigrations(pool)).applied).toEqual([]);
  passwordHash = await hashPassword(PASSWORD, { log2N: 15, r: 8, p: 1, saltBytes: 16, keyBytes: 32 });
  videoBytes = await readFile(resolve(__dirname, "../../../../packages/providers/fixtures/sample-15s-a-v1.mp4"));
  expect(sha(videoBytes)).toBe("4f46bf904a42c7d3acd0cda9d37ccaa2de71dda095a6f91a83c211d5d48f04e7");
});
afterAll(async () => {
  for (const app of apps) await app.close();
  await pool.end();
  expect(externalSends).toBe(0);
});

async function tx<T>(work: (client: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query("BEGIN"); const result = await work(client); await client.query("COMMIT"); return result; }
  catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
async function id(sql: string, values: unknown[] = []): Promise<string> {
  return (await q<{ id: string }>(sql, values)).rows[0]!.id;
}
async function version(table: "project" | "episode" | "scene", entityId: string): Promise<number> {
  return Number((await q(`SELECT ${table === "project" ? "version" : "row_version"} AS value FROM ${table} WHERE id=$1`, [entityId])).rows[0]!.value);
}
/** Uses the existing speech acceptance's real text-chain creation/review gates, with an explicit narrator. */
async function world() {
  const workspaceId = await id("INSERT INTO workspace(name) VALUES('HTTP media acceptance') RETURNING id");
  const projectId = await id("INSERT INTO project(workspace_id,title) VALUES($1,'HTTP media acceptance') RETURNING id", [workspaceId]);
  const story = await chain.createStoryRevision({ workspaceId, projectId, content: { text: "Acceptance source" }, createdBy: actor, expectedVersion: 1 });
  const storyReview = await chain.transitionReview({ table: "story_revision", workspaceId, revisionId: story.revisionId,
    expectedVersion: story.rowVersion, expectedReviewVersion: 1, to: "IN_REVIEW" });
  await chain.approveStory({ workspaceId, projectId, revisionId: story.revisionId, expectedVersion: storyReview.rowVersion,
    expectedReviewVersion: storyReview.reviewVersion, reviewedBy: actor });
  const episodeId = await id("SELECT id FROM episode WHERE workspace_id=$1 AND project_id=$2 AND episode_no=1", [workspaceId, projectId]);
  const script = await chain.createScriptRevision({ workspaceId, projectId, episodeId, sourceStoryRevisionId: story.revisionId,
    content: { text: `INT. ROOM\n${dialogue}` }, createdBy: actor, expectedVersion: await version("episode", episodeId) });
  const scriptReview = await chain.transitionReview({ table: "script_revision", workspaceId, revisionId: script.revisionId,
    expectedVersion: script.rowVersion, expectedReviewVersion: 1, to: "IN_REVIEW" });
  await chain.approveScript({ workspaceId, episodeId, revisionId: script.revisionId, expectedVersion: scriptReview.rowVersion,
    expectedReviewVersion: scriptReview.reviewVersion, reviewedBy: actor });
  const scene = await tx(async client => chain.createSceneRevisionInTransaction(client, { workspaceId, projectId, episodeId,
    sourceScriptRevisionId: script.revisionId, ordinal: 1, heading: "INT. ROOM", timeOfDay: "夜", summary: "Acceptance source",
    createdBy: actor, expectedVersion: await version("episode", episodeId) }));
  const sceneReview = await tx(client => chain.reviewSceneShotInTransaction(client, { kind: "scene", workspaceId, projectId, episodeId,
    sceneId: scene.entityId, revisionId: scene.revisionId, expectedVersion: scene.rowVersion, expectedReviewVersion: 1, to: "IN_REVIEW", reviewedBy: actor }));
  await tx(client => chain.reviewSceneShotInTransaction(client, { kind: "scene", workspaceId, projectId, episodeId,
    sceneId: scene.entityId, revisionId: scene.revisionId, expectedVersion: sceneReview.rowVersion,
    expectedReviewVersion: sceneReview.reviewVersion, to: "APPROVED", reviewedBy: actor }));
  const shot = await tx(async client => chain.createShotScopedInTransaction(client, { workspaceId, projectId, sceneId: scene.entityId,
    sourceSceneRevisionId: scene.revisionId, ordinal: 1, shotType: "中景", camera: "固定", action: "旁白", dialogue,
    promptText: "Acceptance image prompt", createdBy: actor, expectedVersion: await version("scene", scene.entityId) }));
  const shotReview = await tx(client => chain.reviewSceneShotInTransaction(client, { kind: "shot", workspaceId, projectId, episodeId,
    sceneId: scene.entityId, shotId: shot.entityId, revisionId: shot.revisionId, expectedVersion: shot.rowVersion,
    expectedReviewVersion: 1, to: "IN_REVIEW", reviewedBy: actor }));
  await tx(client => chain.reviewSceneShotInTransaction(client, { kind: "shot", workspaceId, projectId, episodeId,
    sceneId: scene.entityId, shotId: shot.entityId, revisionId: shot.revisionId, expectedVersion: shotReview.rowVersion,
    expectedReviewVersion: shotReview.reviewVersion, to: "APPROVED", reviewedBy: actor }));
  return { workspaceId, projectId, episodeId, sceneId: scene.entityId, shotId: shot.entityId, shotRevisionId: shot.revisionId };
}
type World = Awaited<ReturnType<typeof world>>;
type Accepted = { jobId: string; workflowRunId: string; dispatchSeq: number };

function wav(): Buffer {
  const bytes = Buffer.alloc(44 + 48000 * 2 * 2); // Exactly one second, stereo PCM16, 48kHz.
  bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(192000, 28); bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36); bytes.writeUInt32LE(bytes.length - 44, 40); return bytes;
}

async function harness(w: World, enabled = true, comfyFetch?: typeof fetch) {
  const comfyOrigin = "http://127.0.0.1:8188";
  const comfyCheckpoint = "protocol-test.safetensors";
  const runtime = new ServerRealMediaRuntime(w.workspaceId, { REAL_MEDIA_ENABLED: "true", REAL_MEDIA_PRICE_VERSION: "fixture-v1",
    REAL_MEDIA_RECEIPT_KEY: Buffer.alloc(32, 7).toString("base64"), REAL_MEDIA_RECEIPT_KEY_VERSION: "fixture-v1",
    DASHSCOPE_MEDIA_API_KEY: "synthetic-never-sent-key", DASHSCOPE_MEDIA_CREDENTIAL_VERSION: "fixture-v1",
    DASHSCOPE_MEDIA_PRICE_IMAGE: "0.18", DASHSCOPE_MEDIA_PRICE_VIDEO_SECOND: "0.1", DASHSCOPE_MEDIA_PRICE_TTS_CHARACTER: "0.00008",
    DASHSCOPE_MEDIA_VIDEO_SECONDS: "15",
    REAL_MEDIA_MAX_SINGLE_CNY: "2",
    ...(comfyFetch ? { COMFYUI_IMAGE_ENABLED: "true", COMFYUI_BASE_URL: comfyOrigin, COMFYUI_ALLOWED_ORIGINS: comfyOrigin,
      COMFYUI_CHECKPOINT: comfyCheckpoint, COMFYUI_PRICE_IMAGE_ESTIMATE: "0.01", COMFYUI_TARGETED_CANCELLATION: "true" } : {}),
  }, true, async () => { externalSends++; throw new Error("Provider HTTP forbidden in acceptance"); });
  const store = new RealMediaStore(pool, { receiptCipher: runtime.receiptCipher });
  const comfyConfig = runtime.comfyUiConfiguration();
  const comfyAdapter = (mode: "submit" | "query") => new ComfyUiImageAdapter({ ...comfyConfig!, enabled: mode === "submit" },
    { baseUrl: comfyOrigin, allowedOrigins: [comfyOrigin], fetch: comfyFetch, targetedCancellation: true });
  if (comfyConfig) await q(`INSERT INTO provider_configuration(id,workspace_id,provider_key,capability,default_timeout_ms,max_attempts)
      VALUES($1,$2,$3,$4,180000,1)`, [comfyConfig.id, w.workspaceId, comfyConfig.providerKey, comfyConfig.capability]);
  for (const capability of ["image.generate", "video.generate", "audio.tts"] as const) {
    const config = (await runtime.configurationFor(capability))!;
    await q(`INSERT INTO provider_configuration(id,workspace_id,provider_key,capability,default_timeout_ms,max_attempts)
      VALUES($1,$2,$3,$4,180000,1)`, [config.id, w.workspaceId, config.providerKey, capability]);
  }
  const memory = new Map<string, Buffer>();
  const s3: S3MediaClient = {
    async put(input) { if (memory.has(input.key)) return "exists"; memory.set(input.key, Buffer.from(input.bytes)); return "created"; },
    async get(key) { const bytes = memory.get(key); if (!bytes) throw new Error("Fixture object missing");
      return (async function* () { yield bytes; })(); },
  };
  const objects = new S3RealMediaObjects(s3);
  const policy: RealMediaServiceOptions = { workspaceId: w.workspaceId, enabled, readEnabled: true, store, jobs, assets, objects,
    configurationFor: async (capability, client) => {
      const config = await runtime.configurationFor(capability);
      return config && await store.configurationStillEnabled(config, client) ? config : null;
    }, speechCatalog: () => runtime.speechCatalog(),
    ...(comfyConfig ? { comfyUiConfigurationFor: async () => comfyConfig,
      comfyUiReadiness: async () => ({ status: (await comfyAdapter("query").checkReadiness()).state === "READY" ? "available" : "missing_dependencies", workflows: [] }) } : {}) };
  const media = new RealMediaService(policy);
  const runtimeStore = new RuntimeStore(pool);
  const studio = new StudioService(jobs, runtimeStore, chain, w.workspaceId, undefined, assets,
    false, null, false, false, true, "/fixture-must-not-read-in-refusal-tests", true, false, undefined, "legacy", true, true);
  // Keep the production controller list and all runtime->service factories. Replace only runtime construction:
  // it would otherwise open independent credentials, maintenance timers and external infrastructure.
  const module = await Test.createTestingModule({ imports: [
    AuthModule.register({ NODE_ENV: "test" } as ApiEnv,
      { kind: "enabled", auth: new SiteAuth({ username: "admin", passwordHash, publicOrigin: ORIGIN }) }),
    StudioModule.register({ NODE_ENV: "test" } as ApiEnv),
  ] }).overrideProvider(STUDIO_RUNTIME).useValue({
    service: studio, store: runtimeStore, realMedia: media,
    speech: new SpeechService({ workspaceId: w.workspaceId, store: speech, generation: media.speechPort(), batchStore: batches }),
    voiceCompose: new VoiceComposeService({ workspaceId: w.workspaceId, enabled: true, jobs,
      store: new PostgresVoiceComposeStore(pool, jobs), speech }),
    titleWriting: null, scriptBreakdown: null, writingCandidates: null, autoCreation: null, seriesWriting: null,
    vimaxPreview: null, vimaxCandidates: null, vimaxPlanning: null, adminConsoleEnabled: false, adminModels: null,
  }).compile();
  const app = module.createNestApplication({ logger: false }); apps.push(app);
  app.setGlobalPrefix("api/v1"); app.useGlobalFilters(new SafeExceptionFilter());
  await app.listen(0, "127.0.0.1"); const base = `${await app.getUrl()}/api/v1`;
  // Every HTTP request is restricted to this bound localhost server; no URL comes from a provider result.
  async function local(path: string, init: RequestInit = {}) {
    const target = new URL(base + path);
    if (target.origin !== new URL(base).origin || target.hostname !== "127.0.0.1") throw new Error("External HTTP forbidden");
    return fetch(target, { ...init, redirect: "error", signal: AbortSignal.timeout(10_000) });
  }
  const login = await local("/auth/login", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: PASSWORD }) });
  expect(login.status).toBe(200);
  const cookie = login.headers.getSetCookie().map(v => v.split(";", 1)[0]).join("; ");
  const csrf = (await login.json() as { csrfToken: string }).csrfToken;
  const headers = (extra: Record<string, string> = {}) => ({ cookie, origin: ORIGIN, "x-csrf-token": csrf,
    "content-type": "application/json", "idempotency-key": randomUUID(), ...extra });
  async function http<T>(path: string, method = "GET", body?: unknown, extra: Record<string, string> = {}, status = 200): Promise<T> {
    const response = await local(path, { method, headers: headers(extra), ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json() as T;
    expect({ status: response.status, body: response.status === status ? undefined : result }).toEqual({ status, body: undefined });
    return result;
  }
  const submitCounts = new Map<RealMediaCapability, number>();
  const recoveryModes: string[] = [];
  let failMaterializeOnce = false;
  let unknownSubmitOnce = false;
  const deps: RealMediaWorkerDependencies = { jobs, assets, store, objects, preflightLocal: async () => undefined,
    validateComfyUiSourceImage: async bytes => { assertComfyUiSourceImage(bytes,"image/png"); },
    adapterFor: async (config, mode): Promise<MediaProviderAdapter> => {
      recoveryModes.push(mode);
      if (config.providerKey === "comfyui") return comfyAdapter(mode);
      return { providerKey: config.providerKey, capabilities: () => [config.capability],
        async submit(request) {
          if (mode !== "submit") throw new Error("Recovery is query-only");
          submitCounts.set(config.capability, (submitCounts.get(config.capability) ?? 0) + 1);
          if (unknownSubmitOnce) { unknownSubmitOnce = false; throw new MediaSubmissionUnknownError(); }
          const kind = config.capability === "image.generate" ? "IMAGE" : config.capability === "video.generate" ? "VIDEO" : "AUDIO";
          const usage: Record<string, number> = config.capability === "image.generate" ? { image_count: 1 }
            : config.capability === "video.generate" ? { duration: 15 } : { characters: [...spoken].length };
          return { kind: "succeeded", providerRequestId: `fixture-${request.generationJobId}`, outputs: [{ kind,
            retrieval: { kind: "HANDLE", handle: "fixed-fixture-never-fetched" } }],
          accounting: { provider: config.providerKey, model: config.model, usage, costs: [] } };
        },
        async inspect() { throw new Error("Persisted synchronous output needs no provider query"); },
        async resolveOutput() { throw new Error("Fixture materializer performs no network retrieval"); },
      };
    },
    materialize: async (output: MediaProviderOutput, adapter): Promise<VerifiedRealMedia> => {
      if (failMaterializeOnce) { failMaterializeOnce = false; throw new Error("Simulated local delivery interruption after receipt"); }
      if (adapter.providerKey === "comfyui") {
        const resolved = await adapter.resolveOutput(output);
        if (!resolved.uri.startsWith("data:image/png;base64,")) throw new Error("Expected validated fixture bytes");
        return { bytes: Buffer.from(resolved.uri.slice("data:image/png;base64,".length), "base64"),
          mimeType: "image/png", width: 512, height: 512 };
      }
      return output.kind === "IMAGE" ? { bytes: png, mimeType: "image/png", width: 1, height: 1 }
        : output.kind === "VIDEO" ? { bytes: videoBytes, mimeType: "video/mp4", width: 180, height: 320, durationMs: 15000 }
          : { bytes: wav(), mimeType: "audio/wav", durationMs: 1000 };
    },
  };
  async function execution(jobId: string): Promise<RealMediaExecution> {
    const e = await store.loadExecution(w.workspaceId, jobId); if (!e) throw new Error("Real job missing"); return e;
  }
  async function assetFor(jobId: string) {
    const assetId = await id("SELECT id FROM asset WHERE workspace_id=$1 AND source_generation_job_id=$2", [w.workspaceId, jobId]);
    return assets.getWorkspaceAsset(w.workspaceId, assetId);
  }
  return { http, local, headers, policy, store, deps, execution, assetFor, submitCounts, recoveryModes,
    interruptNextDelivery() { failMaterializeOnce = true; },
    loseNextSubmissionReceipt() { unknownSubmitOnce = true; } };
}

function comfyProtocolFixture() {
  const rendered = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=gray:s=512x512",
    "-frames:v", "1", "-threads", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"]);
  const graphs = new Map<string, Record<string, { inputs: Record<string, unknown> }>>();
  const calls = { submitted: 0, uploaded: 0, downloaded: 0 };
  const protocolFetch: typeof fetch = async (target, init) => {
    const url = new URL(String(target));
    if (url.origin !== "http://127.0.0.1:8188") throw new Error("Unexpected provider destination");
    if (url.pathname === "/system_stats") return Response.json({ system: {}, devices: [] });
    if (url.pathname.startsWith("/object_info/")) {
      const node = url.pathname.split("/").at(-1)!;
      const required = Object.fromEntries(comfyUiRequiredNodes()[node]!.map(name => [name,
        name === "ckpt_name" ? [["protocol-test.safetensors"]] : ["ANY"]]));
      return Response.json({ [node]: { python_module: "nodes", input: { required } } });
    }
    if (url.pathname === "/prompt") {
      const promptId = randomUUID();
      const { prompt } = JSON.parse(String(init?.body));
      graphs.set(promptId, prompt); calls.submitted++;
      return Response.json({ prompt_id: promptId, number: calls.submitted, node_errors: {} });
    }
    if (url.pathname === "/upload/image") {
      const file = (init?.body as FormData).get("image") as File;
      expect(Buffer.from(await file.arrayBuffer())).toEqual(rendered);
      calls.uploaded++;
      return Response.json({ name: file.name, subfolder: "", type: "input" });
    }
    if (url.pathname.startsWith("/history/")) {
      const promptId = url.pathname.split("/").at(-1)!;
      const graph = graphs.get(promptId);
      if (!graph) return Response.json({});
      const stem = String(graph["9"]!.inputs.filename_prefix).split("/")[1];
      return Response.json({ [promptId]: { prompt: [0,promptId,graph,{},["9"]], status: { status_str: "success", completed: true },
        outputs: { "9": { images: [{ filename: stem + "_00001_.png", subfolder: "ads-comfyui-v1", type: "output" }] } } } });
    }
    if (url.pathname === "/view") {
      calls.downloaded++;
      return new Response(new Uint8Array(rendered), { headers: { "content-type": "image/png" } });
    }
    throw new Error("Unexpected protocol request " + url.pathname);
  };
  return { protocolFetch, calls, rendered };
}
type Harness = Awaited<ReturnType<typeof harness>>;
const shotPath = (w: World) => `/projects/${w.projectId}/shot-revisions/${w.shotRevisionId}/real-media`;
describe("ComfyUI storyboard flow against disposable PostgreSQL and a protocol fixture", () => {
  it("recovers the original job and persists an adopted image while keeping new candidates separate", async () => {
    const w = await world(), fixture = comfyProtocolFixture(), h = await harness(w, true, fixture.protocolFetch);
    const path = shotPath(w), imagePath = path + "/comfyui";
    const request = { capability: "image.generate", comfyui: {
      workflowId: "sd15-txt2img", prompt: "石铺清晨，木牌落在石碑上。", width: 512, height: 512,
    } };
    expect(await h.http(imagePath)).toEqual({ references: [], jobs: [], selectedAssetId: null, selectionAvailable: true });
    const quote = await h.http<RealMediaQuote>(path + "/quote", "POST", request, {}, 201);
    expect(quote).toMatchObject({ estimateBasis: "self-hosted-resource-estimate", actualCost: "unknown" });
    const auth = await authorize(h, w, quote), key = randomUUID();
    const job = await h.http<Accepted>(path + "/generate", "POST", auth, { "idempotency-key": key }, 202);
    expect(await h.http(imagePath)).toMatchObject({ jobs: [{ jobId: job.jobId, phase: "queued", canCancel: true }] });
    const original = await h.execution(job.jobId);
    await runRealMediaJob(original, h.deps);
    await runRealMediaJob(original, h.deps);
    expect(fixture.calls.submitted).toBe(1);
    const sent = await h.execution(job.jobId);
    expect(sent).toMatchObject({ state: "WAITING_EXTERNAL", receiptState: "ACKNOWLEDGED", providerRequestId: expect.any(String) });
    h.interruptNextDelivery();
    await new RealMediaRecovery(h.deps).recover(sent);
    expect(await h.http(imagePath)).toMatchObject({ jobs: [{ jobId: job.jobId, phase: "finalizing" }] });
    await new RealMediaRecovery(h.deps).recover(await h.execution(job.jobId));
    const asset = await h.assetFor(job.jobId);
    expect(await h.http(imagePath)).toMatchObject({ jobs: [{ jobId: job.jobId, phase: "complete" }], references: [{ id: asset.id }] });
    const preview = await h.local(`/real-media/assets/${asset.id}/content`, { headers: h.headers() });
    expect(preview.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await preview.arrayBuffer())).toEqual(fixture.rendered);
    await h.http(imagePath, "PUT", { assetId: asset.id, expectedSelectedAssetId: null });
    expect(await h.http(imagePath)).toMatchObject({ selectedAssetId: asset.id });

    const foreign = await world(), foreignHarness = await harness(foreign, true, fixture.protocolFetch);
    const ref = { ...request, comfyui: { ...request.comfyui, workflowId: "sd15-img2img", referenceAssetId: asset.id } };
    await foreignHarness.http(shotPath(foreign) + "/quote", "POST", ref, {}, 400);
    const editQuote = await h.http<RealMediaQuote>(path + "/quote", "POST", ref, {}, 201);
    const editAuth = await authorize(h, w, editQuote);
    const editJob = await h.http<Accepted>(path + "/generate", "POST", editAuth, {}, 202);
    await runRealMediaJob(await h.execution(editJob.jobId), h.deps);
    expect(await h.http(imagePath)).toMatchObject({ jobs: [expect.objectContaining({ jobId: editJob.jobId, phase: "queued" }), expect.any(Object)] });
    await new RealMediaRecovery(h.deps).recover(await h.execution(editJob.jobId));
    expect(await h.http(imagePath)).toMatchObject({ jobs: [expect.objectContaining({ jobId: editJob.jobId, phase: "complete" }), expect.any(Object)] });
    const editAsset = await h.assetFor(editJob.jobId);
    expect(await h.http(imagePath)).toMatchObject({ selectedAssetId: asset.id });
    await h.http(imagePath, "PUT", { assetId: editAsset.id, expectedSelectedAssetId: null }, {}, 409);
    await h.http(imagePath, "PUT", { assetId: editAsset.id, expectedSelectedAssetId: asset.id });
    expect(await h.http(imagePath)).toMatchObject({ selectedAssetId: editAsset.id });
    const listPath = `/projects/${w.projectId}/episodes/${w.episodeId}/scenes/${w.sceneId}/shots`;
    const storyboard = await h.http<{ items: { rowVersion: number }[] }>(listPath + "?view=storyboard");
    expect(storyboard).toMatchObject({
      items: [{ storyboard: { ordinal: 1, action: "旁白", promptText: "Acceptance image prompt", characters: [],
        candidates: expect.arrayContaining([{ id: editAsset.id, kind: "IMAGE", storageProvider: "s3", status: "ACTIVE" }]),
        selectedAssetId: editAsset.id } }],
    });
    expect(fixture.calls).toEqual({ submitted: 2, uploaded: 1, downloaded: 2 });
    const stored = await q("SELECT count(*)::int AS n FROM asset WHERE source_generation_job_id=$1", [job.jobId]);
    expect(stored.rows[0]?.n).toBe(1);
    expect(await h.http(path + "/generate", "POST", auth, { "idempotency-key": key }, 202)).toMatchObject({ jobId: job.jobId });
    await h.http(listPath + "/" + w.shotId + "/archive", "POST", {}, { "if-match": String(storyboard.items[0]!.rowVersion) });
    expect(await h.http(listPath + "?view=storyboard")).toMatchObject({ items: [] });
    expect(await h.http(imagePath)).toMatchObject({ selectedAssetId: null });
  });
});
async function authorize(h: Harness, w: World, quote: { quoteId: string; maximumAmount: string; uncertainJobIds?: string[] }) {
  return h.http<{ quoteId: string; budgetAuthorizationId: string }>(`/projects/${w.projectId}/real-media/authorize`, "POST",
    { quoteId: quote.quoteId, maximumAmount: quote.maximumAmount, confirmSinglePaidOperation: true,
      confirmedUncertainJobIds: quote.uncertainJobIds ?? [] }, {}, 201);
}
async function generate(h: Harness, w: World, capability: RealMediaCapability, sourceImageAssetId?: string) {
  const quote = await h.http<RealMediaQuote>(`${shotPath(w)}/quote`, "POST", { capability, ...(sourceImageAssetId ? { sourceImageAssetId } : {}) }, {}, 201);
  const authorization = await authorize(h, w, quote), key = randomUUID();
  const accepted = await h.http<Accepted>(`${shotPath(w)}/generate`, "POST", authorization, { "idempotency-key": key }, 202);
  const frozen = await h.execution(accepted.jobId); await runRealMediaJob(frozen, h.deps);
  await runRealMediaJob(frozen, h.deps); // A stale Bull-style redelivery cannot create a second submission.
  return { accepted, authorization, key, asset: await h.assetFor(accepted.jobId) };
}

/** Save an exact, approved-source narrator plan; no quote, authorization, Job or take is produced. */
async function narratorPlan(h: Harness, w: World) {
  const catalog = await h.http<SpeechCapabilities>(`/projects/${w.projectId}/speech-capabilities`);
  const voice = catalog.voices[0]!;
  const binding = await h.http<SpeechBinding>(`/projects/${w.projectId}/voice-bindings/narrator`, "PUT",
    { catalogVersion: catalog.catalogVersion, catalogVoiceId: voice.catalogVoiceId }, { "if-match": "0" });
  const empty = await h.http<SpeechPlanView>(`/shot-revisions/${w.shotRevisionId}/speech-plan`);
  const lineId = randomUUID();
  const plan = await h.http<SpeechPlanView>(`/shot-revisions/${w.shotRevisionId}/speech-plan`, "PUT", {
    sourceDialogueHash: empty.sourceDialogueHash, timingPolicy: "sequential-reject-overflow", lines: [{ lineId,
      speakerBindingRevisionId: binding.currentRevision.id, sourceStart: dialogue.indexOf(spoken), sourceEnd: dialogue.length,
      displayText: spoken, emotion: "neutral", speed: 1, pauseAfterMs: 0 }],
  }, { "if-match": String(empty.rowVersion) });
  return { plan, lineId };
}

describe("guarded real HTTP + empty PostgreSQL media/speech orchestration", () => {
  it("registers authenticated routes and refuses anonymous, missing-CSRF and disabled submit policy before any job", async () => {
    const w = await world(), h = await harness(w, false);
    expect((await h.local(`/projects/${w.projectId}/real-media/capabilities`)).status).toBe(401);
    expect((await h.local(`${shotPath(w)}/quote`, { method: "POST", headers: { cookie: h.headers().cookie, origin: ORIGIN,
      "content-type": "application/json" }, body: JSON.stringify({ capability: "image.generate" }) })).status).toBe(403);
    const capabilities = await h.http<{ available: boolean }>(`/projects/${w.projectId}/real-media/capabilities`);
    expect(capabilities.available).toBe(false);
    await h.http(`${shotPath(w)}/quote`, "POST", { capability: "image.generate" }, {}, 503);
    expect((await q("SELECT count(*)::int AS n FROM generation_job WHERE workspace_id=$1", [w.workspaceId])).rows[0]!.n).toBe(0);
    expect(h.submitCounts.size).toBe(0);
  });

  it("concurrently replays one authorized job, recovers its private receipt without resubmit and retains reads when submit closes", async () => {
    const w = await world(), h = await harness(w);
    const quote = await h.http<RealMediaQuote>(`${shotPath(w)}/quote`, "POST", { capability: "image.generate" }, {}, 201);
    await h.http(`/projects/${w.projectId}/real-media/authorize`, "POST", { quoteId: quote.quoteId, maximumAmount: "999",
      confirmSinglePaidOperation: true, confirmedUncertainJobIds: [] }, {}, 422);
    const auth = await authorize(h, w, quote), key = randomUUID();
    const responses = await Promise.all([1, 2].map(() => h.http<Accepted>(`${shotPath(w)}/generate`, "POST", auth, { "idempotency-key": key }, 202)));
    expect(responses[0]).toEqual(responses[1]); const job = responses[0]!;
    await h.http(`${shotPath(w)}/generate`, "POST", { ...auth, budgetAuthorizationId: randomUUID() }, { "idempotency-key": key }, 409);
    h.interruptNextDelivery(); const queued = await h.execution(job.jobId);
    await runRealMediaJob(queued, h.deps);
    const interrupted = await h.execution(job.jobId);
    expect(interrupted.receiptState).toBe("UNKNOWN"); expect(interrupted.providerRequestId).toBe(`fixture-${job.jobId}`);
    expect(interrupted.outputs).toHaveLength(1);
    await runRealMediaJob(queued, h.deps);
    await new RealMediaRecovery(h.deps).recover(interrupted);
    const asset = await h.assetFor(job.jobId);
    expect(asset).toMatchObject({ kind: "IMAGE", storageProvider: "s3", reviewStatus: "DRAFT", checksumSha256: sha(png) });
    expect((await h.execution(job.jobId)).receiptState).toBe("SUCCEEDED");
    expect(h.submitCounts.get("image.generate")).toBe(1); expect(h.recoveryModes).toEqual(["submit", "query"]);
    const receipt = (await q("SELECT state,outputs_ciphertext,usage_json FROM real_media_submission WHERE generation_job_id=$1", [job.jobId])).rows[0]!;
    expect(receipt.state).toBe("SUCCEEDED"); expect(receipt.usage_json).toEqual({ image_count: 1 });
    expect(String(receipt.outputs_ciphertext)).not.toContain("fixed-fixture-never-fetched");
    h.policy.enabled = false; // Submit policy may close independently of authenticated receipt/object reads.
    expect(await h.http<Accepted>(`${shotPath(w)}/generate`, "POST", auth, { "idempotency-key": key }, 202)).toEqual(job);
    const content = await h.local(`/real-media/assets/${asset.id}/content`, { headers: h.headers() });
    expect(content.status).toBe(200); expect(content.headers.get("cache-control")).toBe("private, no-store");
    expect(Buffer.from(await content.arrayBuffer())).toEqual(png);
    expect((await q("SELECT count(*)::int AS n FROM job_attempt WHERE generation_job_id=$1", [job.jobId])).rows[0]!.n).toBe(1);
    expect((await q("SELECT kind FROM cost_ledger WHERE generation_job_id=$1", [job.jobId])).rows).toEqual([{ kind: "ESTIMATED" }]);
    expect((await h.http<{ actualCost: string }>(`/projects/${w.projectId}/real-media/cost-exposure`)).actualCost).toBe("unknown");
  });

  it("keeps a submission without a remote ID unknown and requires explicit duplicate-risk confirmation for another quote", async () => {
    const w = await world(), h = await harness(w);
    const quote = await h.http<RealMediaQuote>(`${shotPath(w)}/quote`, "POST", { capability: "image.generate" }, {}, 201);
    const auth = await authorize(h, w, quote), key = randomUUID();
    const accepted = await h.http<Accepted>(`${shotPath(w)}/generate`, "POST", auth, { "idempotency-key": key }, 202);
    h.loseNextSubmissionReceipt(); const queued = await h.execution(accepted.jobId);
    await runRealMediaJob(queued, h.deps);
    const unknown = await h.execution(accepted.jobId);
    expect(unknown).toMatchObject({ receiptState: "UNKNOWN", providerRequestId: null });
    await runRealMediaJob(queued, h.deps); await new RealMediaRecovery(h.deps).recover(unknown);
    expect(h.submitCounts.get("image.generate")).toBe(1); expect(h.recoveryModes).toEqual(["submit"]);
    expect(await h.http<Accepted>(`${shotPath(w)}/generate`, "POST", auth, { "idempotency-key": key }, 202)).toEqual(accepted);
    const replacement = await h.http<RealMediaQuote>(`${shotPath(w)}/quote`, "POST", { capability: "image.generate" }, {}, 201);
    expect(replacement.uncertainJobIds).toEqual([accepted.jobId]);
    const refused = await h.http<{ error: { code: string } }>(`/projects/${w.projectId}/real-media/authorize`, "POST",
      { quoteId: replacement.quoteId, maximumAmount: replacement.maximumAmount, confirmSinglePaidOperation: true,
        confirmedUncertainJobIds: [] }, {}, 409);
    expect(refused.error.code).toBe("REAL_MEDIA_UNCERTAIN_CHANGED");
    await authorize(h, w, replacement); // New explicit permission does not reopen or refund the original submission.
    expect((await h.execution(accepted.jobId)).receiptState).toBe("UNKNOWN");
    expect((await q("SELECT count(*)::int AS n FROM asset WHERE workspace_id=$1", [w.workspaceId])).rows[0]!.n).toBe(0);
    expect((await h.http<{ unknownSubmissionCount: number }>(`/projects/${w.projectId}/real-media/cost-exposure`)).unknownSubmissionCount).toBe(1);
  });

  it("uses a saved first frame and explicit narrator/take selection before queuing one frozen voice mix over HTTP", async () => {
    const w = await world(), h = await harness(w);
    await h.http(`${shotPath(w)}/quote`, "POST", { capability: "video.generate" }, {}, 400);
    const image = await generate(h, w, "image.generate");
    const video = await generate(h, w, "video.generate", image.asset.id);
    const { plan, lineId } = await narratorPlan(h, w);
    const planId = plan.currentRevision!.id, speechPath = `/speech-plans/${planId}`;
    const quote = await h.http<SpeechQuote>(`${speechPath}/lines/${lineId}/quote`, "POST", {});
    const auth = await authorize(h, w, quote), key = randomUUID();
    const accepted = await h.http<{ jobId: string; workflowRunId: string; reused: boolean }>(`${speechPath}/lines/${lineId}/generate`, "POST", auth, { "idempotency-key": key }, 202);
    await runRealMediaJob(await h.execution(accepted.jobId), h.deps);
    const replay = await h.http<typeof accepted>(`${speechPath}/lines/${lineId}/generate`, "POST", auth, { "idempotency-key": key }, 202);
    expect(replay).toMatchObject({ jobId: accepted.jobId, workflowRunId: accepted.workflowRunId, reused: true });
    const takes = await h.http<SpeechTakesPage>(`${speechPath}/takes`);
    expect(takes.selected).toEqual([]); expect(takes.items).toHaveLength(1);
    const take = takes.items[0]!; expect(take.selectable).toBe(true); expect(take.lineId).toBe(lineId);
    const mix = { videoAssetId: video.asset.id, musicAssetId: null, originalAudio: "mute", musicGain: 0.25, ducking: true };
    await h.http(`${speechPath}/mix-preflight`, "POST", mix, {}, 409);
    await h.http(`${speechPath}/selections/${lineId}`, "PUT", { takeAssetId: take.assetId, expectedTakeChecksumSha256: "0".repeat(64) }, { "if-match": String(takes.rowVersion) }, 409);
    await h.http(`${speechPath}/selections/${lineId}`, "PUT", { takeAssetId: take.assetId, expectedTakeChecksumSha256: take.checksumSha256 }, { "if-match": String(takes.rowVersion) });
    const preflight = await h.http<SpeechMixPreflight>(`${speechPath}/mix-preflight`, "POST", mix);
    expect(preflight.manifest.lines).toHaveLength(1); expect(preflight.manifest.lines[0]).toMatchObject({ takeAssetId: take.assetId, displayText: spoken });
    const composeBody = { ...mix, planRevisionId: planId, expectedInputHash: preflight.inputHash }, composeKey = randomUUID();
    const composed = await h.http<Accepted>(`/shot-revisions/${w.shotRevisionId}/voice-compose`, "POST", composeBody, { "idempotency-key": composeKey }, 202);
    expect(await h.http<Accepted>(`/shot-revisions/${w.shotRevisionId}/voice-compose`, "POST", composeBody, { "idempotency-key": composeKey }, 202)).toEqual(composed);
    const frozen = (await q("SELECT kind,state,input_hash,input_snapshot FROM generation_job WHERE id=$1", [composed.jobId])).rows[0]!;
    expect(frozen).toMatchObject({ kind: "MEDIA_COMPOSE", state: "QUEUED", input_snapshot: { schema: VOICE_COMPOSE_JOB_SCHEMA } });
    const checked = assertVoiceComposeSnapshot(frozen.input_snapshot, String(frozen.input_hash));
    expect(checked.input.manifest.lines[0]!.takeAssetId).toBe(take.assetId);
    const page = await h.http<{ items: Array<{ id: string; storageProvider: string; kind: string }> }>(`/shot-revisions/${w.shotRevisionId}/assets`);
    expect(page.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: image.asset.id, storageProvider: "s3", kind: "IMAGE" }),
      expect.objectContaining({ id: video.asset.id, storageProvider: "s3", kind: "VIDEO" })]));
    const review = await h.http<{ error: { code: string } }>(`/assets/${image.asset.id}/review`, "POST",
      { decision: "APPROVE", note: "", contentHash: image.asset.checksumSha256 }, { "if-match": String(image.asset.rowVersion) }, 409);
    expect(review.error.code).toBe("REVIEW_INVALID_TRANSITION");
    for (const route of ["download", "export-manifest"]) {
      const refused = await h.http<{ error: { code: string } }>(`/projects/${w.projectId}/episodes/${w.episodeId}/composites/${image.asset.id}/${route}?expectedContentHash=${image.asset.checksumSha256}`,
        "GET", undefined, {}, 400);
      expect(refused.error.code).toBe("COMPOSE_INPUT_INVALID");
    }
    expect([...h.submitCounts.entries()].sort()).toEqual([["audio.tts", 1], ["image.generate", 1], ["video.generate", 1]]);
    expect((await q("SELECT count(*)::int AS n FROM asset WHERE workspace_id=$1 AND review_status<>'DRAFT'", [w.workspaceId])).rows[0]!.n).toBe(0);
    expect(externalSends).toBe(0);
  });

  it("freezes raw batch quotes without Jobs, confirms one fixed budget once and retains created Jobs when stopping a batch", async () => {
    const w = await world(), h = await harness(w);
    const { plan, lineId } = await narratorPlan(h, w);
    const episodePath = `/projects/${w.projectId}/episodes/${w.episodeId}`;
    const inventory = await h.http<SpeechBatchInventory>(`${episodePath}/speech-batch-plan`);
    expect(inventory.blockers).toEqual([]); expect(inventory.lines).toHaveLength(1);
    expect(inventory.lines[0]).toMatchObject({ lineId, planRevisionId: plan.currentRevision!.id, status: "missing", jobIds: [] });
    const request = { sourceHash: inventory.sourceHash, lineInputRevisionIds: [inventory.lines[0]!.lineInputRevisionId] };
    const freezeKey = randomUUID();
    const quoted = await h.http<SpeechBatchView>(`${episodePath}/speech-batches`, "POST", request, { "idempotency-key": freezeKey }, 201);
    expect(quoted.state).toBe("quoted"); expect(quoted.confirmation).toBeNull(); expect(quoted.operations).toHaveLength(1);
    expect(quoted.operations[0]).toMatchObject({ state: "pending", jobId: null, authorizationId: null });
    expect(await h.http<SpeechBatchView>(`${episodePath}/speech-batches`, "POST", request, { "idempotency-key": freezeKey }, 201)).toEqual(quoted);
    expect((await q("SELECT count(*)::int AS n FROM generation_job WHERE workspace_id=$1", [w.workspaceId])).rows[0]!.n).toBe(0);
    expect((await q("SELECT count(*)::int AS n FROM real_media_authorization WHERE workspace_id=$1 AND authorization_id IS NULL AND job_id IS NULL", [w.workspaceId])).rows[0]!.n).toBe(1);
    expect(h.submitCounts.size).toBe(0);

    const canceled = await h.http<SpeechBatchView>(`/speech-batches/${quoted.id}/cancel`, "POST", {});
    expect(canceled).toMatchObject({ state: "canceled", cancelRequested: true });
    expect(canceled.operations[0]).toMatchObject({ state: "canceled", jobId: null, authorizationId: null });
    const canceledConfirmation: SpeechBatchConfirmation = { frozenHash: quoted.frozenHash, maximumJobs: quoted.operations.length,
      budgets: quoted.frozen.budgets.map(({ currency, maximumAmount }) => ({ currency, maximumAmount })),
      confirmPossibleCharges: true, confirmedUncertainJobIds: [] };
    expect((await h.http<{ error: { code: string } }>(`/speech-batches/${quoted.id}/confirm`, "POST", canceledConfirmation, {}, 409)).error.code).toBe("SPEECH_BATCH_CANCELED");
    expect((await q("SELECT count(*)::int AS n FROM generation_job WHERE workspace_id=$1", [w.workspaceId])).rows[0]!.n).toBe(0);

    const fresh = await h.http<SpeechBatchView>(`${episodePath}/speech-batches`, "POST", request, {}, 201);
    const confirmation: SpeechBatchConfirmation = { frozenHash: fresh.frozenHash, maximumJobs: fresh.operations.length,
      budgets: fresh.frozen.budgets.map(({ currency, maximumAmount }) => ({ currency, maximumAmount })),
      confirmPossibleCharges: true, confirmedUncertainJobIds: [] };
    const changed = await h.http<{ error: { code: string } }>(`/speech-batches/${fresh.id}/confirm`, "POST",
      { ...confirmation, budgets: [{ currency: "CNY", maximumAmount: "999" }] }, {}, 409);
    expect(changed.error.code).toBe("SPEECH_BATCH_BUDGET_CHANGED");
    expect((await q("SELECT count(*)::int AS n FROM generation_job WHERE workspace_id=$1", [w.workspaceId])).rows[0]!.n).toBe(0);
    const confirmKey = randomUUID();
    const confirmed = await h.http<SpeechBatchView>(`/speech-batches/${fresh.id}/confirm`, "POST", confirmation, { "idempotency-key": confirmKey }, 202);
    expect(confirmed.state).toBe("dispatched");
    const operation = confirmed.operations[0]!;
    expect(operation).toMatchObject({ lineId, state: "job_created", jobState: "QUEUED" });
    expect(operation.jobId).toBeTruthy(); expect(operation.authorizationId).toBeTruthy();
    const replay = await h.http<SpeechBatchView>(`/speech-batches/${fresh.id}/confirm`, "POST", confirmation, { "idempotency-key": confirmKey }, 202);
    expect(replay.operations[0]!.jobId).toBe(operation.jobId);
    // Even an explicit confirmation under another HTTP key only reads the frozen command and original Job.
    expect((await h.http<SpeechBatchView>(`/speech-batches/${fresh.id}/confirm`, "POST", confirmation, {}, 202)).operations[0]!.jobId).toBe(operation.jobId);
    const stopped = await h.http<SpeechBatchView>(`/speech-batches/${fresh.id}/cancel`, "POST", {});
    expect(stopped.state).toBe("dispatched"); expect(stopped.operations[0]!.jobId).toBe(operation.jobId);
    const before = await h.http<{ id: string; state: string }>(`/generation-jobs/${operation.jobId}`);
    expect(before).toMatchObject({ id: operation.jobId, state: "QUEUED" });
    const queued = await h.execution(operation.jobId!);
    await runRealMediaJob(queued, h.deps); await runRealMediaJob(queued, h.deps);
    const read = await h.http<SpeechBatchView>(`/speech-batches/${fresh.id}`);
    expect(read.operations[0]).toMatchObject({ jobId: operation.jobId, state: "job_created", jobState: "SUCCEEDED" });
    expect(await h.http<{ id: string; state: string }>(`/generation-jobs/${operation.jobId}`)).toMatchObject({ id: operation.jobId, state: "SUCCEEDED" });
    expect((await h.execution(operation.jobId!)).receiptState).toBe("SUCCEEDED");
    expect((await q("SELECT count(*)::int AS n FROM generation_job WHERE workspace_id=$1", [w.workspaceId])).rows[0]!.n).toBe(1);
    expect((await q("SELECT count(*)::int AS n FROM real_media_submission WHERE workspace_id=$1", [w.workspaceId])).rows[0]!.n).toBe(1);
    expect(h.submitCounts.get("audio.tts")).toBe(1);
    const takes = await h.http<SpeechTakesPage>(`/speech-plans/${plan.currentRevision!.id}/takes`);
    expect(takes.items).toHaveLength(1); expect(takes.selected).toEqual([]);
    expect((await h.http<SpeechBatchInventory>(`${episodePath}/speech-batch-plan`)).lines[0]!.status).toBe("awaiting_selection");
    expect(externalSends).toBe(0);
  });

});
