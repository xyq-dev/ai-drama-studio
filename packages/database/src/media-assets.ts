import type { PoolClient, QueryResultRow } from "pg";
import { PersistenceError, type DatabasePool, type JobPersistenceService } from "./job-service";
import { recordProviderActualCost, type ProviderActualCostInput } from "./mock-media-cost";

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
  storageProvider: string;
  objectKey: string;
  mimeType: string;
  byteSize: number;
  checksumSha256: string;
  width: number | null;
  height: number | null;
  status: string;
  reviewStatus: string;
  sourceJobAttemptId: string | null;
  sourceGenerationJobId: string | null;
  sourceShotRevisionId: string | null;
  providerRequestId: string | null;
  durationMs: number | null;
  createdAt: string;
}

const ASSET_COLUMNS = `id, project_id, kind, storage_provider, object_key, mime_type,
                byte_size, checksum_sha256, width, height, duration_ms, status, review_status,
                source_job_attempt_id, source_generation_job_id, source_shot_revision_id,
                provider_request_id, created_at`;

export class MediaAssetStore {
  constructor(private readonly pool: DatabasePool) {}

  async requireShotScope(workspaceId: string, shotRevisionId: string): Promise<{ projectId: string }> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ project_id: string } & QueryResultRow>(
        "SELECT project_id FROM shot_revision WHERE id = $1 AND workspace_id = $2",
        [shotRevisionId, workspaceId],
      );
      const projectId = result.rows[0]?.project_id;
      if (!projectId) throw new PersistenceError("NOT_FOUND", "Shot revision not found");
      return { projectId };
    } finally {
      client.release();
    }
  }

  async prepareShotGenerationInTransaction(
    client: PoolClient,
    workspaceId: string,
    shotRevisionId: string,
    capability = "image.generate",
  ): Promise<{ projectId: string; promptText: string; dialogue: string | null }> {
    const result = await client.query<{ project_id: string } & QueryResultRow>(
      "SELECT project_id FROM shot_revision WHERE id = $1 AND workspace_id = $2",
      [shotRevisionId, workspaceId],
    );
    const projectId = result.rows[0]?.project_id;
    if (!projectId) throw new PersistenceError("NOT_FOUND", "Shot revision not found");
    await assertUsableShotWithClient(client, workspaceId, projectId, shotRevisionId, true);
    const provider = await client.query(
      `SELECT id FROM provider_configuration
        WHERE workspace_id = $1 AND provider_key = 'mock-media'
          AND capability = $2 AND enabled LIMIT 1`,
      [workspaceId, capability],
    );
    if (!provider.rows[0]) {
      throw new PersistenceError("PROVIDER_CONFIG_INVALID", "Mock media provider is unavailable");
    }
    const source = await client.query<{ prompt_text: string; dialogue: string | null } & QueryResultRow>(
      `SELECT prompt_text, dialogue
         FROM shot_revision
        WHERE id = $1 AND workspace_id = $2 AND project_id = $3`,
      [shotRevisionId, workspaceId, projectId],
    );
    const row = source.rows[0];
    if (!row) throw new PersistenceError("NOT_FOUND", "Shot revision not found");
    return {
      projectId,
      promptText: String(row.prompt_text),
      dialogue: row.dialogue === null ? null : String(row.dialogue),
    };
  }

  async completeAttemptWithAsset(
    jobs: JobPersistenceService,
    input: CreateMediaAssetInput & {
      generationJobId: string;
      traceId: string;
      actualCost?: ProviderActualCostInput;
    },
  ): Promise<MediaAssetRecord | null> {
    return jobs.succeedJobWithArtifact({
      workspaceId: input.workspaceId,
      jobId: input.generationJobId,
      attemptId: input.sourceJobAttemptId,
      traceId: input.traceId,
      persistArtifact: async (client) => {
        const replay = await loadExactReplayOrConflict(client, input);
        const asset = replay ?? await (async () => {
          if (input.sourceShotRevisionId) {
            await assertUsableShotWithClient(
              client, input.workspaceId, input.projectId, input.sourceShotRevisionId, true,
            );
          }
          return insertAsset(client, input);
        })();
        if (input.actualCost) await recordProviderActualCost(client, input.actualCost);
        return asset;
      },
    });
  }

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
        const replay = await loadExactReplayOrConflict(client, input);
        if (replay) {
          await client.query("COMMIT");
          return replay;
        }

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
        `SELECT ${ASSET_COLUMNS}
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

  async getWorkspaceAsset(workspaceId: string, assetId: string): Promise<MediaAssetRecord> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<QueryResultRow>(
        `SELECT ${ASSET_COLUMNS}
           FROM asset
          WHERE id = $1 AND workspace_id = $2`,
        [assetId, workspaceId],
      );
      const row = result.rows[0];
      if (!row) throw new PersistenceError("NOT_FOUND", "Asset not found");
      return mapAsset(row);
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
  const project = await client.query(
    `SELECT id FROM project WHERE id = $1 AND workspace_id = $2
      ${lockRows ? "FOR UPDATE" : ""}`,
    [projectId, workspaceId],
  );
  if (!project.rows[0]) {
    throw new PersistenceError("NOT_FOUND", "Project not found");
  }
  // Read after acquiring the project lock. Pointer changes and stale propagation
  // use this same lock; a pre-lock subquery can observe an obsolete snapshot.
  const pending = await client.query(
    `SELECT 1 FROM stale_recalculation
      WHERE workspace_id = $1 AND project_id = $2 AND status IN ('PENDING', 'RUNNING')
      LIMIT 1`,
    [workspaceId, projectId],
  );
  if (pending.rows[0]) {
    throw new PersistenceError(
      "STALE_RECALCULATION_PENDING",
      "Media generation is blocked until stale propagation completes",
    );
  }

  const shotGate = await client.query<{ ok: boolean; source_scene_revision_id: string } & QueryResultRow>(
    `SELECT (
        shot.current_revision_id = revision.id
        AND shot.approved_revision_id = revision.id
        AND revision.review_status = 'APPROVED'
        AND revision.freshness_status = 'CURRENT'
        AND scene.current_revision_id = revision.source_scene_revision_id
        AND scene.approved_revision_id = revision.source_scene_revision_id
        AND scene_revision.review_status = 'APPROVED'
        AND scene_revision.freshness_status = 'CURRENT'
      ) AS ok, revision.source_scene_revision_id
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

  // A shot may retain an approved scene pointer while the scene's script source
  // has changed; check that upstream dependency before creating a new asset.
  const sceneScript = await client.query<{ script_revision_id: string } & QueryResultRow>(
    `SELECT script_revision_id FROM script_revision_consumer_source
      WHERE workspace_id = $1 AND project_id = $2
        AND consumer_type = 'scene_revision' AND consumer_revision_id = $3`,
    [workspaceId, projectId, shotGate.rows[0].source_scene_revision_id],
  );
  if (sceneScript.rows.length !== 1) {
    throw new PersistenceError("REVIEW_REQUIRED", "Media generation requires a valid scene script source");
  }
  const sceneScriptUsable = await client.query<{ ok: boolean } & QueryResultRow>(
    `SELECT m2_script_source_is_usable($1, $2, 'scene_revision', $3, $4) AS ok`,
    [workspaceId, projectId, shotGate.rows[0].source_scene_revision_id, sceneScript.rows[0]!.script_revision_id],
  );
  if (sceneScriptUsable.rows[0]?.ok !== true) {
    throw new PersistenceError("REVIEW_REQUIRED", "Media generation requires a usable scene script source");
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

async function loadExactReplayOrConflict(
  client: PoolClient,
  input: CreateMediaAssetInput,
): Promise<MediaAssetRecord | null> {
  const exact = await client.query<QueryResultRow>(
    `SELECT ${ASSET_COLUMNS}
       FROM asset
      WHERE workspace_id = $1
        AND storage_provider = $2
        AND object_key = $3
        AND project_id = $4
        AND kind = $5
        AND mime_type = $6
        AND byte_size = $7
        AND checksum_sha256 = $8
        AND width IS NOT DISTINCT FROM $9::integer
        AND height IS NOT DISTINCT FROM $10::integer
        AND duration_ms IS NOT DISTINCT FROM $11::bigint
        AND source_job_attempt_id = $12
        AND source_shot_revision_id IS NOT DISTINCT FROM $13::uuid
        AND provider_configuration_id = $14
        AND provider_request_id = $15
        AND metadata_json = $16::jsonb`,
    [
      input.workspaceId,
      input.storageProvider,
      input.objectKey,
      input.projectId,
      input.kind,
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
  const row = exact.rows[0];
  if (row) return mapAsset(row);

  const conflicting = await client.query(
    `SELECT 1
       FROM asset
      WHERE workspace_id = $1
        AND storage_provider = $2
        AND object_key = $3
      LIMIT 1`,
    [input.workspaceId, input.storageProvider, input.objectKey],
  );
  if (conflicting.rows[0]) {
    throw new PersistenceError("ASSET_CONFLICT", "Asset object key is already bound to different content or metadata");
  }
  return null;
}

async function insertAsset(
  client: PoolClient,
  input: CreateMediaAssetInput,
): Promise<MediaAssetRecord> {
  const lineage = await client.query<{ generation_job_id: string } & QueryResultRow>(
    `SELECT job.id AS generation_job_id
       FROM job_attempt attempt
       JOIN generation_job job
         ON job.id = attempt.generation_job_id
        AND job.workspace_id = attempt.workspace_id
      WHERE attempt.id = $1
        AND attempt.workspace_id = $2
        AND attempt.provider_configuration_id = $3
        AND attempt.provider_request_id = $4
        AND job.project_id = $5
        AND job.source_shot_revision_id IS NOT DISTINCT FROM $6::uuid
      FOR SHARE OF attempt, job`,
    [
      input.sourceJobAttemptId,
      input.workspaceId,
      input.providerConfigurationId,
      input.providerRequestId,
      input.projectId,
      input.sourceShotRevisionId ?? null,
    ],
  );
  const generationJobId = lineage.rows[0]?.generation_job_id;
  if (!generationJobId) {
    throw new PersistenceError(
      "ASSET_LINEAGE_INVALID",
      "Asset source attempt does not belong to the requested project/provider/shot lineage",
    );
  }

  const result = await client.query<QueryResultRow>(
    `INSERT INTO asset
      (workspace_id, project_id, kind, storage_provider, object_key, mime_type,
       byte_size, checksum_sha256, width, height, duration_ms,
       source_job_attempt_id, source_generation_job_id, source_shot_revision_id,
       provider_configuration_id, provider_request_id, metadata_json)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
     ON CONFLICT (storage_provider, object_key) DO NOTHING
     RETURNING ${ASSET_COLUMNS}`,
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
      generationJobId,
      input.sourceShotRevisionId ?? null,
      input.providerConfigurationId,
      input.providerRequestId,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  const row = result.rows[0];
  if (!row) {
    const replay = await loadExactReplayOrConflict(client, input);
    if (!replay) {
      throw new PersistenceError("ASSET_CREATE_FAILED", "Asset was not created");
    }
    return replay;
  }
  if (input.sourceShotRevisionId) {
    await client.query(
      `INSERT INTO asset_revision_dependency
        (workspace_id, project_id, dependent_asset_id,
         shot_revision_id, scene_revision_id, script_revision_id)
       WITH source AS (
         SELECT shot.id AS shot_id, scene.id AS scene_id
           FROM shot_revision shot
           JOIN scene_revision scene
             ON scene.id = shot.source_scene_revision_id
            AND scene.workspace_id = shot.workspace_id
            AND scene.project_id = shot.project_id
          WHERE shot.id = $4 AND shot.workspace_id = $2 AND shot.project_id = $3
       ), script_sources AS (
         SELECT DISTINCT edge.script_revision_id
           FROM script_revision_consumer_source edge, source
          WHERE edge.workspace_id = $2 AND edge.project_id = $3
            AND ((edge.consumer_type = 'shot_revision' AND edge.consumer_revision_id = source.shot_id)
              OR (edge.consumer_type = 'scene_revision' AND edge.consumer_revision_id = source.scene_id))
       )
       SELECT $2::uuid, $3::uuid, $1::uuid, shot_id, NULL::uuid, NULL::uuid FROM source
       UNION ALL
       SELECT $2::uuid, $3::uuid, $1::uuid, NULL::uuid, scene_id, NULL::uuid FROM source
       UNION ALL
       SELECT $2::uuid, $3::uuid, $1::uuid, NULL::uuid, NULL::uuid, script_revision_id FROM script_sources`,
      [row.id, input.workspaceId, input.projectId, input.sourceShotRevisionId],
    );
  }
  return mapAsset(row);
}

function mapAsset(row: QueryResultRow): MediaAssetRecord {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    kind: String(row.kind),
    storageProvider: String(row.storage_provider),
    objectKey: String(row.object_key),
    mimeType: String(row.mime_type),
    byteSize: Number(row.byte_size),
    checksumSha256: String(row.checksum_sha256),
    width: row.width === null || row.width === undefined ? null : Number(row.width),
    height: row.height === null || row.height === undefined ? null : Number(row.height),
    status: String(row.status),
    reviewStatus: String(row.review_status),
    sourceJobAttemptId: row.source_job_attempt_id == null ? null : String(row.source_job_attempt_id),
    sourceGenerationJobId: row.source_generation_job_id == null ? null : String(row.source_generation_job_id),
    sourceShotRevisionId:
      row.source_shot_revision_id === null ? null : String(row.source_shot_revision_id),
    providerRequestId: row.provider_request_id == null ? null : String(row.provider_request_id),
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
    createdAt: new Date(row.created_at as Date | string).toISOString(),
  };
}
