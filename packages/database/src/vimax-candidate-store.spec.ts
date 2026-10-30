import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  VIMAX_CANDIDATE_CREATE_SCHEMA, VIMAX_CANDIDATE_PLACE_SHOTS_SCHEMA, VIMAX_CANDIDATE_RECEIPT_SCHEMA,
  VIMAX_CANDIDATE_SAVE_SCENE_SCHEMA, VIMAX_PLATFORM_PREVIEW_REQUEST_SCHEMA,
  vimaxCandidateCreateSchema, vimaxPlatformSourceSnapshotSchema,
  type VimaxCandidateReceipt,
} from "@ai-drama/contracts";
import { freezeVimaxCandidate, hashVimaxCandidateCommand, hashVimaxCandidateRequest } from "@ai-drama/domain";
import type { DatabasePool } from "./job-service";
import type { TextChainService } from "./text-chain";
import { createLargeVimaxCandidateFixture } from "./vimax-candidate-test-fixtures";
import { assertVimaxCandidateFrozenBytes, VIMAX_CANDIDATE_FROZEN_MAX_BYTES, VimaxCandidateStore } from "./vimax-candidate-store";

type Row = Record<string, unknown>;
const W = "11111111-1111-4111-8111-111111111111";
const SCENE = "99999999-9999-4999-8999-999999999991";
const BASE = "99999999-9999-4999-8999-999999999992";
const SAVED = "99999999-9999-4999-8999-999999999993";
const ID = "99999999-9999-4999-8999-999999999994";
const ACTOR = "owner";
const KEY = "create-candidate";
const SCENE_KEY = "save-scene";
const NOW = "2026-10-31T01:00:00.000Z";
const save = { schema: VIMAX_CANDIDATE_SAVE_SCENE_SCHEMA, expectedVersion: 1, confirmedReview: true as const };
const place = { schema: VIMAX_CANDIDATE_PLACE_SHOTS_SCHEMA, expectedVersion: 2, confirmedReview: true as const };
function setup(options: { ready?: boolean; probeError?: boolean; sourceUnavailable?: boolean; state?: "stored" | "scene_saved";
  missing?: boolean; pending?: boolean; active?: boolean; corrupt?: boolean; failScene?: boolean } = {}) {
  // Strict source schema deliberately has no fixture-only metadata.
  const raw = JSON.parse(readFileSync(resolve(__dirname, "../../../scripts/vimax-evaluation/fixtures/single-scene.json"), "utf8"));
  const source = vimaxPlatformSourceSnapshotSchema.parse({ schema: "ads.vimax-platform-source.v1", projectId: raw.input.projectId,
    episodeId: raw.input.episodeId, episodeNo: raw.input.episodeNo, scriptRevisionId: raw.input.scriptRevisionId, scriptRevisionNo: 1,
    scriptText: raw.input.scriptText, scriptContentHash: raw.input.scriptContentHash, characters: raw.input.characters });
  const target = { sceneId: SCENE, sceneRevisionId: BASE, rowVersion: 3, sourceScriptRevisionId: source.scriptRevisionId,
    ordinal: 1, heading: raw.input.sceneSpans[0].heading, timeOfDay: "夜", summary: "原场景", locationRevisionId: null };
  const body = vimaxCandidateCreateSchema.parse({ schema: VIMAX_CANDIDATE_CREATE_SCHEMA,
    target: { sceneId: SCENE, sceneRevisionId: BASE, rowVersion: 3 },
    request: { schema: VIMAX_PLATFORM_PREVIEW_REQUEST_SCHEMA,
      source: { scriptRevisionId: source.scriptRevisionId, scriptContentHash: source.scriptContentHash, characters: source.characters },
      sceneSpans: raw.input.sceneSpans, selectedSceneKeys: raw.input.selectedSceneKeys, sourceDialogue: raw.input.sourceDialogue,
      requirements: raw.input.requirements, candidate: raw.candidate, supplements: raw.supplements } });
  const built = freezeVimaxCandidate(source, target, body);
  if (!built.ok) throw new Error("unit fixture was refused");
  const sceneReceipt: VimaxCandidateReceipt = { schema: VIMAX_CANDIDATE_RECEIPT_SCHEMA, candidateId: ID, projectId: source.projectId,
    episodeId: source.episodeId, operation: "save_scene", state: "scene_saved", idempotencyKey: SCENE_KEY,
    requestHash: hashVimaxCandidateCommand("save_scene", save), rowVersion: 2, sceneId: SCENE, sceneRevisionId: SAVED, shots: [], savedAt: NOW };
  const row: Row = { id: ID, workspace_id: W, project_id: source.projectId, episode_id: source.episodeId, actor_id: ACTOR,
    idempotency_key: KEY, request_hash: hashVimaxCandidateRequest(source.projectId, source.episodeId, body),
    frozen_hash: options.corrupt ? "0".repeat(64) : built.frozenHash, frozen_json: built.frozen,
    scene_id: SCENE, baseline_scene_revision_id: BASE, baseline_scene_row_version: 3, source_script_revision_id: source.scriptRevisionId,
    state: options.state ?? "stored", row_version: options.state === "scene_saved" ? 2 : 1,
    saved_scene_revision_id: options.state === "scene_saved" ? SAVED : null,
    scene_request_key: options.state === "scene_saved" ? SCENE_KEY : null,
    scene_request_hash: options.state === "scene_saved" ? sceneReceipt.requestHash : null,
    scene_receipt: options.state === "scene_saved" ? sceneReceipt : null,
    shots_request_key: null, shots_request_hash: null, shots_receipt: null,
    created_at: new Date(NOW), updated_at: new Date(NOW), cursor_created_at: "2026-10-31T01:00:00.000000Z" };
  const targetRow: Row = { scene_id: SCENE, scene_revision_id: options.state === "scene_saved" ? SAVED : BASE,
    row_version: options.state === "scene_saved" ? 8 : 3,
    current_revision_id: options.state === "scene_saved" ? SAVED : BASE, approved_revision_id: options.state === "scene_saved" ? SAVED : null,
    review_status: options.state === "scene_saved" ? "APPROVED" : "DRAFT", freshness_status: "CURRENT", archived: false,
    source_script_revision_id: source.scriptRevisionId, ordinal: 1, heading: target.heading, time_of_day: "夜", summary: "原场景",
    location_revision_id: null, active_shot_count: 0 };
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const release = vi.fn();
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values });
    if (sql.includes("obj_description")) {
      if (options.probeError) throw new Error("database probe failure");
      return { rows: [{ version: options.ready === false ? null : "ads.vimax-candidate.storage.v1",
        candidate_columns: 27, shot_columns: 8, prerequisites: 3, guards: 2 }] };
    }
    if (sql.includes("FROM vimax_storyboard_candidate c")) return { rows: options.missing ? [] : [row] };
    if (sql.includes("FROM project")) return { rows: [{ id: source.projectId, writing_mode: "short" }] };
    if (sql.includes("FROM episode")) return { rows: [{ id: source.episodeId, episode_no: source.episodeNo,
      current_script_revision_id: source.scriptRevisionId, approved_script_revision_id: options.sourceUnavailable ? null : source.scriptRevisionId }] };
    if (sql.includes("FROM script_revision")) return { rows: [{ revision_no: 1, content_json: { text: source.scriptText }, review_status: "APPROVED", freshness_status: "CURRENT" }] };
    if (sql.includes("FROM character c")) return { rows: source.characters.map((c) => ({ id: c.characterId, current_revision_id: c.revisionId, revision_id: c.revisionId, name: c.name, freshness_status: "CURRENT" })) };
    if (sql.includes("FROM stale_recalculation")) return { rows: options.pending ? [{}] : [] };
    if (sql.includes("FROM title_writing_run")) return { rows: options.active ? [{}] : [] };
    if (sql.includes("FROM scene s")) return { rows: [targetRow] };
    if (sql.includes("SELECT row_version FROM scene")) return { rows: [{ row_version: Number(targetRow.row_version) }] };
    if (sql.includes("clock_timestamp() AS stamp")) return { rows: [{ stamp: new Date(NOW) }] };
    return { rows: [] };
  });
  const text = {
    createSceneRevisionInTransaction: vi.fn(async () => {
      if (options.failScene) throw new Error("synthetic scene failure");
      return { entityId: SCENE, revisionId: SAVED, revisionNo: 2, contentHash: "a".repeat(64), rowVersion: 4 };
    }),
    createShotScopedInTransaction: vi.fn(async () => ({ entityId: "99999999-9999-4999-8999-999999999995", revisionId: "99999999-9999-4999-8999-999999999996", rowVersion: 1 })),
    addShotCharacterReferencesInTransaction: vi.fn(async () => undefined),
  };
  const store = new VimaxCandidateStore({ connect: async () => ({ query, release }) } as unknown as DatabasePool, text as unknown as TextChainService);
  return { store, calls, query, release, source, body, row, targetRow, text, sceneReceipt };
}
const mutations = (calls: Array<{ sql: string }>) => calls.filter((c) => /^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/.test(c.sql));

describe("ViMax candidate permanent receipts and scoped transactions", () => {
  it("does not auto-create storage, and reports confirmed absence without a business read", async () => {
    const h = setup({ ready: false });
    expect(await h.store.storageReady()).toBe(false);
    await expect(h.store.get(W, h.source.projectId, h.source.episodeId, ACTOR, ID)).rejects.toMatchObject({ code: "VIMAX_CANDIDATE_STORAGE_UNAVAILABLE" });
    expect(mutations(h.calls)).toEqual([]);
    expect(h.calls.some((c) => c.sql.includes("FROM project"))).toBe(false);
    expect(h.calls.at(-1)!.sql).toBe("ROLLBACK");
  });
  it("propagates a failed readiness query instead of pretending storage is missing", async () => {
    const h = setup({ probeError: true });
    await expect(h.store.storageReady()).rejects.toThrow("database probe failure");
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(mutations(h.calls)).toEqual([]);
  });
  it("reads a fully scoped immutable candidate in one read-only snapshot", async () => {
    const h = setup();
    const view = await h.store.get(W, h.source.projectId, h.source.episodeId, ACTOR, ID);
    expect(view.eligibility.canSaveScene).toBe(true);
    expect(h.calls[0]!.sql).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(h.calls.at(-1)!.sql).toBe("ROLLBACK");
    expect(h.calls.find((c) => c.sql.includes("WHERE c.id"))!.values).toEqual([ID, W, h.source.projectId, h.source.episodeId, ACTOR]);
    expect(h.calls.some((c) => /FOR UPDATE/.test(c.sql))).toBe(false);
    expect(mutations(h.calls)).toEqual([]);
  });
  it("keeps a historical candidate readable while its current source is unavailable", async () => {
    const h = setup({ sourceUnavailable: true });
    const view = await h.store.get(W, h.source.projectId, h.source.episodeId, ACTOR, ID);
    expect(view.eligibility.canSaveScene).toBe(false);
    expect(view.eligibility.reasons).toContain("source_unavailable");
    expect(view.frozen.request).toEqual(h.body.request);
  });
  it("refuses stored JSON whose hash changed", async () => {
    const h = setup({ corrupt: true });
    await expect(h.store.get(W, h.source.projectId, h.source.episodeId, ACTOR, ID)).rejects.toMatchObject({ code: "VIMAX_CANDIDATE_CORRUPT" });
    expect(mutations(h.calls)).toEqual([]);
  });
  it("replays a committed create before new-source and activity gates, without another candidate/event", async () => {
    const h = setup({ sourceUnavailable: true, active: true });
    const value = await h.store.create(W, h.source.projectId, h.source.episodeId, ACTOR, KEY, h.body, "trace");
    expect(value.replayed).toBe(true);
    expect(value.candidate.candidateId).toBe(ID);
    expect(mutations(h.calls)).toEqual([]);
    expect(h.calls.some((c) => c.sql.includes("FROM project") && c.sql.includes("FOR UPDATE"))).toBe(false);
    expect(h.calls.at(-1)!.sql).toBe("COMMIT");
  });
  it("refuses a reused create key with changed content before reading a source", async () => {
    const h = setup(); const body = structuredClone(h.body); body.request.requirements.style += "不同";
    await expect(h.store.create(W, h.source.projectId, h.source.episodeId, ACTOR, KEY, body, "trace")).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    expect(h.calls.some((c) => c.sql.includes("FROM project"))).toBe(false);
    expect(mutations(h.calls)).toEqual([]);
  });
  it("replays an immutable scene receipt before every live source, expected-version or approval gate", async () => {
    const h = setup({ state: "scene_saved", sourceUnavailable: true, pending: true, active: true });
    const value = await h.store.saveScene(W, h.source.projectId, h.source.episodeId, ACTOR, ID, SCENE_KEY, save, "trace");
    expect(value).toEqual({ schema: "ads.vimax-candidate.write-response.v1", replayed: true, receipt: h.sceneReceipt });
    expect(h.calls.some((c) => c.sql.includes("FROM project"))).toBe(false);
    expect(mutations(h.calls)).toEqual([]);
  });
  it("rejects changed content under the original operation key and rejects a new key for a saved stage", async () => {
    const h = setup({ state: "scene_saved" });
    await expect(h.store.saveScene(W, h.source.projectId, h.source.episodeId, ACTOR, ID, SCENE_KEY, { ...save, expectedVersion: 2 }, "trace")).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    await expect(h.store.saveScene(W, h.source.projectId, h.source.episodeId, ACTOR, ID, "other", save, "trace")).rejects.toMatchObject({ code: "VIMAX_CANDIDATE_ALREADY_SAVED" });
    expect(mutations(h.calls)).toEqual([]);
  });
  it.each([{ pending: true, code: "SOURCE_STALE" }, { active: true, code: "VIMAX_CANDIDATE_ACTIVE_BREAKDOWN" }])("blocks new writes for %o", async ({ code, ...options }) => {
    const h = setup(options);
    await expect(h.store.saveScene(W, h.source.projectId, h.source.episodeId, ACTOR, ID, SCENE_KEY, save, "trace")).rejects.toMatchObject({ code });
    expect(h.text.createSceneRevisionInTransaction).not.toHaveBeenCalled();
    expect(mutations(h.calls)).toEqual([]);
  });
  it("rolls the whole command back when the actual revision writer fails", async () => {
    const h = setup({ failScene: true });
    await expect(h.store.saveScene(W, h.source.projectId, h.source.episodeId, ACTOR, ID, SCENE_KEY, save, "trace")).rejects.toThrow("synthetic scene failure");
    expect(h.calls.at(-1)!.sql).toBe("ROLLBACK");
    expect(h.calls.some((c) => c.sql.startsWith("UPDATE vimax_storyboard_candidate"))).toBe(false);
  });
  it("requires the exact approved saved revision even if a different current revision is approved", async () => {
    const h = setup({ state: "scene_saved" }); h.targetRow.current_revision_id = BASE; h.targetRow.scene_revision_id = BASE;
    await expect(h.store.placeShots(W, h.source.projectId, h.source.episodeId, ACTOR, ID, "place", place, "trace")).rejects.toMatchObject({ code: "VIMAX_CANDIDATE_TARGET_CHANGED" });
    expect(h.text.createShotScopedInTransaction).not.toHaveBeenCalled();
  });
  it("rejects an opaque cursor from another workspace before opening a connection", async () => {
    const h = setup();
    const cursor = Buffer.from(JSON.stringify({ schema: "ads.vimax-candidate.cursor.v1", workspaceId: "other", projectId: h.source.projectId,
      episodeId: h.source.episodeId, actorId: ACTOR, createdAt: "2026-10-31T01:00:00.000000Z", id: ID })).toString("base64url");
    await expect(h.store.list(W, h.source.projectId, h.source.episodeId, ACTOR, { cursor })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(h.calls).toEqual([]);
  });
  it("binds replayed operation receipts to their exact scoped candidate", async () => {
    const h = setup({ state: "scene_saved" });
    h.row.scene_receipt = { ...h.sceneReceipt, candidateId: BASE };
    await expect(h.store.saveScene(W, h.source.projectId, h.source.episodeId, ACTOR, ID, SCENE_KEY, save, "trace"))
      .rejects.toMatchObject({ code: "VIMAX_CANDIDATE_CORRUPT" });
    expect(mutations(h.calls)).toEqual([]);
    expect(h.calls.some((c) => c.sql.includes("FROM project"))).toBe(false);
  });
  it("keeps the chosen scene identity, ordinal and location while creating a new draft under ordered locks", async () => {
    const h = setup();
    const result = await h.store.saveScene(W, h.source.projectId, h.source.episodeId, ACTOR, ID, SCENE_KEY, save, "actual-trace");
    expect(result.receipt.sceneId).toBe(SCENE);
    expect(result.receipt.sceneRevisionId).toBe(SAVED);
    expect(result.receipt.operation).toBe("save_scene");
    expect(h.text.createSceneRevisionInTransaction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      sceneId: SCENE, expectedVersion: 3, ordinal: 1, locationRevisionId: null, traceId: "actual-trace",
    }));
    const advisory = h.calls.findIndex((c) => c.sql.includes("pg_advisory_xact_lock"));
    const candidate = h.calls.findIndex((c) => c.sql.includes("WHERE c.id") && c.sql.includes("FOR UPDATE"));
    const project = h.calls.findIndex((c) => c.sql.includes("FROM project") && c.sql.includes("FOR UPDATE"));
    const episode = h.calls.findIndex((c) => c.sql.includes("FROM episode") && c.sql.includes("FOR UPDATE"));
    const scene = h.calls.findIndex((c) => c.sql.includes("FOR UPDATE OF s"));
    expect(advisory).toBeLessThan(candidate); expect(candidate).toBeLessThan(project);
    expect(project).toBeLessThan(episode); expect(episode).toBeLessThan(scene);
    expect(h.calls.filter((c) => c.sql.includes("FROM title_writing_run")).every((c) => !c.sql.includes("FOR UPDATE"))).toBe(true);
    expect(h.calls.at(-1)!.sql).toBe("COMMIT");
  });
  it.each(["2026-02-31T01:00:00.000000Z", "2026-02-29T01:00:00.000000Z", "1900-02-29T01:00:00.000000Z",
    "2026-04-31T01:00:00.000000Z", "0000-01-01T01:00:00.000000Z", "2026-13-01T01:00:00.000000Z",
    "2026-01-01T24:00:00.000000Z", "2026-01-01T01:60:00.000000Z", "2026-01-01T01:00:60.000000Z"])(
    "refuses the impossible cursor calendar value %s before PostgreSQL casts", async (createdAt) => {
      const h = setup();
      const cursor = Buffer.from(JSON.stringify({ schema: "ads.vimax-candidate.cursor.v1", workspaceId: W, projectId: h.source.projectId,
        episodeId: h.source.episodeId, actorId: ACTOR, createdAt, id: ID })).toString("base64url");
      await expect(h.store.list(W, h.source.projectId, h.source.episodeId, ACTOR, { cursor })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(h.calls).toEqual([]);
    },
  );
  it("accepts a real Gregorian leap-day cursor", async () => {
    const h = setup();
    const cursor = Buffer.from(JSON.stringify({ schema: "ads.vimax-candidate.cursor.v1", workspaceId: W, projectId: h.source.projectId,
      episodeId: h.source.episodeId, actorId: ACTOR, createdAt: "2000-02-29T01:00:00.000000Z", id: ID })).toString("base64url");
    expect((await h.store.list(W, h.source.projectId, h.source.episodeId, ACTOR, { cursor })).items).toHaveLength(1);
  });
  it("uses UTF-8 bytes for the compact 1 MiB admission boundary and distinct create/read refusals", () => {
    const overhead = Buffer.byteLength(JSON.stringify({ payload: "" }), "utf8");
    const exact = JSON.stringify({ payload: "a".repeat(VIMAX_CANDIDATE_FROZEN_MAX_BYTES - overhead) });
    expect(() => assertVimaxCandidateFrozenBytes(exact, "create")).not.toThrow();
    expect(() => assertVimaxCandidateFrozenBytes(exact, "read")).not.toThrow();
    const unicode = JSON.stringify({ payload: "a".repeat(VIMAX_CANDIDATE_FROZEN_MAX_BYTES - overhead - 1) + "汉" });
    expect(unicode.length).toBe(exact.length);
    expect(() => assertVimaxCandidateFrozenBytes(unicode, "create")).toThrowError(expect.objectContaining({ code: "VIMAX_CANDIDATE_FROZEN_TOO_LARGE" }));
    expect(() => assertVimaxCandidateFrozenBytes(unicode, "read")).toThrowError(expect.objectContaining({ code: "VIMAX_CANDIDATE_CORRUPT" }));
  });
  it("refuses an oversized stored snapshot with a bounded corruption diagnostic", async () => {
    const h = setup(); h.row.frozen_json = { payload: "x".repeat(VIMAX_CANDIDATE_FROZEN_MAX_BYTES) };
    await expect(h.store.get(W, h.source.projectId, h.source.episodeId, ACTOR, ID)).rejects.toMatchObject({ code: "VIMAX_CANDIDATE_CORRUPT" });
    expect(mutations(h.calls)).toEqual([]);
  });

  it("admits a legal request whose escaped and duplicated frozen data exceeded the old SQL ceiling", () => {
    const large = createLargeVimaxCandidateFixture();
    expect(Buffer.byteLength(JSON.stringify(large.body), "utf8")).toBeLessThanOrEqual(300 * 1024);
    expect(Buffer.byteLength(JSON.stringify(large.candidate), "utf8")).toBeLessThanOrEqual(256 * 1024);
    const json = JSON.stringify(large.evaluation.frozen);
    expect(Buffer.byteLength(json, "utf8")).toBeGreaterThan(786_432);
    expect(() => assertVimaxCandidateFrozenBytes(json, "create")).not.toThrow();
    expect(() => assertVimaxCandidateFrozenBytes(json, "read")).not.toThrow();
  });

  it("refuses an unpaired surrogate before any candidate or event INSERT", async () => {
    const h = setup({ missing: true });
    const body = structuredClone(h.body);
    body.request.candidate.storyboard[0]!.visual_desc = "\ud800";
    body.request.candidate.shot_descriptions[0]!.visual_desc = "\ud800";
    await expect(h.store.create(W, h.source.projectId, h.source.episodeId, ACTOR, KEY, body, "trace"))
      .rejects.toMatchObject({ code: "VIMAX_CANDIDATE_BLOCKED" });
    expect(mutations(h.calls)).toEqual([]);
    expect(h.calls.at(-1)!.sql).toBe("ROLLBACK");
  });

});
