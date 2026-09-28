import type { PoolClient, QueryResultRow } from "pg";
import { PersistenceError, type DatabasePool } from "./job-service";

export interface CreateMediaAssetInput {
  workspaceId: string;
  projectId: string;
  kind: "IMAGE" | "VIDEO" | "AUDIO" | "SUBTITLE" | "MUSIC" | "COMPOSITE";
  storageProvider: string;
  objectKey: string;
  mimeType: string;
  byteSize: number;
  checksumSha256: string;
  width?: number;
  height?: number;
  durationMs?: number;
  sourceJobAttemptId: string;
  sourceShotRevisionId?: string;
  providerConfigurationId: string;
  providerRequestId: string;
  metadata?: Record<string, unknown>;
}

export interface MediaAssetRecord {
  id: string;
  projectId: string;
  kind: string;
  objectKey: string;
  mimeType: string;
  checksumSha256: string;
  sourceShotRevisionId: string | null;
  providerRequestId: string;
  createdAt: string;
}

export class MediaAssetStore {
  constructor(private readonly pool: DatabasePool) {}

  async assertUsableShot(
    workspaceId: string,
    projectId: string,
    shotRevisionId: string,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await assertUsableShotWithClient(client, workspaceId, projectId, shotRevisionId, false);
    } finally {
      client.release();
    }
  }

  async createAsset(input: CreateMediaAssetInput): Promise<MediaAssetRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      try {
        if (input.sourceShotRevisionId) {
          await assertUsableShotWithClient(
            client,
            input.workspaceId,
            input.projectId,
            input.sourceShotRevisionId,
            true,
          );
        }
        const created = await insertAsset(client, input);
        await client.query("COMMIT");
        return created;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    } finally {
      client.release();
    }
  }

  async listShotAssets(
    workspaceId: string,
    projectId: string,
    shotRevisionId: string,
  ): Promise<MediaAssetRecord[]> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<QueryResultRow>(
        `SELECT id, project_id, kind, object_key, mime_type, checksum_sha256,
                source_shot_revision_id, provider_request_id, created_at
           FROM asset
          WHERE workspace_id = $1
            AND project_id = $2
            AND source_shot_revision_id = $3
          ORDER BY created_at DESC, id DESC`,
        [workspaceId, projectId, shotRevisionId],
      );
      return result.rows.map(mapAsset);
    } finally {
      client.release();
    }
  }
}

async function assertUsableShotWithClient(
  client: PoolClient,
  workspaceId: string,
  projectId: string,
  shotRevisionId: string,
  lockRows: boolean,
): Promise<void> {
  const project = await client.query<{ has_pending_stale: boolean } & QueryResultRow>(
    `SELECT EXISTS (
        SELECT 1
          FROM stale_recalculation work
         WHERE work.workspace_id = project.workspace_id
           AND work.project_id = project.id
           AND work.status IN ('PENDING', 'RUNNING')
      ) AS has_pending_stale
       FROM project
      WHERE id = $1 AND workspace_id = $2
      ${lockRows ? "FOR SHARE OF project" : ""}`,
    [projectId, workspaceId],
  );
  const projectRow = project.rows[0];
  if (!projectRow) {
    throw new PersistenceError("NOT_FOUND", "Project not found");
  }
  if (projectRow.has_pending_stale) {
    throw new PersistenceError(
      "STALE_RECALCULATION_PENDING",
      "Media generation is blocked until stale propagation completes",
    );
  }

  const shotGate = await client.query<{ ok: boolean } & QueryResultRow>(
    `SELECT (
        shot.current_revision_id = revision.id
        AND shot.approved_revision_id = revision.id
        AND revision.review_status = 'APPROVED'
        AND revision.freshness_status = 'CURRENT'
        AND scene.current_revision_id = revision.source_scene_revision_id
        AND scene.approved_revision_id = revision.source_scene_revision_id
        AND scene_revision.review_status = 'APPROVED'
        AND scene_revision.freshness_status = 'CURRENT'
      ) AS ok
       FROM shot_revision revision
       JOIN shot
         ON shot.id = revision.shot_id
        AND shot.workspace_id = revision.workspace_id
        AND shot.project_id = revision.project_id
       JOIN scene_revision
         ON scene_revision.id = revision.source_scene_revision_id
        AND scene_revision.workspace_id = revision.workspace_id
        AND scene_revision.project_id = revision.project_id
       JOIN scene
         ON scene.id = scene_revision.scene_id
        AND scene.workspace_id = scene_revision.workspace_id
        AND scene.project_id = scene_revision.project_id
      WHERE revision.id = $1
        AND revision.workspace_id = $2
        AND revision.project_id = $3
      ${lockRows ? "FOR SHARE OF shot, revision, scene, scene_revision" : ""}`,
    [shotRevisionId, workspaceId, projectId],
  );
  if (shotGate.rows[0]?.ok !== true) {
    throw new PersistenceError(
      "REVIEW_REQUIRED",
      "Media generation requires the current approved non-stale shot and scene revisions",
    );
  }

  const invalidCharacters = await client.query(
    `SELECT 1
       FROM shot_character_reference refs
       JOIN character_revision revision
         ON revision.id = refs.character_revision_id
        AND revision.workspace_id = refs.workspace_id
        AND revision.project_id = refs.project_id
       JOIN character
         ON character.id = revision.character_id
        AND character.workspace_id = revision.workspace_id
        AND character.project_id = revision.project_id
      WHERE refs.shot_revision_id = $1
        AND refs.workspace_id = $2
        AND refs.project_id = $3
        AND (
          character.current_revision_id IS DISTINCT FROM revision.id
          OR character.approved_revision_id IS DISTINCT FROM revision.id
          OR revision.review_status <> 'APPROVED'
          OR revision.freshness_status <> 'CURRENT'
        )
      LIMIT 1
      ${lockRows ? "FOR SHARE OF character, revision" : ""}`,
    [shotRevisionId, workspaceId, projectId],
  );
  if (invalidCharacters.rows[0]) {
    throw new PersistenceError(
      "REVIEW_REQUIRED",
      "Media generation requires current approved non-stale character revisions",
    );
  }

  const scriptSources = await client.query<
    { script_revision_id: string; episode_id: string; current_script_revision_id: string | null } & QueryResultRow
  >(
    `SELECT source.script_revision_id,
            script.episode_id,
            episode.current_script_revision_id
       FROM script_revision_consumer_source source
       JOIN script_revision script
         ON script.id = source.script_revision_id
        AND script.workspace_id = source.workspace_id
        AND script.project_id = source.project_id
       JOIN episode
         ON episode.id = script.episode_id
        AND episode.workspace_id = script.workspace_id
        AND episode.project_id = script.project_id
      WHERE source.workspace_id = $1
        AND source.project_id = $2
        AND source.consumer_type = 'shot_revision'
        AND source.consumer_revision_id = $3
      ${lockRows ? "FOR SHARE OF script, episode" : ""}`,
    [workspaceId, projectId, shotRevisionId],
  );
  for (const source of scriptSources.rows) {
    const usable = await client.query<{ ok: boolean } & QueryResultRow>(
      `SELECT m2_script_source_is_usable($1, $2, 'shot_revision', $3, $4) AS ok`,
      [workspaceId, projectId, shotRevisionId, source.script_revision_id],
    );
    if (usable.rows[0]?.ok !== true) {
      throw new PersistenceError(
        "REVIEW_REQUIRED",
        "Media generation requires usable approved script dependencies",
      );
    }
  }
}

async function insertAsset(
  client: PoolClient,
  input: CreateMediaAssetInput,
): Promise<MediaAssetRecord> {
  const lineage = await client.query(
    `SELECT 1
       FROM job_attempt attempt
       JOIN generation_job job
         ON job.id = attempt.generation_job_id
        AND job.workspace_id = attempt.workspace_id
      WHERE attempt.id = $1
        AND attempt.workspace_id = $2
        AND attempt.provider_configuration_id = $3
        AND attempt.provider_request_id = $4
        AND job.project_id = $5
      FOR SHARE OF attempt, job`,
    [
      input.sourceJobAttemptId,
      input.workspaceId,
      input.providerConfigurationId,
      input.providerRequestId,
      input.projectId,
    ],
  );
  if (!lineage.rows[0]) {
    throw new PersistenceError(
      "ASSET_LINEAGE_INVALID",
      "Asset source attempt does not belong to the requested project/provider lineage",
    );
  }

  const result = await client.query<QueryResultRow>(
    `INSERT INTO asset
      (workspace_id, project_id, kind, storage_provider, object_key, mime_type,
       byte_size, checksum_sha256, width, height, duration_ms,
       source_job_attempt_id, source_shot_revision_id,
       provider_configuration_id, provider_request_id, metadata_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)
     ON CONFLICT (storage_provider, object_key) DO NOTHING
     RETURNING id, project_id, kind, object_key, mime_type, checksum_sha256,
               source_shot_revision_id, provider_request_id, created_at`,
    [
      input.workspaceId,
      input.projectId,
      input.kind,
      input.storageProvider,
      input.objectKey,
      input.mimeType,
      input.byteSize,
      input.checksumSha256,
      input.width ?? null,
      input.height ?? null,
      input.durationMs ?? null,
      input.sourceJobAttemptId,
      input.sourceShotRevisionId ?? null,
      input.providerConfigurationId,
      input.providerRequestId,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  const row = result.rows[0];
  if (!row) {
    const existing = await client.query<QueryResultRow>(
      `SELECT id, project_id, kind, object_key, mime_type, checksum_sha256,
              source_job_attempt_id, source_shot_revision_id,
              provider_configuration_id, provider_request_id, created_at
         FROM asset
        WHERE workspace_id = $1
          AND storage_provider = $2
          AND object_key = $3`,
      [input.workspaceId, input.storageProvider, input.objectKey],
    );
    const replay = existing.rows[0];
    if (!replay) {
      throw new PersistenceError("ASSET_CREATE_FAILED", "Asset was not created");
    }
    if (
      String(replay.project_id) !== input.projectId ||
      String(replay.kind) !== input.kind ||
      String(replay.source_job_attempt_id) !== input.sourceJobAttemptId ||
      (replay.source_shot_revision_id === null ? null : String(replay.source_shot_revision_id)) !==
        (input.sourceShotRevisionId ?? null) ||
      String(replay.provider_configuration_id) !== input.providerConfigurationId ||
      String(replay.provider_request_id) !== input.providerRequestId ||
      String(replay.checksum_sha256) !== input.checksumSha256
    ) {
      throw new PersistenceError("ASSET_CONFLICT", "Asset object key is already bound to different content");
    }
    return mapAsset(replay);
  }
  return mapAsset(row);
}

function mapAsset(row: QueryResultRow): MediaAssetRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    kind: String(row.kind),
    objectKey: String(row.object_key),
    mimeType: String(row.mime_type),
    checksumSha256: String(row.checksum_sha256),
    sourceShotRevisionId:
      row.source_shot_revision_id === null ? null : String(row.source_shot_revision_id),
    providerRequestId: String(row.provider_request_id),
    createdAt: new Date(row.created_at as Date | string).toISOString(),
  };
}
