import {
  assertExpectedPreflightHash,
  buildComposeJobSnapshot,
  buildComposePreflight,
  canonicalInputHash,
  type ComposeAssetFacts,
  type ComposeAttemptFacts,
  type ComposeJobFacts,
  type ComposeJobSnapshot,
  type ComposePreflightResponse,
  type ComposePreflightSelection,
  type ComposeRenderRequest,
  type ComposeSourceObject,
  DomainError,
} from "@ai-drama/domain";
import type { PoolClient, QueryResultRow } from "pg";
import { PersistenceError, type DatabasePool, type JobPersistenceService } from "./job-service";
import { guardSynchronousMockImageCost, recordProviderActualCost, type ProviderActualCostInput } from "./mock-media-cost";

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
  rowVersion: number;
  createdAt: string;
}

const ASSET_COLUMNS = `id, project_id, kind, storage_provider, object_key, mime_type,
                byte_size, checksum_sha256, width, height, duration_ms, status, review_status,
                source_job_attempt_id, source_generation_job_id, source_shot_revision_id,
                provider_request_id, row_version, created_at`;

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
        if (input.kind === "IMAGE" && input.actualCost) {
          await guardSynchronousMockImageCost(client, {
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            generationJobId: input.generationJobId,
            sourceJobAttemptId: input.sourceJobAttemptId,
            sourceShotRevisionId: input.sourceShotRevisionId,
            providerConfigurationId: input.providerConfigurationId,
            providerRequestId: input.providerRequestId,
          }, input.actualCost);
        }
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

  async preflightCompose(
    workspaceId: string,
    shotRevisionId: string,
    selection: ComposePreflightSelection,
  ): Promise<ComposePreflightResponse> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      try {
        const result = await preflightComposeWithClient(client, workspaceId, shotRevisionId, selection);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        if (error instanceof DomainError) throw new PersistenceError(error.code, error.message);
        throw error;
      }
    } finally {
      client.release();
    }
  }

  async freezeComposeInput(
    client: PoolClient,
    workspaceId: string,
    shotRevisionId: string,
    request: ComposeRenderRequest,
  ): Promise<{ projectId: string; snapshot: ComposeJobSnapshot; inputHash: string }> {
    let preflight: ComposePreflightResponse;
    try {
      preflight = await preflightComposeWithClient(client, workspaceId, shotRevisionId, request);
      assertExpectedPreflightHash(preflight.inputHash, request.expectedInputHash);
    } catch (error) {
      if (error instanceof DomainError) throw new PersistenceError(error.code, error.message);
      throw error;
    }
    const ids = preflight.manifest.sources.flatMap((slot) => (slot.asset ? [slot.asset.assetId] : []));
    const stored = await client.query<QueryResultRow>(
      `SELECT id::text AS id, storage_provider, object_key, byte_size, checksum_sha256
         FROM asset WHERE workspace_id = $1 AND id = ANY($2::uuid[])`,
      [workspaceId, ids],
    );
    const byId = new Map(stored.rows.map((row) => [String(row.id), row]));
    const sourceObjects: ComposeSourceObject[] = [];
    for (const slot of preflight.manifest.sources) {
      if (!slot.asset) continue;
      const row = byId.get(slot.asset.assetId);
      if (!row) throw new PersistenceError("NOT_FOUND", "Asset not found");
      sourceObjects.push({
        role: slot.role,
        assetId: slot.asset.assetId,
        storageProvider: String(row.storage_provider),
        objectKey: String(row.object_key),
        byteSize: Number(row.byte_size),
        checksumSha256: String(row.checksum_sha256),
      });
    }
    try {
      const built = buildComposeJobSnapshot(preflight, sourceObjects);
      return { projectId: preflight.manifest.projectId, snapshot: built.snapshot, inputHash: built.inputHash };
    } catch (error) {
      if (error instanceof DomainError) throw new PersistenceError(error.code, error.message);
      throw error;
    }
  }

  async commitLocalCompose(
    jobs: JobPersistenceService,
    input: {
      workspaceId: string;
      projectId: string;
      shotRevisionId: string;
      jobId: string;
      attemptId: string;
      leaseOwner: string;
      traceId: string;
      objectKey: string;
      checksumSha256: string;
      byteSize: number;
      width: number;
      height: number;
      durationMs: number;
      elapsedMs: number;
    },
  ): Promise<MediaAssetRecord | null> {
    return jobs.succeedJobWithArtifact({
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      attemptId: input.attemptId,
      traceId: input.traceId,
      persistArtifact: async (client) => insertLocalComposeAsset(client, input),
      artifactResponse: (asset) => ({ outputAssetIds: [asset.id], checksumSha256: asset.checksumSha256 }),
    });
  }

  async reviewComposite(
    client: PoolClient,
    input: {
      workspaceId: string;
      assetId: string;
      expectedRowVersion: number;
      decision: "APPROVE" | "REJECT";
      note: string;
      contentHash: string;
      reviewedBy: string;
      traceId: string;
    },
  ): Promise<{ assetId: string; reviewStatus: string; rowVersion: number; contentHash: string }> {
    const located = await client.query<{ project_id: string } & QueryResultRow>(
      "SELECT project_id FROM asset WHERE id = $1 AND workspace_id = $2",
      [input.assetId, input.workspaceId],
    );
    const projectId = located.rows[0]?.project_id;
    if (!projectId) throw new PersistenceError("NOT_FOUND", "Asset not found");
    await client.query("SELECT id FROM project WHERE id = $1 AND workspace_id = $2 FOR UPDATE", [projectId, input.workspaceId]);
    const asset = await client.query<QueryResultRow>(
      `SELECT id, project_id, kind, status, review_status, row_version, checksum_sha256, source_kind,
              source_job_attempt_id, source_generation_job_id, source_shot_revision_id,
              provider_configuration_id, provider_request_id, storage_provider, metadata_json
         FROM asset WHERE id = $1 AND workspace_id = $2 FOR UPDATE`,
      [input.assetId, input.workspaceId],
    );
    const row = asset.rows[0];
    if (!row || row.kind !== "COMPOSITE" || row.source_kind !== "LOCAL_JOB" || row.storage_provider !== "local-compose") {
      throw new PersistenceError("REVIEW_INVALID_TRANSITION", "Only a local composite draft can be reviewed");
    }
    if (row.review_status !== "DRAFT") {
      throw new PersistenceError("REVIEW_INVALID_TRANSITION", "Composite review is already decided");
    }
    if (Number(row.row_version) !== input.expectedRowVersion) {
      throw new PersistenceError("REVISION_CONFLICT", "Composite row version changed; reread before confirming");
    }
    if (row.status !== "ACTIVE") {
      throw new PersistenceError("REVIEW_INVALID_TRANSITION", "Only an active composite draft can be reviewed");
    }
    if (String(row.checksum_sha256) !== input.contentHash) {
      throw new PersistenceError("COMPOSE_CONTENT_HASH_MISMATCH", "Content hash does not match the composite being reviewed");
    }
    if (row.provider_configuration_id !== null || row.provider_request_id !== null || !row.source_job_attempt_id || !row.source_generation_job_id) {
      throw new PersistenceError("REVIEW_INVALID_TRANSITION", "Composite lineage is incomplete");
    }
    const job = await client.query<QueryResultRow>(
      `SELECT job.id, job.kind, job.state, job.input_hash, job.input_snapshot, attempt.id AS attempt_id
         FROM generation_job job
         JOIN job_attempt attempt ON attempt.id = $3 AND attempt.generation_job_id = job.id AND attempt.workspace_id = job.workspace_id
        WHERE job.id = $1 AND job.workspace_id = $2 AND job.project_id = $4
        FOR SHARE OF job, attempt`,
      [row.source_generation_job_id, input.workspaceId, row.source_job_attempt_id, projectId],
    );
    const source = job.rows[0];
    const latest = await client.query<QueryResultRow>(
      `SELECT id FROM job_attempt WHERE generation_job_id = $1 ORDER BY attempt_no DESC LIMIT 1`,
      [row.source_generation_job_id],
    );
    if (!source || source.kind !== "MEDIA_COMPOSE" || source.state !== "SUCCEEDED" || source.attempt_id !== row.source_job_attempt_id || latest.rows[0]?.id !== row.source_job_attempt_id) {
      throw new PersistenceError("REVIEW_INVALID_TRANSITION", "Composite does not come from its successful compose attempt");
    }
    if (input.decision === "APPROVE") {
      if (!row.source_shot_revision_id) throw new PersistenceError("REVIEW_INVALID_TRANSITION", "Composite has no shot source");
      await assertUsableShotWithClient(client, input.workspaceId, String(projectId), String(row.source_shot_revision_id), true);
      const metadata = row.metadata_json as { manifest?: { sources?: Array<{ role: string; asset: { assetId: string } | null }> } };
      const selection = selectionFromMetadata(metadata);
      try {
        await preflightComposeWithClient(client, input.workspaceId, String(row.source_shot_revision_id), selection);
      } catch (error) {
        if (error instanceof DomainError) throw new PersistenceError(error.code, error.message);
        if (error instanceof PersistenceError) throw error;
        throw error;
      }
    }
    const updated = await client.query<QueryResultRow>(
      `UPDATE asset
          SET review_status = $4, reviewed_by = $5, reviewed_at = now(), review_note = $6,
              reviewed_content_hash = checksum_sha256, row_version = row_version + 1
        WHERE id = $1 AND workspace_id = $2 AND review_status = 'DRAFT' AND status = 'ACTIVE' AND row_version = $3
        RETURNING id, review_status, row_version, checksum_sha256`,
      [input.assetId, input.workspaceId, input.expectedRowVersion, input.decision === "APPROVE" ? "APPROVED" : "REJECTED", input.reviewedBy, input.note],
    );
    const saved = updated.rows[0];
    if (!saved) throw new PersistenceError("REVIEW_CONFLICT", "Composite review conflicted with another decision");
    await client.query(
      `INSERT INTO domain_event
        (workspace_id, project_id, aggregate_type, aggregate_id, event_type, payload_json, trace_id)
       VALUES ($1, $2, 'Asset', $3, 'asset.reviewed', $4::jsonb, $5)`,
      [input.workspaceId, projectId, input.assetId, JSON.stringify({
        assetId: input.assetId, reviewStatus: saved.review_status, rowVersion: Number(saved.row_version), contentHash: saved.checksum_sha256,
      }), input.traceId],
    );
    return {
      assetId: String(saved.id),
      reviewStatus: String(saved.review_status),
      rowVersion: Number(saved.row_version),
      contentHash: String(saved.checksum_sha256),
    };
  }
}

function selectionFromMetadata(metadata: { manifest?: { sources?: Array<{ role: string; asset: { assetId: string } | null }> } }): ComposePreflightSelection {
  const sources = metadata.manifest?.sources ?? [];
  const id = (role: string) => sources.find((slot) => slot.role === role)?.asset?.assetId ?? null;
  const videoAssetId = id("video");
  if (!videoAssetId) throw new PersistenceError("COMPOSE_INPUT_INVALID", "Frozen compose manifest has no video");
  return { videoAssetId, audioAssetId: id("audio"), musicAssetId: id("music"), subtitleAssetId: id("subtitle") };
}

async function insertLocalComposeAsset(
  client: PoolClient,
  input: {
    workspaceId: string;
    projectId: string;
    shotRevisionId: string;
    jobId: string;
    attemptId: string;
    leaseOwner: string;
    traceId: string;
    objectKey: string;
    checksumSha256: string;
    byteSize: number;
    width: number;
    height: number;
    durationMs: number;
    elapsedMs: number;
  },
): Promise<MediaAssetRecord> {
  const expectedKey = `compose/${input.workspaceId}/${input.projectId}/${input.jobId}/${input.attemptId}/${input.checksumSha256}.mp4`;
  if (input.objectKey !== expectedKey) {
    throw new PersistenceError("COMPOSE_OUTPUT_INVALID", "Compose object key does not belong to this attempt");
  }
  const held = await client.query<QueryResultRow>(
    `SELECT job.input_hash, job.input_snapshot
       FROM generation_job job
       JOIN job_attempt attempt ON attempt.id = $3 AND attempt.generation_job_id = job.id AND attempt.workspace_id = job.workspace_id
      WHERE job.id = $1 AND job.workspace_id = $2 AND job.project_id = $4
        AND job.kind = 'MEDIA_COMPOSE' AND job.state = 'RUNNING'
        AND job.lease_owner = $5 AND job.cancel_requested_at IS NULL AND job.lease_until > now()
        AND attempt.finished_at IS NULL
        AND attempt.provider_configuration_id IS NULL AND attempt.provider_request_id IS NULL
        AND attempt.attempt_no = (SELECT MAX(latest.attempt_no) FROM job_attempt latest WHERE latest.generation_job_id = job.id)`,
    [input.jobId, input.workspaceId, input.attemptId, input.projectId, input.leaseOwner],
  );
  const locked = held.rows[0];
  if (!locked) {
    throw new PersistenceError("COMPOSE_RESULT_DISCARDED", "Compose result arrived after its attempt lost the lease");
  }
  const snapshot = locked.input_snapshot as ComposeJobSnapshot;
  let hashed: string;
  try {
    hashed = canonicalInputHash(snapshot.input);
  } catch (error) {
    if (error instanceof DomainError) throw new PersistenceError("COMPOSE_INPUT_INVALID", error.message);
    throw error;
  }
  if (hashed !== String(locked.input_hash) || snapshot.schema !== "m4.shot.compose.v1") {
    throw new PersistenceError("COMPOSE_INPUT_INVALID", "Frozen compose input does not match its hash");
  }
  try {
    const current = await preflightComposeWithClient(client, input.workspaceId, input.shotRevisionId, selectionFromMetadata({ manifest: snapshot.input.manifest }));
    if (current.inputHash !== snapshot.preflightInputHash) {
      throw new PersistenceError("COMPOSE_INPUT_INVALID", "Compose sources changed before the output could be stored");
    }
  } catch (error) {
    if (error instanceof PersistenceError) throw error;
    if (error instanceof DomainError) throw new PersistenceError(error.code, error.message);
    throw error;
  }
  const metadata = {
    schema: "m4.shot.compose.asset.v1",
    manifest: snapshot.input.manifest,
    renderProfile: snapshot.input.renderProfile,
    preflightInputHash: snapshot.preflightInputHash,
    output: {
      checksumSha256: input.checksumSha256,
      byteSize: input.byteSize,
      durationMs: input.durationMs,
      width: input.width,
      height: input.height,
      elapsedMs: input.elapsedMs,
    },
  };
  const inserted = await client.query<QueryResultRow>(
    `INSERT INTO asset
      (workspace_id, project_id, kind, storage_provider, object_key, mime_type, byte_size, checksum_sha256,
       width, height, duration_ms, source_kind, source_job_attempt_id, source_generation_job_id, source_shot_revision_id,
       provider_configuration_id, provider_request_id, metadata_json)
     VALUES ($1,$2,'COMPOSITE','local-compose',$3,'video/mp4',$4,$5,$6,$7,$8,'LOCAL_JOB',$9,$10,$11,NULL,NULL,$12::jsonb)
     RETURNING ${ASSET_COLUMNS}`,
    [
      input.workspaceId, input.projectId, input.objectKey, input.byteSize, input.checksumSha256,
      input.width, input.height, input.durationMs, input.attemptId, input.jobId, input.shotRevisionId,
      JSON.stringify(metadata),
    ],
  );
  const row = inserted.rows[0];
  if (!row) throw new PersistenceError("ASSET_CONFLICT", "Compose object key is already registered");
  for (const source of snapshot.input.sourceObjects) {
    await client.query(
      `INSERT INTO asset_dependency (workspace_id, project_id, dependent_asset_id, source_asset_id)
       VALUES ($1, $2, $3, $4)`,
      [input.workspaceId, input.projectId, row.id, source.assetId],
    );
  }
  await client.query(
    `INSERT INTO asset_revision_dependency
      (workspace_id, project_id, dependent_asset_id, shot_revision_id, scene_revision_id, script_revision_id)
     WITH source AS (
       SELECT shot.id AS shot_id, scene.id AS scene_id
         FROM shot_revision shot
         JOIN scene_revision scene ON scene.id = shot.source_scene_revision_id
          AND scene.workspace_id = shot.workspace_id AND scene.project_id = shot.project_id
        WHERE shot.id = $4 AND shot.workspace_id = $2 AND shot.project_id = $3
     ), script_sources AS (
       SELECT DISTINCT edge.script_revision_id
         FROM script_revision_consumer_source edge, source
        WHERE edge.workspace_id = $2 AND edge.project_id = $3
          AND ((edge.consumer_type = 'shot_revision' AND edge.consumer_revision_id = source.shot_id)
            OR (edge.consumer_type = 'scene_revision' AND edge.consumer_revision_id = source.scene_id))
     )
     SELECT $2::uuid, $3::uuid, $1::uuid, shot_id, NULL::uuid, NULL::uuid FROM source
     UNION ALL SELECT $2::uuid, $3::uuid, $1::uuid, NULL::uuid, scene_id, NULL::uuid FROM source
     UNION ALL SELECT $2::uuid, $3::uuid, $1::uuid, NULL::uuid, NULL::uuid, script_revision_id FROM script_sources`,
    [row.id, input.workspaceId, input.projectId, input.shotRevisionId],
  );
  await client.query(
    `INSERT INTO domain_event
      (workspace_id, project_id, aggregate_type, aggregate_id, event_type, payload_json, trace_id)
     VALUES ($1, $2, 'Asset', $3, 'asset.created', $4::jsonb, $5)`,
    [input.workspaceId, input.projectId, row.id, JSON.stringify({
      assetId: row.id, kind: "COMPOSITE", jobId: input.jobId, attemptId: input.attemptId,
    }), input.traceId],
  );
  return mapAsset(row);
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
    rowVersion: Number(row.row_version),
    createdAt: new Date(row.created_at as Date | string).toISOString(),
  };
}

async function preflightComposeWithClient(
  client: PoolClient,
  workspaceId: string,
  shotRevisionId: string,
  selection: ComposePreflightSelection,
): Promise<ComposePreflightResponse> {
  const scope = await client.query<{ project_id: string } & QueryResultRow>(
    "SELECT project_id FROM shot_revision WHERE id = $1 AND workspace_id = $2",
    [shotRevisionId, workspaceId],
  );
  const projectId = scope.rows[0]?.project_id;
  if (!projectId) throw new PersistenceError("NOT_FOUND", "Shot revision not found");
  await assertUsableShotWithClient(client, workspaceId, projectId, shotRevisionId, true);
  const ids = [selection.videoAssetId, selection.audioAssetId, selection.musicAssetId, selection.subtitleAssetId]
    .filter((id): id is string => id !== null)
    .sort();
  const assets = await client.query<QueryResultRow>(
    `SELECT id, workspace_id, project_id, kind, storage_provider, mime_type, byte_size, checksum_sha256,
            width, height, duration_ms, status, review_status, source_job_attempt_id,
            source_generation_job_id, source_shot_revision_id, provider_configuration_id,
            provider_request_id, row_version
       FROM asset
      WHERE workspace_id = $1 AND id = ANY($2::uuid[])
      ORDER BY id
      FOR UPDATE`,
    [workspaceId, ids],
  );
  if (assets.rows.length !== ids.length) throw new PersistenceError("NOT_FOUND", "Asset not found");
  const jobIds = [...new Set(assets.rows.map((row) => String(row.source_generation_job_id ?? "")))].filter((id) => id.length > 0).sort();
  const attemptIds = [...new Set(assets.rows.map((row) => String(row.source_job_attempt_id ?? "")))].filter((id) => id.length > 0).sort();
  const jobs = jobIds.length === 0 ? { rows: [] } : await client.query<QueryResultRow>(
    `SELECT id, workspace_id, project_id, source_shot_revision_id, kind, state
       FROM generation_job
      WHERE workspace_id = $1 AND id = ANY($2::uuid[])
      ORDER BY id
      FOR SHARE`,
    [workspaceId, jobIds],
  );
  const attempts = attemptIds.length === 0 ? { rows: [] } : await client.query<QueryResultRow>(
    `SELECT id, generation_job_id, attempt_no, provider_request_id, provider_configuration_id,
            finished_at IS NOT NULL AS finished
       FROM job_attempt
      WHERE workspace_id = $1 AND id = ANY($2::uuid[])
      ORDER BY id
      FOR SHARE`,
    [workspaceId, attemptIds],
  );
  const jobsById = new Map(jobs.rows.map((row) => [String(row.id), row]));
  const attemptsById = new Map(attempts.rows.map((row) => [String(row.id), row]));
  const byId = new Map(assets.rows.map((row) => [String(row.id), composeFacts(workspaceId, row, jobsById, attemptsById)]));
  return buildComposePreflight({
    workspaceId,
    projectId,
    shotRevisionId,
    assets: {
      video: requiredFacts(byId, selection.videoAssetId),
      audio: selection.audioAssetId ? requiredFacts(byId, selection.audioAssetId) : null,
      music: selection.musicAssetId ? requiredFacts(byId, selection.musicAssetId) : null,
      subtitle: selection.subtitleAssetId ? requiredFacts(byId, selection.subtitleAssetId) : null,
    },
  });
}

function requiredFacts(byId: Map<string, ComposeAssetFacts>, assetId: string): ComposeAssetFacts {
  const facts = byId.get(assetId);
  if (!facts) throw new PersistenceError("NOT_FOUND", "Asset not found");
  return facts;
}

function composeFacts(
  workspaceId: string,
  row: QueryResultRow,
  jobsById: Map<string, QueryResultRow>,
  attemptsById: Map<string, QueryResultRow>,
): ComposeAssetFacts {
  const jobRow = row.source_generation_job_id == null ? undefined : jobsById.get(String(row.source_generation_job_id));
  const attemptRow = row.source_job_attempt_id == null ? undefined : attemptsById.get(String(row.source_job_attempt_id));
  return {
    id: String(row.id),
    workspaceId,
    projectId: String(row.project_id),
    shotRevisionId: row.source_shot_revision_id == null ? null : String(row.source_shot_revision_id),
    kind: String(row.kind),
    mimeType: String(row.mime_type),
    byteSize: integerOrZero(row.byte_size),
    checksumSha256: String(row.checksum_sha256),
    width: row.width === null || row.width === undefined ? null : integerOrZero(row.width),
    height: row.height === null || row.height === undefined ? null : integerOrZero(row.height),
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : integerOrZero(row.duration_ms),
    status: String(row.status),
    reviewStatus: String(row.review_status),
    storageProvider: String(row.storage_provider),
    sourceGenerationJobId: row.source_generation_job_id == null ? null : String(row.source_generation_job_id),
    sourceJobAttemptId: row.source_job_attempt_id == null ? null : String(row.source_job_attempt_id),
    providerRequestId: row.provider_request_id == null ? null : String(row.provider_request_id),
    providerConfigurationId: row.provider_configuration_id == null ? null : String(row.provider_configuration_id),
    rowVersion: integerOrZero(row.row_version),
    job: jobRow ? composeJob(jobRow) : null,
    attempt: attemptRow ? composeAttempt(attemptRow) : null,
  };
}

function composeJob(row: QueryResultRow): ComposeJobFacts {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    projectId: String(row.project_id),
    shotRevisionId: row.source_shot_revision_id == null ? null : String(row.source_shot_revision_id),
    kind: String(row.kind),
    state: String(row.state),
  };
}

function composeAttempt(row: QueryResultRow): ComposeAttemptFacts {
  return {
    id: String(row.id),
    generationJobId: String(row.generation_job_id),
    attemptNo: integerOrZero(row.attempt_no),
    providerRequestId: row.provider_request_id == null ? null : String(row.provider_request_id),
    providerConfigurationId: row.provider_configuration_id == null ? null : String(row.provider_configuration_id),
    finished: row.finished === true,
  };
}

function integerOrZero(value: unknown): number {
  if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : 0;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return 0;
}
