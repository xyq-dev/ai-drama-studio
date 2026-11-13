import { canRequestComfyUiCancellation, COMFYUI_REFERENCE_ASSET_FILTER, PersistenceError, type MediaAssetStore } from "@ai-drama/database";

type Client = Parameters<MediaAssetStore["prepareRealShotGenerationInTransaction"]>[0];
type Scope = { workspaceId: string; projectId: string; shotRevisionId: string };
const CANDIDATE_FILTER = `${COMFYUI_REFERENCE_ASSET_FILTER} AND asset.review_status<>'REJECTED' AND job.state='SUCCEEDED'
  AND job.source_shot_revision_id=asset.source_shot_revision_id
  AND job.input_snapshot->>'schema'='real-media.v1'
  AND job.input_snapshot#>>'{configuration,providerKey}'='comfyui'`;
const scopeValues = (scope: Scope) => [scope.workspaceId, scope.projectId, scope.shotRevisionId];
const imageSelectionFrom = `FROM comfyui_shot_image_selection selected
  JOIN asset ON asset.id=selected.asset_id AND asset.workspace_id=selected.workspace_id
    AND asset.project_id=selected.project_id AND asset.source_shot_revision_id=selected.shot_revision_id
    AND asset.checksum_sha256=selected.asset_checksum_sha256
  JOIN generation_job job ON job.id=asset.source_generation_job_id AND job.workspace_id=asset.workspace_id AND job.project_id=asset.project_id
  JOIN shot_revision revision ON revision.id=selected.shot_revision_id AND revision.workspace_id=selected.workspace_id
  JOIN shot ON shot.id=revision.shot_id AND shot.workspace_id=selected.workspace_id`;

async function selectionInstalled(client: Client): Promise<boolean> {
  const result = await client.query("SELECT obj_description(to_regclass('comfyui_shot_image_selection'),'pg_class')='ads.comfyui.shot-image-selection.v1' AS ready");
  return result.rows[0]?.ready === true;
}

export async function listComfyUiShotMedia(client: Client, scope: Scope, targetedCancel: boolean) {
  const values = scopeValues(scope);
  const result = await client.query(`SELECT 1 FROM shot_revision
    WHERE workspace_id=$1 AND project_id=$2 AND id=$3`, values);
  if (!result.rows[0]) throw new PersistenceError("NOT_FOUND", "Shot revision not found");
  const references = await client.query(`SELECT asset.id,asset.mime_type,
      COALESCE('镜头 ' || revision.ordinal::text || ' · ' || left(revision.action,48),'项目图片') AS label
    FROM asset LEFT JOIN shot_revision revision ON revision.id=asset.source_shot_revision_id
      AND revision.workspace_id=asset.workspace_id AND revision.project_id=asset.project_id
    WHERE asset.workspace_id=$1 AND asset.project_id=$2 AND ${COMFYUI_REFERENCE_ASSET_FILTER}
    ORDER BY asset.created_at DESC,asset.id DESC LIMIT 100`, values.slice(0,2));
  const jobs = await client.query(`SELECT job.id,job.state,job.error_code,job.cancel_requested_at,job.input_snapshot,receipt.state AS receipt_state,
      receipt.outputs_ciphertext IS NOT NULL AS has_output
    FROM generation_job job LEFT JOIN real_media_submission receipt ON receipt.generation_job_id=job.id
      AND receipt.workspace_id=job.workspace_id AND receipt.project_id=job.project_id
    WHERE job.workspace_id=$1 AND job.project_id=$2 AND job.source_shot_revision_id=$3
      AND job.input_snapshot->>'schema'='real-media.v1'
      AND job.input_snapshot#>>'{configuration,providerKey}'='comfyui'
    ORDER BY job.created_at DESC,job.id DESC LIMIT 100`, values);
  const selectionAvailable = await selectionInstalled(client);
  const selected = selectionAvailable ? await client.query(`SELECT selected.asset_id ${imageSelectionFrom}
    WHERE selected.workspace_id=$1 AND selected.project_id=$2 AND selected.shot_revision_id=$3 AND ${CANDIDATE_FILTER}
      AND shot.current_revision_id=revision.id AND shot.approved_revision_id=revision.id
      AND shot.archived_at IS NULL AND revision.review_status='APPROVED' AND revision.freshness_status='CURRENT'`, values) : null;
  return {
    references: references.rows.map(row => ({ id: String(row.id), label: String(row.label), mimeType: String(row.mime_type) })),
    jobs: jobs.rows.map(row => ({
      jobId: String(row.id), state: String(row.state), phase: jobPhase(row.state, row.error_code, row.receipt_state, row.has_output),
      errorCode: row.error_code == null ? undefined : String(row.error_code),
      canCancel: (targetedCancel || row.state !== "WAITING_EXTERNAL") && canRequestComfyUiCancellation({
        state: String(row.state), errorCode: row.error_code == null ? null : String(row.error_code),
        cancelRequested: row.cancel_requested_at != null, inputSnapshot: row.input_snapshot,
      }),
    })),
    selectionAvailable, selectedAssetId: (selected?.rows[0]?.asset_id as string | undefined) ?? null,
  };
}

function jobPhase(state: unknown, code: unknown, receiptState: unknown, hasOutput: unknown): string {
  if (state === "SUCCEEDED") return "complete";
  if (state === "CANCELED") return "canceled";
  if (state === "FAILED") return "failed";
  if (receiptState === "UNKNOWN" || code === "REAL_MEDIA_SUBMISSION_UNKNOWN") return "unknown";
  if (code === "COMFYUI_QUEUED" || state === "QUEUED" || state === "PENDING") return "queued";
  if (code === "COMFYUI_RUNNING" || state === "RUNNING") return "running";
  if (hasOutput) return "finalizing";
  return "progress_unavailable";
}

export async function adoptComfyUiImage(client: Client, scope: Scope, input: {
  assetId: string; expectedSelectedAssetId: string | null; actorId: string;
}): Promise<{ selectedAssetId: string }> {
  const values = scopeValues(scope);
  if (!await selectionInstalled(client)) throw new PersistenceError("COMFYUI_SELECTION_UNAVAILABLE", "Shot image selection is not configured");
  const current = await client.query(`SELECT selected.asset_id ${imageSelectionFrom}
    WHERE selected.workspace_id=$1 AND selected.project_id=$2 AND selected.shot_revision_id=$3 AND ${CANDIDATE_FILTER}`, values);
  const previous = current.rows[0]?.asset_id ?? null;
  if (previous === input.assetId) return { selectedAssetId: input.assetId };
  if (previous !== input.expectedSelectedAssetId) throw new PersistenceError("REFERENCE_SELECTION_CONFLICT", "Shot image selection changed");
  const candidate = await client.query(`SELECT asset.checksum_sha256 FROM asset
    JOIN generation_job job ON job.id=asset.source_generation_job_id AND job.workspace_id=asset.workspace_id AND job.project_id=asset.project_id
    WHERE asset.workspace_id=$1 AND asset.project_id=$2 AND asset.source_shot_revision_id=$3
      AND asset.id=$4 AND ${CANDIDATE_FILTER} FOR SHARE OF asset,job`, [...values,input.assetId]);
  if (!candidate.rows[0]) throw new PersistenceError("REAL_MEDIA_SOURCE_INVALID", "Shot image is not an active generated candidate");
  await client.query(`INSERT INTO comfyui_shot_image_selection(workspace_id,project_id,shot_revision_id,asset_id,asset_checksum_sha256,selected_by)
    VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(workspace_id,project_id,shot_revision_id) DO UPDATE SET
      asset_id=excluded.asset_id,asset_checksum_sha256=excluded.asset_checksum_sha256,selected_by=excluded.selected_by,selected_at=now()`,
  [...values,input.assetId,String(candidate.rows[0].checksum_sha256),input.actorId]);
  return { selectedAssetId: input.assetId };
}
