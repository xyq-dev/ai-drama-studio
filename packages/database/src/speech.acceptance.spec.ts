/**
 * Explicit opt-in PostgreSQL acceptance. WRITING this source does not authorize its execution.
 * Only a separately named, verified-empty database may receive ordinary migrations and the voice/batch drafts.
 * There are no provider/network/object-store calls, DROP, TRUNCATE, Mock request identities or billing assertions.
 * Synthetic WAV / committed lavfi MP4 bytes supply exact fixture metadata to the real Job→Attempt→Asset chain.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SPEECH_BATCH_SCHEMA, type SpeechBatchConfirmation, type SpeechBatchFrozen, type SpeechBatchFrozenOperation,
  type SpeechBatchPreflightRequest, type SpeechBinding, type SpeechGenerationInput, type SpeechMixManifest,
  type SpeechMixPreflight, type SpeechPlanLineInput, type SpeechPlanPut, type SpeechPlanView, type SpeechVoice } from "@ai-drama/contracts";
import { speechBatchBudgets, speechDialogueHash, speechExactHash } from "@ai-drama/domain";
import { JobPersistenceService } from "./job-service";
import { MediaAssetStore, type MediaAssetRecord } from "./media-assets";
import { runMigrations } from "./migrations";
import { TextChainService } from "./text-chain";
import { PostgresSpeechStore, assertSpeechGenerationInputInTransaction, assertSpeechMixManifestInTransaction,
  commitSpeechMixDependencies, commitSpeechTake, speechBatchInventoryInTransaction } from "./speech-store";
import { checkSpeechAcceptanceEnv, verifySpeechAcceptanceDatabase } from "./speech-acceptance-guard";
import { PostgresSpeechBatchStore, assertSpeechBatchDispatchInTransaction, bindSpeechBatchJobInTransaction } from "./speech-batch-store";

const decision = checkSpeechAcceptanceEnv(process.env);
if (!decision.ok) throw new Error(`Speech acceptance refused before opening a connection: ${decision.reason}`);
const pool = new Pool({ connectionString: decision.url, max: 8, connectionTimeoutMillis: 5000,
  statement_timeout: 15_000, query_timeout: 20_000, application_name: "speech-draft-acceptance" });
const jobs = new JobPersistenceService(pool), assets = new MediaAssetStore(pool), chain = new TextChainService(pool);
const speech = new PostgresSpeechStore(pool, jobs);
const batches = new PostgresSpeechBatchStore(pool, jobs, { leaseMs: 3000 });
const actor = "speech-acceptance-operator";
const dialogue = "林夏：你好🙂。\r\n周晨：e\u0301再见。";
const sourceTexts = ["你好🙂。", "e\u0301再见。"];
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const context = (key = randomUUID()) => ({ actorId: actor, traceId: "speech-acceptance", idempotencyKey: key });
let beforeDraft = true;
let batchBeforeDraft = true;
let discovered: string[] = [];
let videoBytes!: Buffer;

async function tx<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client); await client.query("COMMIT"); return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
async function scalar(sql: string, values: unknown[] = []): Promise<string> {
  return String((await pool.query<{ id: string }>(sql, values)).rows[0]!.id);
}
async function version(table: "project" | "episode" | "scene", id: string): Promise<number> {
  return Number((await pool.query(`SELECT ${table === "project" ? "version" : "row_version"} AS value FROM ${table} WHERE id=$1`, [id])).rows[0]!.value);
}
async function assetState(id: string) {
  return (await pool.query<{ status: string; review_status: string }>("SELECT status,review_status FROM asset WHERE id=$1", [id])).rows[0]!;
}

beforeAll(async () => {
  const safe = await verifySpeechAcceptanceDatabase(pool, decision.databaseName);
  if (!safe.ok) throw new Error(`Speech acceptance refused before any writes: ${safe.reason}`);
  const ordinary = await runMigrations(pool);
  discovered = [...ordinary.applied, ...ordinary.alreadyApplied];
  beforeDraft = await speech.storageReady();
  batchBeforeDraft = await batches.storageReady();
  if (beforeDraft || batchBeforeDraft) throw new Error("A speech draft unexpectedly appeared in ordinary migrations");
  await tx(async (client) => {
    for (const draft of ["20261101000100_character_voice.sql", "20261101000300_speech_batch.sql"]) {
      await client.query(await readFile(resolve(__dirname, "../prisma/drafts", draft), "utf8"));
    }
  });
  videoBytes = await readFile(resolve(__dirname, "../../providers/fixtures/sample-15s-a-v1.mp4"));
  // These are the committed lavfi file's actual dimensions/duration/hash, never its Mock snapshot/request identity.
  expect(videoBytes.length).toBe(28643);
  expect(sha(videoBytes)).toBe("4f46bf904a42c7d3acd0cda9d37ccaa2de71dda095a6f91a83c211d5d48f04e7");
});
afterAll(async () => { await pool.end(); });

async function world() {
  const workspaceId = await scalar("INSERT INTO workspace(name) VALUES('synthetic speech acceptance') RETURNING id");
  const projectId = await scalar("INSERT INTO project(workspace_id,title) VALUES($1,'synthetic speech acceptance') RETURNING id", [workspaceId]);
  const story = await chain.createStoryRevision({ workspaceId, projectId, content: { text: "Synthetic acceptance story" }, createdBy: actor, expectedVersion: 1 });
  let review = await chain.transitionReview({ table: "story_revision", workspaceId, revisionId: story.revisionId,
    expectedVersion: story.rowVersion, expectedReviewVersion: 1, to: "IN_REVIEW" });
  await chain.approveStory({ workspaceId, projectId, revisionId: story.revisionId, expectedVersion: review.rowVersion,
    expectedReviewVersion: review.reviewVersion, reviewedBy: actor });
  const episodeId = await scalar("SELECT id FROM episode WHERE workspace_id=$1 AND project_id=$2 AND episode_no=1", [workspaceId, projectId]);
  const script = await chain.createScriptRevision({ workspaceId, projectId, episodeId, sourceStoryRevisionId: story.revisionId,
    content: { text: `INT. ROOM\n${dialogue}\n旁观在门外。` }, createdBy: actor, expectedVersion: await version("episode", episodeId) });
  review = await chain.transitionReview({ table: "script_revision", workspaceId, revisionId: script.revisionId,
    expectedVersion: script.rowVersion, expectedReviewVersion: 1, to: "IN_REVIEW" });
  await chain.approveScript({ workspaceId, episodeId, revisionId: script.revisionId, expectedVersion: review.rowVersion,
    expectedReviewVersion: review.reviewVersion, reviewedBy: actor });
  const characters: Array<{ id: string; revisionId: string; name: string }> = [];
  for (const name of ["林夏", "周晨", "旁观"]) {
    const projectVersion = await version("project", projectId);
    const character = await tx((client) => chain.createTextEntityRevisionInTransaction(client, { kind: "character", workspaceId, projectId,
      name, sourceScriptRevisionId: script.revisionId, content: { description: "Synthetic acceptance character" }, createdBy: actor,
      expectedVersion: projectVersion }));
    characters.push({ id: character.entityId, revisionId: character.revisionId, name });
    const inReview = await tx((client) => chain.reviewTextEntityInTransaction(client, { kind: "character", workspaceId, projectId,
      entityId: character.entityId, revisionId: character.revisionId, expectedVersion: character.rowVersion, expectedReviewVersion: 1,
      to: "IN_REVIEW", reviewedBy: actor }));
    await tx((client) => chain.reviewTextEntityInTransaction(client, { kind: "character", workspaceId, projectId, entityId: character.entityId,
      revisionId: character.revisionId, expectedVersion: inReview.rowVersion, expectedReviewVersion: inReview.reviewVersion, to: "APPROVED", reviewedBy: actor }));
  }
  const episodeVersion = await version("episode", episodeId);
  const scene = await tx((client) => chain.createSceneRevisionInTransaction(client, { workspaceId, projectId, episodeId,
    sourceScriptRevisionId: script.revisionId, ordinal: 1, heading: "INT. ROOM", timeOfDay: "夜", summary: "Synthetic source scene",
    createdBy: actor, expectedVersion: episodeVersion }));
  const sceneReview = await tx((client) => chain.reviewSceneShotInTransaction(client, { kind: "scene", workspaceId, projectId, episodeId,
    sceneId: scene.entityId, revisionId: scene.revisionId, expectedVersion: scene.rowVersion, expectedReviewVersion: 1, to: "IN_REVIEW", reviewedBy: actor }));
  await tx((client) => chain.reviewSceneShotInTransaction(client, { kind: "scene", workspaceId, projectId, episodeId, sceneId: scene.entityId,
    revisionId: scene.revisionId, expectedVersion: sceneReview.rowVersion, expectedReviewVersion: sceneReview.reviewVersion, to: "APPROVED", reviewedBy: actor }));
  const sceneVersion = await version("scene", scene.entityId);
  const shot = await tx(async (client) => {
    const created = await chain.createShotScopedInTransaction(client, { workspaceId, projectId, sceneId: scene.entityId,
      sourceSceneRevisionId: scene.revisionId, ordinal: 1, shotType: "中景", camera: "固定", action: "二人交谈", dialogue,
      promptText: "Synthetic acceptance image prompt", createdBy: actor, expectedVersion: sceneVersion });
    await chain.addShotCharacterReferencesInTransaction(client, { workspaceId, projectId, shotRevisionId: created.revisionId,
      characterRevisionIds: characters.slice(0, 2).map((item) => item.revisionId), role: "speaker" });
    return created;
  });
  const shotReview = await tx((client) => chain.reviewSceneShotInTransaction(client, { kind: "shot", workspaceId, projectId, episodeId,
    sceneId: scene.entityId, shotId: shot.entityId, revisionId: shot.revisionId, expectedVersion: shot.rowVersion,
    expectedReviewVersion: 1, to: "IN_REVIEW", reviewedBy: actor }));
  await tx((client) => chain.reviewSceneShotInTransaction(client, { kind: "shot", workspaceId, projectId, episodeId, sceneId: scene.entityId,
    shotId: shot.entityId, revisionId: shot.revisionId, expectedVersion: shotReview.rowVersion, expectedReviewVersion: shotReview.reviewVersion,
    to: "APPROVED", reviewedBy: actor }));
  const providerId = await scalar(`INSERT INTO provider_configuration(workspace_id,provider_key,capability,default_timeout_ms,max_attempts)
    VALUES($1,'dashscope-media','audio.tts',30000,1) RETURNING id`, [workspaceId]);
  const videoProviderId = await scalar(`INSERT INTO provider_configuration(workspace_id,provider_key,capability,default_timeout_ms,max_attempts)
    VALUES($1,'dashscope-media','video.generate',30000,1) RETURNING id`, [workspaceId]);
  const voice = (voiceId: string): SpeechVoice => ({ catalogVoiceId: `dashscope:${voiceId}`, name: `Synthetic preset ${voiceId}`,
    providerConfigurationId: providerId, providerConfigurationVersion: "synthetic-v1", providerKey: "dashscope-media", model: "qwen3-tts-flash",
    modelVersion: "synthetic-v1", voiceId, locale: "zh-CN", rightsRef: "synthetic-acceptance-no-provider-call",
    capabilities: { emotions: ["neutral"], speedMin: 1, speedMax: 1, maxTextCharacters: 600 } });
  const bindings: SpeechBinding[] = [];
  for (const [index, character] of characters.entries()) {
    const selected = voice(["Cherry", "Ethan", "Serena"][index]!);
    bindings.push(await speech.putBinding(workspaceId, projectId, character.id, selected,
      { catalogVersion: "synthetic-catalog-v1", catalogVoiceId: selected.catalogVoiceId }, 0, context()));
  }
  return { workspaceId, projectId, episodeId, sceneId: scene.entityId, shotId: shot.entityId, shotRevisionId: shot.revisionId,
    providerId, videoProviderId, characters, bindings, voice };
}
type World = Awaited<ReturnType<typeof world>>;
function planBody(w: World): SpeechPlanPut {
  return { sourceDialogueHash: speechDialogueHash(dialogue), timingPolicy: "sequential-reject-overflow", lines: sourceTexts.map((displayText, index) => ({
    lineId: randomUUID(), speakerBindingRevisionId: w.bindings[index]!.currentRevision.id, sourceStart: dialogue.indexOf(displayText),
    sourceEnd: dialogue.indexOf(displayText) + displayText.length, displayText, emotion: "neutral", speed: 1, pauseAfterMs: index === 0 ? 300 : 0,
  })) };
}
function lineBody(value: SpeechPlanLineInput): SpeechPlanLineInput {
  return { lineId: value.lineId, speakerBindingRevisionId: value.speakerBindingRevisionId, sourceStart: value.sourceStart,
    sourceEnd: value.sourceEnd, displayText: value.displayText, emotion: value.emotion, speed: value.speed, pauseAfterMs: value.pauseAfterMs };
}
async function savePlan(w: World, body = planBody(w), expectedVersion = 0, key = randomUUID()) {
  return speech.putPlan(w.workspaceId, w.shotRevisionId, body, expectedVersion, context(key));
}
function planId(plan: SpeechPlanView): string {
  if (!plan.currentRevision) throw new Error("Saved plan revision missing");
  return plan.currentRevision.id;
}
function wav(durationMs: number): Buffer {
  const sampleRate = 48_000, channels = 2, bytesPerSample = 2, dataLength = durationMs * sampleRate * channels * bytesPerSample / 1000;
  if (!Number.isSafeInteger(dataLength) || dataLength < 1) throw new Error("Invalid synthetic WAV duration");
  const bytes = Buffer.alloc(44 + dataLength);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(36 + dataLength, 4); bytes.write("WAVE", 8); bytes.write("fmt ", 12);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(channels, 22); bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * channels * bytesPerSample, 28); bytes.writeUInt16LE(channels * bytesPerSample, 32);
  bytes.writeUInt16LE(bytesPerSample * 8, 34); bytes.write("data", 36); bytes.writeUInt32LE(dataLength, 40);
  return bytes;
}
async function queued(w: World, kind: "MEDIA_TTS" | "MEDIA_VIDEO" | "MEDIA_COMPOSE", snapshot: Record<string, unknown>, providerId: string | null,
  validate?: (client: PoolClient) => Promise<void>) {
  const key = randomUUID();
  const created = await jobs.createAndQueueWorkflowJob({ workspaceId: w.workspaceId, actorId: actor, httpMethod: "POST",
    routeKey: `/speech-acceptance/${w.shotRevisionId}/${kind}`, key, requestHash: speechExactHash(snapshot), expiresAt: new Date("9999-12-31T00:00:00Z") }, async (client) => {
    await validate?.(client);
    return { workspaceId: w.workspaceId, projectId: w.projectId, sourceShotRevisionId: w.shotRevisionId, type: kind, kind,
      requestedBy: actor, inputHash: speechExactHash(snapshot), inputSnapshot: snapshot, traceId: "speech-acceptance" };
  });
  const leaseOwner = `synthetic-owner:${key}`;
  const attempt = await jobs.acquireQueuedJob({ workspaceId: w.workspaceId, jobId: created.body.jobId, dispatchSeq: created.body.dispatchSeq,
    providerConfigurationId: providerId, leaseOwner, leaseMs: 120_000, traceId: "speech-acceptance" });
  if (!attempt) throw new Error("Synthetic Job attempt was not acquired");
  const providerRequestId = providerId ? `synthetic-${kind.toLowerCase()}-${randomUUID()}` : null;
  if (providerId) await jobs.attachProviderRequest({ workspaceId: w.workspaceId, attemptId: attempt.attemptId,
    providerConfigurationId: providerId, providerRequestId: providerRequestId! });
  return { jobId: created.body.jobId, attemptId: attempt.attemptId, providerRequestId, leaseOwner };
}
async function prepareTake(w: World, plan: SpeechPlanView, index: number, durationMs = 1000) {
  const line = plan.currentRevision!.lines[index]!;
  const input = await speech.generationInput(w.workspaceId, planId(plan), line.lineId);
  const snapshot = { schema: "real-media.v1", capability: "audio.tts", sourceText: input.spokenText,
    speech: input, syntheticAcceptance: "no-provider-call" };
  const job = await queued(w, "MEDIA_TTS", snapshot, w.providerId, (client) => assertSpeechGenerationInputInTransaction(client, input));
  const bytes = wav(durationMs);
  return { ...job, input, bytes, durationMs };
}
type PreparedTake = Awaited<ReturnType<typeof prepareTake>>;
async function finishTake(w: World, prepared: PreparedTake, overrides: { speechInput?: SpeechGenerationInput; mimeType?: string; width?: number; height?: number } = {}) {
  const checksumSha256 = sha(prepared.bytes);
  return assets.completeAttemptWithAsset(jobs, { workspaceId: w.workspaceId, projectId: w.projectId, generationJobId: prepared.jobId,
    sourceJobAttemptId: prepared.attemptId, sourceShotRevisionId: w.shotRevisionId, providerConfigurationId: w.providerId,
    providerRequestId: prepared.providerRequestId!, kind: "AUDIO", storageProvider: "s3",
    objectKey: `real-media/${w.workspaceId}/${w.projectId}/${prepared.jobId}/${prepared.attemptId}/${checksumSha256}.wav`,
    mimeType: overrides.mimeType ?? "audio/wav", byteSize: prepared.bytes.length, checksumSha256, durationMs: prepared.durationMs,
    ...(overrides.width !== undefined ? { width: overrides.width, height: overrides.height } : {}),
    traceId: "speech-acceptance", metadata: { schema: "real-media.asset.v1", syntheticAcceptance: "silent-wav-no-provider-call", sampleRate: 48000, channels: 2 },
    afterPersist: (client, asset) => commitSpeechTake(client, { workspaceId: w.workspaceId, projectId: w.projectId, assetId: asset.id,
      jobId: prepared.jobId, attemptId: prepared.attemptId, speechInput: overrides.speechInput ?? prepared.input }) });
}
async function take(w: World, plan: SpeechPlanView, index: number, durationMs = 1000): Promise<MediaAssetRecord> {
  const result = await finishTake(w, await prepareTake(w, plan, index, durationMs));
  if (!result) throw new Error("Synthetic audio completion was canceled");
  return result;
}
async function video(w: World): Promise<MediaAssetRecord> {
  const job = await queued(w, "MEDIA_VIDEO", { schema: "real-media.v1", capability: "video.generate", syntheticAcceptance: "offline-lavfi-no-provider-call" }, w.videoProviderId,
    async (client) => { await assets.prepareRealShotGenerationInTransaction(client, w.workspaceId, w.projectId, w.shotRevisionId, "video.generate"); });
  const checksumSha256 = sha(videoBytes);
  const result = await assets.completeAttemptWithAsset(jobs, { workspaceId: w.workspaceId, projectId: w.projectId, generationJobId: job.jobId,
    sourceJobAttemptId: job.attemptId, sourceShotRevisionId: w.shotRevisionId, providerConfigurationId: w.videoProviderId,
    providerRequestId: job.providerRequestId!, kind: "VIDEO", storageProvider: "s3", mimeType: "video/mp4", width: 180, height: 320,
    byteSize: videoBytes.length, checksumSha256, durationMs: 15_000,
    objectKey: `real-media/${w.workspaceId}/${w.projectId}/${job.jobId}/${job.attemptId}/${checksumSha256}.mp4`,
    traceId: "speech-acceptance", metadata: { schema: "real-media.asset.v1", syntheticAcceptance: "offline-lavfi-no-provider-call" } });
  if (!result) throw new Error("Synthetic video completion was canceled");
  return result;
}
async function select(w: World, plan: SpeechPlanView, index: number, asset: MediaAssetRecord, expectedVersion?: number) {
  const current = expectedVersion ?? (await speech.takes(w.workspaceId, planId(plan))).rowVersion;
  return speech.select(w.workspaceId, planId(plan), plan.currentRevision!.lines[index]!.lineId,
    { takeAssetId: asset.id, expectedTakeChecksumSha256: asset.checksumSha256 }, current, context());
}
async function changeVoice(w: World, index: number, voiceId: string, expectedVersion?: number) {
  const binding = (await speech.bindings(w.workspaceId, w.projectId)).items.find((item) => item.speakerId === w.characters[index]!.id)!;
  const impact = await speech.bindingImpact(w.workspaceId, w.projectId, binding.speakerId);
  const voice = w.voice(voiceId);
  return speech.putBinding(w.workspaceId, w.projectId, binding.speakerId, voice,
    { catalogVersion: "synthetic-catalog-v1", catalogVoiceId: voice.catalogVoiceId, expectedImpactHash: impact.inputHash }, expectedVersion ?? binding.rowVersion, context());
}
async function preflight(w: World, plan: SpeechPlanView, videoAsset: MediaAssetRecord): Promise<SpeechMixPreflight> {
  return speech.mixPreflight(w.workspaceId, planId(plan), { videoAssetId: videoAsset.id, musicAssetId: null, originalAudio: "mute", musicGain: 0.25, ducking: true });
}
async function selectedWorld() {
  const w = await world(), plan = await savePlan(w);
  const first = await take(w, plan, 0, 1000), second = await take(w, plan, 1, 2000), picture = await video(w);
  await select(w, plan, 0, first); await select(w, plan, 1, second);
  return { w, plan, first, second, picture };
}
async function composite(w: World, input: SpeechMixPreflight): Promise<string> {
  const job = await queued(w, "MEDIA_COMPOSE", { schema: "speech.acceptance.local-output.v1", manifest: input.manifest, syntheticAcceptance: true }, null);
  const checksum = sha(videoBytes);
  const result = await jobs.succeedJobWithArtifact({ workspaceId: w.workspaceId, jobId: job.jobId, attemptId: job.attemptId,
    traceId: "speech-acceptance", beforeLock: (client) => assertSpeechMixManifestInTransaction(client, input.manifest),
    persistArtifact: async (client) => {
      const assetId = String((await client.query<{ id: string }>(`INSERT INTO asset(workspace_id,project_id,kind,storage_provider,object_key,mime_type,
        byte_size,checksum_sha256,width,height,duration_ms,source_kind,source_job_attempt_id,source_generation_job_id,source_shot_revision_id,metadata_json)
        VALUES($1,$2,'COMPOSITE','local-compose',$3,'video/mp4',$4,$5,180,320,15000,'LOCAL_JOB',$6,$7,$8,$9::jsonb) RETURNING id`,
      [w.workspaceId, w.projectId, `compose/${w.workspaceId}/${w.projectId}/${job.jobId}/${job.attemptId}/${checksum}.mp4`, videoBytes.length, checksum,
        job.attemptId, job.jobId, w.shotRevisionId, JSON.stringify({ schema: "speech.acceptance.composite.v1", syntheticAcceptance: "lavfi-byte-placeholder-no-render", manifest: input.manifest })])).rows[0]!.id);
      await commitSpeechMixDependencies(client, assetId, input.manifest);
      await client.query("INSERT INTO asset_dependency(workspace_id,project_id,dependent_asset_id,source_asset_id) VALUES($1,$2,$3,$4)", [w.workspaceId, w.projectId, assetId, input.manifest.videoAssetId]);
      return { id: assetId };
    } });
  if (!result) throw new Error("Synthetic composite completion was canceled");
  return result.id;
}

/** Quotes here are frozen fixture metadata, never provider prices, budget approvals or paid-call evidence. */
async function batchSnapshot(w: World, lineInputRevisionIds?: string[]) {
  const { inventory, inputs } = await tx((client) => speechBatchInventoryInTransaction(client, w.workspaceId, w.projectId, w.episodeId, true));
  const request: SpeechBatchPreflightRequest = { sourceHash: inventory.sourceHash,
    lineInputRevisionIds: lineInputRevisionIds ?? inventory.lines.filter((item) => item.status === "missing").map((item) => item.lineInputRevisionId) };
  const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const operations: SpeechBatchFrozenOperation[] = request.lineInputRevisionIds.map((lineInputRevisionId) => {
    const input = inputs.get(lineInputRevisionId);
    if (!input) throw new Error("Synthetic batch input missing from source inventory");
    return { id: randomUUID(), input, idempotencyKey: randomUUID(), quote: { quoteId: randomUUID(), inputHash: input.inputHash,
      currency: "CNY", estimatedAmount: "0.10", maximumAmount: "0.20", expiresAt, providerConfigurationId: w.providerId,
      providerConfigurationVersion: "synthetic-v1", priceVersion: "synthetic-no-provider-call", uncertainJobIds: [] } };
  });
  const frozen: SpeechBatchFrozen = { schema: SPEECH_BATCH_SCHEMA, projectId: w.projectId, episodeId: w.episodeId,
    sourceHash: inventory.sourceHash, operations, budgets: speechBatchBudgets(operations), expiresAt };
  return { request, frozen };
}
function batchConfirmation(frozen: SpeechBatchFrozen): SpeechBatchConfirmation {
  return { frozenHash: speechExactHash(frozen), maximumJobs: frozen.operations.length,
    budgets: frozen.budgets.map(({ currency, maximumAmount }) => ({ currency, maximumAmount })),
    confirmPossibleCharges: true, confirmedUncertainJobIds: [] };
}

describe("speech character-voice draft in an explicitly authorized new empty PostgreSQL database", () => {
  it("applies only the explicit voice/batch drafts, verifies readiness and leaves ordinary migration discovery unchanged", async () => {
    expect(beforeDraft).toBe(false); expect(await speech.storageReady()).toBe(true);
    expect(batchBeforeDraft).toBe(false); expect(await batches.storageReady()).toBe(true);
    expect(discovered.some((name) => /speech|character_voice|real_media/.test(name))).toBe(false);
    expect((await runMigrations(pool)).applied).toEqual([]);
    expect((await pool.query("SELECT name FROM schema_migration WHERE name LIKE '%character_voice%' OR name LIKE '%real_media%' OR name LIKE '%speech_batch%' ")).rowCount).toBe(0);
    expect((await pool.query("SELECT to_regclass('real_media_submission') AS media, to_regclass('speech_voice_binding') AS speech")).rows[0]).toMatchObject({ media: null, speech: "speech_voice_binding" });
  });

  it("preserves raw Unicode/CRLF source spans and rejects omission, normalized replacements and speakers outside the shot/project", async () => {
    const w = await world(), request = planBody(w), other = await world();
    expect((await speech.plan(w.workspaceId, w.shotRevisionId)).sourceDialogue).toBe(dialogue);
    const normalizedHash = { ...request, sourceDialogueHash: speechDialogueHash(dialogue.replace(/\r\n/g, "\n")) };
    await expect(savePlan(w, normalizedHash)).rejects.toMatchObject({ code: "SPEECH_SOURCE_CHANGED" });
    const normalized = structuredClone(request); normalized.lines[1]!.displayText = normalized.lines[1]!.displayText.normalize("NFC");
    await expect(savePlan(w, normalized)).rejects.toMatchObject({ code: "SPEECH_SOURCE_MISMATCH" });
    await expect(savePlan(w, { ...request, lines: request.lines.slice(0, 1) })).rejects.toMatchObject({ code: "SPEECH_SOURCE_MISMATCH" });
    for (const badVoice of [w.bindings[2]!.currentRevision.id, other.bindings[0]!.currentRevision.id]) {
      const wrong = structuredClone(request); wrong.lines[0]!.speakerBindingRevisionId = badVoice;
      await expect(savePlan(w, wrong)).rejects.toMatchObject({ code: "SPEECH_VOICE_STALE" });
    }
    const splitEmoji = structuredClone(request); splitEmoji.lines[0]!.sourceEnd = dialogue.indexOf("🙂") + 1;
    splitEmoji.lines[0]!.displayText = dialogue.slice(splitEmoji.lines[0]!.sourceStart, splitEmoji.lines[0]!.sourceEnd);
    await expect(savePlan(w, splitEmoji)).rejects.toMatchObject({ code: "SPEECH_SOURCE_MISMATCH" });
    await expect(speech.putBinding(w.workspaceId, w.projectId, other.characters[0]!.id, w.voice("Cherry"),
      { catalogVersion: "synthetic-catalog-v1", catalogVoiceId: "dashscope:Cherry" }, 0, context())).rejects.toMatchObject({ code: "NOT_FOUND" });
    const saved = await savePlan(w, request);
    expect(saved.currentRevision!.lines.map((item) => item.displayText)).toEqual(sourceTexts);
    expect(saved.sourceDialogueHash).toBe(speechDialogueHash(dialogue));
  });

  it("permanently replays one concurrent same-key plan write and rejects a changed exact payload", async () => {
    const w = await world(), request = planBody(w), key = randomUUID();
    const [first, second] = await Promise.all([savePlan(w, request, 0, key), savePlan(w, request, 0, key)]);
    expect(planId(first)).toBe(planId(second)); expect(first.rowVersion).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM speech_plan_revision WHERE workspace_id=$1", [w.workspaceId])).rows[0]!.n).toBe(1);
    const changed = structuredClone(request); changed.lines[0]!.pauseAfterMs += 1;
    await expect(savePlan(w, changed, 0, key)).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    await changeVoice(w, 0, "Serena");
    expect(planId(await savePlan(w, request, 0, key))).toBe(planId(first));
    const receipt = (await pool.query("SELECT expires_at FROM idempotency_record WHERE workspace_id=$1 AND idempotency_key=$2", [w.workspaceId, key])).rows[0]!;
    expect(new Date(receipt.expires_at).getUTCFullYear()).toBe(9999);
    expect((await pool.query("SELECT count(*)::int AS n FROM generation_job WHERE workspace_id=$1", [w.workspaceId])).rows[0]!.n).toBe(0);
  });

  it("versions voices with CAS, preserves no-op identities, and reuses unchanged line inputs when only arrangement changes", async () => {
    const w = await world(), request = planBody(w), plan = await savePlan(w, request);
    const same = await speech.putBinding(w.workspaceId, w.projectId, w.characters[0]!.id, w.voice("Cherry"),
      { catalogVersion: "synthetic-catalog-v1", catalogVoiceId: "dashscope:Cherry" }, 1, context());
    expect(same.currentRevision.id).toBe(w.bindings[0]!.currentRevision.id); expect(same.rowVersion).toBe(1);
    await expect(changeVoice(w, 0, "Serena", 0)).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    const replayPlan = await savePlan(w, request, plan.rowVersion);
    expect(planId(replayPlan)).toBe(planId(plan)); expect(replayPlan.rowVersion).toBe(plan.rowVersion);
    const rearranged = structuredClone(request); rearranged.lines.reverse(); rearranged.lines[0]!.pauseAfterMs = 800;
    const next = await savePlan(w, rearranged, plan.rowVersion);
    expect(planId(next)).not.toBe(planId(plan));
    expect(next.currentRevision!.lines.map((item) => item.lineInputRevisionId).sort()).toEqual(plan.currentRevision!.lines.map((item) => item.lineInputRevisionId).sort());
    const changed = await changeVoice(w, 0, "Serena");
    expect(changed.rowVersion).toBe(2); expect(changed.currentRevision.id).not.toBe(same.currentRevision.id);
    expect((await pool.query("SELECT count(*)::int AS n FROM speech_voice_revision WHERE binding_id=$1", [same.id])).rows[0]!.n).toBe(2);
    await expect(speech.generationInput(w.workspaceId, planId(next), request.lines[0]!.lineId)).rejects.toMatchObject({ code: "SPEECH_VOICE_STALE" });
  });

  it("binds AUDIO to the exact real Job/Attempt/frozen input, rejects MIME/dimension swaps, and stales a late old-voice take", async () => {
    const w = await world(), plan = await savePlan(w), prepared = await prepareTake(w, plan, 0, 1000);
    const otherInput = await speech.generationInput(w.workspaceId, planId(plan), plan.currentRevision!.lines[1]!.lineId);
    await expect(finishTake(w, prepared, { speechInput: otherInput })).rejects.toMatchObject({ code: "SPEECH_TAKE_INVALID" });
    await expect(finishTake(w, prepared, { mimeType: "audio/mpeg" })).rejects.toMatchObject({ code: "SPEECH_TAKE_INVALID" });
    await expect(finishTake(w, prepared, { width: 180, height: 320 })).rejects.toMatchObject({ code: "SPEECH_TAKE_INVALID" });
    expect((await pool.query("SELECT count(*)::int AS n FROM asset WHERE source_generation_job_id=$1", [prepared.jobId])).rows[0]!.n).toBe(0);
    const accepted = await finishTake(w, prepared); expect(accepted).not.toBeNull();
    expect(accepted).toMatchObject({ kind: "AUDIO", mimeType: "audio/wav", width: null, height: null, reviewStatus: "DRAFT", durationMs: 1000 });
    const lineage = (await pool.query(`SELECT t.job_id,t.attempt_id,j.state,at.finished_at IS NOT NULL AS finished,a.provider_request_id
      FROM speech_take t JOIN asset a ON a.id=t.asset_id JOIN generation_job j ON j.id=t.job_id JOIN job_attempt at ON at.id=t.attempt_id WHERE t.asset_id=$1`, [accepted!.id])).rows[0]!;
    expect(lineage).toMatchObject({ job_id: prepared.jobId, attempt_id: prepared.attemptId, state: "SUCCEEDED", finished: true, provider_request_id: prepared.providerRequestId });
    expect(String(lineage.provider_request_id).startsWith("mock-media|")).toBe(false);
    await expect(tx((client) => commitSpeechTake(client, { workspaceId: w.workspaceId, projectId: w.projectId, assetId: accepted!.id,
      jobId: randomUUID(), attemptId: prepared.attemptId, speechInput: prepared.input }))).rejects.toMatchObject({ code: "SPEECH_TAKE_INVALID" });
    const late = await prepareTake(w, plan, 0, 1200);
    await changeVoice(w, 0, "Serena");
    const historical = await finishTake(w, late); expect(historical).not.toBeNull();
    expect(await assetState(historical!.id)).toEqual({ status: "STALE", review_status: "DRAFT" });
    expect((await speech.takes(w.workspaceId, planId(plan))).selected).toEqual([]);
    await expect(tx((client) => assertSpeechGenerationInputInTransaction(client, late.input))).rejects.toMatchObject({ code: "SPEECH_VOICE_STALE" });
    expect(await speech.generationInput(w.workspaceId, planId(plan), late.input.lineId, true)).toEqual(late.input);
  });

  it("reads selected audio outside the newest candidate page and serializes competing selections under one plan CAS", async () => {
    const w = await world(), plan = await savePlan(w), original = await take(w, plan, 0, 100);
    await select(w, plan, 0, original);
    for (let start = 0; start < 100; start += 4) await Promise.all(Array.from({ length: 4 }, (_, index) => take(w, plan, 0, 120 + start + index)));
    const firstPage = await speech.takes(w.workspaceId, planId(plan));
    expect(firstPage.items).toHaveLength(100); expect(firstPage.hasMore).toBe(true); expect(firstPage.items.some((item) => item.assetId === original.id)).toBe(false);
    expect(firstPage.selected).toEqual([expect.objectContaining({ takeAssetId: original.id, usable: true })]);
    const secondPage = await speech.takes(w.workspaceId, planId(plan), firstPage.nextCursor!);
    expect(secondPage.items.map((item) => item.assetId)).toEqual([original.id]); expect(secondPage.hasMore).toBe(false);
    expect(secondPage.selected[0]!.takeAssetId).toBe(original.id);
    const foreign = await selectedWorld();
    await expect(speech.takes(w.workspaceId, planId(plan), foreign.first.id)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const competitors = firstPage.items.slice(0, 2), expectedVersion = firstPage.rowVersion;
    const results = await Promise.allSettled(competitors.map((candidate) => speech.select(w.workspaceId, planId(plan), plan.currentRevision!.lines[0]!.lineId,
      { takeAssetId: candidate.assetId, expectedTakeChecksumSha256: candidate.checksumSha256 }, expectedVersion, context())));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ status: "rejected", reason: { code: "REVISION_CONFLICT" } });
  });

  it("builds measured sentence VTT, rejects overflow and forged manifests, and inherits unchanged takes across new arrangements", async () => {
    const { w, plan, picture } = await selectedWorld();
    const checked = await preflight(w, plan, picture);
    expect(checked.manifest.totalSpeechMs).toBe(3300);
    expect(checked.manifest.lines.map((item) => [item.startMs, item.endMs])).toEqual([[0, 1000], [1300, 3300]]);
    expect(checked.subtitleVtt).toContain("00:00:01.300 --> 00:00:03.300\ne\u0301再见。");
    expect(checked.manifest.subtitles.checksumSha256).toBe(speechDialogueHash(checked.subtitleVtt));
    expect(checked.inputHash).toBe(speechExactHash(checked.manifest));
    await tx((client) => assertSpeechMixManifestInTransaction(client, checked.manifest));
    for (const mutate of [(value: SpeechMixManifest) => { value.lines.pop(); }, (value: SpeechMixManifest) => { value.lines[0]!.endMs -= 1; },
      (value: SpeechMixManifest) => { value.subtitles.cues[0]!.text = "伪造台词"; }, (value: SpeechMixManifest) => { value.videoDurationMs += 1000; }]) {
      const forged = structuredClone(checked.manifest); mutate(forged);
      await expect(tx((client) => assertSpeechMixManifestInTransaction(client, forged))).rejects.toMatchObject({ code: "SPEECH_SELECTION_STALE" });
    }
    const current = await speech.plan(w.workspaceId, w.shotRevisionId);
    const rearranged: SpeechPlanPut = { sourceDialogueHash: current.sourceDialogueHash, timingPolicy: "sequential-reject-overflow",
      lines: [...current.currentRevision!.lines].reverse().map(lineBody) };
    const updated = await savePlan(w, rearranged, current.rowVersion);
    const inherited = (await speech.takes(w.workspaceId, planId(updated))).selected;
    expect(inherited).toHaveLength(2);
    expect(inherited.every((item) => item.inheritedFromSelectionId !== null && item.usable === true)).toBe(true);
    await expect(tx((client) => assertSpeechMixManifestInTransaction(client, checked.manifest))).rejects.toMatchObject({ code: "SPEECH_PLAN_STALE" });
    expect((await preflight(w, updated, picture)).manifest.lines[0]!.displayText).toBe(sourceTexts[1]);
    const tooLong = await take(w, updated, 0, 16_000); await select(w, updated, 0, tooLong);
    await expect(preflight(w, updated, picture)).rejects.toMatchObject({ code: "SPEECH_AUDIO_OVERFLOW", overflowMs: 2300 });
  });

  it("stales typed dependent composites on selection and voice changes while retaining audio history and confirmed lineage", async () => {
    const { w, plan, first, picture } = await selectedWorld();
    const oldMix = await preflight(w, plan, picture), oldComposite = await composite(w, oldMix);
    const alternate = await take(w, plan, 0, 1100); await select(w, plan, 0, alternate);
    expect((await assetState(oldComposite)).status).toBe("STALE"); expect((await assetState(first.id)).status).toBe("ACTIVE");
    const newMix = await preflight(w, plan, picture), newComposite = await composite(w, newMix);
    const impact = await speech.bindingImpact(w.workspaceId, w.projectId, w.characters[0]!.id);
    expect(impact).toMatchObject({ affectedLines: 1, affectedShots: 1, affectedAssets: 1 });
    await changeVoice(w, 0, "Serena");
    expect((await assetState(newComposite)).status).toBe("STALE"); expect((await assetState(alternate.id)).status).toBe("STALE");
    expect((await speech.takes(w.workspaceId, planId(plan))).selected.find((item) => item.lineId === plan.currentRevision!.lines[0]!.lineId)).toMatchObject({ takeAssetId: alternate.id, usable: false });
    const typed = (await pool.query(`SELECT (SELECT count(*)::int FROM speech_mix_dependency WHERE dependent_asset_id=$1) AS plans,
      (SELECT count(*)::int FROM speech_mix_selection_dependency WHERE dependent_asset_id=$1) AS selections,
      (SELECT count(*)::int FROM asset_dependency WHERE dependent_asset_id=$1) AS assets`, [newComposite])).rows[0]!;
    expect(typed).toEqual({ plans: 1, selections: 2, assets: 3 });
    expect((await pool.query("SELECT count(*)::int AS n FROM speech_take WHERE asset_id=ANY($1::uuid[])", [[first.id, alternate.id]])).rows[0]!.n).toBe(2);
  });

  it("enforces immutable SQL history, exact slot/input FKs, project scope, pointer ownership, version advancement and AUDIO approval prohibition", async () => {
    const { w, plan, first } = await selectedWorld(), other = await world();
    const slotRows = await pool.query<{ id: string; line_id: string; current_selection_id: string; line_input_revision_id: string }>(
      "SELECT id,line_id,current_selection_id,line_input_revision_id FROM speech_selection_slot WHERE plan_revision_id=$1 ORDER BY line_id", [planId(plan)]);
    const slotOne = slotRows.rows[0]!, slotTwo = slotRows.rows[1]!;
    await expect(pool.query("UPDATE speech_voice_revision SET voice_json='{}'::jsonb WHERE id=$1", [w.bindings[0]!.currentRevision.id])).rejects.toThrow(/immutable/);
    await expect(pool.query("DELETE FROM speech_selection WHERE id=$1", [slotOne.current_selection_id])).rejects.toThrow(/immutable/);
    await expect(pool.query("UPDATE speech_plan SET row_version=row_version WHERE workspace_id=$1", [w.workspaceId])).rejects.toThrow(/version must advance/);
    await expect(pool.query("UPDATE speech_selection_slot SET line_input_revision_id=$1 WHERE id=$2", [slotTwo.line_input_revision_id, slotOne.id])).rejects.toThrow(/identity is immutable/);
    await expect(pool.query("UPDATE speech_selection_slot SET current_selection_id=$1 WHERE id=$2", [slotTwo.current_selection_id, slotOne.id])).rejects.toMatchObject({ code: "23503" });
    const otherPlan = await savePlan(other);
    await expect(pool.query("UPDATE speech_plan SET current_revision_id=$1,row_version=row_version+1 WHERE workspace_id=$2", [planId(otherPlan), w.workspaceId])).rejects.toMatchObject({ code: "23503" });
    await expect(pool.query(`INSERT INTO speech_voice_binding(workspace_id,project_id,speaker_id,character_id) VALUES($1,$2,$3::text,$4::uuid)`,
      [w.workspaceId, w.projectId, other.characters[0]!.id, other.characters[0]!.id])).rejects.toMatchObject({ code: "23503" });
    const wrongTake = (await speech.takes(w.workspaceId, planId(plan))).selected.find((item) => item.lineId === slotTwo.line_id)!;
    await expect(pool.query(`INSERT INTO speech_selection(workspace_id,project_id,slot_id,take_asset_id,line_input_revision_id,checksum_sha256,selected_by)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [w.workspaceId, w.projectId, slotOne.id, wrongTake.takeAssetId, slotTwo.line_input_revision_id, wrongTake.checksumSha256, actor])).rejects.toMatchObject({ code: "23503" });
    await expect(pool.query(`UPDATE asset SET review_status='APPROVED',reviewed_by=$2,reviewed_at=now(),reviewed_content_hash=checksum_sha256,row_version=row_version+1 WHERE id=$1`,
      [first.id, actor])).rejects.toMatchObject({ code: "23514" });
    expect((await assetState(first.id)).review_status).toBe("DRAFT");
  });

  it("inventories every episode source blocker and preserves the source hash while jobs, candidates and selections progress", async () => {
    const w = await world();
    const inventory = () => tx((client) => speechBatchInventoryInTransaction(client, w.workspaceId, w.projectId, w.episodeId, true));
    const missingPlan = await inventory();
    expect(missingPlan.inventory.lines).toEqual([]);
    expect(missingPlan.inventory.blockers).toEqual([expect.objectContaining({ shotRevisionId: w.shotRevisionId, code: "SPEECH_PLAN_MISSING" })]);
    const plan = await savePlan(w), pending = await inventory();
    expect(pending.inventory.blockers).toEqual([]);
    expect(pending.inventory.lines.map((item) => item.status)).toEqual(["missing", "missing"]);
    expect(pending.inputs.size).toBe(2);
    expect(pending.inventory.lines.map((item) => item.displayText)).toEqual(sourceTexts);
    const prepared = await prepareTake(w, plan, 0), running = await inventory();
    expect(running.inventory.sourceHash).toBe(pending.inventory.sourceHash);
    expect(running.inventory.lines[0]).toMatchObject({ status: "in_progress", jobIds: [prepared.jobId] });
    const accepted = await finishTake(w, prepared);
    if (!accepted) throw new Error("Synthetic candidate completion was canceled");
    const candidates = await inventory();
    expect(candidates.inventory.sourceHash).toBe(pending.inventory.sourceHash);
    expect(candidates.inventory.lines[0]).toMatchObject({ status: "awaiting_selection", jobIds: [] });
    await select(w, plan, 0, accepted);
    const selected = await inventory();
    expect(selected.inventory.sourceHash).toBe(pending.inventory.sourceHash);
    expect(selected.inventory.lines.map((item) => item.status)).toEqual(["selected", "missing"]);
    const scriptId = await scalar(`SELECT script_revision_id AS id FROM script_revision_consumer_source
      WHERE workspace_id=$1 AND project_id=$2 AND consumer_type='scene_revision'
      AND consumer_revision_id=(SELECT current_revision_id FROM scene WHERE id=$3)`, [w.workspaceId, w.projectId, w.sceneId]);
    const episodeVersion = await version("episode", w.episodeId);
    await tx((client) => chain.createSceneRevisionInTransaction(client, { workspaceId: w.workspaceId, projectId: w.projectId,
      episodeId: w.episodeId, sourceScriptRevisionId: scriptId, ordinal: 2, heading: "INT. EMPTY ROOM", timeOfDay: "夜",
      summary: "An explicit scene with no saved shots is a blocker", createdBy: actor, expectedVersion: episodeVersion }));
    const incomplete = await inventory();
    expect(incomplete.inventory.lines).toHaveLength(2);
    expect(incomplete.inventory.blockers).toContainEqual(expect.objectContaining({ shotRevisionId: null, code: "SPEECH_BATCH_SHOTS_MISSING" }));
    expect(incomplete.inventory.sourceHash).not.toBe(pending.inventory.sourceHash);
    await expect(tx((client) => speechBatchInventoryInTransaction(client, w.workspaceId, w.projectId, randomUUID(), true))).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("skips existing candidates and permanently replays a concurrent batch preflight key while rejecting changed payloads", async () => {
    const w = await world(), plan = await savePlan(w);
    await take(w, plan, 0);
    const withCandidate = await batchSnapshot(w, [plan.currentRevision!.lines[0]!.lineInputRevisionId]);
    await expect(batches.create(w.workspaceId, w.projectId, w.episodeId, withCandidate.request, withCandidate.frozen, context())).rejects.toMatchObject({ code: "SPEECH_BATCH_LINE_AVAILABLE" });
    const snapshot = await batchSnapshot(w), key = randomUUID();
    expect(snapshot.frozen.operations.map((op) => op.input.lineId)).toEqual([plan.currentRevision!.lines[1]!.lineId]);
    const create = () => batches.create(w.workspaceId, w.projectId, w.episodeId, snapshot.request, snapshot.frozen, context(key));
    const [first, second] = await Promise.all([create(), create()]);
    expect(first.id).toBe(second.id);
    expect(first.frozenHash).toBe(speechExactHash(snapshot.frozen));
    expect(first.operations).toHaveLength(1);
    expect((await batches.list(w.workspaceId, w.projectId, w.episodeId)).items).toHaveLength(1);
    expect((await batches.findPreflight(w.workspaceId, w.projectId, w.episodeId, key, speechExactHash(snapshot.request)))?.id).toBe(first.id);
    const changed = { ...snapshot.request, lineInputRevisionIds: plan.currentRevision!.lines.map((item) => item.lineInputRevisionId) };
    await expect(batches.create(w.workspaceId, w.projectId, w.episodeId, changed, snapshot.frozen, context(key))).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    await changeVoice(w, 0, "Serena");
    expect((await create()).id).toBe(first.id);
    expect((await batches.findPreflight(w.workspaceId, w.projectId, w.episodeId, key, speechExactHash(snapshot.request)))?.id).toBe(first.id);
    expect((await pool.query("SELECT count(*)::int AS n FROM generation_job WHERE workspace_id=$1", [w.workspaceId])).rows[0]!.n).toBe(1);
  });

  it("confirms exact batch budgets, excludes a second active batch, fences expired claims, and atomically binds a real queued job against cancellation", async () => {
    const w = await world(); await savePlan(w);
    const inventory = await batches.inventory(w.workspaceId, w.projectId, w.episodeId);
    const snapshot = await batchSnapshot(w, [inventory.lines[0]!.lineInputRevisionId]);
    const first = await batches.create(w.workspaceId, w.projectId, w.episodeId, snapshot.request, snapshot.frozen, context());
    const alternateSnapshot = await batchSnapshot(w, [inventory.lines[1]!.lineInputRevisionId]);
    const alternate = await batches.create(w.workspaceId, w.projectId, w.episodeId, alternateSnapshot.request, alternateSnapshot.frozen, context());
    const body = batchConfirmation(snapshot.frozen);
    await expect(batches.confirm(w.workspaceId, first.id, { ...body, budgets: [{ currency: "CNY", maximumAmount: "0.20000001" }] }, context())).rejects.toMatchObject({ code: "SPEECH_BATCH_BUDGET_CHANGED" });
    await batches.confirm(w.workspaceId, first.id, body, context());
    await expect(pool.query("UPDATE speech_batch_command SET state='quoted',row_version=row_version+1 WHERE id=$1", [first.id])).rejects.toThrow(/state cannot skip confirmation or reopen/);
    await expect(pool.query("UPDATE speech_batch_command SET confirmed_by='different-actor',row_version=row_version+1 WHERE id=$1", [first.id])).rejects.toThrow(/frozen identity is immutable/);
    await expect(pool.query("UPDATE speech_batch_command SET confirmed_at=confirmed_at+interval '1 second',row_version=row_version+1 WHERE id=$1", [first.id])).rejects.toThrow(/frozen identity is immutable/);
    await expect(pool.query("UPDATE speech_batch_operation SET quote_id=$2,row_version=row_version+1 WHERE id=$1", [first.operations[0]!.id, randomUUID()])).rejects.toThrow(/operation identity is immutable/);
    expect((await batches.read(w.workspaceId, first.id)).confirmation).toEqual(body);
    await expect(batches.confirm(w.workspaceId, alternate.id, batchConfirmation(alternateSnapshot.frozen), context())).rejects.toMatchObject({ code: "SPEECH_BATCH_ACTIVE_EXISTS" });
    const original = await batches.claim(w.workspaceId, first.id, false);
    if (!original) throw new Error("Synthetic batch operation was not claimed");
    await expect(pool.query("UPDATE speech_batch_operation SET state='pending',dispatch_token=NULL,lease_until=NULL,row_version=row_version+1 WHERE id=$1", [original.operation.id])).rejects.toThrow(/state cannot be reset or silently retried/);
    expect(await batches.claim(w.workspaceId, first.id, false)).toBeNull();
    // Only the CI suite waits for this real PostgreSQL lease; this source is not executed during development.
    await new Promise((resolveWait) => setTimeout(resolveWait, 3100));
    const reclaimed = await batches.claim(w.workspaceId, first.id, true);
    if (!reclaimed) throw new Error("Expired synthetic batch claim was not recovered");
    expect(reclaimed.operation.id).toBe(original.operation.id);
    expect(reclaimed.operation.idempotencyKey).toBe(original.operation.idempotencyKey);
    expect(reclaimed.ref.dispatchToken).not.toBe(original.ref.dispatchToken);
    const authorizationId = randomUUID(); // Fixture authorization identity; no real-media budget draft is applied here.
    await batches.recordAuthorization(w.workspaceId, reclaimed.ref, authorizationId);
    const input = { speech: reclaimed.operation.input, quoteId: reclaimed.operation.quote.quoteId,
      budgetAuthorizationId: authorizationId, idempotencyKey: reclaimed.operation.idempotencyKey, actorId: actor };
    await expect(tx((client) => assertSpeechBatchDispatchInTransaction(client, original.ref, input))).rejects.toMatchObject({ code: "SPEECH_BATCH_LEASE_LOST" });
    await expect(tx((client) => assertSpeechBatchDispatchInTransaction(client, undefined, input))).rejects.toMatchObject({ code: "SPEECH_BATCH_CONFIRMATION_CHANGED" });
    let entered!: () => void, release!: () => void, enterFailed!: (reason?: unknown) => void;
    const beforeCancellation = new Promise<void>((resolveEntered, rejectEntered) => { entered = resolveEntered; enterFailed = rejectEntered; });
    const continueCreation = new Promise<void>((resolveContinue) => { release = resolveContinue; });
    const source = reclaimed.operation.input;
    const snapshotJob = { schema: "real-media.v1", capability: "audio.tts", sourceText: source.spokenText,
      speech: source, budget: { authorizationId, quoteId: input.quoteId }, syntheticAcceptance: "no-provider-call" };
    const created = jobs.createAndQueueWorkflowJob({ workspaceId: w.workspaceId, actorId: actor, httpMethod: "POST",
      routeKey: "/speech-batch-acceptance/generate", key: reclaimed.operation.idempotencyKey, requestHash: speechExactHash(snapshotJob), expiresAt: new Date("9999-12-31T00:00:00Z") },
    async (client) => {
      await assertSpeechBatchDispatchInTransaction(client, reclaimed.ref, input);
      entered(); await continueCreation;
      return { workspaceId: w.workspaceId, projectId: w.projectId, sourceShotRevisionId: source.shotRevisionId,
        type: "MEDIA_TTS", kind: "MEDIA_TTS", requestedBy: actor, inputHash: speechExactHash(snapshotJob), inputSnapshot: snapshotJob, traceId: "speech-batch-acceptance" };
    }, (client, job) => bindSpeechBatchJobInTransaction(client, reclaimed.ref, { jobId: job.jobId, workflowRunId: job.workflowRunId }));
    void created.catch(enterFailed);
    await beforeCancellation;
    // Dispatch already holds the project/source lock. Cancel waits, then preserves the job committed with its operation link.
    const cancel = batches.cancel(w.workspaceId, first.id, context());
    release();
    const accepted = await created; await cancel;
    const canceled = await batches.read(w.workspaceId, first.id);
    expect(canceled.cancelRequested).toBe(true);
    expect(canceled.operations[0]).toMatchObject({ state: "job_created", jobId: accepted.body.jobId, workflowRunId: accepted.body.workflowRunId });
    await expect(pool.query("UPDATE speech_batch_command SET state='dispatching',cancel_requested=false,cancel_requested_at=NULL,row_version=row_version+1 WHERE id=$1", [first.id])).rejects.toThrow(/frozen identity is immutable/);
    expect((await pool.query("SELECT state FROM generation_job WHERE id=$1", [accepted.body.jobId])).rows[0]!.state).toBe("QUEUED");
    expect((await pool.query("SELECT count(*)::int AS n FROM generation_job WHERE workspace_id=$1", [w.workspaceId])).rows[0]!.n).toBe(1);
    // A synthetic metadata notice proves the projection reads the real Job row, without claiming a provider call occurred.
    await pool.query("UPDATE generation_job SET error_code='SPEECH_ACCEPTANCE_SYNTHETIC_NOTICE',row_version=row_version+1 WHERE id=$1", [accepted.body.jobId]);
    expect((await batches.read(w.workspaceId, first.id)).operations[0]?.errorCode).toBe("SPEECH_ACCEPTANCE_SYNTHETIC_NOTICE");
    await batches.confirm(w.workspaceId, alternate.id, batchConfirmation(alternateSnapshot.frozen), context());
    const stoppedClaim = await batches.claim(w.workspaceId, alternate.id, false);
    if (!stoppedClaim) throw new Error("The separate unsubmitted operation was not claimed");
    const stoppedAuthorization = randomUUID();
    await batches.recordAuthorization(w.workspaceId, stoppedClaim.ref, stoppedAuthorization);
    await batches.cancel(w.workspaceId, alternate.id, context());
    expect(await batches.claim(w.workspaceId, alternate.id, true)).toBeNull();
    // Here cancel wins the project lock before core consumption, using the formerly valid claim and authorization.
    await expect(tx((client) => assertSpeechBatchDispatchInTransaction(client, stoppedClaim.ref, {
      speech: stoppedClaim.operation.input, quoteId: stoppedClaim.operation.quote.quoteId, budgetAuthorizationId: stoppedAuthorization,
      idempotencyKey: stoppedClaim.operation.idempotencyKey, actorId: actor }))).rejects.toMatchObject({ code: "SPEECH_BATCH_CANCELED" });
    expect((await pool.query("SELECT count(*)::int AS n FROM generation_job WHERE workspace_id=$1", [w.workspaceId])).rows[0]!.n).toBe(1);
    await expect(tx((client) => assertSpeechBatchDispatchInTransaction(client, reclaimed.ref, input))).rejects.toThrow();
    await expect(tx((client) => assertSpeechBatchDispatchInTransaction(client, undefined, input))).rejects.toThrow();
  });
});
