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
  const result = await client.query<{ ok: boolean } & QueryResultRow>(
    `SELECT (
        shot.current_revision_id = revision.id
        AND shot.approved_revision_id = revision.id
        AND revision.review_status = 'APPROVED'
        AND revision.freshness_status = 'CURRENT'
      ) AS ok
       FROM shot_revision revision
       JOIN shot
         ON shot.id = revision.shot_id
        AND shot.workspace_id = revision.workspace_id
        AND shot.project_id = revision.project_id
      WHERE revision.id = $1
        AND revision.workspace_id = $2
        AND revision.project_id = $3
      ${lockRows ? "FOR SHARE OF shot, revision" : ""}`,
    [shotRevisionId, workspaceId, projectId],
  );
  if (result.rows[0]?.ok !== true) {
    throw new PersistenceError(
      "REVIEW_REQUIRED",
      "Media generation requires the current approved non-stale shot revision",
    );
  }
}

async function insertAsset(
  client: PoolClient,
  input: CreateMediaAssetInput,
): Promise<MediaAssetRecord> {
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
              source_shot_revision_id, provider_request_id, created_at
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
