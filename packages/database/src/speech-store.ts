import { randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import { SPEECH_STORAGE_VERSION, speechVoiceSchema, type SpeechBinding, type SpeechBindingPut, type SpeechGenerationInput,
  type SpeechMixManifest, type SpeechMixPreflight, type SpeechMixRequest, type SpeechPlanLine, type SpeechPlanPut,
  type SpeechPlanView, type SpeechSelection, type SpeechSelectionPut, type SpeechTake, type SpeechTakesPage,
  type SpeechVoice, type SpeechVoiceRevision } from "@ai-drama/contracts";
import { buildSpeechMixPreflight, speechExactHash, speechDialogueHash, speechLineInputHash, validateSpeechPlanSource } from "@ai-drama/domain";
import { PersistenceError, type DatabasePool, type JobPersistenceService } from "./job-service";
import { projectEpisodePlanIn } from "./episode-plan";

type Row = QueryResultRow & Record<string, unknown>;
type Context = { actorId: string; traceId: string; idempotencyKey: string };
export interface SpeechImpact { inputHash: string; affectedLines: number; affectedShots: number; affectedAssets: number }
export interface SpeechPersistence {
  storageReady(): Promise<boolean>;
  requireProject(workspaceId: string, projectId: string): Promise<void>;
  bindings(workspaceId: string, projectId: string): Promise<{ items: SpeechBinding[] }>;
  bindingImpact(workspaceId: string, projectId: string, speakerId: string): Promise<SpeechImpact>;
  putBinding(workspaceId: string, projectId: string, speakerId: string, voice: SpeechVoice,
    body: SpeechBindingPut, expectedVersion: number, context: Context): Promise<SpeechBinding>;
  plan(workspaceId: string, shotRevisionId: string): Promise<SpeechPlanView>;
  putPlan(workspaceId: string, shotRevisionId: string, body: SpeechPlanPut, expectedVersion: number, context: Context): Promise<SpeechPlanView>;
  generationInput(workspaceId: string, planRevisionId: string, lineId: string, historicalRead?: boolean): Promise<SpeechGenerationInput>;
  takes(workspaceId: string, planRevisionId: string, cursor?: string): Promise<SpeechTakesPage>;
  select(workspaceId: string, planRevisionId: string, lineId: string, body: SpeechSelectionPut,
    expectedVersion: number, context: Context): Promise<{ rowVersion: number; selection: SpeechSelection }>;
  mixPreflight(workspaceId: string, planRevisionId: string, body: SpeechMixRequest): Promise<SpeechMixPreflight>;
}
function fail(code: string, message: string): never { throw new PersistenceError(code, message); }
const iso = (value: unknown): string => value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
const json = (value: unknown): Record<string, unknown> => typeof value === "string" ? JSON.parse(value) as Record<string, unknown> : value as Record<string, unknown>;
const TABLES = ["speech_voice_binding", "speech_voice_revision", "speech_plan", "speech_plan_revision", "speech_line_input_revision",
  "speech_plan_line", "speech_take", "speech_selection_slot", "speech_selection", "speech_mix_dependency", "speech_mix_selection_dependency"];

async function project(client: PoolClient, workspaceId: string, projectId: string, lock = false): Promise<void> {
  const row = await client.query("SELECT id FROM project WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL" + (lock ? " FOR UPDATE" : ""), [projectId, workspaceId]);
  if (!row.rows[0]) fail("NOT_FOUND", "Project not found");
  if ((await projectEpisodePlanIn(client, workspaceId, projectId)).writingMode === "series") fail("SERIES_MEDIA_NOT_ENABLED", "Series media is not enabled");
}
/** The same project lock serializes source edits, voice changes, selection and composition completion. */
async function source(client: PoolClient, workspaceId: string, shotRevisionId: string, lock = false): Promise<{ projectId: string; dialogue: string }> {
  const found = await client.query<Row>("SELECT project_id FROM shot_revision WHERE id = $1 AND workspace_id = $2", [shotRevisionId, workspaceId]);
  if (!found.rows[0]) fail("NOT_FOUND", "Shot revision not found");
  const projectId = String(found.rows[0].project_id);
  await project(client, workspaceId, projectId, lock);
  const pending = await client.query("SELECT 1 FROM stale_recalculation WHERE workspace_id=$1 AND project_id=$2 AND status IN ('PENDING','RUNNING') LIMIT 1", [workspaceId, projectId]);
  if (pending.rows[0]) fail("STALE_RECALCULATION_PENDING", "Source freshness is being recalculated");
  const result = await client.query<Row>(`SELECT r.dialogue, (
      sh.current_revision_id=r.id AND sh.approved_revision_id=r.id AND sh.archived_at IS NULL
      AND r.review_status='APPROVED' AND r.freshness_status='CURRENT'
      AND sc.current_revision_id=sr.id AND sc.approved_revision_id=sr.id AND sc.archived_at IS NULL
      AND sr.review_status='APPROVED' AND sr.freshness_status='CURRENT'
      AND NOT EXISTS (SELECT 1 FROM shot_character_reference ref
        JOIN character_revision cr ON cr.id=ref.character_revision_id AND cr.workspace_id=ref.workspace_id AND cr.project_id=ref.project_id
        JOIN character c ON c.id=cr.character_id AND c.workspace_id=cr.workspace_id AND c.project_id=cr.project_id
        WHERE ref.workspace_id=r.workspace_id AND ref.project_id=r.project_id AND ref.shot_revision_id=r.id
        AND (c.archived_at IS NOT NULL OR c.current_revision_id IS DISTINCT FROM cr.id OR c.approved_revision_id IS DISTINCT FROM cr.id OR cr.review_status<>'APPROVED' OR cr.freshness_status<>'CURRENT'))
      ) AS usable, sr.id AS scene_revision_id
      FROM shot_revision r JOIN shot sh ON sh.id=r.shot_id AND sh.workspace_id=r.workspace_id AND sh.project_id=r.project_id
      JOIN scene_revision sr ON sr.id=r.source_scene_revision_id AND sr.workspace_id=r.workspace_id AND sr.project_id=r.project_id
      JOIN scene sc ON sc.id=sr.scene_id AND sc.workspace_id=r.workspace_id AND sc.project_id=r.project_id
      WHERE r.id=$1 AND r.workspace_id=$2 AND r.project_id=$3`, [shotRevisionId, workspaceId, projectId]);
  const row = result.rows[0];
  if (!row || row.usable !== true) fail("REVIEW_REQUIRED", "Speech requires current approved shot, scene and characters");
  const scripts = await client.query<Row>(`SELECT consumer_type, consumer_revision_id, script_revision_id
    FROM script_revision_consumer_source WHERE workspace_id=$1 AND project_id=$2
      AND ((consumer_type='scene_revision' AND consumer_revision_id=$3) OR (consumer_type='shot_revision' AND consumer_revision_id=$4))`,
  [workspaceId, projectId, row.scene_revision_id, shotRevisionId]);
  if (!scripts.rows.some((item) => item.consumer_type === "scene_revision")) fail("REVIEW_REQUIRED", "Scene script source is missing");
  for (const item of scripts.rows) {
    const checked = await client.query<Row>("SELECT m2_script_source_is_usable($1,$2,$3,$4,$5) AS ok", [workspaceId, projectId, item.consumer_type, item.consumer_revision_id, item.script_revision_id]);
    if (checked.rows[0]?.ok !== true) fail("REVIEW_REQUIRED", "Speech script source is no longer usable");
  }
  return { projectId, dialogue: String(row.dialogue ?? "") };
}
function voiceRevision(row: Row): SpeechVoiceRevision {
  const parsed = speechVoiceSchema.safeParse(json(row.voice_json));
  if (!parsed.success || speechExactHash(parsed.data) !== row.content_hash) fail("SPEECH_STORAGE_CORRUPT", "Voice snapshot is invalid");
  return { ...parsed.data, id: String(row.revision_id ?? row.id), bindingId: String(row.binding_id), contentHash: String(row.content_hash) };
}
function binding(row: Row): SpeechBinding {
  return { id: String(row.binding_id), speakerId: String(row.speaker_id), rowVersion: Number(row.row_version), currentRevision: voiceRevision(row) };
}
function line(row: Row): SpeechPlanLine {
  return { lineId: String(row.line_id), lineInputRevisionId: String(row.line_input_revision_id), inputHash: String(row.input_hash),
    speakerBindingRevisionId: String(row.voice_revision_id), sourceStart: Number(row.source_start), sourceEnd: Number(row.source_end),
    displayText: String(row.display_text), emotion: String(row.emotion), speed: Number(row.speed), pauseAfterMs: Number(row.pause_after_ms) };
}
const LINE_SQL = `SELECT pl.*, li.input_hash, li.voice_revision_id, li.display_text, li.emotion, li.speed
  FROM speech_plan_line pl JOIN speech_line_input_revision li ON li.id=pl.line_input_revision_id AND li.workspace_id=pl.workspace_id AND li.project_id=pl.project_id`;
async function planByRevision(client: PoolClient, workspaceId: string, planRevisionId: string, requireCurrent = true): Promise<Row> {
  const result = await client.query<Row>(`SELECT p.*, r.id AS revision_id, r.content_hash, r.source_dialogue_hash, r.timing_policy
    FROM speech_plan_revision r JOIN speech_plan p ON p.id=r.plan_id AND p.workspace_id=r.workspace_id AND p.project_id=r.project_id
    WHERE r.id=$1 AND r.workspace_id=$2`, [planRevisionId, workspaceId]);
  const row = result.rows[0];
  if (!row) fail("NOT_FOUND", "Speech plan not found");
  if (requireCurrent && row.current_revision_id !== planRevisionId) fail("SPEECH_PLAN_STALE", "Speech plan was replaced");
  return row;
}
async function voicesFor(client: PoolClient, workspaceId: string, projectId: string, shotRevisionId: string, ids: string[], currentOnly = true): Promise<Map<string, { voice: SpeechVoiceRevision; speakerName: string }>> {
  const result = await client.query<Row>(`SELECT v.*, v.id AS revision_id, b.speaker_id, COALESCE(c.name,'旁白') AS speaker_name
    FROM speech_voice_revision v JOIN speech_voice_binding b ON b.id=v.binding_id AND b.workspace_id=v.workspace_id AND b.project_id=v.project_id
    LEFT JOIN character c ON c.id=b.character_id AND c.workspace_id=b.workspace_id AND c.project_id=b.project_id
    WHERE v.workspace_id=$1 AND v.project_id=$2 AND v.id=ANY($3::uuid[]) ${currentOnly ? "AND b.current_revision_id=v.id" : ""}
      AND (b.speaker_id='narrator' OR EXISTS (SELECT 1 FROM shot_character_reference ref
        JOIN character_revision cr ON cr.id=ref.character_revision_id AND cr.workspace_id=ref.workspace_id AND cr.project_id=ref.project_id
        WHERE ref.shot_revision_id=$4 AND ref.workspace_id=$1 AND ref.project_id=$2 AND cr.character_id=b.character_id))`,
  [workspaceId, projectId, ids, shotRevisionId]);
  return new Map(result.rows.map((row) => [String(row.revision_id), { voice: voiceRevision(row), speakerName: String(row.speaker_name) }]));
}
async function selections(client: PoolClient, workspaceId: string, planRevisionId: string): Promise<SpeechSelection[]> {
  const rows = await client.query<Row>(`SELECT s.*, slot.line_id FROM speech_selection_slot slot
    JOIN speech_selection s ON s.id=slot.current_selection_id AND s.slot_id=slot.id AND s.workspace_id=slot.workspace_id AND s.project_id=slot.project_id
    WHERE slot.workspace_id=$1 AND slot.plan_revision_id=$2 ORDER BY slot.line_id`, [workspaceId, planRevisionId]);
  return rows.rows.map((row) => ({ id: String(row.id), lineId: String(row.line_id), takeAssetId: String(row.take_asset_id),
    lineInputRevisionId: String(row.line_input_revision_id), checksumSha256: String(row.checksum_sha256), selectedBy: String(row.selected_by),
    selectedAt: iso(row.selected_at), inheritedFromSelectionId: row.inherited_from_selection_id ? String(row.inherited_from_selection_id) : null }));
}
const TAKE_SQL = `SELECT a.*, t.line_input_revision_id, t.job_id, li.line_id, li.voice_revision_id,
  (a.status='ACTIVE' AND a.review_status='DRAFT' AND a.kind='AUDIO' AND a.mime_type='audio/wav' AND a.duration_ms>0
   AND a.width IS NULL AND a.height IS NULL AND a.source_generation_job_id=t.job_id AND a.source_job_attempt_id=t.attempt_id
   AND a.source_shot_revision_id=li.shot_revision_id AND j.source_shot_revision_id=li.shot_revision_id
   AND a.provider_configuration_id=at.provider_configuration_id AND a.provider_configuration_id=vr.provider_configuration_id
   AND a.provider_request_id=at.provider_request_id
   AND j.state='SUCCEEDED' AND j.kind='MEDIA_TTS' AND at.finished_at IS NOT NULL
   AND at.attempt_no=(SELECT max(latest.attempt_no) FROM job_attempt latest WHERE latest.generation_job_id=j.id AND latest.workspace_id=j.workspace_id)
   AND vb.current_revision_id=li.voice_revision_id) AS selectable
  FROM speech_take t JOIN asset a ON a.id=t.asset_id AND a.workspace_id=t.workspace_id AND a.project_id=t.project_id
  JOIN speech_line_input_revision li ON li.id=t.line_input_revision_id AND li.workspace_id=t.workspace_id AND li.project_id=t.project_id
  JOIN speech_voice_revision vr ON vr.id=li.voice_revision_id AND vr.workspace_id=li.workspace_id AND vr.project_id=li.project_id
  JOIN speech_voice_binding vb ON vb.id=vr.binding_id AND vb.workspace_id=vr.workspace_id AND vb.project_id=vr.project_id
  JOIN generation_job j ON j.id=t.job_id AND j.workspace_id=t.workspace_id AND j.project_id=t.project_id
  JOIN job_attempt at ON at.id=t.attempt_id AND at.generation_job_id=j.id AND at.workspace_id=t.workspace_id`;
function take(row: Row): SpeechTake {
  return { assetId: String(row.id), lineId: String(row.line_id), lineInputRevisionId: String(row.line_input_revision_id),
    checksumSha256: String(row.checksum_sha256), durationMs: Number(row.duration_ms), status: String(row.status), selectable: row.selectable === true,
    jobId: String(row.job_id), alignmentVersion: "sentence-duration-v1" };
}
async function stale(client: PoolClient, workspaceId: string, projectId: string, seeds: string[], reason: string, traceId: string): Promise<string[]> {
  if (!seeds.length) return [];
  const result = await client.query<Row>(`WITH RECURSIVE affected(id) AS (
    SELECT unnest($3::uuid[]) UNION SELECT d.dependent_asset_id FROM asset_dependency d JOIN affected a ON a.id=d.source_asset_id
      WHERE d.workspace_id=$1 AND d.project_id=$2
    ), changed AS (UPDATE asset SET status='STALE',row_version=row_version+1 WHERE workspace_id=$1 AND project_id=$2 AND status='ACTIVE'
      AND id IN (SELECT id FROM affected) RETURNING id), events AS (
      INSERT INTO domain_event(workspace_id,project_id,aggregate_type,aggregate_id,event_type,payload_json,trace_id)
      SELECT $1,$2,'Asset',id,'asset.stale',jsonb_build_object('assetId',id,'staleFromRef',$4::text),$5 FROM changed RETURNING 1)
    SELECT id FROM changed`, [workspaceId, projectId, seeds, reason, traceId]);
  return result.rows.map((row) => String(row.id));
}

export class PostgresSpeechStore implements SpeechPersistence {
  constructor(private readonly pool: DatabasePool, private readonly jobs: JobPersistenceService) {}
  private async read<T>(work: (client: PoolClient) => Promise<T>): Promise<T> { const c = await this.pool.connect(); try { return await work(c); } finally { c.release(); } }
  async storageReady(): Promise<boolean> {
    return this.read(async (client) => {
      const row = await client.query<Row>(`SELECT obj_description(to_regclass('speech_voice_binding'),'pg_class') AS version,
        (SELECT count(*)::int FROM information_schema.tables WHERE table_schema=current_schema() AND table_name=ANY($1::text[])) AS tables,
        (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal AND tgenabled IN ('O','A') AND tgname='speech_immutable_guard' AND tgrelid=ANY(ARRAY[
          to_regclass('speech_voice_revision'),to_regclass('speech_plan_revision'),to_regclass('speech_line_input_revision'),to_regclass('speech_plan_line'),
          to_regclass('speech_take'),to_regclass('speech_selection'),to_regclass('speech_mix_dependency'),to_regclass('speech_mix_selection_dependency')])) AS guards,
        (SELECT count(*)::int FROM pg_trigger WHERE NOT tgisinternal AND tgenabled IN ('O','A') AND tgname='speech_pointer_guard'
          AND tgrelid=ANY(ARRAY[to_regclass('speech_voice_binding'),to_regclass('speech_plan'),to_regclass('speech_selection_slot')])) AS pointers`, [TABLES]);
      return row.rows[0]?.version === SPEECH_STORAGE_VERSION && Number(row.rows[0]?.tables) === TABLES.length && Number(row.rows[0]?.guards) === 8 && Number(row.rows[0]?.pointers) === 3;
    });
  }
  async requireProject(workspaceId: string, projectId: string): Promise<void> { return this.read((c) => project(c, workspaceId, projectId)); }
  private async write<T>(workspaceId: string, route: string, body: unknown, context: Context, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const result = await this.jobs.runIdempotent({ workspaceId, actorId: context.actorId, httpMethod: "PUT", routeKey: route,
      key: context.idempotencyKey, requestHash: speechExactHash(body), expiresAt: new Date("9999-12-31T00:00:00Z") }, 200, work);
    return result.body;
  }
  async bindings(workspaceId: string, projectId: string): Promise<{ items: SpeechBinding[] }> {
    return this.read(async (client) => { await project(client, workspaceId, projectId); const rows = await client.query<Row>(`SELECT b.id AS binding_id,b.speaker_id,b.row_version,v.id AS revision_id,v.content_hash,v.voice_json
      FROM speech_voice_binding b JOIN speech_voice_revision v ON v.id=b.current_revision_id AND v.binding_id=b.id AND v.workspace_id=b.workspace_id AND v.project_id=b.project_id
      WHERE b.workspace_id=$1 AND b.project_id=$2 ORDER BY b.speaker_id`, [workspaceId, projectId]); return { items: rows.rows.map(binding) }; });
  }
  private async impactIn(client: PoolClient, workspaceId: string, projectId: string, speakerId: string): Promise<SpeechImpact & { seeds: string[] }> {
    const rows = await client.query<Row>(`SELECT b.current_revision_id,li.id AS input_id,li.line_id,li.shot_revision_id,t.asset_id,
      EXISTS (SELECT 1 FROM speech_plan_line pl JOIN speech_plan p ON p.current_revision_id=pl.plan_revision_id AND p.workspace_id=pl.workspace_id AND p.project_id=pl.project_id
        WHERE pl.line_input_revision_id=li.id AND pl.workspace_id=li.workspace_id AND pl.project_id=li.project_id) AS current_line
      FROM speech_voice_binding b LEFT JOIN speech_line_input_revision li ON li.voice_revision_id=b.current_revision_id AND li.workspace_id=b.workspace_id AND li.project_id=b.project_id
      LEFT JOIN speech_take t ON t.line_input_revision_id=li.id AND t.workspace_id=li.workspace_id AND t.project_id=li.project_id
      WHERE b.workspace_id=$1 AND b.project_id=$2 AND b.speaker_id=$3 ORDER BY li.id,t.asset_id`, [workspaceId, projectId, speakerId]);
    const seeds = rows.rows.flatMap((row) => row.asset_id ? [String(row.asset_id)] : []);
    const assets = await client.query<Row>(`WITH RECURSIVE affected(id) AS (SELECT unnest($3::uuid[]) UNION SELECT d.dependent_asset_id FROM asset_dependency d JOIN affected a ON a.id=d.source_asset_id WHERE d.workspace_id=$1 AND d.project_id=$2)
      SELECT asset.id,asset.kind,asset.status FROM affected JOIN asset ON asset.id=affected.id AND asset.workspace_id=$1 AND asset.project_id=$2 ORDER BY asset.id`, [workspaceId, projectId, seeds]);
    return { inputHash: speechExactHash({ speakerId, rows: rows.rows, assets: assets.rows }),
      affectedLines: new Set(rows.rows.flatMap((row) => row.current_line === true ? [`${row.shot_revision_id}:${row.line_id}`] : [])).size,
      affectedShots: new Set(rows.rows.flatMap((row) => row.current_line === true ? [String(row.shot_revision_id)] : [])).size,
      affectedAssets: assets.rows.filter((row) => row.kind === "COMPOSITE" && row.status === "ACTIVE").length, seeds };
  }
  async bindingImpact(workspaceId: string, projectId: string, speakerId: string): Promise<SpeechImpact> {
    return this.read(async (c) => { await project(c, workspaceId, projectId); const { seeds: _seeds, ...impact } = await this.impactIn(c, workspaceId, projectId, speakerId); return impact; });
  }
  async putBinding(workspaceId: string, projectId: string, speakerId: string, voice: SpeechVoice, body: SpeechBindingPut, expectedVersion: number, context: Context): Promise<SpeechBinding> {
    return this.write(workspaceId, `/projects/${projectId}/voice-bindings/${speakerId}`, { body, voice, expectedVersion }, context, async (client) => {
      await project(client, workspaceId, projectId, true);
      if (speakerId !== "narrator") {
        const c = await client.query("SELECT id FROM character WHERE id=$1 AND project_id=$2 AND workspace_id=$3 AND archived_at IS NULL", [speakerId, projectId, workspaceId]);
        if (!c.rows[0]) fail("NOT_FOUND", "Speaker is not a project character");
      }
      const found = await client.query<Row>("SELECT * FROM speech_voice_binding WHERE workspace_id=$1 AND project_id=$2 AND speaker_id=$3 FOR UPDATE", [workspaceId, projectId, speakerId]);
      const existing = found.rows[0];
      if ((existing ? Number(existing.row_version) : 0) !== expectedVersion) fail("REVISION_CONFLICT", "Voice binding changed");
      if (existing?.current_revision_id) {
        const prior = await client.query<Row>("SELECT * FROM speech_voice_revision WHERE id=$1 AND workspace_id=$2 AND project_id=$3", [existing.current_revision_id, workspaceId, projectId]);
        const saved = prior.rows[0] ? voiceRevision(prior.rows[0]) : null;
        if (saved?.contentHash === speechExactHash(voice)) return { id: String(existing.id), speakerId, rowVersion: expectedVersion, currentRevision: saved };
      }
      const impact = await this.impactIn(client, workspaceId, projectId, speakerId);
      if (existing && body.expectedImpactHash !== impact.inputHash) fail("SPEECH_IMPACT_CHANGED", "Confirm the current voice-change impact first");
      const provider = await client.query<Row>("SELECT id FROM provider_configuration WHERE id=$1 AND workspace_id=$2 AND capability='audio.tts' AND provider_key=$3 AND enabled", [voice.providerConfigurationId, workspaceId, voice.providerKey]);
      if (!provider.rows[0]) fail("SPEECH_PROVIDER_DISABLED", "Voice provider is no longer available");
      const bindingId = existing ? String(existing.id) : randomUUID(), revisionId = randomUUID(), contentHash = speechExactHash(voice);
      if (!existing) await client.query("INSERT INTO speech_voice_binding(id,workspace_id,project_id,speaker_id,character_id) VALUES($1,$2,$3,$4,$5)", [bindingId, workspaceId, projectId, speakerId, speakerId === "narrator" ? null : speakerId]);
      await client.query("INSERT INTO speech_voice_revision(id,workspace_id,project_id,binding_id,provider_configuration_id,content_hash,voice_json,created_by) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)", [revisionId, workspaceId, projectId, bindingId, voice.providerConfigurationId, contentHash, JSON.stringify(voice), context.actorId]);
      const version = existing ? expectedVersion + 1 : 1;
      await client.query("UPDATE speech_voice_binding SET current_revision_id=$1,row_version=$2,updated_at=now() WHERE id=$3 AND workspace_id=$4", [revisionId, version, bindingId, workspaceId]);
      await stale(client, workspaceId, projectId, impact.seeds, `voice:${existing?.current_revision_id ?? "new"}`, context.traceId);
      return { id: bindingId, speakerId, rowVersion: version, currentRevision: { ...voice, id: revisionId, bindingId, contentHash } };
    });
  }
  private async planIn(client: PoolClient, workspaceId: string, shotRevisionId: string): Promise<SpeechPlanView> {
    const src = await source(client, workspaceId, shotRevisionId);
    const result = await client.query<Row>(`SELECT p.*,r.id AS revision_id,r.content_hash,r.timing_policy FROM speech_plan p
      LEFT JOIN speech_plan_revision r ON r.id=p.current_revision_id AND r.plan_id=p.id AND r.workspace_id=p.workspace_id AND r.project_id=p.project_id
      WHERE p.workspace_id=$1 AND p.shot_revision_id=$2`, [workspaceId, shotRevisionId]);
    const p = result.rows[0];
    const ls = p?.revision_id ? await client.query<Row>(`${LINE_SQL} WHERE pl.workspace_id=$1 AND pl.plan_revision_id=$2 ORDER BY pl.ordinal`, [workspaceId, p.revision_id]) : { rows: [] };
    return { shotRevisionId, projectId: src.projectId, sourceDialogue: src.dialogue, sourceDialogueHash: speechDialogueHash(src.dialogue), rowVersion: Number(p?.row_version ?? 0),
      currentRevision: p?.revision_id ? { id: String(p.revision_id), contentHash: String(p.content_hash), timingPolicy: "sequential-reject-overflow", lines: ls.rows.map(line) } : null };
  }
  async plan(workspaceId: string, shotRevisionId: string): Promise<SpeechPlanView> { return this.read((c) => this.planIn(c, workspaceId, shotRevisionId)); }
  async putPlan(workspaceId: string, shotRevisionId: string, body: SpeechPlanPut, expectedVersion: number, context: Context): Promise<SpeechPlanView> {
    return this.write(workspaceId, `/shot-revisions/${shotRevisionId}/speech-plan`, { body, expectedVersion }, context, async (client) => {
      const src = await source(client, workspaceId, shotRevisionId, true);
      const current = await client.query<Row>("SELECT * FROM speech_plan WHERE workspace_id=$1 AND shot_revision_id=$2 FOR UPDATE", [workspaceId, shotRevisionId]);
      const old = current.rows[0];
      if (Number(old?.row_version ?? 0) !== expectedVersion) fail("REVISION_CONFLICT", "Speech plan changed");
      const voices = await voicesFor(client, workspaceId, src.projectId, shotRevisionId, body.lines.map((value) => value.speakerBindingRevisionId));
      validateSpeechPlanSource(src.dialogue, body, voices);
      if (old?.current_revision_id) {
        const prior = await client.query<Row>("SELECT content_hash FROM speech_plan_revision WHERE id=$1 AND workspace_id=$2 AND project_id=$3", [old.current_revision_id, workspaceId, src.projectId]);
        if (prior.rows[0]?.content_hash === speechExactHash(body)) return this.planIn(client, workspaceId, shotRevisionId);
      }
      const planId = old ? String(old.id) : randomUUID(), revisionId = randomUUID();
      if (!old) await client.query("INSERT INTO speech_plan(id,workspace_id,project_id,shot_revision_id) VALUES($1,$2,$3,$4)", [planId, workspaceId, src.projectId, shotRevisionId]);
      await client.query("INSERT INTO speech_plan_revision(id,workspace_id,project_id,plan_id,source_dialogue_hash,content_hash,timing_policy,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [revisionId, workspaceId, src.projectId, planId, body.sourceDialogueHash, speechExactHash(body), body.timingPolicy, context.actorId]);
      const oldSelections = old?.current_revision_id ? await selections(client, workspaceId, String(old.current_revision_id)) : [];
      for (const [index, value] of body.lines.entries()) {
        const inputHash = speechLineInputHash(shotRevisionId, value, voices.get(value.speakerBindingRevisionId)!.voice);
        const prior = await client.query<Row>("SELECT id FROM speech_line_input_revision WHERE workspace_id=$1 AND shot_revision_id=$2 AND line_id=$3 AND input_hash=$4", [workspaceId, shotRevisionId, value.lineId, inputHash]);
        const inputId = prior.rows[0] ? String(prior.rows[0].id) : randomUUID();
        if (!prior.rows[0]) await client.query("INSERT INTO speech_line_input_revision(id,workspace_id,project_id,shot_revision_id,line_id,voice_revision_id,input_hash,display_text,emotion,speed) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [inputId, workspaceId, src.projectId, shotRevisionId, value.lineId, value.speakerBindingRevisionId, inputHash, value.displayText, value.emotion, value.speed]);
        await client.query("INSERT INTO speech_plan_line(workspace_id,project_id,plan_revision_id,line_id,line_input_revision_id,ordinal,source_start,source_end,pause_after_ms) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [workspaceId, src.projectId, revisionId, value.lineId, inputId, index + 1, value.sourceStart, value.sourceEnd, value.pauseAfterMs]);
        const slotId = randomUUID();
        await client.query("INSERT INTO speech_selection_slot(id,workspace_id,project_id,plan_revision_id,line_id,line_input_revision_id) VALUES($1,$2,$3,$4,$5,$6)", [slotId, workspaceId, src.projectId, revisionId, value.lineId, inputId]);
        const inherited = oldSelections.find((selected) => selected.lineId === value.lineId && selected.lineInputRevisionId === inputId);
        if (inherited) {
          const valid = await client.query<Row>(`${TAKE_SQL} WHERE t.workspace_id=$1 AND t.asset_id=$2 AND t.line_input_revision_id=$3`, [workspaceId, inherited.takeAssetId, inputId]);
          if (valid.rows[0]?.selectable === true && valid.rows[0].checksum_sha256 === inherited.checksumSha256) await this.insertSelection(client, workspaceId, src.projectId, slotId, value.lineId, inputId, inherited.takeAssetId, inherited.checksumSha256, context.actorId, inherited.id);
        }
      }
      await client.query("UPDATE speech_plan SET current_revision_id=$1,row_version=$2,updated_at=now() WHERE id=$3 AND workspace_id=$4", [revisionId, old ? expectedVersion + 1 : 1, planId, workspaceId]);
      if (old?.current_revision_id) {
        const affected = await client.query<Row>("SELECT dependent_asset_id FROM speech_mix_dependency WHERE workspace_id=$1 AND project_id=$2 AND plan_revision_id=$3", [workspaceId, src.projectId, old.current_revision_id]);
        await stale(client, workspaceId, src.projectId, affected.rows.map((row) => String(row.dependent_asset_id)), `speech-plan:${old.current_revision_id}`, context.traceId);
      }
      return this.planIn(client, workspaceId, shotRevisionId);
    });
  }
  async generationInput(workspaceId: string, planRevisionId: string, lineId: string, historicalRead = false): Promise<SpeechGenerationInput> {
    return this.read(async (client) => {
      const p = await planByRevision(client, workspaceId, planRevisionId, !historicalRead);
      // A permanent-key replay can read its immutable source even after edits. New sends still run the strict
      // assertSpeechGenerationInputInTransaction in the Job-creation transaction after idempotency lookup.
      const historical = historicalRead ? await client.query<Row>("SELECT dialogue FROM shot_revision WHERE id=$1 AND workspace_id=$2 AND project_id=$3", [p.shot_revision_id, workspaceId, p.project_id]) : null;
      if (historical && !historical.rows[0]) fail("NOT_FOUND", "Historical speech source not found");
      const src = historical ? { projectId: String(p.project_id), dialogue: String(historical.rows[0]!.dialogue ?? "") } : await source(client, workspaceId, String(p.shot_revision_id));
      const rows = await client.query<Row>(`${LINE_SQL} WHERE pl.workspace_id=$1 AND pl.plan_revision_id=$2 AND pl.line_id=$3`, [workspaceId, planRevisionId, lineId]);
      const row = rows.rows[0]; if (!row) fail("NOT_FOUND", "Speech line not found");
      const value = line(row), voices = await voicesFor(client, workspaceId, src.projectId, String(p.shot_revision_id), [value.speakerBindingRevisionId], !historicalRead);
      const v = voices.get(value.speakerBindingRevisionId); if (!v) fail("SPEECH_VOICE_STALE", "Voice binding changed");
      if (speechDialogueHash(src.dialogue) !== p.source_dialogue_hash || speechLineInputHash(String(p.shot_revision_id), value, v.voice) !== value.inputHash) fail("SPEECH_SOURCE_CHANGED", "Line source changed");
      return { workspaceId, projectId: src.projectId, shotRevisionId: String(p.shot_revision_id), planRevisionId, lineId,
        lineInputRevisionId: value.lineInputRevisionId, inputHash: value.inputHash, displayText: value.displayText, spokenText: value.displayText,
        voice: v.voice, emotion: value.emotion, speed: value.speed };
    });
  }
  async takes(workspaceId: string, planRevisionId: string, cursor?: string): Promise<SpeechTakesPage> {
    return this.read(async (client) => {
      const p = await planByRevision(client, workspaceId, planRevisionId);
      await source(client, workspaceId, String(p.shot_revision_id));
      if (cursor) {
        const validCursor = await client.query<Row>(`${TAKE_SQL} WHERE t.workspace_id=$1 AND t.project_id=$2 AND t.asset_id=$3
          AND EXISTS (SELECT 1 FROM speech_plan_line pl WHERE pl.plan_revision_id=$4 AND pl.workspace_id=t.workspace_id AND pl.line_input_revision_id=t.line_input_revision_id)`, [workspaceId, p.project_id, cursor, planRevisionId]);
        if (!validCursor.rows[0]) fail("VALIDATION_ERROR", "Candidate cursor is not in this speech plan");
      }
      const rows = await client.query<Row>(`${TAKE_SQL} WHERE t.workspace_id=$1 AND t.project_id=$2
        AND EXISTS (SELECT 1 FROM speech_plan_line pl WHERE pl.plan_revision_id=$3 AND pl.workspace_id=t.workspace_id AND pl.line_input_revision_id=t.line_input_revision_id)
        AND ($4::uuid IS NULL OR (a.created_at,a.id)<(SELECT created_at,id FROM asset WHERE id=$4 AND workspace_id=$1 AND project_id=$2))
        ORDER BY a.created_at DESC,a.id DESC LIMIT 101`, [workspaceId, p.project_id, planRevisionId, cursor ?? null]);
      // Selection lookup is deliberately independent of the newest-candidate page.
      const chosen = await selections(client, workspaceId, planRevisionId);
      const selectedAssets = chosen.length ? await client.query<Row>(`${TAKE_SQL} WHERE t.workspace_id=$1 AND t.project_id=$2 AND t.asset_id=ANY($3::uuid[])`, [workspaceId, p.project_id, chosen.map((value) => value.takeAssetId)]) : { rows: [] };
      const selected = chosen.map((value) => {
        const asset = selectedAssets.rows.find((row) => row.id === value.takeAssetId);
        return { ...value, usable: asset?.selectable === true && asset.line_input_revision_id === value.lineInputRevisionId && asset.checksum_sha256 === value.checksumSha256,
          ...(asset ? { durationMs: Number(asset.duration_ms) } : {}) };
      });
      const items = rows.rows.slice(0, 100).map(take);
      return { items, selected, hasMore: rows.rows.length > 100, rowVersion: Number(p.row_version), nextCursor: rows.rows.length > 100 ? items.at(-1)!.assetId : null };
    });
  }
  private async insertSelection(client: PoolClient, workspaceId: string, projectId: string, slotId: string, lineId: string, inputId: string,
    assetId: string, checksum: string, actorId: string, inherited: string | null): Promise<SpeechSelection> {
    const result = await client.query<Row>("INSERT INTO speech_selection(workspace_id,project_id,slot_id,take_asset_id,line_input_revision_id,checksum_sha256,selected_by,inherited_from_selection_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,selected_at", [workspaceId, projectId, slotId, assetId, inputId, checksum, actorId, inherited]);
    const row = result.rows[0]!;
    await client.query("UPDATE speech_selection_slot SET current_selection_id=$1 WHERE id=$2 AND workspace_id=$3", [row.id, slotId, workspaceId]);
    return { id: String(row.id), lineId, takeAssetId: assetId, lineInputRevisionId: inputId, checksumSha256: checksum, selectedBy: actorId, selectedAt: iso(row.selected_at), inheritedFromSelectionId: inherited };
  }
  async select(workspaceId: string, planRevisionId: string, lineId: string, body: SpeechSelectionPut, expectedVersion: number, context: Context): Promise<{ rowVersion: number; selection: SpeechSelection }> {
    return this.write(workspaceId, `/speech-plans/${planRevisionId}/selections/${lineId}`, { body, expectedVersion }, context, async (client) => {
      const initial = await planByRevision(client, workspaceId, planRevisionId);
      await source(client, workspaceId, String(initial.shot_revision_id), true);
      const p = await planByRevision(client, workspaceId, planRevisionId);
      const locked = await client.query<Row>("SELECT row_version FROM speech_plan WHERE id=$1 AND workspace_id=$2 FOR UPDATE", [p.id, workspaceId]);
      if (Number(locked.rows[0]?.row_version) !== expectedVersion) fail("REVISION_CONFLICT", "Selection changed");
      const slot = await client.query<Row>(`SELECT slot.*,pl.line_input_revision_id FROM speech_selection_slot slot
        JOIN speech_plan_line pl ON pl.plan_revision_id=slot.plan_revision_id AND pl.line_id=slot.line_id AND pl.workspace_id=slot.workspace_id
        WHERE slot.workspace_id=$1 AND slot.plan_revision_id=$2 AND slot.line_id=$3 FOR UPDATE OF slot`, [workspaceId, planRevisionId, lineId]);
      const s = slot.rows[0]; if (!s) fail("NOT_FOUND", "Speech line not found");
      const rows = await client.query<Row>(`${TAKE_SQL} WHERE t.workspace_id=$1 AND t.project_id=$2 AND t.asset_id=$3 AND t.line_input_revision_id=$4`, [workspaceId, p.project_id, body.takeAssetId, s.line_input_revision_id]);
      const candidate = rows.rows[0];
      if (!candidate || candidate.selectable !== true || candidate.checksum_sha256 !== body.expectedTakeChecksumSha256) fail("SPEECH_TAKE_INVALID", "Take is not usable for this exact line and voice");
      if (s.current_selection_id) {
        const already = (await selections(client, workspaceId, planRevisionId)).find((value) => value.id === s.current_selection_id);
        if (already?.takeAssetId === body.takeAssetId && already.checksumSha256 === body.expectedTakeChecksumSha256 && already.lineInputRevisionId === String(s.line_input_revision_id)) {
          return { rowVersion: expectedVersion, selection: already };
        }
      }
      const selected = await this.insertSelection(client, workspaceId, String(p.project_id), String(s.id), lineId, String(s.line_input_revision_id), body.takeAssetId, body.expectedTakeChecksumSha256, context.actorId, null);
      if (s.current_selection_id) {
        const affected = await client.query<Row>("SELECT dependent_asset_id FROM speech_mix_selection_dependency WHERE workspace_id=$1 AND project_id=$2 AND selection_id=$3", [workspaceId, p.project_id, s.current_selection_id]);
        await stale(client, workspaceId, String(p.project_id), affected.rows.map((row) => String(row.dependent_asset_id)), `speech-selection:${s.current_selection_id}`, context.traceId);
      }
      await client.query("UPDATE speech_plan SET row_version=row_version+1,updated_at=now() WHERE id=$1 AND workspace_id=$2", [p.id, workspaceId]);
      return { rowVersion: expectedVersion + 1, selection: selected };
    });
  }
  async mixPreflight(workspaceId: string, planRevisionId: string, body: SpeechMixRequest): Promise<SpeechMixPreflight> {
    return this.read(async (client) => {
      await client.query("BEGIN");
      try {
        const result = await speechMixPreflightInTransaction(client, workspaceId, planRevisionId, body);
        await client.query("COMMIT"); return result;
      } catch (error) { await client.query("ROLLBACK"); throw error; }
    });
  }
}

/** Recheck inside the real-media Job creation transaction, immediately before reservation/freezing. */
export async function assertSpeechGenerationInputInTransaction(client: PoolClient, input: SpeechGenerationInput): Promise<void> {
  const src = await source(client, input.workspaceId, input.shotRevisionId, true);
  if (src.projectId !== input.projectId || input.displayText !== input.spokenText) fail("SPEECH_SOURCE_MISMATCH", "Speech source identity is invalid");
  const p = await planByRevision(client, input.workspaceId, input.planRevisionId);
  if (p.shot_revision_id !== input.shotRevisionId || speechDialogueHash(src.dialogue) !== p.source_dialogue_hash) fail("SPEECH_SOURCE_CHANGED", "Speech source changed");
  const rows = await client.query<Row>(`${LINE_SQL} WHERE pl.workspace_id=$1 AND pl.plan_revision_id=$2 AND pl.line_id=$3`, [input.workspaceId, input.planRevisionId, input.lineId]);
  const value = rows.rows[0] ? line(rows.rows[0]) : null;
  if (!value || value.lineInputRevisionId !== input.lineInputRevisionId || value.inputHash !== input.inputHash || value.speakerBindingRevisionId !== input.voice.id
    || value.displayText !== input.displayText || value.emotion !== input.emotion || value.speed !== input.speed) fail("SPEECH_SOURCE_CHANGED", "Frozen line no longer matches");
  const voices = await voicesFor(client, input.workspaceId, input.projectId, input.shotRevisionId, [input.voice.id]);
  const v = voices.get(input.voice.id);
  if (!v || speechExactHash(v.voice) !== speechExactHash(input.voice) || speechLineInputHash(input.shotRevisionId, value, v.voice) !== input.inputHash) fail("SPEECH_VOICE_STALE", "Frozen voice no longer matches");
}
/** Called after Asset insert in its successful attempt transaction. Never selects or approves AUDIO. */
export async function commitSpeechTake(client: PoolClient, input: { workspaceId: string; projectId: string; assetId: string; jobId: string; attemptId: string; speechInput: SpeechGenerationInput }): Promise<void> {
  const speech = input.speechInput;
  if (speech.workspaceId !== input.workspaceId || speech.projectId !== input.projectId || speech.spokenText !== speech.displayText) fail("SPEECH_TAKE_INVALID", "Speech take scope is invalid");
  const identity = await client.query<Row>(`SELECT a.id,vb.current_revision_id AS current_voice_revision_id FROM asset a JOIN speech_line_input_revision li ON li.id=$6 AND li.workspace_id=a.workspace_id AND li.project_id=a.project_id
    JOIN speech_voice_revision vr ON vr.id=li.voice_revision_id AND vr.workspace_id=li.workspace_id AND vr.project_id=li.project_id
    JOIN speech_voice_binding vb ON vb.id=vr.binding_id AND vb.workspace_id=vr.workspace_id AND vb.project_id=vr.project_id
    JOIN generation_job j ON j.id=a.source_generation_job_id AND j.project_id=a.project_id AND j.workspace_id=a.workspace_id
    WHERE a.id=$1 AND a.workspace_id=$2 AND a.project_id=$3 AND a.source_generation_job_id=$4 AND a.source_job_attempt_id=$5
      AND a.kind='AUDIO' AND a.review_status='DRAFT' AND a.mime_type='audio/wav' AND a.duration_ms>0 AND a.width IS NULL AND a.height IS NULL
      AND a.source_kind='PROVIDER' AND a.storage_provider='s3' AND j.kind='MEDIA_TTS' AND j.input_snapshot->>'schema'='real-media.v1'
      AND j.input_snapshot->'speech'=$11::jsonb
      AND a.source_shot_revision_id=$7 AND li.input_hash=$8 AND li.voice_revision_id=$9 AND li.line_id=$10
      AND a.provider_configuration_id=vr.provider_configuration_id`, [input.assetId, input.workspaceId, input.projectId, input.jobId, input.attemptId,
    speech.lineInputRevisionId, speech.shotRevisionId, speech.inputHash, speech.voice.id, speech.lineId, JSON.stringify(speech)]);
  if (!identity.rows[0]) fail("SPEECH_TAKE_INVALID", "Speech take does not match its server-frozen line");
  await client.query(`INSERT INTO speech_take(asset_id,workspace_id,project_id,line_input_revision_id,job_id,attempt_id)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(asset_id) DO NOTHING`, [input.assetId, input.workspaceId, input.projectId, speech.lineInputRevisionId, input.jobId, input.attemptId]);
  if (identity.rows[0].current_voice_revision_id !== speech.voice.id) {
    // A late result remains its original historical candidate; a voice changed while it was generating.
    await stale(client, input.workspaceId, input.projectId, [input.assetId], `voice:${speech.voice.id}`, `speech-take:${input.jobId}`);
  }
}
/** Compose calls this under the project lock after rechecking the exact manifest. */
export async function commitSpeechMixDependencies(client: PoolClient, dependentAssetId: string, manifest: SpeechMixManifest): Promise<void> {
  await assertSpeechMixManifestInTransaction(client, manifest);
  await client.query("INSERT INTO speech_mix_dependency(workspace_id,project_id,dependent_asset_id,plan_revision_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [manifest.workspaceId, manifest.projectId, dependentAssetId, manifest.planRevisionId]);
  for (const value of manifest.lines) {
    await client.query("INSERT INTO speech_mix_selection_dependency(workspace_id,project_id,dependent_asset_id,selection_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [manifest.workspaceId, manifest.projectId, dependentAssetId, value.selectionId]);
    await client.query("INSERT INTO asset_dependency(workspace_id,project_id,dependent_asset_id,source_asset_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [manifest.workspaceId, manifest.projectId, dependentAssetId, value.takeAssetId]);
  }
}
/** Both compose submission and completion must compare the full authoritative measured manifest. */
export async function assertSpeechMixManifestInTransaction(client: PoolClient, manifest: SpeechMixManifest): Promise<void> {
  const rebuilt = await speechMixPreflightInTransaction(client, manifest.workspaceId, manifest.planRevisionId, {
    videoAssetId: manifest.videoAssetId, musicAssetId: manifest.mix.musicAssetId, originalAudio: manifest.mix.originalAudio,
    musicGain: manifest.mix.musicGain, ducking: manifest.mix.ducking,
  });
  if (rebuilt.inputHash !== speechExactHash(manifest)) fail("SPEECH_SELECTION_STALE", "Measured mix sources or selections changed before completion");
}

/** Authoritative freeze under the caller's transaction and the common project lock. No connection is opened here. */
export async function speechMixPreflightInTransaction(client: PoolClient, workspaceId: string, planRevisionId: string, body: SpeechMixRequest): Promise<SpeechMixPreflight> {
      const initial = await planByRevision(client, workspaceId, planRevisionId);
      const src = await source(client, workspaceId, String(initial.shot_revision_id), true);
      const p = await planByRevision(client, workspaceId, planRevisionId);
      const ls = await client.query<Row>(`${LINE_SQL} WHERE pl.workspace_id=$1 AND pl.plan_revision_id=$2 ORDER BY pl.ordinal`, [workspaceId, planRevisionId]);
      const selected = await selections(client, workspaceId, planRevisionId);
      const rows = await client.query<Row>(`${TAKE_SQL} WHERE t.workspace_id=$1 AND t.project_id=$2 AND t.asset_id=ANY($3::uuid[])`, [workspaceId, src.projectId, selected.map((s) => s.takeAssetId)]);
      if (rows.rows.some((row) => row.selectable !== true)) fail("SPEECH_SELECTION_STALE", "One selected voice take is no longer usable");
      const assets = await client.query<Row>(`SELECT a.* FROM asset a JOIN generation_job j ON j.id=a.source_generation_job_id AND j.workspace_id=a.workspace_id AND j.project_id=a.project_id
        JOIN job_attempt at ON at.id=a.source_job_attempt_id AND at.generation_job_id=j.id AND at.workspace_id=a.workspace_id
        WHERE a.workspace_id=$1 AND a.project_id=$2 AND a.source_shot_revision_id=$3 AND a.id=ANY($4::uuid[])
        AND a.status='ACTIVE' AND j.state='SUCCEEDED' AND at.finished_at IS NOT NULL AND at.attempt_no=(SELECT max(n.attempt_no) FROM job_attempt n WHERE n.generation_job_id=j.id AND n.workspace_id=j.workspace_id)`,
      [workspaceId, src.projectId, p.shot_revision_id, [body.videoAssetId, ...(body.musicAssetId ? [body.musicAssetId] : [])]]);
      const v = assets.rows.find((a) => a.id === body.videoAssetId && a.kind === "VIDEO" && a.mime_type === "video/mp4");
      if (!v) fail("SPEECH_VIDEO_INVALID", "A measured video in this shot is required");
      const m = body.musicAssetId ? assets.rows.find((a) => a.id === body.musicAssetId && a.kind === "MUSIC" && a.mime_type === "audio/wav") : null;
      const facts = (r: Row) => ({ assetId: String(r.id), checksumSha256: String(r.checksum_sha256), durationMs: Number(r.duration_ms), rowVersion: Number(r.row_version), status: String(r.status) });
      return buildSpeechMixPreflight({ workspaceId, projectId: src.projectId, shotRevisionId: String(p.shot_revision_id), planRevisionId,
        planHash: String(p.content_hash), planRowVersion: Number(p.row_version), lines: ls.rows.map(line), selections: selected,
        takes: rows.rows.map((row) => ({ ...facts(row), lineInputRevisionId: String(row.line_input_revision_id), voiceRevisionId: String(row.voice_revision_id) })),
        video: facts(v), music: m ? facts(m) : null, request: body });
}
