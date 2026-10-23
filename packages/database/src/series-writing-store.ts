import type { PoolClient, QueryResult, QueryResultRow } from "pg";
import {
  SERIES_NEVER_SENT_ERROR_CODES,
  TITLE_WRITING_CANCELED_BEFORE_SEND,
  currentUncertainCallIds,
  seriesBatchRange,
  seriesStageEpisodeNo,
  type SeriesAdmission,
  type SeriesCallFinish,
  type SeriesCallRecord,
  type SeriesCallReservation,
  type SeriesDecisionRecord,
  type SeriesGrantCreation,
  type SeriesGrantRecord,
  type SeriesJobArtifacts,
  type SeriesJobBundle,
  type SeriesJobPlan,
  type SeriesJobRecord,
  type SeriesLedgerRevisionRecord,
  type SeriesLimits,
  type SeriesNextStep,
  type SeriesPlacement,
  type SeriesPlacementCandidates,
  type SeriesPlanRevisionRecord,
  type SeriesPlanStory,
  type SeriesRecord,
  type SeriesResumePreparation,
  type SeriesRunState,
  type SeriesScriptRevision,
  type SeriesSnapshot,
  type SeriesStageOutput,
  type SeriesStageRecord,
  type SeriesStoryRevision,
  type SeriesWritingStore,
  type TitleWritingProviderKey,
  type TitleWritingStepKey,
  type TitleWritingUsageView,
} from "@ai-drama/contracts";
import { seriesCurrentPlan, seriesGrantRemainingSends, seriesJobNormalSends, seriesJobSends, seriesJobUpstreamChange } from "@ai-drama/domain";
import type { DatabasePool } from "./job-service";
import { episodePlanReadyIn } from "./episode-plan";
import { SERIES_WRITING_MIGRATION } from "./migrations";
import type { TextChainService } from "./text-chain";
import { recentWritingCalls, runningWritingRuns, writingCallLockKey } from "./writing-candidate-store";

export { SERIES_WRITING_MIGRATION };

/** Every column the store reads or writes. Until all exist and the migration is recorded, storageReady() is false. */
export const SERIES_WRITING_TABLES: Readonly<Record<string, readonly string[]>> = {
  project: ["writing_mode"],
  series_writing_series: ["id", "workspace_id", "project_id", "actor_id", "idempotency_key", "input_hash", "input_json", "title", "episode_count", "created_at", "updated_at"],
  series_writing_grant: ["id", "series_id", "workspace_id", "project_id", "actor_id", "idempotency_key", "request_hash", "input_json", "provider_key", "model",
    "call_budget", "calls_used", "state", "stop_reason", "cancel_requested_at", "created_at", "updated_at"],
  series_writing_run: ["id", "job_seq", "series_id", "grant_id", "workspace_id", "project_id", "job_kind", "batch_no", "input_hash", "input_json", "provider_key", "model",
    "state", "error_code", "cancel_requested_at", "executor_id", "lease_until", "call_cap", "calls_used", "created_at", "updated_at"],
  series_writing_stage: ["run_id", "workspace_id", "stage_key", "ordinal", "state", "attempt_no", "error_code", "output_json", "output_hash", "depends_on_json",
    "reused_from", "script_save", "script_revision_id", "updated_at"],
  series_writing_call: ["id", "run_id", "grant_id", "series_id", "workspace_id", "stage_key", "attempt_no", "provider_key", "model", "request_hash", "state",
    "executor_id", "provider_request_id", "response_model", "usage_json", "billing_status", "error_code", "created_at", "finished_at"],
  series_writing_plan_revision: ["id", "series_id", "workspace_id", "revision_no", "origin", "source_run_id", "parent_revision_id", "content_json", "content_hash",
    "review_json", "story_revision_id", "story_save", "created_by", "created_at"],
  series_writing_ledger_revision: ["id", "series_id", "workspace_id", "batch_no", "revision_no", "origin", "content_json", "content_hash", "summaries_json",
    "basis_json", "created_by", "created_at"],
  series_writing_decision: ["id", "series_id", "workspace_id", "target", "basis_json", "note", "created_by", "created_at"],
  series_writing_resume: ["grant_id", "workspace_id", "idempotency_key", "request_hash", "confirmed_call_ids", "created_at"],
};

const cols = (table: string, skip: readonly string[] = []) => SERIES_WRITING_TABLES[table]!.filter((column) => !skip.includes(column)).join(", ");
const SERIES_COLUMNS = cols("series_writing_series");
const GRANT_COLUMNS = cols("series_writing_grant");
const RUN_COLUMNS = cols("series_writing_run");
const STAGE_COLUMNS = cols("series_writing_stage");
const CALL_COLUMNS = cols("series_writing_call", ["billing_status"]);
const PLAN_COLUMNS = cols("series_writing_plan_revision");
/** A plan revision with the content hash of the story it is bound to (read from the story revision, which never changes). */
const PLAN_WITH_STORY = `${PLAN_COLUMNS.split(", ").map((column) => `p.${column}`).join(", ")}, sr.content_hash AS story_hash`;
const LEDGER_COLUMNS = cols("series_writing_ledger_revision");
const DECISION_COLUMNS = cols("series_writing_decision");

type Row = QueryResultRow & Record<string, unknown>;
type Query = (sql: string, values?: unknown[]) => Promise<QueryResult<Row>>;

function iso(value: unknown): string {
  return (value instanceof Date ? value : new Date(String(value))).toISOString();
}

function isoOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : iso(value);
}

function str(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toSeries(row: Row): SeriesRecord {
  return { id: String(row.id), workspaceId: String(row.workspace_id), projectId: String(row.project_id), actorId: String(row.actor_id),
    idempotencyKey: String(row.idempotency_key), inputHash: String(row.input_hash), input: row.input_json as SeriesRecord["input"], title: String(row.title),
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}

function toGrant(row: Row): SeriesGrantRecord {
  return { id: String(row.id), seriesId: String(row.series_id), workspaceId: String(row.workspace_id), projectId: String(row.project_id), actorId: String(row.actor_id),
    idempotencyKey: String(row.idempotency_key), requestHash: String(row.request_hash), input: row.input_json as SeriesGrantRecord["input"],
    callBudget: Number(row.call_budget), callsUsed: Number(row.calls_used), state: row.state as SeriesGrantRecord["state"], stopReason: str(row.stop_reason),
    cancelRequestedAt: isoOrNull(row.cancel_requested_at), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}

function toRun(row: Row): SeriesJobRecord {
  return { id: String(row.id), seq: Number(row.job_seq), seriesId: String(row.series_id), grantId: String(row.grant_id), workspaceId: String(row.workspace_id),
    projectId: String(row.project_id), kind: row.job_kind as SeriesJobRecord["kind"], batchNo: row.batch_no === null || row.batch_no === undefined ? null : Number(row.batch_no),
    input: row.input_json as SeriesJobRecord["input"], inputHash: String(row.input_hash), state: row.state as SeriesRunState, errorCode: str(row.error_code),
    cancelRequestedAt: isoOrNull(row.cancel_requested_at), executorId: str(row.executor_id), leaseUntil: isoOrNull(row.lease_until),
    callCap: Number(row.call_cap), callsUsed: Number(row.calls_used), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}

function toStage(row: Row): SeriesStageRecord {
  return { runId: String(row.run_id), stageKey: String(row.stage_key), ordinal: Number(row.ordinal), state: row.state as SeriesStageRecord["state"],
    attemptNo: Number(row.attempt_no), errorCode: str(row.error_code), output: (row.output_json ?? null) as SeriesStageOutput | null, outputHash: str(row.output_hash),
    dependsOn: (row.depends_on_json ?? null) as Record<string, string> | null, reusedFrom: str(row.reused_from),
    scriptSave: (row.script_save as SeriesStageRecord["scriptSave"]) ?? null, scriptRevisionId: str(row.script_revision_id), updatedAt: iso(row.updated_at) };
}

function toCall(row: Row): SeriesCallRecord {
  return { id: String(row.id), runId: String(row.run_id), grantId: String(row.grant_id), seriesId: String(row.series_id), workspaceId: String(row.workspace_id),
    stageKey: String(row.stage_key), attemptNo: Number(row.attempt_no), providerKey: row.provider_key as TitleWritingProviderKey, model: String(row.model),
    requestHash: String(row.request_hash), state: row.state as SeriesCallRecord["state"], executorId: String(row.executor_id),
    providerRequestId: str(row.provider_request_id), responseModel: str(row.response_model), usage: row.usage_json as TitleWritingUsageView,
    errorCode: str(row.error_code), createdAt: iso(row.created_at), finishedAt: isoOrNull(row.finished_at) };
}

function toPlan(row: Row): SeriesPlanRevisionRecord {
  return { id: String(row.id), seriesId: String(row.series_id), revisionNo: Number(row.revision_no), origin: row.origin as SeriesPlanRevisionRecord["origin"],
    sourceRunId: str(row.source_run_id), parentRevisionId: str(row.parent_revision_id), content: row.content_json as SeriesPlanRevisionRecord["content"],
    contentHash: String(row.content_hash), review: (row.review_json ?? null) as SeriesPlanRevisionRecord["review"], storyRevisionId: str(row.story_revision_id),
    storyHash: str(row.story_hash), storySave: row.story_save as SeriesPlanRevisionRecord["storySave"], createdBy: String(row.created_by), createdAt: iso(row.created_at) };
}

function toLedger(row: Row): SeriesLedgerRevisionRecord {
  return { id: String(row.id), seriesId: String(row.series_id), batchNo: Number(row.batch_no), revisionNo: Number(row.revision_no),
    origin: row.origin as SeriesLedgerRevisionRecord["origin"], content: row.content_json as SeriesLedgerRevisionRecord["content"], contentHash: String(row.content_hash),
    summaries: row.summaries_json as SeriesLedgerRevisionRecord["summaries"], basis: row.basis_json as SeriesLedgerRevisionRecord["basis"],
    createdBy: String(row.created_by), createdAt: iso(row.created_at) };
}

function contentText(value: unknown): string {
  return typeof (value as { text?: unknown } | null)?.text === "string" ? (value as { text: string }).text : JSON.stringify(value);
}

function toStory(row: Row | undefined): SeriesStoryRevision | null {
  return row ? { id: String(row.id), text: contentText(row.content_json), contentHash: String(row.content_hash),
    reviewStatus: row.review_status as SeriesStoryRevision["reviewStatus"], freshnessStatus: row.freshness_status as SeriesStoryRevision["freshnessStatus"],
    createdBy: String(row.created_by), createdAt: iso(row.created_at) } : null;
}

/** Two bases name exactly the same texts at the same hashes. */
function sameBasis(a: Record<string, string>, b: Record<string, string>): boolean {
  return Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) => b[key] === value);
}

function toDecision(row: Row): SeriesDecisionRecord {
  return { id: String(row.id), seriesId: String(row.series_id), target: String(row.target), basis: row.basis_json as Record<string, string>, note: String(row.note),
    createdBy: String(row.created_by), createdAt: iso(row.created_at) };
}

/** The lock every run start of a workspace (title writing, automatic creation and series grants) is serialized under. */
function runLockKey(workspaceId: string): string {
  return `title_writing_run:${workspaceId}`;
}

/**
 * PostgreSQL storage of series writing (migration 20261023000100_series_writing). Lock order: workspace run lock →
 * series row → grant row → job row → project → episode for grants, resumes, hand-overs, edits and placement; workspace
 * call lock → job row → grant row for reservations. Every query names the workspace.
 */
export class PostgresSeriesWritingStore implements SeriesWritingStore {
  private readyConfirmed = false;

  constructor(private readonly pool: DatabasePool, private readonly textChain: TextChainService) {}

  async storageReady(): Promise<boolean> {
    if (this.readyConfirmed) return true;
    try {
      const ledger = await this.query("SELECT to_regclass('schema_migration') IS NOT NULL AS present", []);
      if (ledger.rows[0]?.present !== true) return false;
      const recorded = await this.query("SELECT 1 FROM schema_migration WHERE name = $1", [SERIES_WRITING_MIGRATION]);
      if (!recorded.rows[0]) return false;
      const result = await this.query(
        `SELECT table_name, column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = ANY($1::text[])`, [Object.keys(SERIES_WRITING_TABLES)]);
      const present = new Set(result.rows.map((row) => `${String(row.table_name)}.${String(row.column_name)}`));
      this.readyConfirmed = Object.entries(SERIES_WRITING_TABLES).every(([table, columns]) => columns.every((column) => present.has(`${table}.${column}`)));
      return this.readyConfirmed;
    } catch {
      return false;
    }
  }

  /** The new tables' provider CHECKs name all three active providers from the start. */
  async providerStorageReady(_providerKey: TitleWritingProviderKey): Promise<boolean> {
    return this.storageReady();
  }

  async createSeries(series: SeriesRecord, project: { title: string; premise: string }): Promise<{ kind: "created" | "existing"; series: SeriesRecord } | { kind: "conflict" } | { kind: "plan_unavailable" }> {
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [runLockKey(series.workspaceId)]);
      const existing = (await client.query<Row>(`SELECT ${SERIES_COLUMNS} FROM series_writing_series WHERE workspace_id = $1 AND actor_id = $2 AND idempotency_key = $3`,
        [series.workspaceId, series.actorId, series.idempotencyKey])).rows[0];
      if (existing) return String(existing.input_hash) === series.inputHash ? { kind: "existing", series: toSeries(existing) } : { kind: "conflict" };
      if (!await episodePlanReadyIn(client)) return { kind: "plan_unavailable" };
      await client.query(
        `INSERT INTO project (id, workspace_id, title, premise, episode_count, target_episode_seconds, writing_mode)
         VALUES ($1, $2, $3, $4, $5, $6, 'series')`,
        [series.projectId, series.workspaceId, project.title, project.premise, series.input.episodeCount, series.input.episodeSeconds]);
      const inserted = await client.query<Row>(
        `INSERT INTO series_writing_series (id, workspace_id, project_id, actor_id, idempotency_key, input_hash, input_json, title, episode_count, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $10) RETURNING ${SERIES_COLUMNS}`,
        [series.id, series.workspaceId, series.projectId, series.actorId, series.idempotencyKey, series.inputHash, JSON.stringify(series.input), series.title,
          series.input.episodeCount, series.createdAt]);
      return { kind: "created", series: toSeries(inserted.rows[0]!) };
    });
  }

  async findSeriesByKey(workspaceId: string, actorId: string, idempotencyKey: string): Promise<SeriesRecord | null> {
    const row = (await this.query(`SELECT ${SERIES_COLUMNS} FROM series_writing_series WHERE workspace_id = $1 AND actor_id = $2 AND idempotency_key = $3`,
      [workspaceId, actorId, idempotencyKey])).rows[0];
    return row ? toSeries(row) : null;
  }

  private async load(query: Query, series: SeriesRecord): Promise<SeriesSnapshot> {
    const project = (await query(
      `SELECT p.episode_count, p.writing_mode, p.current_story_revision_id, p.approved_story_revision_id, sr.review_status, sr.freshness_status
         FROM project p LEFT JOIN story_revision sr ON sr.id = p.approved_story_revision_id WHERE p.id = $1 AND p.workspace_id = $2`,
      [series.projectId, series.workspaceId])).rows[0]!;
    const episodes = (await query(
      "SELECT id, episode_no, row_version, current_script_revision_id, approved_script_revision_id FROM episode WHERE project_id = $1 AND workspace_id = $2 ORDER BY episode_no",
      [series.projectId, series.workspaceId])).rows;
    const scripts = (await query(
      `SELECT s.id, e.episode_no, s.content_json, s.content_hash, s.review_status, s.freshness_status, s.source_story_revision_id, s.created_by, s.created_at
         FROM script_revision s JOIN episode e ON e.id = s.episode_id
        WHERE e.project_id = $1 AND e.workspace_id = $2 AND (s.id = e.current_script_revision_id OR s.id = e.approved_script_revision_id)`,
      [series.projectId, series.workspaceId])).rows;
    const stories = (await query(
      `SELECT id, content_json, content_hash, review_status, freshness_status, created_by, created_at FROM story_revision
        WHERE project_id = $1 AND workspace_id = $2 AND id = ANY($3::uuid[])`,
      [series.projectId, series.workspaceId, [project.current_story_revision_id, project.approved_story_revision_id].filter((id) => id !== null)])).rows;
    const plans = (await query(
      `SELECT ${PLAN_WITH_STORY} FROM series_writing_plan_revision p LEFT JOIN story_revision sr ON sr.id = p.story_revision_id
        WHERE p.series_id = $1 ORDER BY p.revision_no`, [series.id])).rows.map(toPlan);
    const ledgers = (await query(`SELECT ${LEDGER_COLUMNS} FROM series_writing_ledger_revision WHERE series_id = $1 ORDER BY batch_no, revision_no`, [series.id])).rows.map(toLedger);
    const decisions = (await query(`SELECT ${DECISION_COLUMNS} FROM series_writing_decision WHERE series_id = $1 ORDER BY created_at, id`, [series.id])).rows.map(toDecision);
    const grants = (await query(`SELECT ${GRANT_COLUMNS} FROM series_writing_grant WHERE series_id = $1 ORDER BY created_at, id`, [series.id])).rows.map(toGrant);
    const runs = (await query(`SELECT ${RUN_COLUMNS} FROM series_writing_run WHERE series_id = $1 ORDER BY job_seq`, [series.id])).rows.map(toRun);
    const ids = runs.map((run) => run.id);
    const stages = ids.length === 0 ? [] : (await query(`SELECT ${STAGE_COLUMNS} FROM series_writing_stage WHERE run_id = ANY($1::uuid[]) ORDER BY ordinal`, [ids])).rows.map(toStage);
    const calls = ids.length === 0 ? [] : (await query(`SELECT ${CALL_COLUMNS} FROM series_writing_call WHERE run_id = ANY($1::uuid[]) ORDER BY created_at, attempt_no`, [ids])).rows.map(toCall);
    const approvedId = str(project.approved_story_revision_id);
    return {
      series,
      project: { episodeCount: Number(project.episode_count), writingMode: project.writing_mode === "series" ? "series" : "short",
        currentStoryRevisionId: str(project.current_story_revision_id), approvedStoryRevisionId: approvedId,
        approvedStoryCurrent: approvedId !== null && approvedId === str(project.current_story_revision_id) && project.review_status === "APPROVED" && project.freshness_status === "CURRENT",
        currentStory: toStory(stories.find((row) => String(row.id) === str(project.current_story_revision_id))),
        approvedStory: toStory(stories.find((row) => String(row.id) === approvedId)) },
      episodes: episodes.map((row) => ({ episodeNo: Number(row.episode_no), episodeId: String(row.id), rowVersion: Number(row.row_version),
        currentScriptRevisionId: str(row.current_script_revision_id), approvedScriptRevisionId: str(row.approved_script_revision_id) })),
      scripts: scripts.map((row): SeriesScriptRevision => ({ id: String(row.id), episodeNo: Number(row.episode_no),
        text: contentText(row.content_json),
        contentHash: String(row.content_hash), reviewStatus: row.review_status as SeriesScriptRevision["reviewStatus"],
        freshnessStatus: row.freshness_status as SeriesScriptRevision["freshnessStatus"], sourceStoryRevisionId: String(row.source_story_revision_id),
        createdBy: String(row.created_by), createdAt: iso(row.created_at) })),
      plans, ledgers, decisions, grants,
      jobs: runs.map((run) => ({ run, stages: stages.filter((stage) => stage.runId === run.id), calls: calls.filter((call) => call.runId === run.id) })),
    };
  }

  private async seriesOf(query: Query, workspaceId: string, projectId: string, lock = false): Promise<SeriesRecord | null> {
    const row = (await query(`SELECT ${SERIES_COLUMNS} FROM series_writing_series WHERE workspace_id = $1 AND project_id = $2${lock ? " FOR UPDATE" : ""}`,
      [workspaceId, projectId])).rows[0];
    return row ? toSeries(row) : null;
  }

  async snapshot(workspaceId: string, projectId: string): Promise<SeriesSnapshot | null> {
    const client = await this.pool.connect();
    try {
      // One consistent read of every table the state is computed from.
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const query: Query = (sql, values) => client.query<Row>(sql, values);
      const series = await this.seriesOf(query, workspaceId, projectId);
      const result = series ? await this.load(query, series) : null;
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async findGrantByKey(workspaceId: string, actorId: string, idempotencyKey: string): Promise<SeriesGrantRecord | null> {
    const row = (await this.query(`SELECT ${GRANT_COLUMNS} FROM series_writing_grant WHERE workspace_id = $1 AND actor_id = $2 AND idempotency_key = $3`,
      [workspaceId, actorId, idempotencyKey])).rows[0];
    return row ? toGrant(row) : null;
  }

  private async activeRuns(client: PoolClient, workspaceId: string): Promise<Array<{ kind: "title" | "auto" | "series"; id: string; projectId: string }>> {
    const titles = await client.query<Row>("SELECT to_regclass('title_writing_run') IS NOT NULL AS present");
    const titleRows = titles.rows[0]?.present === true
      ? (await client.query<Row>("SELECT id, project_id FROM title_writing_run WHERE workspace_id = $1 AND state = 'running'", [workspaceId])).rows
      : [];
    return [...titleRows.map((row) => ({ kind: "title" as const, id: String(row.id), projectId: String(row.project_id) })), ...await runningWritingRuns(client, workspaceId)];
  }

  private async insertJob(client: PoolClient, plan: SeriesJobPlan, executor: { executorId: string; leaseUntil: string } | null): Promise<void> {
    const run = plan.run;
    await client.query(
      `INSERT INTO series_writing_run (id, job_seq, series_id, grant_id, workspace_id, project_id, job_kind, batch_no, input_hash, input_json, provider_key, model, state,
         executor_id, lease_until, call_cap, calls_used, created_at, updated_at)
       VALUES ($1, $16, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, 'running', $12, $13, $14, 0, $15, $15)`,
      [run.id, run.seriesId, run.grantId, run.workspaceId, run.projectId, run.kind, run.batchNo, run.inputHash, JSON.stringify(run.input), run.input.providerKey,
        run.input.model, executor?.executorId ?? null, executor?.leaseUntil ?? null, run.callCap, run.createdAt, run.seq]);
    for (const [ordinal, stage] of plan.stages.entries()) {
      await client.query(
        `INSERT INTO series_writing_stage (run_id, workspace_id, stage_key, ordinal, state, attempt_no, output_json, output_hash, depends_on_json, reused_from,
           script_save, updated_at)
         VALUES ($1, $2, $3, $4, $5, 0, $6::jsonb, $7, $8::jsonb, $9, $10, $11)`,
        [run.id, run.workspaceId, stage.stageKey, ordinal, stage.reused ? "completed" : "pending", stage.reused ? JSON.stringify(stage.reused.output) : null,
          stage.reused?.outputHash ?? null, stage.reused ? JSON.stringify(stage.reused.dependsOn) : null, stage.reused?.fromRunId ?? null,
          seriesStageEpisodeNo(stage.stageKey) !== null ? "pending" : null, run.createdAt]);
    }
  }

  async createGrant(grant: SeriesGrantRecord, limits: SeriesLimits, admit: (snapshot: SeriesSnapshot) => SeriesAdmission): Promise<SeriesGrantCreation> {
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [runLockKey(grant.workspaceId)]);
      const existing = (await client.query<Row>(`SELECT ${GRANT_COLUMNS} FROM series_writing_grant WHERE workspace_id = $1 AND actor_id = $2 AND idempotency_key = $3`,
        [grant.workspaceId, grant.actorId, grant.idempotencyKey])).rows[0];
      if (existing) {
        const found = toGrant(existing);
        return found.requestHash === grant.requestHash && found.projectId === grant.projectId ? { kind: "existing", grant: found } : { kind: "conflict" };
      }
      const query: Query = (sql, values) => client.query<Row>(sql, values);
      const series = await this.seriesOf(query, grant.workspaceId, grant.projectId, true);
      if (!series || series.id !== grant.seriesId) return { kind: "refused", code: "NOT_FOUND" };
      const active = await this.activeRuns(client, grant.workspaceId);
      const same = active.find((item) => item.projectId === grant.projectId);
      if (same) return { kind: "active", runKind: same.kind, runId: same.id };
      const admission = admit(await this.load(query, series));
      if (admission.kind === "refused") return admission;
      if (active.length >= limits.maxActiveRuns) return { kind: "blocked", code: "SERIES_ACTIVE_RUN_CAP" };
      // Daily admission of the current bounded stage (its job) only; each send still reserves under the call lock.
      const required = seriesJobSends(admission.job);
      const remaining = Math.max(0, limits.maxCallsPerDay - await recentWritingCalls(client, grant.workspaceId, limits.sinceIso));
      if (remaining < required) return { kind: "daily_quota_low", requiredCalls: required, remainingCalls: remaining };
      await client.query(
        `INSERT INTO series_writing_grant (id, series_id, workspace_id, project_id, actor_id, idempotency_key, request_hash, input_json, provider_key, model,
           call_budget, calls_used, state, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, 0, 'running', $12, $12)`,
        [grant.id, grant.seriesId, grant.workspaceId, grant.projectId, grant.actorId, grant.idempotencyKey, grant.requestHash, JSON.stringify(grant.input),
          grant.input.providerKey, grant.input.model, grant.callBudget, grant.createdAt]);
      await this.insertJob(client, admission.job, null);
      return { kind: "created", grant, jobId: admission.job.run.id };
    });
  }

  async getJob(workspaceId: string, jobId: string): Promise<SeriesJobBundle | null> {
    const row = (await this.query(`SELECT ${RUN_COLUMNS} FROM series_writing_run WHERE id = $1 AND workspace_id = $2`, [jobId, workspaceId])).rows[0];
    if (!row) return null;
    const stages = (await this.query(`SELECT ${STAGE_COLUMNS} FROM series_writing_stage WHERE run_id = $1 ORDER BY ordinal`, [jobId])).rows.map(toStage);
    const calls = (await this.query(`SELECT ${CALL_COLUMNS} FROM series_writing_call WHERE run_id = $1 ORDER BY created_at, attempt_no`, [jobId])).rows.map(toCall);
    return { run: toRun(row), stages, calls };
  }

  async claimJob(workspaceId: string, jobId: string, executorId: string, nowIso: string, leaseUntil: string): Promise<boolean> {
    const result = await this.query(
      `UPDATE series_writing_run r SET executor_id = $2, lease_until = $4, updated_at = $3
        WHERE r.id = $1 AND r.workspace_id = $5 AND r.state = 'running'
          AND (r.executor_id IS NULL OR r.executor_id = $2 OR r.lease_until <= $3)
          AND (r.executor_id = $2 OR NOT EXISTS (SELECT 1 FROM series_writing_call c WHERE c.run_id = r.id AND c.state IN ('reserved', 'submitted')))`,
      [jobId, executorId, nowIso, leaseUntil, workspaceId]);
    return result.rowCount === 1;
  }

  private async ownedRun(client: PoolClient, workspaceId: string, jobId: string, executorId: string, nowIso: string): Promise<SeriesJobRecord | null> {
    const row = (await client.query<Row>(`SELECT ${RUN_COLUMNS} FROM series_writing_run WHERE id = $1 AND workspace_id = $2 FOR UPDATE`, [jobId, workspaceId])).rows[0];
    if (!row) return null;
    const run = toRun(row);
    if (run.state !== "running" || run.executorId !== executorId || run.leaseUntil === null || run.leaseUntil <= nowIso) return null;
    return run;
  }

  private async grantRow(client: PoolClient, grantId: string): Promise<SeriesGrantRecord> {
    return toGrant((await client.query<Row>(`SELECT ${GRANT_COLUMNS} FROM series_writing_grant WHERE id = $1 FOR UPDATE`, [grantId])).rows[0]!);
  }

  async completeLocalStage(workspaceId: string, jobId: string, executorId: string, stageKey: string, output: SeriesStageOutput, outputHash: string, nowIso: string): Promise<boolean> {
    return this.transaction(async (client) => {
      if (!await this.ownedRun(client, workspaceId, jobId, executorId, nowIso)) return false;
      const updated = await client.query(
        `UPDATE series_writing_stage SET state = 'completed', output_json = $3::jsonb, output_hash = $4, depends_on_json = '{}'::jsonb, updated_at = $5
          WHERE run_id = $1 AND stage_key = $2 AND state = 'pending'`, [jobId, stageKey, JSON.stringify(output), outputHash, nowIso]);
      if (updated.rowCount !== 1) return false;
      await client.query("UPDATE series_writing_run SET updated_at = $2 WHERE id = $1", [jobId, nowIso]);
      return true;
    });
  }

  async reserveCall(call: SeriesCallRecord, limits: { sinceIso: string; maxCallsPerDay: number }, nowIso: string, leaseUntil: string): Promise<SeriesCallReservation> {
    return this.transaction(async (client) => {
      // The same lock as every paid text call of the workspace: the shared count and this insert are atomic.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [writingCallLockKey(call.workspaceId)]);
      const run = await this.ownedRun(client, call.workspaceId, call.runId, call.executorId, nowIso);
      if (!run) return { kind: "lost" };
      const grant = await this.grantRow(client, run.grantId);
      if (run.cancelRequestedAt !== null || grant.cancelRequestedAt !== null) return { kind: "canceled" };
      if (run.callsUsed >= run.callCap) return { kind: "blocked", code: "SERIES_JOB_CAP" };
      if (grant.callsUsed >= grant.callBudget) return { kind: "blocked", code: "SERIES_GRANT_BUDGET" };
      if (await recentWritingCalls(client, call.workspaceId, limits.sinceIso) >= limits.maxCallsPerDay) return { kind: "blocked", code: "SERIES_DAILY_CAP" };
      const stage = await client.query(
        `UPDATE series_writing_stage SET state = 'reserved', attempt_no = $3, error_code = NULL, updated_at = $4
          WHERE run_id = $1 AND stage_key = $2 AND state = 'pending'`, [call.runId, call.stageKey, call.attemptNo, nowIso]);
      if (stage.rowCount !== 1) return { kind: "lost" };
      await client.query(
        `INSERT INTO series_writing_call (id, run_id, grant_id, series_id, workspace_id, stage_key, attempt_no, provider_key, model, request_hash, state, executor_id,
           usage_json, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'reserved', $11, $12::jsonb, $13)`,
        [call.id, call.runId, call.grantId, call.seriesId, call.workspaceId, call.stageKey, call.attemptNo, call.providerKey, call.model, call.requestHash,
          call.executorId, JSON.stringify(call.usage), call.createdAt]);
      await client.query("UPDATE series_writing_run SET calls_used = calls_used + 1, lease_until = $2, updated_at = $3 WHERE id = $1", [call.runId, leaseUntil, nowIso]);
      await client.query("UPDATE series_writing_grant SET calls_used = calls_used + 1, updated_at = $2 WHERE id = $1", [run.grantId, nowIso]);
      return { kind: "reserved" };
    });
  }

  async markCallSubmitted(workspaceId: string, callId: string, executorId: string, nowIso: string, leaseUntil: string): Promise<"submitted" | "canceled" | "lost"> {
    return this.transaction(async (client) => {
      const found = (await client.query<Row>("SELECT run_id, stage_key FROM series_writing_call WHERE id = $1 AND workspace_id = $2", [callId, workspaceId])).rows[0];
      if (!found) return "lost";
      const run = await this.ownedRun(client, workspaceId, String(found.run_id), executorId, nowIso);
      if (!run) return "lost";
      const grant = await this.grantRow(client, run.grantId);
      if (run.cancelRequestedAt !== null || grant.cancelRequestedAt !== null) {
        const closed = await client.query(
          "UPDATE series_writing_call SET state = 'rejected', error_code = $3, finished_at = $4 WHERE id = $1 AND executor_id = $2 AND state = 'reserved'",
          [callId, executorId, TITLE_WRITING_CANCELED_BEFORE_SEND, nowIso]);
        if (closed.rowCount !== 1) return "lost";
        await client.query("UPDATE series_writing_stage SET state = 'canceled', error_code = NULL, updated_at = $3 WHERE run_id = $1 AND stage_key = $2",
          [run.id, found.stage_key, nowIso]);
        await this.release(client, run.id, run.grantId, 1, nowIso);
        return "canceled";
      }
      const updated = await client.query("UPDATE series_writing_call SET state = 'submitted' WHERE id = $1 AND executor_id = $2 AND state = 'reserved'", [callId, executorId]);
      if (updated.rowCount !== 1) return "lost";
      await client.query("UPDATE series_writing_stage SET state = 'submitted', updated_at = $3 WHERE run_id = $1 AND stage_key = $2", [run.id, found.stage_key, nowIso]);
      await client.query("UPDATE series_writing_run SET lease_until = $2, updated_at = $3 WHERE id = $1", [run.id, leaseUntil, nowIso]);
      return "submitted";
    });
  }

  async finishCall(workspaceId: string, callId: string, executorId: string, patch: SeriesCallFinish, nowIso: string): Promise<boolean> {
    return this.transaction(async (client) => {
      const found = (await client.query<Row>("SELECT run_id, stage_key FROM series_writing_call WHERE id = $1 AND workspace_id = $2", [callId, workspaceId])).rows[0];
      if (!found) return false;
      const runRow = await client.query<Row>("SELECT executor_id FROM series_writing_run WHERE id = $1 AND workspace_id = $2 FOR UPDATE", [found.run_id, workspaceId]);
      if (runRow.rows[0]?.executor_id !== executorId) return false;
      const updated = await client.query(
        `UPDATE series_writing_call SET state = $3, error_code = $4, provider_request_id = $5, response_model = $6, usage_json = $7::jsonb, finished_at = $8
          WHERE id = $1 AND executor_id = $2 AND state = 'submitted'`,
        [callId, executorId, patch.state, patch.errorCode, patch.providerRequestId, patch.responseModel, JSON.stringify(patch.usage), nowIso]);
      if (updated.rowCount !== 1) return false;
      await client.query(
        `UPDATE series_writing_stage SET state = $3, error_code = $4, output_json = $5::jsonb, output_hash = $6, depends_on_json = $7::jsonb, updated_at = $8
          WHERE run_id = $1 AND stage_key = $2`,
        [found.run_id, found.stage_key, patch.state, patch.errorCode, patch.output === null ? null : JSON.stringify(patch.output), patch.outputHash,
          patch.dependsOn === null ? null : JSON.stringify(patch.dependsOn), nowIso]);
      await client.query("UPDATE series_writing_run SET updated_at = $2 WHERE id = $1", [found.run_id, nowIso]);
      return true;
    });
  }

  /** Gives never-sent reservations back to their job and grant (the call records stay, rejected before their send). */
  private async release(client: PoolClient, runId: string, grantId: string, calls: number, nowIso: string): Promise<void> {
    if (calls === 0) return;
    await client.query("UPDATE series_writing_run SET calls_used = GREATEST(calls_used - $2, 0), updated_at = $3 WHERE id = $1", [runId, calls, nowIso]);
    await client.query("UPDATE series_writing_grant SET calls_used = GREATEST(calls_used - $2, 0), updated_at = $3 WHERE id = $1", [grantId, calls, nowIso]);
  }

  private async stopGrant(client: PoolClient, grantId: string, state: SeriesGrantRecord["state"], reason: string | null, nowIso: string): Promise<void> {
    await client.query("UPDATE series_writing_grant SET state = $2, stop_reason = $3, updated_at = $4 WHERE id = $1", [grantId, state, reason, nowIso]);
  }

  async finishJob(workspaceId: string, jobId: string, executorId: string, state: Exclude<SeriesRunState, "running" | "completed">, errorCode: string | null, nowIso: string): Promise<boolean> {
    return this.transaction(async (client) => {
      const updated = await client.query<Row>(
        `UPDATE series_writing_run SET state = $3, error_code = $4, executor_id = NULL, lease_until = NULL, updated_at = $5
          WHERE id = $1 AND workspace_id = $6 AND state = 'running' AND executor_id = $2 RETURNING grant_id`,
        [jobId, executorId, state, errorCode, nowIso, workspaceId]);
      if (updated.rowCount !== 1) return false;
      if (state === "canceled") await client.query("UPDATE series_writing_stage SET state = 'canceled', updated_at = $2 WHERE run_id = $1 AND state = 'pending'", [jobId, nowIso]);
      await this.grantRow(client, String(updated.rows[0]!.grant_id));
      await this.stopGrant(client, String(updated.rows[0]!.grant_id), state === "canceled" ? "canceled" : "stopped", errorCode ?? state, nowIso);
      return true;
    });
  }

  private async handOver(client: PoolClient, series: SeriesRecord, grant: SeriesGrantRecord, limits: SeriesLimits, nowIso: string,
    executor: { executorId: string; leaseUntil: string } | null, next: (snapshot: SeriesSnapshot) => SeriesAdmission | { kind: "done" }): Promise<SeriesNextStep> {
    if (grant.cancelRequestedAt !== null) {
      await this.stopGrant(client, grant.id, "canceled", "canceled", nowIso);
      return { kind: "grant_stopped", reason: "canceled" };
    }
    const query: Query = (sql, values) => client.query<Row>(sql, values);
    const snapshot = await this.load(query, series);
    const decision = next(snapshot);
    if (decision.kind === "done") {
      await this.stopGrant(client, grant.id, "completed", null, nowIso);
      return { kind: "grant_completed" };
    }
    if (decision.kind === "refused") {
      await this.stopGrant(client, grant.id, "stopped", decision.code, nowIso);
      return { kind: "grant_stopped", reason: decision.code };
    }
    if ((await this.activeRuns(client, grant.workspaceId)).length >= limits.maxActiveRuns) {
      await this.stopGrant(client, grant.id, "stopped", "active_run_cap", nowIso);
      return { kind: "grant_stopped", reason: "active_run_cap" };
    }
    const required = seriesJobSends(decision.job);
    if (Math.max(0, limits.maxCallsPerDay - await recentWritingCalls(client, grant.workspaceId, limits.sinceIso)) < required) {
      await this.stopGrant(client, grant.id, "stopped", "daily_quota_low", nowIso);
      return { kind: "grant_stopped", reason: "daily_quota_low" };
    }
    if (grant.callsUsed + seriesGrantRemainingSends(snapshot, grant) - seriesJobNormalSends(decision.job) + required > grant.callBudget) {
      await this.stopGrant(client, grant.id, "stopped", "grant_budget_exhausted", nowIso);
      return { kind: "grant_stopped", reason: "grant_budget_exhausted" };
    }
    await this.insertJob(client, decision.job, executor);
    await client.query("UPDATE series_writing_grant SET state = 'running', stop_reason = NULL, updated_at = $2 WHERE id = $1", [grant.id, nowIso]);
    return { kind: "job", jobId: decision.job.run.id };
  }

  async completeJob(workspaceId: string, jobId: string, executorId: string, artifacts: SeriesJobArtifacts, limits: SeriesLimits, nowIso: string, leaseUntil: string,
    next: (snapshot: SeriesSnapshot) => SeriesAdmission | { kind: "done" }): Promise<SeriesNextStep> {
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [runLockKey(workspaceId)]);
      const projectRow = (await client.query<Row>("SELECT project_id FROM series_writing_run WHERE id = $1 AND workspace_id = $2", [jobId, workspaceId])).rows[0];
      if (!projectRow) return { kind: "lost" };
      const query: Query = (sql, values) => client.query<Row>(sql, values);
      const series = (await this.seriesOf(query, workspaceId, String(projectRow.project_id), true))!;
      const run = await this.ownedRun(client, workspaceId, jobId, executorId, nowIso);
      if (!run) return { kind: "lost" };
      const open = await client.query<Row>("SELECT count(*) FILTER (WHERE state <> 'completed')::int AS open FROM series_writing_stage WHERE run_id = $1", [jobId]);
      if (Number(open.rows[0]?.open ?? 1) !== 0) return { kind: "lost" };
      const grant = await this.grantRow(client, run.grantId);
      if (artifacts.kind === "plan") {
        const project = (await client.query<Row>("SELECT version, current_story_revision_id FROM project WHERE id = $1 AND workspace_id = $2 FOR UPDATE",
          [run.projectId, workspaceId])).rows[0]!;
        let storySave: SeriesPlanRevisionRecord["storySave"] = "conflict";
        let storyRevisionId: string | null = null;
        if (project.current_story_revision_id === null && artifacts.storyText !== null) {
          // The story editor's own save path: a DRAFT revision written by the machine job, never a person, never reviewed here.
          const created = await this.textChain.createStoryRevisionInTransaction(client, {
            workspaceId, projectId: run.projectId, content: { text: artifacts.storyText }, createdBy: `series-writing:${jobId}`,
            expectedVersion: Number(project.version), traceId: `series-writing:${jobId}`,
          });
          storyRevisionId = created.revisionId;
          storySave = "saved";
        }
        const plan = artifacts.plan;
        const revisionNo = Number((await client.query<Row>("SELECT coalesce(max(revision_no), 0)::int AS last FROM series_writing_plan_revision WHERE series_id = $1",
          [series.id])).rows[0]?.last ?? 0) + 1;
        await client.query(
          `INSERT INTO series_writing_plan_revision (id, series_id, workspace_id, revision_no, origin, source_run_id, parent_revision_id, content_json, content_hash,
             review_json, story_revision_id, story_save, created_by, created_at)
           VALUES ($1, $2, $3, $4, 'model', $5, $6, $7::jsonb, $8, $9::jsonb, $10, $11, $12, $13)`,
          [plan.id, series.id, workspaceId, revisionNo, plan.sourceRunId, plan.parentRevisionId, JSON.stringify(plan.content), plan.contentHash,
            plan.review === null ? null : JSON.stringify(plan.review), storyRevisionId, storySave, plan.createdBy, plan.createdAt]);
      }
      if (artifacts.kind === "batch") await this.insertLedger(client, workspaceId, artifacts.ledger);
      await client.query("UPDATE series_writing_run SET state = 'completed', error_code = NULL, executor_id = NULL, lease_until = NULL, updated_at = $2 WHERE id = $1",
        [jobId, nowIso]);
      return this.handOver(client, series, grant, limits, nowIso, { executorId, leaseUntil }, next);
    });
  }

  private async insertLedger(client: PoolClient, workspaceId: string, ledger: SeriesLedgerRevisionRecord): Promise<void> {
    const revisionNo = Number((await client.query<Row>(
      "SELECT coalesce(max(revision_no), 0)::int AS last FROM series_writing_ledger_revision WHERE series_id = $1 AND batch_no = $2", [ledger.seriesId, ledger.batchNo]))
      .rows[0]?.last ?? 0) + 1;
    await client.query(
      `INSERT INTO series_writing_ledger_revision (id, series_id, workspace_id, batch_no, revision_no, origin, content_json, content_hash, summaries_json, basis_json,
         created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10::jsonb, $11, $12)`,
      [ledger.id, ledger.seriesId, workspaceId, ledger.batchNo, revisionNo, ledger.origin, JSON.stringify(ledger.content), ledger.contentHash,
        JSON.stringify(ledger.summaries), JSON.stringify(ledger.basis), ledger.createdBy, ledger.createdAt]);
  }

  async requestCancel(workspaceId: string, projectId: string, grantId: string, nowIso: string): Promise<SeriesGrantRecord | null> {
    return this.transaction(async (client) => {
      // Job row before grant row, the order a reservation takes them in.
      const running = await client.query<Row>("SELECT id FROM series_writing_run WHERE grant_id = $1 AND workspace_id = $2 AND state = 'running' FOR UPDATE",
        [grantId, workspaceId]);
      const row = (await client.query<Row>(`SELECT ${GRANT_COLUMNS} FROM series_writing_grant WHERE id = $1 AND workspace_id = $2 AND project_id = $3 FOR UPDATE`,
        [grantId, workspaceId, projectId])).rows[0];
      if (!row) return null;
      const grant = toGrant(row);
      if (grant.state === "running" && grant.cancelRequestedAt === null) {
        await client.query("UPDATE series_writing_grant SET cancel_requested_at = $2, updated_at = $2 WHERE id = $1", [grantId, nowIso]);
        if (running.rows.length > 0) await client.query("UPDATE series_writing_run SET cancel_requested_at = $2, updated_at = $2 WHERE grant_id = $1 AND state = 'running'", [grantId, nowIso]);
        else await this.stopGrant(client, grantId, "canceled", "canceled", nowIso);
      } else if (grant.state === "stopped") {
        await client.query("UPDATE series_writing_grant SET cancel_requested_at = $2 WHERE id = $1", [grantId, nowIso]);
        await this.stopGrant(client, grantId, "canceled", "canceled", nowIso);
      }
      return toGrant((await client.query<Row>(`SELECT ${GRANT_COLUMNS} FROM series_writing_grant WHERE id = $1`, [grantId])).rows[0]!);
    });
  }

  async prepareResume(workspaceId: string, projectId: string, grantId: string, request: { resumeKey: string; requestHash: string; confirmedCallIds: readonly string[];
    providerReady: boolean; limits: SeriesLimits }, nowIso: string, next: (snapshot: SeriesSnapshot) => SeriesAdmission | { kind: "done" }): Promise<SeriesResumePreparation> {
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [runLockKey(workspaceId)]);
      const query: Query = (sql, values) => client.query<Row>(sql, values);
      const series = await this.seriesOf(query, workspaceId, projectId, true);
      const row = series ? (await client.query<Row>(`SELECT ${GRANT_COLUMNS} FROM series_writing_grant WHERE id = $1 AND workspace_id = $2 AND project_id = $3 FOR UPDATE`,
        [grantId, workspaceId, projectId])).rows[0] : undefined;
      if (!series || !row) return { kind: "not_found" };
      const grant = toGrant(row);
      const previous = (await client.query<Row>("SELECT request_hash FROM series_writing_resume WHERE grant_id = $1 AND idempotency_key = $2", [grantId, request.resumeKey])).rows[0];
      if (previous) return String(previous.request_hash) === request.requestHash ? { kind: "replayed", grant } : { kind: "key_conflict" };
      if (grant.state === "running") return { kind: "active" };
      // A canceled grant is final: going on is a new grant the person confirms again.
      if (grant.state === "completed" || grant.state === "canceled") return { kind: "not_resumable" };
      const active = await this.activeRuns(client, workspaceId);
      if (active.some((item) => item.projectId === projectId)) return { kind: "active" };
      if (active.length >= request.limits.maxActiveRuns) return { kind: "active_cap" };
      const snapshot = await this.load(query, series);
      const last = snapshot.jobs.filter((job) => job.run.grantId === grantId).sort((a, b) => a.run.seq - b.run.seq).at(-1)!;
      const record = async () => {
        await client.query(
          `INSERT INTO series_writing_resume (grant_id, workspace_id, idempotency_key, request_hash, confirmed_call_ids, created_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6)`, [grantId, workspaceId, request.resumeKey, request.requestHash, JSON.stringify([...request.confirmedCallIds].sort()), nowIso]);
      };
      if (last.run.state !== "completed") {
        const uncertain = currentUncertainCallIds(last.stages.map((stage) => ({ stepKey: stage.stageKey as TitleWritingStepKey, state: stage.state, attemptNo: stage.attemptNo })),
          last.calls.map((call) => ({ callId: call.id, stepKey: call.stageKey as TitleWritingStepKey, attemptNo: call.attemptNo, state: call.state })));
        const confirmed = [...request.confirmedCallIds].sort();
        if (uncertain.length > 0 && confirmed.length === 0) return { kind: "needs_confirmation" };
        if (uncertain.length !== confirmed.length || uncertain.some((id, index) => id !== confirmed[index])) return { kind: "stale_confirmation" };
        const redo = last.stages.filter((stage) => stage.state === "unknown" || stage.state === "rejected" || stage.state === "canceled");
        const sends = redo.some((stage) => stage.stageKey !== "sources") || last.stages.some((stage) => stage.state === "pending" && stage.stageKey !== "sources");
        if (sends && !request.providerReady) return { kind: "provider_unconfigured" };
        if (sends && (grant.callsUsed + seriesGrantRemainingSends(snapshot, grant) > grant.callBudget || last.run.callsUsed >= last.run.callCap)) return { kind: "budget_exhausted" };
        const upstream = seriesJobUpstreamChange(snapshot, last.run);
        if (upstream) return { kind: "refused", code: upstream };
        await record();
        await client.query("UPDATE series_writing_stage SET state = 'pending', updated_at = $2 WHERE run_id = $1 AND state IN ('unknown', 'rejected', 'canceled')", [last.run.id, nowIso]);
        await client.query(
          `UPDATE series_writing_run SET state = 'running', error_code = NULL, cancel_requested_at = NULL, executor_id = NULL, lease_until = NULL, updated_at = $2
            WHERE id = $1`, [last.run.id, nowIso]);
        await client.query("UPDATE series_writing_grant SET state = 'running', stop_reason = NULL, cancel_requested_at = NULL, updated_at = $2 WHERE id = $1", [grantId, nowIso]);
        return { kind: "ok", jobId: last.run.id };
      }
      // The last job completed and the grant stopped between jobs (a blocker, the daily cap): the next job, if the series may go on.
      const decision = next(snapshot);
      if (decision.kind === "done") return { kind: "not_resumable" };
      if (decision.kind === "refused") return { kind: "refused", code: decision.code, ...(decision.details ? { details: decision.details } : {}) };
      if (!request.providerReady) return { kind: "provider_unconfigured" };
      if (grant.callsUsed + seriesGrantRemainingSends(snapshot, grant) > grant.callBudget) return { kind: "budget_exhausted" };
      const required = seriesJobSends(decision.job);
      const remaining = Math.max(0, request.limits.maxCallsPerDay - await recentWritingCalls(client, workspaceId, request.limits.sinceIso));
      if (remaining < required) return { kind: "daily_quota_low", requiredCalls: required, remainingCalls: remaining };
      await record();
      await client.query("UPDATE series_writing_grant SET state = 'running', stop_reason = NULL, cancel_requested_at = NULL, updated_at = $2 WHERE id = $1", [grantId, nowIso]);
      await this.insertJob(client, decision.job, null);
      return { kind: "ok", jobId: decision.job.run.id };
    });
  }

  async recoverExpired(workspaceId: string, nowIso: string): Promise<number> {
    return this.transaction(async (client) => {
      const expired = await client.query<Row>(
        `SELECT id, grant_id FROM series_writing_run WHERE workspace_id = $2 AND state = 'running' AND executor_id IS NOT NULL AND lease_until <= $1
          ORDER BY lease_until LIMIT 50 FOR UPDATE SKIP LOCKED`, [nowIso, workspaceId]);
      for (const row of expired.rows) {
        const jobId = String(row.id);
        // Never sent: the reservation is given back (the call stays, rejected before its send), so the stage is sent once
        // within the job's own budget and never needs a person's resend. Only a reserved call is touched, so a second pass
        // gives nothing back again.
        const neverSent = await client.query<Row>(
          `UPDATE series_writing_call SET state = 'rejected', error_code = $3, finished_at = $2
            WHERE run_id = $1 AND state = 'reserved' RETURNING stage_key`, [jobId, nowIso, SERIES_NEVER_SENT_ERROR_CODES[0]]);
        for (const call of neverSent.rows) {
          await client.query("UPDATE series_writing_stage SET state = 'pending', updated_at = $3 WHERE run_id = $1 AND stage_key = $2", [jobId, call.stage_key, nowIso]);
        }
        await this.release(client, jobId, String(row.grant_id), neverSent.rows.length, nowIso);
        const maybeSent = await client.query<Row>(
          `UPDATE series_writing_call SET state = 'unknown', error_code = 'executor_lost', finished_at = $2
            WHERE run_id = $1 AND state = 'submitted' RETURNING stage_key`, [jobId, nowIso]);
        for (const call of maybeSent.rows) {
          await client.query("UPDATE series_writing_stage SET state = 'unknown', error_code = 'executor_lost', updated_at = $3 WHERE run_id = $1 AND stage_key = $2",
            [jobId, call.stage_key, nowIso]);
        }
        if (maybeSent.rows.length > 0) {
          await client.query("UPDATE series_writing_run SET state = 'needs_attention', error_code = 'executor_lost', executor_id = NULL, lease_until = NULL, updated_at = $2 WHERE id = $1",
            [jobId, nowIso]);
          await this.grantRow(client, String(row.grant_id));
          await this.stopGrant(client, String(row.grant_id), "stopped", "executor_lost", nowIso);
        } else {
          await client.query("UPDATE series_writing_run SET executor_id = NULL, lease_until = NULL, updated_at = $2 WHERE id = $1", [jobId, nowIso]);
        }
      }
      return expired.rows.length;
    });
  }

  async listClaimable(workspaceId: string, nowIso: string, limit: number): Promise<string[]> {
    const result = await this.query(
      `SELECT id FROM series_writing_run WHERE workspace_id = $3 AND state = 'running' AND (executor_id IS NULL OR lease_until <= $1) ORDER BY updated_at LIMIT $2`,
      [nowIso, limit, workspaceId]);
    return result.rows.map((row) => String(row.id));
  }

  /** The project row, after the series row (series → project → episode): the row the workbench's saves lock first. */
  private async lockProject(client: PoolClient, workspaceId: string, projectId: string): Promise<void> {
    await client.query("SELECT id FROM project WHERE id = $1 AND workspace_id = $2 FOR UPDATE", [projectId, workspaceId]);
  }

  /** Locks the series and refuses while one of its jobs runs (an edit never races a job). */
  private async editable(client: PoolClient, workspaceId: string, projectId: string): Promise<SeriesRecord | "not_found" | "active"> {
    const query: Query = (sql, values) => client.query<Row>(sql, values);
    const series = await this.seriesOf(query, workspaceId, projectId, true);
    if (!series) return "not_found";
    const running = await client.query("SELECT 1 FROM series_writing_run WHERE series_id = $1 AND state = 'running'", [series.id]);
    return running.rows[0] ? "active" : series;
  }

  async savePlanRevision(workspaceId: string, projectId: string, revision: SeriesPlanRevisionRecord, expected: { parentId: string | null; storyRevisionId: string | null },
    story: SeriesPlanStory): Promise<"saved" | "conflict" | "story_conflict" | "not_found" | "active"> {
    return this.transaction(async (client) => {
      // Series row, then project: the order placement and the story editor's save take them in.
      const series = await this.editable(client, workspaceId, projectId);
      if (typeof series === "string") return series;
      const current = (await client.query<Row>("SELECT id, revision_no FROM series_writing_plan_revision WHERE series_id = $1 ORDER BY revision_no DESC LIMIT 1", [series.id])).rows[0];
      if ((current ? String(current.id) : null) !== expected.parentId) return "conflict";
      const project = (await client.query<Row>("SELECT version, current_story_revision_id FROM project WHERE id = $1 AND workspace_id = $2 FOR UPDATE",
        [projectId, workspaceId])).rows[0];
      // The story the page showed must still be the work's current one: a story saved since is never silently replaced.
      if (!project || str(project.current_story_revision_id) !== expected.storyRevisionId) return "story_conflict";
      let storyRevisionId: string;
      if (story.mode === "from_plan") {
        // The story editor's own save path: a new DRAFT (never approved here); scripts of the story it replaces go STALE.
        storyRevisionId = (await this.textChain.createStoryRevisionInTransaction(client, {
          workspaceId, projectId, content: { text: story.text }, createdBy: revision.createdBy, expectedVersion: Number(project.version),
          traceId: `series-writing:plan:${revision.id}`,
        })).revisionId;
      } else {
        if (expected.storyRevisionId === null) return "story_conflict";
        storyRevisionId = expected.storyRevisionId;
      }
      await client.query(
        `INSERT INTO series_writing_plan_revision (id, series_id, workspace_id, revision_no, origin, source_run_id, parent_revision_id, content_json, content_hash,
           review_json, story_revision_id, story_save, created_by, created_at)
         VALUES ($1, $2, $3, $4, 'manual', NULL, $5, $6::jsonb, $7, NULL, $8, 'saved', $9, $10)`,
        [revision.id, series.id, workspaceId, Number(current?.revision_no ?? 0) + 1, expected.parentId, JSON.stringify(revision.content), revision.contentHash,
          storyRevisionId, revision.createdBy, revision.createdAt]);
      return "saved";
    });
  }

  async saveLedgerRevision(workspaceId: string, projectId: string, revision: SeriesLedgerRevisionRecord, expectedParentId: string | null,
    basisNow: (snapshot: SeriesSnapshot) => Record<string, string> | null, expectedBasis: Record<string, string>):
    Promise<"saved" | "conflict" | "stale" | "blocked" | "not_found" | "active"> {
    return this.transaction(async (client) => {
      // The series row lock every edit takes first: plan, ledgers and placement cannot change until this commits. A
      // workbench script or story save does not take it but takes the project row first (then the episode), so this
      // takes the project row too, in the same series → project order as placement: a save either committed before the
      // basis is read here (and is in it) or waits until this commits (and then makes the ledger pending as usual).
      const series = await this.editable(client, workspaceId, projectId);
      if (typeof series === "string") return series;
      await this.lockProject(client, workspaceId, projectId);
      const current = (await client.query<Row>(
        "SELECT id FROM series_writing_ledger_revision WHERE series_id = $1 AND batch_no = $2 ORDER BY revision_no DESC LIMIT 1", [series.id, revision.batchNo])).rows[0];
      if ((current ? String(current.id) : null) !== expectedParentId) return "conflict";
      const now = basisNow(await this.load((sql, values) => client.query<Row>(sql, values), series));
      if (!now) return "blocked";
      if (!sameBasis(now, expectedBasis)) return "stale";
      await this.insertLedger(client, workspaceId, { ...revision, seriesId: series.id });
      return "saved";
    });
  }

  async saveDecision(workspaceId: string, projectId: string, decision: SeriesDecisionRecord, current: (snapshot: SeriesSnapshot) => Record<string, string> | null):
    Promise<"saved" | "conflict" | "not_ready" | "not_found" | "active"> {
    return this.transaction(async (client) => {
      // The series row lock every edit takes first: no plan, ledger or placement changes between this read and the insert;
      // and the project row, as the workbench's story and script saves take it first: none of them crosses the check either.
      const series = await this.editable(client, workspaceId, projectId);
      if (typeof series === "string") return series;
      await this.lockProject(client, workspaceId, projectId);
      const now = current(await this.load((sql, values) => client.query<Row>(sql, values), series));
      if (!now) return "not_ready";
      if (!sameBasis(now, decision.basis)) return "conflict";
      await client.query(
        `INSERT INTO series_writing_decision (id, series_id, workspace_id, target, basis_json, note, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
        [decision.id, series.id, workspaceId, decision.target, JSON.stringify(decision.basis), decision.note, decision.createdBy, decision.createdAt]);
      return "saved";
    });
  }

  async placeBatch(workspaceId: string, projectId: string, batchNo: number, candidates: (snapshot: SeriesSnapshot) => SeriesPlacementCandidates,
    actorId: string, nowIso: string): Promise<SeriesPlacement> {
    return this.transaction(async (client) => {
      const series = await this.editable(client, workspaceId, projectId);
      if (series === "not_found") return { kind: "not_found" };
      if (series === "active") return { kind: "not_ready", reason: "job_running" };
      const query: Query = (sql, values) => client.query<Row>(sql, values);
      // Series row → project → episodes (the order of the script editor's save, project then episode), and only then the
      // state: no story or script save can cross the dependency check below before this commits.
      const project = (await client.query<Row>(
        `SELECT p.current_story_revision_id, p.approved_story_revision_id, p.episode_count, p.writing_mode, sr.review_status, sr.freshness_status
           FROM project p LEFT JOIN story_revision sr ON sr.id = p.approved_story_revision_id WHERE p.id = $1 AND p.workspace_id = $2 FOR UPDATE OF p`,
        [projectId, workspaceId])).rows[0];
      const episodes = (await client.query<Row>(
        "SELECT id, episode_no, row_version, current_script_revision_id FROM episode WHERE project_id = $1 AND workspace_id = $2 ORDER BY episode_no FOR UPDATE",
        [projectId, workspaceId])).rows;
      const snapshot = await this.load(query, series);
      const plan = seriesCurrentPlan(snapshot);
      if (!plan || plan.storySave !== "saved" || plan.storyRevisionId === null) return { kind: "story_not_saved" };
      const own = await client.query("SELECT 1 FROM story_revision WHERE id = $1 AND project_id = $2 AND workspace_id = $3", [plan.storyRevisionId, projectId, workspaceId]);
      if (!own.rows[0]) return { kind: "story_not_saved" };
      const approved = str(project?.approved_story_revision_id);
      if (!approved || str(project?.current_story_revision_id) !== approved || project?.review_status !== "APPROVED" || project.freshness_status !== "CURRENT") {
        return { kind: "story_not_approved" };
      }
      // Scripts are written from the plan's own story only; another approved story needs plan and story bound again first.
      if (approved !== plan.storyRevisionId) return { kind: "story_changed" };
      const n = series.input.episodeCount;
      const numbers = episodes.map((row) => Number(row.episode_no));
      if (project.writing_mode !== "series" || Number(project.episode_count) !== n || numbers.length !== n || numbers.some((number, index) => number !== index + 1)) {
        return { kind: "plan_mismatch" };
      }
      // The batch's dependencies checked again on the locked state: nothing written from a plan, ledger or review no longer current.
      const chosen = candidates(snapshot);
      if (chosen.kind === "blocked") return { kind: "not_ready", reason: chosen.reason };
      const { first, last } = seriesBatchRange(n, batchNo);
      let placed = 0;
      const conflicts: number[] = [];
      for (const script of chosen.scripts) {
        if (script.episodeNo < first || script.episodeNo > last) return { kind: "plan_mismatch" };
        const stage = (await client.query<Row>("SELECT script_save FROM series_writing_stage WHERE run_id = $1 AND stage_key = $2 FOR UPDATE", [script.runId, script.stageKey])).rows[0];
        if (!stage || stage.script_save !== "pending") continue;
        const episode = episodes.find((row) => Number(row.episode_no) === script.episodeNo)!;
        if (episode.current_script_revision_id !== null) {
          await client.query("UPDATE series_writing_stage SET script_save = 'conflict', updated_at = $3 WHERE run_id = $1 AND stage_key = $2", [script.runId, script.stageKey, nowIso]);
          conflicts.push(script.episodeNo);
          continue;
        }
        const created = await this.textChain.createScriptRevisionInTransaction(client, {
          workspaceId, projectId, episodeId: String(episode.id), sourceStoryRevisionId: approved, content: { text: script.text },
          createdBy: actorId, expectedVersion: Number(episode.row_version), traceId: `series-writing:${script.runId}`,
        });
        await client.query("UPDATE series_writing_stage SET script_save = 'saved', script_revision_id = $3, updated_at = $4 WHERE run_id = $1 AND stage_key = $2",
          [script.runId, script.stageKey, created.revisionId, nowIso]);
        placed += 1;
      }
      return { kind: "ok", placed, conflicts };
    });
  }

  private async query(sql: string, values: unknown[]): Promise<QueryResult<Row>> {
    const client = await this.pool.connect();
    try {
      return await client.query<Row>(sql, values);
    } finally {
      client.release();
    }
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
