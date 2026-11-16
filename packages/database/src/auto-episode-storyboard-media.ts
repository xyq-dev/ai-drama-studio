import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { AutoEpisodeStoryboardShotView, RealMediaSnapshot } from "@ai-drama/contracts";
import { requireAutoEpisodeStoryboardShot } from "./auto-episode-storyboard-source";
import { PersistenceError } from "./job-service";

type Scope = { workspaceId: string; projectId: string; runId: string };
type Shot = { shotId: string; shotRevisionId: string; caption: string };
const scopeValues = (scope: Scope) => [scope.workspaceId, scope.projectId, scope.runId];
const boundedText = (text: string, maxLength: number) => text.slice(0, maxLength).replace(/[\uD800-\uDBFF]$/u, "").trimEnd();

export async function autoStoryboardMediaReadiness(client: PoolClient) {
  const { rows: [row] } = await client.query(`SELECT
    obj_description(to_regclass('comfyui_shot_image_selection'),'pg_class')='ads.comfyui.shot-image-selection.v1' AS selection,
    to_regclass('character_reference_selection') IS NOT NULL AS characters`);
  return { selectionAvailable: row?.selection === true, characterReferencesAvailable: row?.characters === true };
}

export async function requireAutoStoryboardSelection(client: PoolClient): Promise<void> {
  if (!(await autoStoryboardMediaReadiness(client)).selectionAvailable) {
    throw new PersistenceError("AUTO_STORYBOARD_SELECTION_UNAVAILABLE", "Storyboard image selection is not available");
  }
}

/** Use the same saved shot prompt and current scoped descriptions when quoting and rechecking the source. */
export async function freezeAutoStoryboardSource(client: PoolClient, scope: Scope, shotRevisionId: string) {
  const shot = await requireAutoEpisodeStoryboardShot(client, scope, shotRevisionId);
  const { rows: [revision] } = await client.query(`SELECT prompt_text FROM shot_revision
    WHERE workspace_id=$1 AND project_id=$2 AND id=$3`, [scope.workspaceId, scope.projectId, shotRevisionId]);
  const prompt = String(revision?.prompt_text ?? "").trim();
  if (!prompt || prompt.length > 2000) throw new PersistenceError("AUTO_STORYBOARD_SOURCE_NOT_READY", "Storyboard prompt is missing or too long");
  const { rows: characters } = await client.query(`SELECT c.name,
      COALESCE(NULLIF(r.content_json->>'appearance',''), NULLIF(r.content_json->>'identity',''), r.content_json->>'description') AS appearance
    FROM shot_character_reference ref JOIN character_revision r ON r.id=ref.character_revision_id
      AND r.workspace_id=ref.workspace_id AND r.project_id=ref.project_id
    JOIN character c ON c.id=r.character_id AND c.workspace_id=r.workspace_id AND c.project_id=r.project_id
      AND c.current_revision_id=r.id AND c.approved_revision_id=r.id AND c.archived_at IS NULL
    WHERE ref.workspace_id=$1 AND ref.project_id=$2 AND ref.shot_revision_id=$3
      AND r.review_status='APPROVED' AND r.freshness_status='CURRENT'
    ORDER BY c.id LIMIT 8`, [scope.workspaceId, scope.projectId, shotRevisionId]);
  const descriptions = characters.flatMap((row) => typeof row.appearance === "string" && row.appearance.trim()
    ? [`${boundedText(String(row.name).trim(), 80)}：${boundedText(row.appearance.trim(), 160)}`] : []);
  const sourceText = descriptions.length > 0 ? boundedText(`${prompt}\n\n角色形象：${descriptions.join("；")}`, 2000) : prompt;
  return { autoStoryboard: { runId: scope.runId, shotId: shot.shotId }, sourceText, sourceHash: createHash("sha256").update(sourceText).digest("hex") };
}

export async function assertAutoStoryboardSource(client: PoolClient, scope: Omit<Scope, "runId">, snapshot: Omit<RealMediaSnapshot, "budget">): Promise<void> {
  if (!snapshot.autoStoryboard) return;
  const source = await freezeAutoStoryboardSource(client, { ...scope, runId: snapshot.autoStoryboard.runId }, snapshot.shotRevisionId);
  if (source.autoStoryboard.shotId !== snapshot.autoStoryboard.shotId || source.sourceText !== snapshot.sourceText || source.sourceHash !== snapshot.sourceHash) {
    throw new PersistenceError("AUTO_STORYBOARD_SOURCE_NOT_READY", "Storyboard source changed after quoting");
  }
}

/** Call while holding the project lock shared by media authorization and intent. */
export async function assertNoBusyAutoStoryboardShot(client: PoolClient, scope: Scope, shotId: string, shotRevisionId: string, excludeJobId?: string): Promise<void> {
  const { rows } = await client.query(`SELECT 1 FROM generation_job job JOIN shot_revision revision ON revision.id=job.source_shot_revision_id
      AND revision.workspace_id=job.workspace_id AND revision.project_id=job.project_id
    LEFT JOIN real_media_submission receipt ON receipt.generation_job_id=job.id AND receipt.workspace_id=job.workspace_id AND receipt.project_id=job.project_id
    WHERE job.workspace_id=$1 AND job.project_id=$2 AND revision.shot_id=$3
      AND job.input_snapshot->>'schema'='real-media.v1' AND job.input_snapshot->>'capability'='image.generate'
      AND (job.state IN ('PENDING','QUEUED','RUNNING','WAITING_EXTERNAL') OR receipt.state IN ('INTENT','UNKNOWN','ACKNOWLEDGED')
        OR (revision.id=$5 AND job.input_snapshot#>>'{autoStoryboard,runId}'=$6 AND job.input_snapshot#>>'{configuration,providerKey}'='openai-media'
          AND job.input_snapshot#>>'{configuration,model}'='gpt-image-2.5-sunburst' AND EXISTS (
            SELECT 1 FROM asset WHERE asset.source_generation_job_id=job.id AND asset.workspace_id=job.workspace_id
              AND asset.project_id=job.project_id AND asset.source_shot_revision_id=revision.id AND ${USABLE_IMAGE}
          )))
      AND ($4::uuid IS NULL OR job.id<>$4) LIMIT 1`, [scope.workspaceId, scope.projectId, shotId, excludeJobId ?? null, shotRevisionId, scope.runId]);
  if (rows.length) throw new PersistenceError("AUTO_STORYBOARD_SHOT_BUSY", "This shot already has an active, unresolved or usable image request");
}

const OPENAI_STORYBOARD_JOB = `job.input_snapshot->>'schema'='real-media.v1'
  AND job.input_snapshot->>'capability'='image.generate'
  AND job.input_snapshot#>>'{configuration,providerKey}'='openai-media'
  AND job.input_snapshot#>>'{configuration,model}'='gpt-image-2.5-sunburst'`;
const SCOPED_JOB = `job.workspace_id=$1 AND job.project_id=$2 AND ${OPENAI_STORYBOARD_JOB}
  AND job.input_snapshot#>>'{autoStoryboard,runId}'=$3`;
const ASSET_JOB_ON = `job.id=asset.source_generation_job_id AND job.workspace_id=asset.workspace_id
  AND job.project_id=asset.project_id AND job.source_shot_revision_id=asset.source_shot_revision_id`;
const ASSET_JOB_JOIN = `JOIN generation_job job ON ${ASSET_JOB_ON}`;
const USABLE_IMAGE = `asset.status='ACTIVE' AND asset.review_status<>'REJECTED' AND asset.kind='IMAGE'
  AND asset.storage_provider='s3' AND asset.mime_type='image/png' AND asset.width=1024 AND asset.height=1536 AND job.state='SUCCEEDED'
  AND asset.byte_size BETWEEN 1 AND 8388608 AND asset.checksum_sha256 ~ '^[a-f0-9]{64}$'
  AND asset.object_key=concat('real-media/',asset.workspace_id,'/',asset.project_id,'/',job.id,'/',asset.source_job_attempt_id,'/',asset.checksum_sha256,'.png')`;

/** Shared selection readers bind the asset to the scoped selection and its verified checksum.
 * Use the job's stored source revision, as at adoption, for the shot lineage. */
export const RETAINED_AUTO_STORYBOARD_IMAGE_FILTER = `${OPENAI_STORYBOARD_JOB}
  AND job.input_snapshot#>>'{autoStoryboard,runId}' IS NOT NULL
  AND job.source_shot_revision_id=asset.source_shot_revision_id
  AND ${USABLE_IMAGE}`;

export async function readAutoStoryboardShots(client: PoolClient, scope: Scope, shots: readonly Shot[], selectionAvailable: boolean, receiptAvailable: boolean): Promise<AutoEpisodeStoryboardShotView[]> {
  if (shots.length === 0) return [];
  const values = [...scopeValues(scope), shots.map(({ shotRevisionId }) => shotRevisionId)];
  const receipt = receiptAvailable ? `LEFT JOIN real_media_submission receipt ON receipt.generation_job_id=job.id
    AND receipt.workspace_id=job.workspace_id AND receipt.project_id=job.project_id` : "";
  const unresolved = `(job.state IN ('PENDING','QUEUED','RUNNING','WAITING_EXTERNAL')
    ${receiptAvailable ? "OR receipt.state IN ('INTENT','UNKNOWN','ACKNOWLEDGED')" : ""})`;
  const jobs = await client.query(`SELECT DISTINCT ON (revision.shot_id) revision.shot_id,job.id,job.state,job.error_code,
      job.input_snapshot#>>'{budget,quoteId}' AS quote_id,
      ${receiptAvailable ? "receipt.state" : "NULL::text"} AS receipt_state
    FROM generation_job job JOIN shot_revision revision ON revision.id=job.source_shot_revision_id
      AND revision.workspace_id=job.workspace_id AND revision.project_id=job.project_id
    ${receipt} WHERE ${SCOPED_JOB} AND revision.shot_id=ANY($5::uuid[])
      AND (job.source_shot_revision_id=ANY($4::uuid[]) OR ${unresolved})
    ORDER BY revision.shot_id,(${unresolved} IS TRUE) DESC,job.created_at DESC,job.id DESC`, [...values, shots.map(({ shotId }) => shotId)]);
  const assets = await client.query(`SELECT DISTINCT ON (asset.source_shot_revision_id) asset.source_shot_revision_id,asset.id
    FROM asset ${ASSET_JOB_JOIN} WHERE ${SCOPED_JOB} AND asset.source_shot_revision_id=ANY($4::uuid[]) AND ${USABLE_IMAGE}
    ORDER BY asset.source_shot_revision_id,asset.created_at DESC,asset.id DESC`, values);
  const kept = selectionAvailable ? await client.query(`SELECT chosen.shot_revision_id,chosen.asset_id FROM comfyui_shot_image_selection chosen
    JOIN asset ON asset.id=chosen.asset_id AND asset.workspace_id=chosen.workspace_id AND asset.project_id=chosen.project_id
      AND asset.source_shot_revision_id=chosen.shot_revision_id AND asset.checksum_sha256=chosen.asset_checksum_sha256
    ${ASSET_JOB_JOIN} WHERE ${SCOPED_JOB} AND chosen.shot_revision_id=ANY($4::uuid[]) AND ${USABLE_IMAGE}`, values) : null;
  const latest = new Map(jobs.rows.map(row => [row.shot_id, row]));
  const previews = new Map(assets.rows.map(row => [row.source_shot_revision_id, String(row.id)]));
  const selections = new Map(kept?.rows.map(row => [row.shot_revision_id, String(row.asset_id)]) ?? []);
  return shots.map((shot) => {
    const job = latest.get(shot.shotId);
    const keptAssetId = selections.get(shot.shotRevisionId) ?? null;
    const previewAssetId = previews.get(shot.shotRevisionId) ?? keptAssetId;
    let state: AutoEpisodeStoryboardShotView["state"] = keptAssetId ? "kept" : previewAssetId ? "generated" : "ready";
    if (job?.receipt_state === "UNKNOWN" || job?.error_code === "REAL_MEDIA_SUBMISSION_UNKNOWN") state = "unknown";
    else if (job && ["PENDING", "QUEUED", "RUNNING", "WAITING_EXTERNAL"].includes(String(job.state))) state = "queued";
    else if (job?.state === "FAILED" || job?.state === "CANCELED") state = "failed";
    return { ...shot, state, jobId: job ? String(job.id) : null, quoteId: job?.quote_id ?? null, previewAssetId, keptAssetId };
  });
}

export async function adoptAutoStoryboardImage(client: PoolClient, scope: Scope, shotRevisionId: string,
  input: { assetId: string; expectedSelectedAssetId: string | null; actorId: string }): Promise<{ selectedAssetId: string }> {
  await requireAutoStoryboardSelection(client);
  const values = [...scopeValues(scope), shotRevisionId];
  const previous = await client.query(`SELECT chosen.asset_id, job.input_snapshot#>>'{autoStoryboard,runId}' AS run_id,
      (${USABLE_IMAGE} AND asset.checksum_sha256=chosen.asset_checksum_sha256) AS usable
    FROM comfyui_shot_image_selection chosen
    JOIN asset ON asset.id=chosen.asset_id AND asset.workspace_id=chosen.workspace_id AND asset.project_id=chosen.project_id
    LEFT JOIN generation_job job ON ${ASSET_JOB_ON}
    WHERE chosen.workspace_id=$1 AND chosen.project_id=$2 AND chosen.shot_revision_id=$3 FOR UPDATE OF chosen`,
    [scope.workspaceId, scope.projectId, shotRevisionId]);
  const selected = previous.rows[0];
  if (selected && selected.run_id !== scope.runId) throw new PersistenceError("REFERENCE_SELECTION_CONFLICT", "This shot already has a different image selection");
  const old = selected?.usable ? String(selected.asset_id) : null;
  if (old === input.assetId) return { selectedAssetId: input.assetId };
  if (old !== input.expectedSelectedAssetId) throw new PersistenceError("REFERENCE_SELECTION_CONFLICT", "Storyboard selection changed");
  const candidate = await client.query(`SELECT asset.checksum_sha256 FROM asset ${ASSET_JOB_JOIN}
    WHERE ${SCOPED_JOB} AND asset.source_shot_revision_id=$4 AND asset.id=$5 AND ${USABLE_IMAGE} FOR SHARE OF asset,job`, [...values, input.assetId]);
  if (!candidate.rows[0]) throw new PersistenceError("REAL_MEDIA_SOURCE_INVALID", "Storyboard image is not a usable candidate for this shot");
  await client.query(`INSERT INTO comfyui_shot_image_selection(workspace_id,project_id,shot_revision_id,asset_id,asset_checksum_sha256,selected_by)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(workspace_id,project_id,shot_revision_id) DO UPDATE SET
      asset_id=excluded.asset_id,asset_checksum_sha256=excluded.asset_checksum_sha256,selected_by=excluded.selected_by,selected_at=now()`,
    [scope.workspaceId, scope.projectId, shotRevisionId, input.assetId, candidate.rows[0].checksum_sha256, input.actorId]);
  return { selectedAssetId: input.assetId };
}
