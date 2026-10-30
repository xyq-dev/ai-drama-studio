import { randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import {
  VIMAX_CANDIDATE_CREATE_SCHEMA, VIMAX_CANDIDATE_RECEIPT_SCHEMA, VIMAX_CANDIDATE_VIEW_SCHEMA,
  vimaxCandidateCreateSchema, vimaxCandidateFrozenSchema, vimaxCandidatePlaceShotsSchema,
  vimaxCandidateReceiptSchema, vimaxCandidateSaveSceneSchema, vimaxCandidateTargetSchema,
  vimaxCandidateViewSchema,
  type VimaxCandidateBlocker, type VimaxCandidateCreate, type VimaxCandidateCreateResponse,
  type VimaxCandidateFrozen, type VimaxCandidatePage, type VimaxCandidatePlaceShots,
  type VimaxCandidateReceipt, type VimaxCandidateSaveScene, type VimaxCandidateTarget,
  type VimaxCandidateTargets, type VimaxCandidateView, type VimaxCandidateWriteResponse,
} from "@ai-drama/contracts";
import {
  breakdownShotPromptText, freezeVimaxCandidate, hashVimaxCandidateCommand, hashVimaxCandidateFrozen,
  hashVimaxCandidateRequest, sameVimaxCandidateSource, vimaxCandidateShotPlans,
} from "@ai-drama/domain";
import { PersistenceError, type DatabasePool } from "./job-service";
import { TextChainService } from "./text-chain";
import { VimaxPreviewSourceStore, type VimaxPreviewSourceRead } from "./vimax-preview-source";

type Row = QueryResultRow & Record<string, unknown>;
type Operation = "save_scene" | "place_shots";
type Command = VimaxCandidateSaveScene | VimaxCandidatePlaceShots;
type Context = { source: VimaxPreviewSourceRead; pending: boolean; active: boolean };
type TargetRead = { target: VimaxCandidateTarget | null; current: VimaxCandidateView["eligibility"]["currentScene"] };
const TABLE = "vimax_storyboard_candidate";
const STORAGE_VERSION = "ads.vimax-candidate.storage.v1";
/** Compact JSON admission is smaller than the SQL JSONB text cap, leaving room for PostgreSQL's added whitespace. */
export const VIMAX_CANDIDATE_FROZEN_MAX_BYTES = 1_048_576;
export function assertVimaxCandidateFrozenBytes(json: string, mode: "create" | "read"): void {
  if (Buffer.byteLength(json, "utf8") > VIMAX_CANDIDATE_FROZEN_MAX_BYTES) {
    fail(mode === "create" ? "VIMAX_CANDIDATE_FROZEN_TOO_LARGE" : "VIMAX_CANDIDATE_CORRUPT", "Candidate snapshot exceeds its storage limit");
  }
}
/** Same strict calendar bounds as text-chain cursors: Date.parse alone normalizes invalid dates. */
function isValidTimestampCursor(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  if (year < 1 || month < 1 || month > 12 || Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1]!;
}
const REQUIRED_COLUMNS = [
  "id", "workspace_id", "project_id", "episode_id", "actor_id", "idempotency_key", "request_hash", "frozen_hash", "frozen_json",
  "source_script_revision_id", "scene_id", "baseline_scene_revision_id", "baseline_scene_row_version", "shot_count", "state", "row_version",
  "saved_scene_revision_id", "scene_request_key", "scene_request_hash", "scene_receipt", "scene_saved_at",
  "shots_request_key", "shots_request_hash", "shots_receipt", "shots_saved_at", "created_at", "updated_at",
] as const;
const SHOT_COLUMNS = ["candidate_id", "shot_index", "workspace_id", "project_id", "scene_id", "source_scene_revision_id", "shot_id", "shot_revision_id"] as const;
const SELECT_COLUMNS = `c.*, to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at`;
const TARGET_COLUMNS = `s.id AS scene_id, s.row_version, s.current_revision_id, s.approved_revision_id,
  s.archived_at IS NOT NULL AS archived, r.id AS scene_revision_id, r.source_script_revision_id,
  r.ordinal, r.heading, r.time_of_day, r.summary, r.location_revision_id, r.review_status, r.freshness_status,
  (SELECT count(*)::int FROM shot sh WHERE sh.scene_id = s.id AND sh.project_id = s.project_id
    AND sh.workspace_id = s.workspace_id AND sh.archived_at IS NULL) AS active_shot_count`;
const TARGET_JOIN = `FROM scene s LEFT JOIN scene_revision r ON r.id = s.current_revision_id AND r.scene_id = s.id
  AND r.project_id = s.project_id AND r.workspace_id = s.workspace_id`;
function fail(code: string, message: string): never { throw new PersistenceError(code, message); }
const iso = (value: unknown) => value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
const checkedKey = (key: string) => {
  if (typeof key !== "string" || key.length < 1 || key.length > 200 || key.includes("\u0000")) fail("VALIDATION_ERROR", "Invalid request identity");
  return key;
};
const safe = <T>(parsed: { success: true; data: T } | { success: false }): T => {
  if (!parsed.success) fail("VALIDATION_ERROR", "Invalid candidate request");
  return parsed.data;
};

/** Permanent candidate and operation receipts. No provider, job scheduler or automatic schema creation is involved. */
export class VimaxCandidateStore {
  private readonly source: VimaxPreviewSourceStore;
  private readonly text: TextChainService;
  constructor(private readonly pool: DatabasePool, text?: TextChainService) {
    this.source = new VimaxPreviewSourceStore(pool);
    this.text = text ?? new TextChainService(pool);
  }

  async storageReady(): Promise<boolean> {
    const client = await this.pool.connect();
    try { return await this.readyIn(client); } finally { client.release(); }
  }

  private async readyIn(client: PoolClient): Promise<boolean> {
    // Confirmed absence returns false. Query/permission/connection failures are deliberately not swallowed.
    const result = await client.query<Row>(`SELECT
      obj_description(to_regclass('vimax_storyboard_candidate'), 'pg_class') AS version,
      (SELECT count(*)::int FROM information_schema.columns WHERE table_schema = current_schema()
        AND table_name = 'vimax_storyboard_candidate' AND column_name = ANY($1::text[])) AS candidate_columns,
      (SELECT count(*)::int FROM information_schema.columns WHERE table_schema = current_schema()
        AND table_name = 'vimax_storyboard_candidate_shot' AND column_name = ANY($2::text[])) AS shot_columns,
      (SELECT count(*)::int FROM information_schema.columns WHERE table_schema = current_schema()
        AND ((table_name = 'shot_revision' AND column_name = 'planned_duration_ms')
          OR (table_name = 'title_writing_run' AND column_name IN ('run_kind','episode_id')))) AS prerequisites,
      (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal AND tgenabled IN ('O','A')
        AND ((tgrelid = to_regclass('vimax_storyboard_candidate') AND tgname = 'vimax_storyboard_candidate_guard')
          OR (tgrelid = to_regclass('vimax_storyboard_candidate_shot') AND tgname = 'vimax_storyboard_candidate_shot_guard'))) AS guards`,
    [[...REQUIRED_COLUMNS], [...SHOT_COLUMNS]]);
    const row = result.rows[0];
    return row?.version === STORAGE_VERSION && Number(row.candidate_columns) === REQUIRED_COLUMNS.length
      && Number(row.shot_columns) === SHOT_COLUMNS.length && Number(row.prerequisites) === 3 && Number(row.guards) === 2;
  }

  private async transaction<T>(write: boolean, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query(write ? "BEGIN" : "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      try {
        if (!await this.readyIn(client)) fail("VIMAX_CANDIDATE_STORAGE_UNAVAILABLE", "Candidate storage is not ready");
        const value = await work(client);
        await client.query(write ? "COMMIT" : "ROLLBACK");
        return value;
      } catch (error) { await client.query("ROLLBACK"); throw error; }
    } finally { client.release(); }
  }

  private async context(client: PoolClient, workspaceId: string, projectId: string, episodeId: string): Promise<Context> {
    const source = await this.source.readInTransaction(client, workspaceId, projectId, episodeId);
    const pending = await client.query(`SELECT 1 FROM stale_recalculation
      WHERE workspace_id = $1 AND project_id = $2 AND status IN ('PENDING','RUNNING') LIMIT 1`, [workspaceId, projectId]);
    const active = await client.query(`SELECT 1 FROM title_writing_run
      WHERE workspace_id = $1 AND project_id = $2 AND episode_id = $3
        AND run_kind = 'script_breakdown' AND state = 'running' LIMIT 1`, [workspaceId, projectId, episodeId]);
    return { source, pending: pending.rows.length > 0, active: active.rows.length > 0 };
  }

  private assertSource(context: Context) {
    if (context.source.kind === "not_found") fail("NOT_FOUND", "Candidate source not found");
    if (context.source.kind === "series_not_enabled") fail("SERIES_MEDIA_NOT_ENABLED", "Series candidates are not enabled");
    if (context.source.kind !== "ok") fail("VIMAX_CANDIDATE_SOURCE_CHANGED", "Candidate source is unavailable");
    if (context.pending) fail("SOURCE_STALE", "Source dependency propagation is incomplete");
    if (context.active) fail("VIMAX_CANDIDATE_ACTIVE_BREAKDOWN", "An episode breakdown is running");
    return context.source.source;
  }

  private async lockWriteScope(client: PoolClient, workspaceId: string, projectId: string, episodeId: string): Promise<void> {
    const project = await client.query("SELECT id FROM project WHERE id = $1 AND workspace_id = $2 FOR UPDATE", [projectId, workspaceId]);
    if (!project.rows[0]) fail("NOT_FOUND", "Project not found");
    const episode = await client.query("SELECT id FROM episode WHERE id = $1 AND project_id = $2 AND workspace_id = $3 FOR UPDATE", [episodeId, projectId, workspaceId]);
    if (!episode.rows[0]) fail("NOT_FOUND", "Episode not found");
  }

  private async targetIn(client: PoolClient, workspaceId: string, projectId: string, episodeId: string, sceneId: string, lock = false): Promise<TargetRead> {
    const result = await client.query<Row>(`SELECT ${TARGET_COLUMNS} ${TARGET_JOIN}
      WHERE s.id = $1 AND s.workspace_id = $2 AND s.project_id = $3 AND s.episode_id = $4${lock ? " FOR UPDATE OF s" : ""}`,
    [sceneId, workspaceId, projectId, episodeId]);
    return this.targetFromRow(result.rows[0]);
  }

  private targetFromRow(row: Row | undefined): TargetRead {
    if (!row) return { target: null, current: null };
    const current = { sceneId: String(row.scene_id), rowVersion: Number(row.row_version),
      currentRevisionId: row.current_revision_id as string | null, approvedRevisionId: row.approved_revision_id as string | null,
      reviewStatus: row.review_status as string | null, freshnessStatus: row.freshness_status as string | null,
      archived: row.archived === true, activeShotCount: Number(row.active_shot_count) };
    const target = row.scene_revision_id === null ? null : vimaxCandidateTargetSchema.parse({
      sceneId: String(row.scene_id), sceneRevisionId: String(row.scene_revision_id), rowVersion: Number(row.row_version),
      sourceScriptRevisionId: String(row.source_script_revision_id), ordinal: Number(row.ordinal), heading: String(row.heading),
      timeOfDay: row.time_of_day as string | null, summary: String(row.summary), locationRevisionId: row.location_revision_id as string | null,
    });
    return { target, current };
  }

  async targets(workspaceId: string, projectId: string, episodeId: string): Promise<VimaxCandidateTargets> {
    return this.transaction(false, async (client) => {
      const context = await this.context(client, workspaceId, projectId, episodeId);
      // Listing can show why a target cannot be changed while a breakdown is active or propagation is pending.
      const source = this.assertSource({ ...context, active: false, pending: false });
      const result = await client.query<Row>(`SELECT ${TARGET_COLUMNS} ${TARGET_JOIN}
        WHERE s.workspace_id = $1 AND s.project_id = $2 AND s.episode_id = $3 AND s.archived_at IS NULL
        ORDER BY r.ordinal, s.id LIMIT 101`, [workspaceId, projectId, episodeId]);
      if (result.rows.length > 100) fail("VALIDATION_ERROR", "Too many candidate target scenes");
      return { schema: "ads.vimax-candidate.targets.v1", source,
        targets: result.rows.flatMap((row) => {
          const read = this.targetFromRow(row);
          if (!read.target || !read.current) return [];
          const reasons: VimaxCandidateBlocker[] = [];
          if (context.pending) reasons.push("stale_propagation_pending");
          if (context.active) reasons.push("active_breakdown");
          if (read.current.freshnessStatus !== "CURRENT" || read.target.sourceScriptRevisionId !== source.scriptRevisionId) reasons.push("target_changed");
          if (read.current.activeShotCount > 0) reasons.push("target_has_shots");
          return [{ ...read.target, activeShotCount: read.current.activeShotCount, eligible: reasons.length === 0, reasons }];
        }),
      };
    });
  }

  private frozen(row: Row): VimaxCandidateFrozen {
    let json: string | undefined;
    try { json = JSON.stringify(row.frozen_json); } catch { fail("VIMAX_CANDIDATE_CORRUPT", "Stored candidate is not JSON"); }
    if (json === undefined) fail("VIMAX_CANDIDATE_CORRUPT", "Stored candidate is missing");
    assertVimaxCandidateFrozenBytes(json, "read");
    const parsed = vimaxCandidateFrozenSchema.safeParse(row.frozen_json);
    if (!parsed.success || hashVimaxCandidateFrozen(parsed.data) !== row.frozen_hash) fail("VIMAX_CANDIDATE_CORRUPT", "Stored candidate integrity check failed");
    return parsed.data;
  }

  private async view(client: PoolClient, row: Row, context?: Context): Promise<VimaxCandidateView> {
    const frozen = this.frozen(row);
    const currentContext = context ?? await this.context(client, String(row.workspace_id), String(row.project_id), String(row.episode_id));
    const now = await this.targetIn(client, String(row.workspace_id), String(row.project_id), String(row.episode_id), frozen.target.sceneId);
    const reasons: VimaxCandidateBlocker[] = [];
    if (currentContext.source.kind !== "ok") reasons.push("source_unavailable");
    else if (!sameVimaxCandidateSource(currentContext.source.source, frozen.request.source)) reasons.push("source_changed");
    if (currentContext.pending) reasons.push("stale_propagation_pending");
    if (currentContext.active) reasons.push("active_breakdown");
    const state = row.state as VimaxCandidateView["state"];
    if (state === "shots_saved") reasons.push("already_saved");
    else {
      if (!now.target || !now.current || now.current.archived || now.current.freshnessStatus !== "CURRENT"
        || now.target.sourceScriptRevisionId !== frozen.source.scriptRevisionId) reasons.push("target_changed");
      else if (state === "stored") {
        if (JSON.stringify(now.target) !== JSON.stringify(frozen.target)) reasons.push("target_changed");
      } else if (now.current.currentRevisionId !== row.saved_scene_revision_id) reasons.push("target_changed");
      else if (now.current.approvedRevisionId !== row.saved_scene_revision_id || now.current.reviewStatus !== "APPROVED") reasons.push("awaiting_scene_approval");
      if (now.current && now.current.activeShotCount > 0) reasons.push("target_has_shots");
    }
    return vimaxCandidateViewSchema.parse({
      schema: VIMAX_CANDIDATE_VIEW_SCHEMA, candidateId: row.id, projectId: row.project_id, episodeId: row.episode_id,
      state, rowVersion: Number(row.row_version), requestKey: row.idempotency_key, requestHash: row.request_hash,
      frozenHash: row.frozen_hash, frozen, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
      sceneReceipt: row.scene_receipt ?? null, shotsReceipt: row.shots_receipt ?? null,
      eligibility: { canSaveScene: state === "stored" && reasons.length === 0,
        canPlaceShots: state === "scene_saved" && reasons.length === 0, reasons: [...new Set(reasons)], currentScene: now.current },
    });
  }

  private async row(client: PoolClient, workspaceId: string, projectId: string, episodeId: string, actorId: string, candidateId: string, lock = false): Promise<Row> {
    const result = await client.query<Row>(`SELECT ${SELECT_COLUMNS} FROM ${TABLE} c
      WHERE c.id = $1 AND c.workspace_id = $2 AND c.project_id = $3 AND c.episode_id = $4 AND c.actor_id = $5${lock ? " FOR UPDATE OF c" : ""}`,
    [candidateId, workspaceId, projectId, episodeId, actorId]);
    if (!result.rows[0]) fail("NOT_FOUND", "Candidate not found");
    return result.rows[0];
  }

  async get(workspaceId: string, projectId: string, episodeId: string, actorId: string, candidateId: string): Promise<VimaxCandidateView> {
    return this.transaction(false, async (client) => this.view(client, await this.row(client, workspaceId, projectId, episodeId, actorId, candidateId)));
  }

  async list(workspaceId: string, projectId: string, episodeId: string, actorId: string,
    options: { limit?: number; cursor?: string } = {}): Promise<VimaxCandidatePage> {
    const limit = options.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) fail("VALIDATION_ERROR", "Invalid candidate page size");
    let cursor: { createdAt: string; id: string } | null = null;
    if (options.cursor) {
      try {
        if (options.cursor.length > 1000 || !/^[A-Za-z0-9_-]+$/.test(options.cursor)) throw new Error("cursor");
        const parsed = JSON.parse(Buffer.from(options.cursor, "base64url").toString("utf8")) as Record<string, unknown>;
        if (Object.keys(parsed).sort().join(",") !== "actorId,createdAt,episodeId,id,projectId,schema,workspaceId"
          || parsed.schema !== "ads.vimax-candidate.cursor.v1" || parsed.workspaceId !== workspaceId || parsed.projectId !== projectId
          || parsed.episodeId !== episodeId || parsed.actorId !== actorId || typeof parsed.createdAt !== "string"
          || !isValidTimestampCursor(parsed.createdAt) || typeof parsed.id !== "string"
          || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(parsed.id)) throw new Error("cursor");
        cursor = { createdAt: parsed.createdAt, id: parsed.id };
      } catch { fail("VALIDATION_ERROR", "Invalid candidate page cursor"); }
    }
    return this.transaction(false, async (client) => {
      const context = await this.context(client, workspaceId, projectId, episodeId);
      if (context.source.kind === "not_found") fail("NOT_FOUND", "Episode not found");
      const result = await client.query<Row>(`SELECT ${SELECT_COLUMNS} FROM ${TABLE} c
        WHERE c.workspace_id = $1 AND c.project_id = $2 AND c.episode_id = $3 AND c.actor_id = $4
          ${cursor ? "AND (c.created_at, c.id) < ($5::timestamptz, $6::uuid)" : ""}
        ORDER BY c.created_at DESC, c.id DESC LIMIT $${cursor ? 7 : 5}`, cursor
      ? [workspaceId, projectId, episodeId, actorId, cursor.createdAt, cursor.id, limit + 1]
      : [workspaceId, projectId, episodeId, actorId, limit + 1]);
      const page = result.rows.slice(0, limit);
      const items: VimaxCandidateView[] = [];
      for (const row of page) items.push(await this.view(client, row, context));
      const last = page.at(-1);
      const nextCursor = result.rows.length > limit && last ? Buffer.from(JSON.stringify({ schema: "ads.vimax-candidate.cursor.v1",
        workspaceId, projectId, episodeId, actorId, createdAt: last.cursor_created_at, id: last.id })).toString("base64url") : null;
      return { schema: "ads.vimax-candidate.page.v1", items, nextCursor };
    });
  }

  async create(workspaceId: string, projectId: string, episodeId: string, actorId: string, keyValue: string,
    bodyValue: VimaxCandidateCreate, traceId: string): Promise<VimaxCandidateCreateResponse> {
    const body = safe(vimaxCandidateCreateSchema.safeParse(bodyValue));
    const key = checkedKey(keyValue);
    const requestHash = hashVimaxCandidateRequest(projectId, episodeId, body);
    return this.transaction(true, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`title_writing_run:${workspaceId}`]);
      const previous = await client.query<Row>(`SELECT ${SELECT_COLUMNS} FROM ${TABLE} c
        WHERE c.workspace_id = $1 AND c.actor_id = $2 AND c.idempotency_key = $3 FOR UPDATE OF c`, [workspaceId, actorId, key]);
      if (previous.rows[0]) {
        const row = previous.rows[0];
        if (row.project_id !== projectId || row.episode_id !== episodeId || row.request_hash !== requestHash) fail("IDEMPOTENCY_KEY_REUSED", "Candidate request identity changed");
        return { schema: "ads.vimax-candidate.create-response.v1", replayed: true, candidate: await this.view(client, row) };
      }
      await this.lockWriteScope(client, workspaceId, projectId, episodeId);
      const context = await this.context(client, workspaceId, projectId, episodeId);
      const source = this.assertSource(context);
      const target = await this.targetIn(client, workspaceId, projectId, episodeId, body.target.sceneId, true);
      this.assertEmptyTarget(target, source.scriptRevisionId);
      const frozen = freezeVimaxCandidate(source, target.target!, body);
      if (!frozen.ok) fail(this.freezeCode(frozen.code), "Candidate could not be frozen");
      const frozenJson = JSON.stringify(frozen.frozen);
      assertVimaxCandidateFrozenBytes(frozenJson, "create");
      const candidateId = randomUUID();
      await client.query(`INSERT INTO ${TABLE}
        (id, workspace_id, project_id, episode_id, actor_id, idempotency_key, request_hash, frozen_hash, frozen_json,
         source_script_revision_id, scene_id, baseline_scene_revision_id, baseline_scene_row_version, shot_count)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14)`,
      [candidateId, workspaceId, projectId, episodeId, actorId, key, requestHash, frozen.frozenHash, frozenJson,
        source.scriptRevisionId, body.target.sceneId, body.target.sceneRevisionId, body.target.rowVersion, frozen.frozen.request.supplements.shots.length]);
      await client.query(`INSERT INTO domain_event
        (workspace_id, project_id, aggregate_type, aggregate_id, event_type, payload_json, trace_id)
        VALUES ($1,$2,'VimaxCandidate',$3,'vimax.candidate.stored',$4::jsonb,$5)`,
      [workspaceId, projectId, candidateId, JSON.stringify({ schema: "ads.vimax-candidate.audit.v1", candidateId,
        episodeId, sceneId: body.target.sceneId, sourceScriptRevisionId: source.scriptRevisionId,
        frozenHash: frozen.frozenHash, actorId }), traceId]);
      return { schema: "ads.vimax-candidate.create-response.v1", replayed: false,
        candidate: await this.view(client, await this.row(client, workspaceId, projectId, episodeId, actorId, candidateId), context) };
    });
  }

  private freezeCode(code: "source_changed" | "target_changed" | "candidate_blocked"): string {
    return code === "source_changed" ? "VIMAX_CANDIDATE_SOURCE_CHANGED"
      : code === "target_changed" ? "VIMAX_CANDIDATE_TARGET_CHANGED" : "VIMAX_CANDIDATE_BLOCKED";
  }

  private assertEmptyTarget(read: TargetRead, scriptRevisionId: string): void {
    if (!read.target || !read.current || read.current.archived || read.current.freshnessStatus !== "CURRENT"
      || read.target.sourceScriptRevisionId !== scriptRevisionId) fail("VIMAX_CANDIDATE_TARGET_CHANGED", "Target scene changed");
    if (read.current.activeShotCount > 0) fail("VIMAX_CANDIDATE_HAS_SHOTS", "Manual or existing shots must be preserved");
  }

  async saveScene(workspaceId: string, projectId: string, episodeId: string, actorId: string, candidateId: string,
    key: string, body: VimaxCandidateSaveScene, traceId: string): Promise<VimaxCandidateWriteResponse> {
    return this.command("save_scene", workspaceId, projectId, episodeId, actorId, candidateId, key,
      safe(vimaxCandidateSaveSceneSchema.safeParse(body)), traceId);
  }
  async placeShots(workspaceId: string, projectId: string, episodeId: string, actorId: string, candidateId: string,
    key: string, body: VimaxCandidatePlaceShots, traceId: string): Promise<VimaxCandidateWriteResponse> {
    return this.command("place_shots", workspaceId, projectId, episodeId, actorId, candidateId, key,
      safe(vimaxCandidatePlaceShotsSchema.safeParse(body)), traceId);
  }

  private async command(operation: Operation, workspaceId: string, projectId: string, episodeId: string, actorId: string,
    candidateId: string, keyValue: string, body: Command, traceId: string): Promise<VimaxCandidateWriteResponse> {
    const key = checkedKey(keyValue);
    const requestHash = hashVimaxCandidateCommand(operation, body);
    const prefix = operation === "save_scene" ? "scene" : "shots";
    return this.transaction(true, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`title_writing_run:${workspaceId}`]);
      const row = await this.row(client, workspaceId, projectId, episodeId, actorId, candidateId, true);
      if (row[`${prefix}_receipt`] !== null) {
        if (row[`${prefix}_request_key`] !== key) fail("VIMAX_CANDIDATE_ALREADY_SAVED", "Candidate stage is already saved");
        if (row[`${prefix}_request_hash`] !== requestHash) fail("IDEMPOTENCY_KEY_REUSED", "Candidate command identity changed");
        const parsed = vimaxCandidateReceiptSchema.safeParse(row[`${prefix}_receipt`]);
        if (!parsed.success) fail("VIMAX_CANDIDATE_CORRUPT", "Stored operation receipt is malformed");
        const receipt = parsed.data;
        if (receipt.operation !== operation || receipt.candidateId !== candidateId || receipt.projectId !== projectId
          || receipt.episodeId !== episodeId || receipt.sceneId !== row.scene_id || receipt.sceneRevisionId !== row.saved_scene_revision_id
          || receipt.idempotencyKey !== key || receipt.requestHash !== requestHash
          || (operation === "save_scene" ? !["scene_saved", "shots_saved"].includes(String(row.state)) : row.state !== "shots_saved")) {
          fail("VIMAX_CANDIDATE_CORRUPT", "Stored operation receipt does not match its candidate");
        }
        return { schema: "ads.vimax-candidate.write-response.v1", replayed: true, receipt };
      }
      if (Number(row.row_version) !== body.expectedVersion) fail("REVISION_CONFLICT", "Candidate version changed");
      if ((operation === "save_scene" && row.state !== "stored") || (operation === "place_shots" && row.state !== "scene_saved")) {
        fail("VIMAX_CANDIDATE_REVIEW_REQUIRED", "Candidate scene must be saved and approved first");
      }
      const frozen = this.frozen(row);
      await this.lockWriteScope(client, workspaceId, projectId, episodeId);
      const context = await this.context(client, workspaceId, projectId, episodeId);
      const source = this.assertSource(context);
      if (!sameVimaxCandidateSource(source, frozen.request.source)) fail("VIMAX_CANDIDATE_SOURCE_CHANGED", "Candidate source changed");
      const read = await this.targetIn(client, workspaceId, projectId, episodeId, frozen.target.sceneId, true);
      this.assertEmptyTarget(read, frozen.source.scriptRevisionId);
      // Re-evaluate immutable candidate content with the current source, without relabelling an uploaded report as approval.
      const valid = freezeVimaxCandidate(source, frozen.target, { schema: VIMAX_CANDIDATE_CREATE_SCHEMA,
        target: { sceneId: frozen.target.sceneId, sceneRevisionId: frozen.target.sceneRevisionId, rowVersion: frozen.target.rowVersion }, request: frozen.request });
      if (!valid.ok) fail(this.freezeCode(valid.code), "Stored candidate no longer passes validation");
      if (operation === "save_scene") {
        if (JSON.stringify(read.target) !== JSON.stringify(frozen.target)) fail("VIMAX_CANDIDATE_TARGET_CHANGED", "Target scene changed since candidate creation");
        const scene = frozen.evaluation.review.scene;
        const created = await this.text.createSceneRevisionInTransaction(client, {
          workspaceId, projectId, episodeId, sceneId: frozen.target.sceneId,
          sourceScriptRevisionId: frozen.source.scriptRevisionId, locationRevisionId: frozen.target.locationRevisionId,
          ordinal: frozen.target.ordinal, heading: scene.heading, timeOfDay: scene.timeOfDay || null, summary: scene.description,
          createdBy: actorId, expectedVersion: frozen.target.rowVersion, traceId,
        });
        const receipt = this.receipt(operation, row, key, requestHash, created.revisionId, [], await this.stamp(client));
        await client.query(`UPDATE ${TABLE} SET state = 'scene_saved', row_version = 2, saved_scene_revision_id = $2,
          scene_request_key = $3, scene_request_hash = $4, scene_receipt = $5::jsonb, scene_saved_at = $6, updated_at = $6 WHERE id = $1`,
        [candidateId, created.revisionId, key, requestHash, JSON.stringify(receipt), receipt.savedAt]);
        return { schema: "ads.vimax-candidate.write-response.v1", replayed: false, receipt };
      }
      if (read.current!.currentRevisionId !== row.saved_scene_revision_id) fail("VIMAX_CANDIDATE_TARGET_CHANGED", "Candidate scene was edited");
      if (read.current!.approvedRevisionId !== row.saved_scene_revision_id || read.current!.reviewStatus !== "APPROVED") {
        fail("VIMAX_CANDIDATE_REVIEW_REQUIRED", "The exact candidate scene revision must be approved");
      }
      const sceneRevisionId = String(row.saved_scene_revision_id);
      const plans = vimaxCandidateShotPlans(frozen);
      const links: Array<{ index: number; shotId: string; shotRevisionId: string }> = [];
      const sceneForPrompt = { ...frozen.evaluation.review.scene, heading: read.target!.heading, timeOfDay: read.target!.timeOfDay ?? "" };
      for (const [index, shot] of plans.entries()) {
        const version = await client.query<Row>("SELECT row_version FROM scene WHERE id = $1 AND workspace_id = $2", [frozen.target.sceneId, workspaceId]);
        const created = await this.text.createShotScopedInTransaction(client, {
          workspaceId, projectId, sceneId: frozen.target.sceneId, sourceSceneRevisionId: sceneRevisionId, ordinal: index + 1,
          shotType: shot.shotType, camera: shot.camera, action: shot.action,
          // Preserve every validated source character and space; the legacy formatter trims dialogue.
          dialogue: shot.dialogue.length === 0 ? null : shot.dialogue.map((line) => `${line.speaker}：${line.line}`).join("\n"),
          plannedDurationMs: shot.plannedSeconds * 1000, durationHint: null,
          promptText: breakdownShotPromptText(sceneForPrompt, shot), createdBy: actorId, expectedVersion: Number(version.rows[0]!.row_version), traceId,
        });
        await this.text.addShotCharacterReferencesInTransaction(client, { workspaceId, projectId,
          shotRevisionId: created.revisionId, characterRevisionIds: shot.characterKeys.map((key) => frozen.source.characters.find((item) => item.key === key)!.revisionId), role: "appears" });
        await client.query(`INSERT INTO vimax_storyboard_candidate_shot
          (candidate_id, shot_index, workspace_id, project_id, scene_id, source_scene_revision_id, shot_id, shot_revision_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [candidateId, index, workspaceId, projectId, frozen.target.sceneId, sceneRevisionId, created.entityId, created.revisionId]);
        links.push({ index, shotId: created.entityId, shotRevisionId: created.revisionId });
      }
      const receipt = this.receipt(operation, row, key, requestHash, sceneRevisionId, links, await this.stamp(client));
      await client.query(`UPDATE ${TABLE} SET state = 'shots_saved', row_version = 3, shots_request_key = $2,
        shots_request_hash = $3, shots_receipt = $4::jsonb, shots_saved_at = $5, updated_at = $5 WHERE id = $1`,
      [candidateId, key, requestHash, JSON.stringify(receipt), receipt.savedAt]);
      return { schema: "ads.vimax-candidate.write-response.v1", replayed: false, receipt };
    });
  }

  private async stamp(client: PoolClient): Promise<string> {
    return iso((await client.query<Row>("SELECT clock_timestamp() AS stamp")).rows[0]!.stamp);
  }
  private receipt(operation: Operation, row: Row, key: string, requestHash: string, sceneRevisionId: string,
    shots: Array<{ index: number; shotId: string; shotRevisionId: string }>, savedAt: string): VimaxCandidateReceipt {
    return vimaxCandidateReceiptSchema.parse({ schema: VIMAX_CANDIDATE_RECEIPT_SCHEMA, candidateId: row.id,
      projectId: row.project_id, episodeId: row.episode_id, operation, idempotencyKey: key, requestHash,
      rowVersion: operation === "save_scene" ? 2 : 3, state: operation === "save_scene" ? "scene_saved" : "shots_saved",
      sceneId: row.scene_id, sceneRevisionId, shots, savedAt });
  }
}
