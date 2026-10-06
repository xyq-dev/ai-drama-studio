import type { PoolClient, QueryResultRow } from "pg";
import {
  CHARACTER_REFERENCE_JOB_KIND,
  CHARACTER_REFERENCE_ROLE,
  selectedReferenceUsable,
  type CharacterReferenceReviewRequest,
} from "@ai-drama/domain";
import { PersistenceError, type DatabasePool, type JobPersistenceService } from "./job-service";
import { recordProviderActualCost, type ProviderActualCostInput } from "./mock-media-cost";

/**
 * Character reference images. The asset columns `reference_role` / `source_character_revision_id`, the relaxed
 * IMAGE approval check and `character_reference_selection` come from the unapplied draft
 * prisma/drafts/20261005000200_character_reference_image.sql. Until they all exist, storageReady() is false and
 * every operation here refuses with CHARACTER_REFERENCE_STORAGE_UNAVAILABLE. No path falls back to plain IMAGE.
 */
export const CHARACTER_REFERENCE_STORAGE_UNAVAILABLE = "CHARACTER_REFERENCE_STORAGE_UNAVAILABLE";

export interface CharacterReferenceAsset {
  id: string;
  projectId: string;
  characterRevisionId: string;
  generationJobId: string | null;
  objectKey: string;
  mimeType: string;
  byteSize: number;
  checksumSha256: string;
  width: number | null;
  height: number | null;
  status: string;
  reviewStatus: string;
  reviewedContentHash: string | null;
  reviewNote: string | null;
  rowVersion: number;
  createdAt: string;
}

export interface CharacterReferenceSelection {
  characterId: string;
  sourceCharacterRevisionId: string;
  assetId: string;
  selectedBy: string;
  createdAt: string;
}

export interface CharacterReferenceListing {
  characterId: string;
  currentRevisionId: string | null;
  selection: (CharacterReferenceSelection & { usable: boolean }) | null;
  items: CharacterReferenceAsset[];
}

export interface PreparedReferenceGeneration {
  projectId: string;
  characterId: string;
  characterContentHash: string;
  providerConfigurationId: string;
}

export interface StrictVideoReference {
  characterRevisionId: string;
  assetId: string;
  checksumSha256: string;
}

const ASSET_COLUMNS = `asset.id, asset.project_id, asset.source_character_revision_id, asset.source_generation_job_id,
  asset.object_key, asset.mime_type, asset.byte_size, asset.checksum_sha256, asset.width, asset.height, asset.status,
  asset.review_status, asset.reviewed_content_hash, asset.review_note, asset.row_version, asset.created_at`;

function toAsset(row: QueryResultRow): CharacterReferenceAsset {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    characterRevisionId: String(row.source_character_revision_id),
    generationJobId: row.source_generation_job_id === null ? null : String(row.source_generation_job_id),
    objectKey: String(row.object_key),
    mimeType: String(row.mime_type),
    byteSize: Number(row.byte_size),
    checksumSha256: String(row.checksum_sha256),
    width: row.width === null ? null : Number(row.width),
    height: row.height === null ? null : Number(row.height),
    status: String(row.status),
    reviewStatus: String(row.review_status),
    reviewedContentHash: row.reviewed_content_hash === null ? null : String(row.reviewed_content_hash),
    reviewNote: row.review_note === null ? null : String(row.review_note),
    rowVersion: Number(row.row_version),
    createdAt: (row.created_at as Date).toISOString(),
  };
}

function unavailable(): PersistenceError {
  return new PersistenceError(CHARACTER_REFERENCE_STORAGE_UNAVAILABLE,
    "Character reference storage is not installed; the reference image draft has not been applied");
}

async function withTransaction<T>(pool: DatabasePool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    client.release();
  }
}

/** True only when every draft column, the selection table and the IMAGE approval relaxation exist. */
export async function characterReferenceStorageReady(client: Pick<PoolClient, "query">): Promise<boolean> {
  try {
    const columns = await client.query<{ table_name: string; column_name: string } & QueryResultRow>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND ((table_name = 'asset' AND column_name IN ('reference_role', 'source_character_revision_id'))
            OR (table_name = 'character_reference_selection'
              AND column_name IN ('workspace_id', 'project_id', 'character_id', 'source_character_revision_id',
                                  'asset_id', 'selected_by', 'created_at')))`,
    );
    if (columns.rows.length !== 9) return false;
    const approval = await client.query<{ definition: string } & QueryResultRow>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conname = 'asset_approval_kind_check' AND conrelid = 'asset'::regclass`,
    );
    return approval.rows.length === 1 && String(approval.rows[0]?.definition).includes(CHARACTER_REFERENCE_ROLE);
  } catch {
    return false;
  }
}

export class CharacterReferenceStore {
  constructor(private readonly pool: DatabasePool) {}

  async storageReady(): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      return await characterReferenceStorageReady(client);
    } finally {
      client.release();
    }
  }

  private async requireStorage(client: PoolClient): Promise<void> {
    if (!await characterReferenceStorageReady(client)) throw unavailable();
  }

  /**
   * Generation gate: the revision is its character's current revision, CURRENT, every script source it consumed is
   * approved and usable, no stale recalculation is pending, and the Mock image configuration is enabled. The
   * character itself need not be approved.
   */
  async prepareGenerationInTransaction(
    client: PoolClient,
    workspaceId: string,
    characterRevisionId: string,
  ): Promise<PreparedReferenceGeneration> {
    await this.requireStorage(client);
    const revision = await client.query<QueryResultRow>(
      `SELECT project_id, character_id, content_hash FROM character_revision WHERE id = $1 AND workspace_id = $2`,
      [characterRevisionId, workspaceId],
    );
    const row = revision.rows[0];
    if (!row) throw new PersistenceError("NOT_FOUND", "Character revision not found");
    const projectId = String(row.project_id);
    await client.query("SELECT id FROM project WHERE id = $1 AND workspace_id = $2 FOR UPDATE", [projectId, workspaceId]);
    const pending = await client.query(
      `SELECT 1 FROM stale_recalculation
        WHERE workspace_id = $1 AND project_id = $2 AND status IN ('PENDING', 'RUNNING') LIMIT 1`,
      [workspaceId, projectId],
    );
    if (pending.rows[0]) {
      throw new PersistenceError("STALE_RECALCULATION_PENDING", "Reference generation is blocked until stale propagation completes");
    }
    const gate = await client.query<{ current: boolean; fresh: boolean } & QueryResultRow>(
      `SELECT character.current_revision_id = revision.id AS current, revision.freshness_status = 'CURRENT' AS fresh
         FROM character_revision revision
         JOIN character ON character.id = revision.character_id AND character.workspace_id = revision.workspace_id
        WHERE revision.id = $1 AND revision.workspace_id = $2
        FOR SHARE OF character, revision`,
      [characterRevisionId, workspaceId],
    );
    if (gate.rows[0]?.fresh !== true) throw new PersistenceError("SOURCE_STALE", "Character revision is STALE");
    if (gate.rows[0]?.current !== true) {
      throw new PersistenceError("REVIEW_REQUIRED", "Reference images are generated from the character's current revision");
    }
    const sources = await client.query<{ usable: boolean } & QueryResultRow>(
      `SELECT m2_script_source_is_usable(edge.workspace_id, edge.project_id, edge.consumer_type,
                edge.consumer_revision_id, edge.script_revision_id) AS usable
         FROM script_revision_consumer_source edge
        WHERE edge.workspace_id = $1 AND edge.project_id = $2
          AND edge.consumer_type = 'character_revision' AND edge.consumer_revision_id = $3`,
      [workspaceId, projectId, characterRevisionId],
    );
    if (sources.rows.length === 0 || sources.rows.some((source) => source.usable !== true)) {
      throw new PersistenceError("SCRIPT_REVIEW_REQUIRED", "Reference generation requires an approved current script source");
    }
    const provider = await client.query<{ id: string } & QueryResultRow>(
      `SELECT id FROM provider_configuration
        WHERE workspace_id = $1 AND provider_key = 'mock-media' AND capability = 'image.generate' AND enabled LIMIT 1`,
      [workspaceId],
    );
    const providerConfigurationId = provider.rows[0]?.id;
    if (!providerConfigurationId) throw new PersistenceError("PROVIDER_CONFIG_INVALID", "Mock media provider is unavailable");
    return { projectId, characterId: String(row.character_id), characterContentHash: String(row.content_hash),
      providerConfigurationId: String(providerConfigurationId) };
  }

  /** Persists one generated reference and completes its attempt atomically, re-checking the generation gate. */
  async completeGeneration(jobs: JobPersistenceService, input: {
    workspaceId: string;
    projectId: string;
    jobId: string;
    attemptId: string;
    characterRevisionId: string;
    providerConfigurationId: string;
    providerRequestId: string;
    objectKey: string;
    byteSize: number;
    checksumSha256: string;
    width: number;
    height: number;
    traceId: string;
    actualCost: ProviderActualCostInput;
  }): Promise<CharacterReferenceAsset | null> {
    return jobs.succeedJobWithArtifact({
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      attemptId: input.attemptId,
      traceId: input.traceId,
      persistArtifact: async (client) => {
        await this.prepareGenerationInTransaction(client, input.workspaceId, input.characterRevisionId);
        const lineage = await client.query(
          `SELECT 1 FROM job_attempt attempt
             JOIN generation_job job ON job.id = attempt.generation_job_id AND job.workspace_id = attempt.workspace_id
            WHERE attempt.id = $1 AND attempt.workspace_id = $2 AND job.id = $3 AND job.kind = $4
              AND job.project_id = $5 AND attempt.provider_configuration_id = $6 AND attempt.provider_request_id = $7
              AND job.input_snapshot->>'characterRevisionId' = $8
            FOR SHARE OF attempt, job`,
          [input.attemptId, input.workspaceId, input.jobId, CHARACTER_REFERENCE_JOB_KIND, input.projectId,
            input.providerConfigurationId, input.providerRequestId, input.characterRevisionId],
        );
        if (!lineage.rows[0]) {
          throw new PersistenceError("ASSET_LINEAGE_INVALID", "Reference attempt does not match its job and character revision");
        }
        const inserted = await client.query<QueryResultRow>(
          `INSERT INTO asset
            (workspace_id, project_id, kind, storage_provider, object_key, mime_type, byte_size, checksum_sha256,
             width, height, source_job_attempt_id, source_generation_job_id, provider_configuration_id,
             provider_request_id, reference_role, source_character_revision_id)
           VALUES ($1, $2, 'IMAGE', 'mock-object-store', $3, 'image/png', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT (storage_provider, object_key) DO NOTHING
           RETURNING ${ASSET_COLUMNS.replaceAll("asset.", "")}`,
          [input.workspaceId, input.projectId, input.objectKey, input.byteSize, input.checksumSha256, input.width,
            input.height, input.attemptId, input.jobId, input.providerConfigurationId, input.providerRequestId,
            CHARACTER_REFERENCE_ROLE, input.characterRevisionId],
        );
        let row = inserted.rows[0];
        if (!row) {
          const existing = await client.query<QueryResultRow>(
            `SELECT ${ASSET_COLUMNS} FROM asset
              WHERE workspace_id = $1 AND storage_provider = 'mock-object-store' AND object_key = $2
                AND source_job_attempt_id = $3 AND source_character_revision_id = $4`,
            [input.workspaceId, input.objectKey, input.attemptId, input.characterRevisionId],
          );
          row = existing.rows[0];
          if (!row) throw new PersistenceError("ASSET_CONFLICT", "Reference object key belongs to another asset");
        } else {
          await client.query(
            `INSERT INTO asset_revision_dependency (workspace_id, project_id, dependent_asset_id, character_revision_id)
             VALUES ($1, $2, $3, $4)`,
            [input.workspaceId, input.projectId, row.id, input.characterRevisionId],
          );
          await recordProviderActualCost(client, input.actualCost);
        }
        return toAsset(row);
      },
    });
  }

  async listForCharacter(workspaceId: string, characterId: string): Promise<CharacterReferenceListing> {
    const client = await this.pool.connect();
    try {
      await this.requireStorage(client);
      const character = await client.query<QueryResultRow>(
        "SELECT id, current_revision_id FROM character WHERE id = $1 AND workspace_id = $2",
        [characterId, workspaceId],
      );
      const found = character.rows[0];
      if (!found) throw new PersistenceError("NOT_FOUND", "Character not found");
      const items = await client.query<QueryResultRow>(
        `SELECT ${ASSET_COLUMNS} FROM asset
           JOIN character_revision revision ON revision.id = asset.source_character_revision_id
            AND revision.workspace_id = asset.workspace_id
          WHERE asset.workspace_id = $1 AND revision.character_id = $2 AND asset.reference_role = $3
          ORDER BY asset.created_at DESC, asset.id DESC LIMIT 100`,
        [workspaceId, characterId, CHARACTER_REFERENCE_ROLE],
      );
      const assets = items.rows.map(toAsset);
      const selection = await client.query<QueryResultRow>(
        `SELECT character_id, source_character_revision_id, asset_id, selected_by, created_at
           FROM character_reference_selection WHERE workspace_id = $1 AND character_id = $2`,
        [workspaceId, characterId],
      );
      const selected = selection.rows[0];
      const currentRevisionId = found.current_revision_id === null ? null : String(found.current_revision_id);
      let usable = false;
      if (selected && currentRevisionId) {
        const asset = assets.find((item) => item.id === String(selected.asset_id));
        const fresh = await client.query<{ fresh: boolean } & QueryResultRow>(
          "SELECT freshness_status = 'CURRENT' AS fresh FROM character_revision WHERE id = $1",
          [currentRevisionId],
        );
        usable = Boolean(asset) && fresh.rows[0]?.fresh === true
          && String(selected.source_character_revision_id) === currentRevisionId
          && selectedReferenceUsable({ assetStatus: asset!.status, reviewStatus: asset!.reviewStatus,
            reviewedContentHash: asset!.reviewedContentHash, checksumSha256: asset!.checksumSha256,
            referenceRole: CHARACTER_REFERENCE_ROLE, sourceCharacterRevisionId: asset!.characterRevisionId }, currentRevisionId);
      }
      return {
        characterId,
        currentRevisionId,
        selection: selected ? {
          characterId: String(selected.character_id),
          sourceCharacterRevisionId: String(selected.source_character_revision_id),
          assetId: String(selected.asset_id),
          selectedBy: String(selected.selected_by),
          createdAt: (selected.created_at as Date).toISOString(),
          usable,
        } : null,
        items: assets,
      };
    } finally {
      client.release();
    }
  }

  /**
   * Manual review of one reference image on its exact bytes. Only an ACTIVE reference made from its character's
   * current, CURRENT revision can be approved; a STALE or superseded reference can only stay unapproved.
   */
  async reviewInTransaction(
    client: PoolClient,
    input: { workspaceId: string; assetId: string; reviewedBy: string; traceId: string } & CharacterReferenceReviewRequest,
  ): Promise<CharacterReferenceAsset> {
    await this.requireStorage(client);
    const locked = await client.query<QueryResultRow>(
      `SELECT ${ASSET_COLUMNS}, asset.reference_role FROM asset
        WHERE asset.id = $1 AND asset.workspace_id = $2 FOR UPDATE`,
      [input.assetId, input.workspaceId],
    );
    const row = locked.rows[0];
    if (!row || row.reference_role !== CHARACTER_REFERENCE_ROLE) {
      throw new PersistenceError("NOT_FOUND", "Character reference image not found");
    }
    if (Number(row.row_version) !== input.expectedRowVersion) {
      throw new PersistenceError("REVIEW_CONFLICT", "The reference image changed since it was read");
    }
    if (String(row.checksum_sha256) !== input.contentHash) {
      throw new PersistenceError("REVIEW_CONFLICT", "The reviewed content hash does not match the stored image");
    }
    // The asset lifecycle trigger allows one review per asset, from DRAFT; a new decision needs a new image.
    if (row.review_status !== "DRAFT") {
      throw new PersistenceError("REVIEW_INVALID_TRANSITION", "This reference image was already reviewed");
    }
    if (input.decision === "APPROVED") {
      if (row.status !== "ACTIVE") {
        throw new PersistenceError("REVIEW_INVALID_TRANSITION", "Only an ACTIVE reference image can be approved");
      }
      const source = await client.query<{ ok: boolean } & QueryResultRow>(
        `SELECT character.current_revision_id = revision.id AND revision.freshness_status = 'CURRENT' AS ok
           FROM character_revision revision
           JOIN character ON character.id = revision.character_id AND character.workspace_id = revision.workspace_id
          WHERE revision.id = $1 AND revision.workspace_id = $2 FOR SHARE OF character, revision`,
        [row.source_character_revision_id, input.workspaceId],
      );
      if (source.rows[0]?.ok !== true) {
        throw new PersistenceError("REVIEW_REQUIRED", "The reference image is not from the character's current revision");
      }
    }
    const updated = await client.query<QueryResultRow>(
      `UPDATE asset SET review_status = $3, reviewed_by = $4, reviewed_at = now(), review_note = $5,
              reviewed_content_hash = checksum_sha256, row_version = row_version + 1
        WHERE id = $1 AND workspace_id = $2
        RETURNING ${ASSET_COLUMNS.replaceAll("asset.", "")}`,
      [input.assetId, input.workspaceId, input.decision, input.reviewedBy, input.note],
    );
    await client.query(
      `INSERT INTO domain_event (workspace_id, project_id, aggregate_type, aggregate_id, event_type, payload_json, trace_id)
       VALUES ($1, $2, 'Asset', $3, 'asset.reviewed', $4::jsonb, $5)`,
      [input.workspaceId, row.project_id, input.assetId,
        JSON.stringify({ assetId: input.assetId, reviewStatus: input.decision, role: CHARACTER_REFERENCE_ROLE }), input.traceId],
    );
    return toAsset(updated.rows[0]!);
  }

  /**
   * Compare-and-set selection of the reference used for video. The asset must be ACTIVE, approved on its bytes,
   * and made from the character's current CURRENT revision.
   */
  async selectInTransaction(
    client: PoolClient,
    input: { workspaceId: string; characterId: string; assetId: string; expectedSelectedAssetId: string | null;
      selectedBy: string; traceId: string },
  ): Promise<CharacterReferenceSelection> {
    await this.requireStorage(client);
    const character = await client.query<QueryResultRow>(
      `SELECT character.id, character.project_id, character.current_revision_id,
              revision.freshness_status
         FROM character
         LEFT JOIN character_revision revision ON revision.id = character.current_revision_id
        WHERE character.id = $1 AND character.workspace_id = $2
        FOR UPDATE OF character`,
      [input.characterId, input.workspaceId],
    );
    const found = character.rows[0];
    if (!found) throw new PersistenceError("NOT_FOUND", "Character not found");
    const current = await client.query<QueryResultRow>(
      "SELECT asset_id FROM character_reference_selection WHERE workspace_id = $1 AND character_id = $2",
      [input.workspaceId, input.characterId],
    );
    const currentAssetId = current.rows[0] ? String(current.rows[0].asset_id) : null;
    if (currentAssetId !== input.expectedSelectedAssetId) {
      throw new PersistenceError("REFERENCE_SELECTION_CONFLICT", "The selected reference changed since it was read",
        { currentAssetId });
    }
    const asset = await client.query<QueryResultRow>(
      `SELECT ${ASSET_COLUMNS}, asset.reference_role FROM asset
        WHERE asset.id = $1 AND asset.workspace_id = $2 AND asset.project_id = $3 FOR SHARE`,
      [input.assetId, input.workspaceId, found.project_id],
    );
    const row = asset.rows[0];
    if (!row || row.reference_role !== CHARACTER_REFERENCE_ROLE) {
      throw new PersistenceError("NOT_FOUND", "Character reference image not found");
    }
    const revisionId = found.current_revision_id === null ? null : String(found.current_revision_id);
    if (!revisionId || found.freshness_status !== "CURRENT" || !selectedReferenceUsable({
      assetStatus: String(row.status), reviewStatus: String(row.review_status),
      reviewedContentHash: row.reviewed_content_hash === null ? null : String(row.reviewed_content_hash),
      checksumSha256: String(row.checksum_sha256), referenceRole: String(row.reference_role),
      sourceCharacterRevisionId: String(row.source_character_revision_id),
    }, revisionId)) {
      throw new PersistenceError("REVIEW_REQUIRED",
        "Only an approved ACTIVE reference from the character's current revision can be selected");
    }
    const saved = await client.query<QueryResultRow>(
      `INSERT INTO character_reference_selection
         (workspace_id, project_id, character_id, source_character_revision_id, asset_id, selected_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (workspace_id, character_id) DO UPDATE
         SET project_id = EXCLUDED.project_id, source_character_revision_id = EXCLUDED.source_character_revision_id,
             asset_id = EXCLUDED.asset_id, selected_by = EXCLUDED.selected_by, created_at = now()
       RETURNING character_id, source_character_revision_id, asset_id, selected_by, created_at`,
      [input.workspaceId, found.project_id, input.characterId, revisionId, input.assetId, input.selectedBy],
    );
    await client.query(
      `INSERT INTO domain_event (workspace_id, project_id, aggregate_type, aggregate_id, event_type, payload_json, trace_id)
       VALUES ($1, $2, 'Character', $3, 'character.reference_selected', $4::jsonb, $5)`,
      [input.workspaceId, found.project_id, input.characterId,
        JSON.stringify({ characterId: input.characterId, assetId: input.assetId, characterRevisionId: revisionId,
          previousAssetId: currentAssetId }), input.traceId],
    );
    const selected = saved.rows[0]!;
    return {
      characterId: String(selected.character_id),
      sourceCharacterRevisionId: String(selected.source_character_revision_id),
      assetId: String(selected.asset_id),
      selectedBy: String(selected.selected_by),
      createdAt: (selected.created_at as Date).toISOString(),
    };
  }

  /**
   * Strict video gate. For every character the shot revision references, the character's selection must point at a
   * usable reference made from exactly that referenced revision. Missing storage or selection refuses the video.
   */
  async strictVideoReferencesInTransaction(
    client: PoolClient,
    workspaceId: string,
    projectId: string,
    shotRevisionId: string,
  ): Promise<StrictVideoReference[]> {
    await this.requireStorage(client);
    const refs = await client.query<QueryResultRow>(
      `SELECT refs.character_revision_id, character.current_revision_id, character.approved_revision_id,
              revision.review_status AS revision_review, revision.freshness_status AS revision_freshness,
              selection.asset_id, selection.source_character_revision_id AS selected_revision,
              asset.status, asset.review_status, asset.reviewed_content_hash, asset.checksum_sha256,
              asset.reference_role, asset.source_character_revision_id
         FROM shot_character_reference refs
         JOIN character_revision revision ON revision.id = refs.character_revision_id
          AND revision.workspace_id = refs.workspace_id AND revision.project_id = refs.project_id
         JOIN character ON character.id = revision.character_id AND character.workspace_id = revision.workspace_id
         LEFT JOIN character_reference_selection selection
           ON selection.workspace_id = character.workspace_id AND selection.character_id = character.id
         LEFT JOIN asset ON asset.id = selection.asset_id AND asset.workspace_id = selection.workspace_id
        WHERE refs.shot_revision_id = $1 AND refs.workspace_id = $2 AND refs.project_id = $3
        ORDER BY refs.character_revision_id
        FOR SHARE OF character, revision`,
      [shotRevisionId, workspaceId, projectId],
    );
    const result: StrictVideoReference[] = [];
    for (const row of refs.rows) {
      const revisionId = String(row.character_revision_id);
      const characterUsable = String(row.current_revision_id) === revisionId && String(row.approved_revision_id) === revisionId
        && row.revision_review === "APPROVED" && row.revision_freshness === "CURRENT";
      const referenceUsable = row.asset_id !== null && String(row.selected_revision) === revisionId
        && selectedReferenceUsable({ assetStatus: String(row.status), reviewStatus: String(row.review_status),
          reviewedContentHash: row.reviewed_content_hash === null ? null : String(row.reviewed_content_hash),
          checksumSha256: String(row.checksum_sha256), referenceRole: row.reference_role === null ? null : String(row.reference_role),
          sourceCharacterRevisionId: row.source_character_revision_id === null ? null : String(row.source_character_revision_id),
        }, revisionId);
      if (!characterUsable || !referenceUsable) {
        throw new PersistenceError("CHARACTER_REFERENCE_REQUIRED",
          "Video generation requires each referenced character and its selected reference image to be approved and current",
          { characterRevisionId: revisionId });
      }
      result.push({ characterRevisionId: revisionId, assetId: String(row.asset_id), checksumSha256: String(row.checksum_sha256) });
    }
    return result;
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    return withTransaction(this.pool, work);
  }
}

/** Parses the frozen `characterReferences` of a strict video snapshot; null when the snapshot is legacy. */
export function frozenCharacterReferences(snapshot: unknown): StrictVideoReference[] | null {
  if (!snapshot || typeof snapshot !== "object" || !("characterReferences" in snapshot)) return null;
  const value = (snapshot as { characterReferences: unknown }).characterReferences;
  if (!Array.isArray(value)) throw new PersistenceError("VALIDATION_ERROR", "characterReferences must be an array");
  return value.map((item) => {
    const record = item as Record<string, unknown> | null;
    if (!record || typeof record.characterRevisionId !== "string" || typeof record.assetId !== "string"
      || typeof record.checksumSha256 !== "string") {
      throw new PersistenceError("VALIDATION_ERROR", "characterReferences entries are invalid");
    }
    return { characterRevisionId: record.characterRevisionId, assetId: record.assetId, checksumSha256: record.checksumSha256 };
  });
}

/**
 * Re-checks the references a strict video job froze: each is still the character's selection, ACTIVE, approved on
 * the same bytes and from the same character revision. Used at completion and before a manual retry.
 */
export async function assertFrozenReferencesUsable(
  client: PoolClient,
  workspaceId: string,
  references: readonly StrictVideoReference[],
): Promise<void> {
  if (references.length === 0) return;
  if (!await characterReferenceStorageReady(client)) throw unavailable();
  for (const reference of references) {
    const row = (await client.query<QueryResultRow>(
      `SELECT asset.status, asset.review_status, asset.reviewed_content_hash, asset.checksum_sha256,
              asset.reference_role, asset.source_character_revision_id, selection.asset_id AS selected_asset_id,
              revision.freshness_status
         FROM asset
         JOIN character_revision revision ON revision.id = asset.source_character_revision_id
          AND revision.workspace_id = asset.workspace_id
         LEFT JOIN character_reference_selection selection
           ON selection.workspace_id = asset.workspace_id AND selection.character_id = revision.character_id
        WHERE asset.id = $1 AND asset.workspace_id = $2
        FOR SHARE OF asset`,
      [reference.assetId, workspaceId],
    )).rows[0];
    const usable = row !== undefined && String(row.selected_asset_id) === reference.assetId
      && row.freshness_status === "CURRENT" && String(row.checksum_sha256) === reference.checksumSha256
      && selectedReferenceUsable({ assetStatus: String(row.status), reviewStatus: String(row.review_status),
        reviewedContentHash: row.reviewed_content_hash === null ? null : String(row.reviewed_content_hash),
        checksumSha256: String(row.checksum_sha256), referenceRole: row.reference_role === null ? null : String(row.reference_role),
        sourceCharacterRevisionId: row.source_character_revision_id === null ? null : String(row.source_character_revision_id),
      }, reference.characterRevisionId);
    if (!usable) {
      throw new PersistenceError("CHARACTER_REFERENCE_REQUIRED", "A frozen character reference is no longer usable",
        { assetId: reference.assetId, characterRevisionId: reference.characterRevisionId });
    }
  }
}
