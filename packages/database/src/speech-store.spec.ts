import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import type { SpeechGenerationInput, SpeechVoice, SpeechVoiceRevision } from "@ai-drama/contracts";
import { speechExactHash, speechDialogueHash, speechLineInputHash } from "@ai-drama/domain";
import { PostgresSpeechStore, assertSpeechGenerationInputInTransaction, commitSpeechTake } from "./speech-store";
import type { DatabasePool, JobPersistenceService } from "./job-service";

const uid = (d: string) => `${d.repeat(8)}-${d.repeat(4)}-4${d.repeat(3)}-8${d.repeat(3)}-${d.repeat(12)}`;
const baseVoice: SpeechVoice = { catalogVoiceId: "Cherry", name: "Cherry", providerConfigurationId: uid("1"), providerConfigurationVersion: "v1",
  providerKey: "dashscope-media", model: "qwen3-tts-flash", modelVersion: "v1", voiceId: "Cherry", locale: "zh-CN", rightsRef: "preset-v1",
  capabilities: { emotions: ["neutral"], speedMin: 1, speedMax: 1 } };
const voice: SpeechVoiceRevision = { ...baseVoice, id: uid("2"), bindingId: uid("3"), contentHash: speechExactHash(baseVoice) };
const line = { lineId: uid("4"), lineInputRevisionId: uid("5"), speakerBindingRevisionId: voice.id, displayText: "你来了。", emotion: "neutral", speed: 1, sourceStart: 3, sourceEnd: 7, pauseAfterMs: 0 };
const input: SpeechGenerationInput = { workspaceId: uid("1"), projectId: uid("2"), shotRevisionId: uid("3"), planRevisionId: uid("4"),
  lineId: line.lineId, lineInputRevisionId: line.lineInputRevisionId, inputHash: speechLineInputHash(uid("3"), line, voice),
  displayText: line.displayText, spokenText: line.displayText, voice, emotion: "neutral", speed: 1 };
function client(answer: (sql: string, values: unknown[]) => unknown[]) {
  const query = vi.fn(async (sql: string, values: unknown[] = []) => ({ rows: answer(sql, values), rowCount: 1 }));
  const release = vi.fn();
  return { query, release, client: { query, release } as unknown as PoolClient };
}
function sourceAnswers(sql: string): unknown[] | undefined {
  if (sql.startsWith("SELECT project_id FROM shot_revision")) return [{ project_id: input.projectId }];
  if (sql.startsWith("SELECT id FROM project") || sql.startsWith("SELECT 1 FROM project")) return [{ id: input.projectId }];
  if (sql.includes("information_schema.columns")) return [];
  if (sql.includes("FROM stale_recalculation")) return [];
  if (sql.includes("AS usable, sr.id")) return [{ dialogue: "林夏：你来了。", usable: true, scene_revision_id: uid("6") }];
  if (sql.includes("FROM script_revision_consumer_source")) return [{ consumer_type: "scene_revision", consumer_revision_id: uid("6"), script_revision_id: uid("7") }];
  if (sql.includes("m2_script_source_is_usable")) return [{ ok: true }];
  return undefined;
}
describe("speech persistence boundaries", () => {
  it("returns unavailable for absent draft storage and propagates permission/connection failures", async () => {
    const missing = client(() => [{ version: null, tables: 0, guards: 0 }]);
    const pool = { connect: async () => missing.client } as DatabasePool;
    expect(await new PostgresSpeechStore(pool, {} as JobPersistenceService).storageReady()).toBe(false);
    expect(missing.release).toHaveBeenCalledOnce();
    const broken = { connect: async () => { throw Object.assign(new Error("storage error"), { code: "EIO" }); } } as unknown as DatabasePool;
    await expect(new PostgresSpeechStore(broken, {} as JobPersistenceService).storageReady()).rejects.toMatchObject({ code: "EIO" });
  });
  it("rechecks the project lock, approved source, current plan and exact current voice inside Job creation", async () => {
    const c = client((sql) => {
      const s = sourceAnswers(sql); if (s) return s;
      if (sql.includes("FROM speech_plan_revision r")) return [{ id: uid("8"), revision_id: input.planRevisionId, current_revision_id: input.planRevisionId,
        project_id: input.projectId, shot_revision_id: input.shotRevisionId, source_dialogue_hash: speechDialogueHash("林夏：你来了。") }];
      if (sql.includes("FROM speech_plan_line pl")) return [{ line_id: line.lineId, line_input_revision_id: line.lineInputRevisionId, input_hash: input.inputHash,
        voice_revision_id: voice.id, display_text: line.displayText, emotion: "neutral", speed: 1, source_start: 3, source_end: 7, pause_after_ms: 0 }];
      if (sql.includes("FROM speech_voice_revision v")) return [{ voice_json: baseVoice, revision_id: voice.id, binding_id: voice.bindingId, content_hash: voice.contentHash, speaker_name: "林夏" }];
      throw new Error(`Unexpected query: ${sql}`);
    });
    await expect(assertSpeechGenerationInputInTransaction(c.client, input)).resolves.toBeUndefined();
    const statements = c.query.mock.calls.map(([sql]) => sql);
    expect(statements.findIndex((sql) => sql.includes("FOR UPDATE"))).toBeLessThan(statements.findIndex((sql) => sql.includes("FROM speech_plan_revision r")));
    expect(statements.some((sql) => /INSERT|UPDATE (?!project)/.test(sql) && !sql.startsWith("SELECT"))).toBe(false);
    await expect(assertSpeechGenerationInputInTransaction(c.client, { ...input, spokenText: "偷偷换台词" })).rejects.toMatchObject({ code: "SPEECH_SOURCE_MISMATCH" });
  });
  it("refuses a superseded plan before any paid Job can be frozen", async () => {
    const c = client((sql) => {
      const s = sourceAnswers(sql); if (s) return s;
      if (sql.includes("FROM speech_plan_revision r")) return [{ current_revision_id: uid("9") }];
      throw new Error("Later reads must not run");
    });
    await expect(assertSpeechGenerationInputInTransaction(c.client, input)).rejects.toMatchObject({ code: "SPEECH_PLAN_STALE" });
    expect(c.query.mock.calls.some(([sql]) => sql.includes("INSERT"))).toBe(false);
  });
  it("reads immutable historical input for receipt recovery without granting a new send", async () => {
    const c = client((sql) => {
      if (sql.includes("FROM speech_plan_revision r")) return [{ current_revision_id: uid("9"), shot_revision_id: input.shotRevisionId, project_id: input.projectId,
        source_dialogue_hash: speechDialogueHash("林夏：你来了。") }];
      if (sql.startsWith("SELECT dialogue FROM shot_revision")) return [{ dialogue: "林夏：你来了。" }];
      if (sql.includes("FROM speech_plan_line pl")) return [{ line_id: line.lineId, line_input_revision_id: line.lineInputRevisionId, input_hash: input.inputHash,
        voice_revision_id: voice.id, display_text: line.displayText, emotion: "neutral", speed: 1, source_start: 3, source_end: 7, pause_after_ms: 0 }];
      if (sql.includes("FROM speech_voice_revision v")) return [{ voice_json: baseVoice, revision_id: voice.id, binding_id: voice.bindingId, content_hash: voice.contentHash, speaker_name: "林夏" }];
      throw new Error(`Unexpected query: ${sql}`);
    });
    const store = new PostgresSpeechStore({ connect: async () => c.client }, {} as JobPersistenceService);
    await expect(store.generationInput(input.workspaceId, input.planRevisionId, input.lineId, true)).resolves.toEqual(input);
    expect(c.query.mock.calls.some(([sql]) => sql.includes("INSERT") || sql.includes("FOR UPDATE"))).toBe(false);
  });
  it("registers a validated historical candidate without selecting or approving AUDIO", async () => {
    const c = client((sql) => sql.startsWith("SELECT a.id") ? [{ id: uid("8"), current_voice_revision_id: voice.id }] : []);
    await commitSpeechTake(c.client, { workspaceId: input.workspaceId, projectId: input.projectId, assetId: uid("8"), jobId: uid("7"), attemptId: uid("6"), speechInput: input });
    expect(c.query.mock.calls.at(-1)?.[0]).toContain("INSERT INTO speech_take");
    expect(c.query.mock.calls.some(([sql]) => sql.includes("UPDATE asset") || sql.includes("INSERT INTO speech_selection"))).toBe(false);
    const mismatch = client(() => []);
    await expect(commitSpeechTake(mismatch.client, { workspaceId: input.workspaceId, projectId: input.projectId, assetId: uid("8"), jobId: uid("7"), attemptId: uid("6"), speechInput: input })).rejects.toMatchObject({ code: "SPEECH_TAKE_INVALID" });
    expect(mismatch.query).toHaveBeenCalledOnce();
  });
  it("reads a selected take independently of the capped newest candidate page", async () => {
    const c = client((sql) => {
      const s = sourceAnswers(sql); if (s) return s;
      if (sql.includes("FROM speech_plan_revision r")) return [{ id: uid("8"), current_revision_id: input.planRevisionId, shot_revision_id: input.shotRevisionId, project_id: input.projectId, row_version: 4 }];
      if (sql.includes("FROM speech_take t")) return [];
      if (sql.includes("FROM speech_selection_slot slot")) return [{ id: uid("9"), line_id: line.lineId, take_asset_id: uid("8"), line_input_revision_id: line.lineInputRevisionId,
        checksum_sha256: "d".repeat(64), selected_by: "owner", selected_at: new Date("2026-11-01T00:00:00Z"), inherited_from_selection_id: null }];
      throw new Error(`Unexpected query: ${sql}`);
    });
    const store = new PostgresSpeechStore({ connect: async () => c.client }, {} as JobPersistenceService);
    const page = await store.takes(input.workspaceId, input.planRevisionId);
    expect(page.items).toEqual([]);
    expect(page.selected[0]?.takeAssetId).toBe(uid("8"));
    expect(page.rowVersion).toBe(4);
  });
  it("keeps the current selection and downstream freshness when explicitly choosing the same exact take", async () => {
    const checksum = "d".repeat(64), assetId = uid("8"), selectionId = uid("9");
    const c = client((sql) => {
      const s = sourceAnswers(sql); if (s) return s;
      if (sql.includes("FROM speech_plan_revision r")) return [{ id: uid("8"), current_revision_id: input.planRevisionId, shot_revision_id: input.shotRevisionId, project_id: input.projectId, row_version: 4 }];
      if (sql.startsWith("SELECT row_version FROM speech_plan")) return [{ row_version: 4 }];
      if (sql.includes("SELECT slot.*")) return [{ id: uid("6"), line_input_revision_id: line.lineInputRevisionId, current_selection_id: selectionId }];
      if (sql.includes("FROM speech_take t")) return [{ id: assetId, selectable: true, checksum_sha256: checksum }];
      if (sql.includes("FROM speech_selection_slot slot")) return [{ id: selectionId, line_id: line.lineId, take_asset_id: assetId, line_input_revision_id: line.lineInputRevisionId,
        checksum_sha256: checksum, selected_by: "owner", selected_at: new Date("2026-11-01T00:00:00Z"), inherited_from_selection_id: null }];
      throw new Error(`Unexpected query: ${sql}`);
    });
    const jobs = { runIdempotent: vi.fn(async (_scope, _status, work: (client: PoolClient) => Promise<unknown>) => ({ body: await work(c.client) })) } as unknown as JobPersistenceService;
    const store = new PostgresSpeechStore({ connect: async () => c.client }, jobs);
    expect(await store.select(input.workspaceId, input.planRevisionId, input.lineId, { takeAssetId: assetId, expectedTakeChecksumSha256: checksum }, 4,
      { actorId: "owner", traceId: "trace", idempotencyKey: "same-choice" })).toMatchObject({ rowVersion: 4, selection: { id: selectionId } });
    expect(c.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE") || sql.startsWith("INSERT"))).toBe(false);
  });
});
