import { randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import {
  ASSET_UPLOAD_MAX_BYTES,
  ASSET_UPLOAD_MIME_TYPES,
  type AssetUploadMimeType,
  type CreateUploadSessionRequest,
  type UploadSessionView,
} from "@ai-drama/contracts";
import { PersistenceError, type DatabasePool } from "./job-service";
import { projectOwnerColumnReady, storeActorId, storeOwnerAccountFilter } from "./creator-access-context";

export const UPLOAD_SESSION_STORAGE_VERSION = "ads.upload-session.v1";
export const UPLOAD_SESSION_TTL_MS = 15 * 60 * 1000;
const STORAGE_PROVIDER = "s3";

type Row = QueryResultRow & Record<string, unknown>;

const EXT: Record<AssetUploadMimeType, string> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/webp": "webp",
};

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function mapSession(row: Row): UploadSessionView {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    storageProvider: String(row.storage_provider),
    temporaryStorageKey: String(row.temporary_storage_key),
    expectedMimeType: String(row.expected_mime_type) as AssetUploadMimeType,
    expectedByteSize: Number(row.expected_byte_size),
    expectedContentHash: row.expected_content_hash == null ? null : String(row.expected_content_hash),
    status: String(row.status) as UploadSessionView["status"],
    expiresAt: iso(row.expires_at),
    createdBy: String(row.created_by),
    createdAt: iso(row.created_at),
    completedAt: row.completed_at == null ? null : iso(row.completed_at),
    completedAssetId: row.completed_asset_id == null ? null : String(row.completed_asset_id),
    sourceShotRevisionId: row.source_shot_revision_id == null ? null : String(row.source_shot_revision_id),
  };
}

function temporaryKey(
  workspaceId: string,
  projectId: string,
  sessionId: string,
  mimeType: AssetUploadMimeType,
  checksum: string,
): string {
  return `uploads/${workspaceId}/${projectId}/${sessionId}/${checksum}.${EXT[mimeType]}`;
}

export function uploadObjectKey(
  workspaceId: string,
  projectId: string,
  sessionId: string,
  mimeType: AssetUploadMimeType,
  checksumSha256: string,
): string {
  if (!/^[0-9a-f]{64}$/.test(checksumSha256)) {
    throw new PersistenceError("OBJECT_HASH_MISMATCH", "上传内容校验失败，哈希或大小与预期不符。");
  }
  return temporaryKey(workspaceId, projectId, sessionId, mimeType, checksumSha256);
}

export class UploadSessionStore {
  constructor(private readonly pool: DatabasePool) {}

  async storageReady(): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      return await this.readyIn(client);
    } finally {
      client.release();
    }
  }

  private async readyIn(client: PoolClient): Promise<boolean> {
    const result = await client.query<{ version: string | null }>(
      `SELECT obj_description(to_regclass('upload_session'), 'pg_class') AS version`,
    );
    return result.rows[0]?.version === UPLOAD_SESSION_STORAGE_VERSION;
  }

  private async requireReady(client: PoolClient): Promise<void> {
    if (!(await this.readyIn(client))) {
      throw new PersistenceError("UPLOAD_SESSION_UNAVAILABLE", "上传会话存储尚未启用。");
    }
  }

  private async requireOwnedProject(client: PoolClient, workspaceId: string, projectId: string): Promise<void> {
    const params: unknown[] = [projectId, workspaceId];
    let ownerSql = "";
    const owner = storeOwnerAccountFilter();
    if (owner && await projectOwnerColumnReady(client)) {
      params.push(owner);
      ownerSql = "AND owner_account_id = $3::uuid";
    }
    const result = await client.query(
      `SELECT id FROM project
        WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL AND status = 'ACTIVE' ${ownerSql}
        FOR SHARE`,
      params,
    );
    if (!result.rows[0]) throw new PersistenceError("NOT_FOUND", "未找到该作品。");
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      try {
        await this.requireReady(client);
        const value = await work(client);
        await client.query("COMMIT");
        return value;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    } finally {
      client.release();
    }
  }

  async createSession(
    workspaceId: string,
    input: CreateUploadSessionRequest,
  ): Promise<UploadSessionView> {
    if (!(ASSET_UPLOAD_MIME_TYPES as readonly string[]).includes(input.mimeType)) {
      throw new PersistenceError("UNSUPPORTED_MEDIA", "不支持的图片格式，仅允许 PNG、JPEG 或 WebP。");
    }
    if (!Number.isSafeInteger(input.byteSize) || input.byteSize < 1 || input.byteSize > ASSET_UPLOAD_MAX_BYTES) {
      throw new PersistenceError("UPLOAD_LIMIT", "上传文件超过 8 MiB 上限。");
    }
    return this.transaction(async (client) => {
      await this.requireOwnedProject(client, workspaceId, input.projectId);
      if (input.shotRevisionId) {
        const shot = await client.query(
          `SELECT id FROM shot_revision
            WHERE id = $1 AND workspace_id = $2 AND project_id = $3`,
          [input.shotRevisionId, workspaceId, input.projectId],
        );
        if (!shot.rows[0]) throw new PersistenceError("NOT_FOUND", "未找到该镜头版本。");
      }
      const sessionId = randomUUID();
      const checksumPart = input.contentHash ?? "pending";
      const key = temporaryKey(workspaceId, input.projectId, sessionId, input.mimeType, checksumPart);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + UPLOAD_SESSION_TTL_MS);
      const createdBy = storeActorId();
      const inserted = await client.query<Row>(
        `INSERT INTO upload_session (
           id, workspace_id, project_id, storage_provider, temporary_storage_key,
           expected_mime_type, expected_byte_size, expected_content_hash, status,
           expires_at, created_by, created_at, source_shot_revision_id
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,'PENDING',$9,$10,$11,$12
         ) RETURNING *`,
        [
          sessionId,
          workspaceId,
          input.projectId,
          STORAGE_PROVIDER,
          key,
          input.mimeType,
          input.byteSize,
          input.contentHash ?? null,
          expiresAt.toISOString(),
          createdBy,
          now.toISOString(),
          input.shotRevisionId ?? null,
        ],
      );
      const row = inserted.rows[0];
      if (!row) throw new PersistenceError("UPLOAD_SESSION_UNAVAILABLE", "上传会话未能创建。");
      return mapSession(row);
    });
  }

  async getSession(workspaceId: string, sessionId: string): Promise<UploadSessionView> {
    return this.transaction(async (client) => {
      const session = await this.loadOwnedSession(client, workspaceId, sessionId);
      return this.expireIfNeeded(client, session);
    });
  }

  /**
   * After bytes are stored at objectKey, mark the session UPLOADED.
   * Updates temporary_storage_key when the create-time key still used the pending placeholder.
   */
  async markUploaded(
    workspaceId: string,
    sessionId: string,
    input: { objectKey: string; byteSize: number; checksumSha256: string; mimeType: string },
  ): Promise<UploadSessionView> {
    return this.transaction(async (client) => {
      let session = await this.loadOwnedSession(client, workspaceId, sessionId, true);
      session = await this.expireIfNeeded(client, session);
      if (session.status === "COMPLETED") return session;
      if (session.status !== "PENDING" && session.status !== "UPLOADED") {
        throw new PersistenceError("UPLOAD_SESSION_EXPIRED", "上传会话已过期，请重新创建。");
      }
      if (session.expectedMimeType !== input.mimeType) {
        throw new PersistenceError("UNSUPPORTED_MEDIA", "不支持的图片格式，仅允许 PNG、JPEG 或 WebP。");
      }
      if (input.byteSize !== session.expectedByteSize) {
        throw new PersistenceError("OBJECT_HASH_MISMATCH", "上传内容校验失败，哈希或大小与预期不符。");
      }
      if (session.expectedContentHash && session.expectedContentHash !== input.checksumSha256) {
        throw new PersistenceError("OBJECT_HASH_MISMATCH", "上传内容校验失败，哈希或大小与预期不符。");
      }
      const expectedKey = uploadObjectKey(
        workspaceId,
        session.projectId,
        session.id,
        session.expectedMimeType,
        input.checksumSha256,
      );
      if (input.objectKey !== expectedKey) {
        throw new PersistenceError("OBJECT_HASH_MISMATCH", "上传内容校验失败，哈希或大小与预期不符。");
      }
      const updated = await client.query<Row>(
        `UPDATE upload_session
            SET status = 'UPLOADED',
                temporary_storage_key = $4,
                expected_content_hash = COALESCE(expected_content_hash, $5)
          WHERE id = $1 AND workspace_id = $2 AND project_id = $3
            AND status IN ('PENDING', 'UPLOADED')
          RETURNING *`,
        [session.id, workspaceId, session.projectId, expectedKey, input.checksumSha256],
      );
      const row = updated.rows[0];
      if (!row) throw new PersistenceError("NOT_FOUND", "未找到该上传会话。");
      return mapSession(row);
    });
  }

  /**
   * Verify MIME/size/hash against the session, create an UPLOAD Asset, mark COMPLETED.
   * Replay of a completed session returns the same assetId without inserting again.
   */
  async complete(
    workspaceId: string,
    sessionId: string,
    verified: { mimeType: string; byteSize: number; checksumSha256: string; objectKey: string },
    context: { traceId: string },
  ): Promise<{ assetId: string; session: UploadSessionView }> {
    return this.transaction(async (client) => {
      let session = await this.loadOwnedSession(client, workspaceId, sessionId, true);
      session = await this.expireIfNeeded(client, session);
      if (session.status === "COMPLETED") {
        if (!session.completedAssetId) {
          throw new PersistenceError("UPLOAD_SESSION_UNAVAILABLE", "上传会话状态损坏。");
        }
        return { assetId: session.completedAssetId, session };
      }
      if (session.status !== "UPLOADED") {
        throw new PersistenceError("OBJECT_HASH_MISMATCH", "上传内容校验失败，哈希或大小与预期不符。");
      }
      if (
        verified.mimeType !== session.expectedMimeType
        || verified.byteSize !== session.expectedByteSize
        || verified.objectKey !== session.temporaryStorageKey
        || !/^[0-9a-f]{64}$/.test(verified.checksumSha256)
        || (session.expectedContentHash != null && session.expectedContentHash !== verified.checksumSha256)
      ) {
        throw new PersistenceError("OBJECT_HASH_MISMATCH", "上传内容校验失败，哈希或大小与预期不符。");
      }

      const asset = await client.query<{ id: string }>(
        `INSERT INTO asset (
           workspace_id, project_id, kind, storage_provider, object_key, mime_type,
           byte_size, checksum_sha256, source_kind, source_job_attempt_id, source_generation_job_id,
           source_shot_revision_id, provider_configuration_id, provider_request_id, metadata_json
         ) VALUES (
           $1,$2,'IMAGE',$3,$4,$5,$6,$7,'UPLOAD',NULL,NULL,$8,NULL,NULL,'{}'::jsonb
         )
         ON CONFLICT (storage_provider, object_key) DO NOTHING
         RETURNING id`,
        [
          workspaceId,
          session.projectId,
          session.storageProvider,
          session.temporaryStorageKey,
          session.expectedMimeType,
          session.expectedByteSize,
          verified.checksumSha256,
          session.sourceShotRevisionId,
        ],
      );
      let assetId = asset.rows[0]?.id;
      if (!assetId) {
        const existing = await client.query<{ id: string; source_kind: string; checksum_sha256: string; byte_size: string }>(
          `SELECT id, source_kind, checksum_sha256, byte_size::text
             FROM asset
            WHERE workspace_id = $1 AND storage_provider = $2 AND object_key = $3`,
          [workspaceId, session.storageProvider, session.temporaryStorageKey],
        );
        const row = existing.rows[0];
        if (
          !row
          || row.source_kind !== "UPLOAD"
          || row.checksum_sha256 !== verified.checksumSha256
          || Number(row.byte_size) !== session.expectedByteSize
        ) {
          throw new PersistenceError("OBJECT_HASH_MISMATCH", "上传内容校验失败，哈希或大小与预期不符。");
        }
        assetId = row.id;
      } else {
        if (session.sourceShotRevisionId) {
          await client.query(
            `INSERT INTO asset_revision_dependency
               (workspace_id, project_id, dependent_asset_id, shot_revision_id)
             VALUES ($1,$2,$3,$4)`,
            [workspaceId, session.projectId, assetId, session.sourceShotRevisionId],
          );
        }
        await client.query(
          `INSERT INTO domain_event
             (workspace_id, project_id, aggregate_type, aggregate_id, event_type, payload_json, trace_id)
           VALUES ($1,$2,'Asset',$3,'asset.created',$4::jsonb,$5)`,
          [
            workspaceId,
            session.projectId,
            assetId,
            JSON.stringify({
              assetId,
              projectId: session.projectId,
              kind: "IMAGE",
              sourceJobId: null,
              sourceKind: "UPLOAD",
              uploadSessionId: session.id,
            }),
            context.traceId,
          ],
        );
      }

      const updated = await client.query<Row>(
        `UPDATE upload_session
            SET status = 'COMPLETED',
                completed_at = now(),
                completed_asset_id = $4,
                expected_content_hash = COALESCE(expected_content_hash, $5)
          WHERE id = $1 AND workspace_id = $2 AND project_id = $3 AND status = 'UPLOADED'
          RETURNING *`,
        [session.id, workspaceId, session.projectId, assetId, verified.checksumSha256],
      );
      const row = updated.rows[0];
      if (!row) {
        // Concurrent completer won; reload.
        const again = await this.loadOwnedSession(client, workspaceId, sessionId);
        if (again.status === "COMPLETED" && again.completedAssetId) {
          return { assetId: again.completedAssetId, session: again };
        }
        throw new PersistenceError("OBJECT_HASH_MISMATCH", "上传内容校验失败，哈希或大小与预期不符。");
      }
      return { assetId, session: mapSession(row) };
    });
  }

  private async loadOwnedSession(
    client: PoolClient,
    workspaceId: string,
    sessionId: string,
    forUpdate = false,
  ): Promise<UploadSessionView> {
    const lock = forUpdate ? "FOR UPDATE OF s" : "";
    const owner = storeOwnerAccountFilter();
    const params: unknown[] = [sessionId, workspaceId];
    let ownerSql = "";
    if (owner && await projectOwnerColumnReady(client)) {
      params.push(owner);
      ownerSql = "AND p.owner_account_id = $3::uuid";
    }
    const result = await client.query<Row>(
      `SELECT s.*
         FROM upload_session s
         JOIN project p ON p.id = s.project_id AND p.workspace_id = s.workspace_id
        WHERE s.id = $1 AND s.workspace_id = $2
          AND p.archived_at IS NULL AND p.status = 'ACTIVE' ${ownerSql}
        ${lock}`,
      params,
    );
    const row = result.rows[0];
    if (!row) throw new PersistenceError("NOT_FOUND", "未找到该上传会话。");
    return mapSession(row);
  }

  private async expireIfNeeded(client: PoolClient, session: UploadSessionView): Promise<UploadSessionView> {
    if (session.status === "COMPLETED" || session.status === "EXPIRED" || session.status === "FAILED") {
      return session;
    }
    if (Date.parse(session.expiresAt) > Date.now()) return session;
    const updated = await client.query<Row>(
      `UPDATE upload_session SET status = 'EXPIRED'
        WHERE id = $1 AND status IN ('PENDING', 'UPLOADED')
        RETURNING *`,
      [session.id],
    );
    if (updated.rows[0]) return mapSession(updated.rows[0]);
    throw new PersistenceError("UPLOAD_SESSION_EXPIRED", "上传会话已过期，请重新创建。");
  }
}
