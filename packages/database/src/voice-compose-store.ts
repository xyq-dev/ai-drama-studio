import type { PoolClient, QueryResultRow } from "pg";
import type { SpeechMixManifest } from "@ai-drama/contracts";
import { VOICE_COMPOSE_JOB_SCHEMA, VOICE_COMPOSE_OUTPUT_SCHEMA, VOICE_COMPOSE_RENDER_PROFILE, assertVoiceComposeSnapshot,
  buildVoiceComposeJobSnapshot, speechExactHash, type VoiceComposeJobSnapshot, type VoiceComposeRenderRequest,
  type VoiceComposeSourceObject } from "@ai-drama/domain";
import { PersistenceError, type DatabasePool, type JobPersistenceService } from "./job-service";
import { assertSpeechMixManifestInTransaction, commitSpeechMixDependencies, speechMixPreflightInTransaction } from "./speech-store";

type Row = QueryResultRow & Record<string, unknown>;
export interface VoiceComposeCommitInput {
  workspaceId: string; projectId: string; shotRevisionId: string; jobId: string; attemptId: string; leaseOwner: string;
  traceId: string; objectKey: string; checksumSha256: string; byteSize: number; width: number; height: number;
  durationMs: number; elapsedMs: number;
  fontSha256: string; fontFamily: string;
  fontSourceSha256?: string; fontSourceFaceIndex?: number;
}
export interface VoiceComposeCommittedAsset { id: string; checksumSha256: string }
function fail(code: string, message: string): never { throw new PersistenceError(code, message); }

/** One existing MEDIA_COMPOSE job owns the new profile; this store creates no second task registry. */
export class PostgresVoiceComposeStore {
  constructor(private readonly pool: DatabasePool, private readonly jobs: JobPersistenceService,
    private readonly options: { allowMockSources?: boolean } = {}) {}

  async freezeInTransaction(client: PoolClient, workspaceId: string, shotRevisionId: string, request: VoiceComposeRenderRequest): Promise<{
    projectId: string; snapshot: VoiceComposeJobSnapshot; inputHash: string;
  }> {
    const preflight = await speechMixPreflightInTransaction(client, workspaceId, request.planRevisionId, request);
    const manifest = preflight.manifest;
    if (manifest.workspaceId !== workspaceId || manifest.shotRevisionId !== shotRevisionId) fail("COMPOSE_INPUT_INVALID", "Voice plan is outside this shot");
    if (preflight.inputHash !== request.expectedInputHash) fail("COMPOSE_INPUT_CHANGED", "Voice sources changed after preflight");
    const ids = [...new Set([manifest.videoAssetId, ...manifest.lines.map((line) => line.takeAssetId), ...(manifest.mix.musicAssetId ? [manifest.mix.musicAssetId] : [])])].sort();
    const found = await client.query<Row>(`SELECT a.*, j.kind AS source_job_kind, j.state AS source_job_state,
      j.input_hash AS source_input_hash,j.input_snapshot AS source_input_snapshot,at.id AS source_attempt_id,
      at.provider_configuration_id AS attempt_provider_id, at.provider_request_id AS attempt_request_id,
      at.finished_at IS NOT NULL AS attempt_finished,
      at.attempt_no=(SELECT max(n.attempt_no) FROM job_attempt n WHERE n.generation_job_id=j.id AND n.workspace_id=j.workspace_id) AS latest_attempt
      FROM asset a JOIN generation_job j ON j.id=a.source_generation_job_id AND j.workspace_id=a.workspace_id AND j.project_id=a.project_id
      JOIN job_attempt at ON at.id=a.source_job_attempt_id AND at.generation_job_id=j.id AND at.workspace_id=a.workspace_id
      WHERE a.workspace_id=$1 AND a.project_id=$2 AND a.source_shot_revision_id=$3 AND a.id=ANY($4::uuid[])
      ORDER BY a.id FOR SHARE OF a,j,at`, [workspaceId, manifest.projectId, shotRevisionId, ids]);
    const byId = new Map(found.rows.map((row) => [String(row.id), row]));
    const realAttempts = found.rows.filter((row) => row.storage_provider === "s3").map((row) => String(row.source_attempt_id));
    const receiptRows = realAttempts.length ? await client.query<Row>(`SELECT s.job_attempt_id,s.generation_job_id,s.provider_configuration_id,
      s.provider_request_id,s.input_hash,s.state,pc.provider_key,pc.capability
      FROM real_media_submission s JOIN provider_configuration pc ON pc.id=s.provider_configuration_id AND pc.workspace_id=s.workspace_id
      WHERE s.workspace_id=$1 AND s.project_id=$2 AND s.job_attempt_id=ANY($3::uuid[])`, [workspaceId, manifest.projectId, realAttempts]) : { rows: [] as Row[] };
    const receipts = new Map(receiptRows.rows.map((row) => [String(row.job_attempt_id), row]));
    const source = (role: VoiceComposeSourceObject["role"], assetId: string, checksumSha256: string, durationMs?: number, lineId?: string): VoiceComposeSourceObject => {
      const row = byId.get(assetId);
      const kind = role === "video" ? "VIDEO" : role === "music" ? "MUSIC" : "AUDIO";
      const jobKind = role === "video" ? "MEDIA_VIDEO" : role === "music" ? "MEDIA_MUSIC" : "MEDIA_TTS";
      if (!row || row.status !== "ACTIVE" || row.review_status !== "DRAFT" || row.source_kind !== "PROVIDER" || row.kind !== kind ||
        row.mime_type !== (role === "video" ? "video/mp4" : "audio/wav") || row.source_job_kind !== jobKind || row.source_job_state !== "SUCCEEDED" ||
        row.attempt_finished !== true || row.latest_attempt !== true || !row.provider_configuration_id || !row.provider_request_id ||
        row.provider_configuration_id !== row.attempt_provider_id || row.provider_request_id !== row.attempt_request_id ||
        row.checksum_sha256 !== checksumSha256 || (durationMs !== undefined && Number(row.duration_ms) !== durationMs) ||
        !(row.storage_provider === "s3" || (this.options.allowMockSources === true && process.env.NODE_ENV !== "production" && row.storage_provider === "mock-object-store"))) {
        fail("COMPOSE_INPUT_INVALID", "Voice compose source no longer matches its successful generation");
      }
      if (row.storage_provider === "s3") {
        const receipt = receipts.get(String(row.source_attempt_id));
        const snapshot = row.source_input_snapshot as { schema?: string } | null;
        const capability = role === "video" ? "video.generate" : role === "music" ? "audio.music" : "audio.tts";
        if (!receipt || receipt.state !== "SUCCEEDED" || receipt.generation_job_id !== row.source_generation_job_id ||
          receipt.provider_configuration_id !== row.provider_configuration_id || receipt.provider_request_id !== row.provider_request_id ||
          receipt.input_hash !== row.source_input_hash || snapshot?.schema !== "real-media.v1" ||
          receipt.provider_key !== (role === "music" ? "elevenlabs-media" : "dashscope-media") || receipt.capability !== capability ||
          String(row.provider_request_id).startsWith("mock-media|")) fail("COMPOSE_INPUT_INVALID", "Voice compose real source has no matching successful receipt");
      }
      return { role, assetId, ...(lineId ? { lineId } : {}), storageProvider: row.storage_provider as VoiceComposeSourceObject["storageProvider"],
        objectKey: String(row.object_key), byteSize: Number(row.byte_size), checksumSha256 };
    };
    const objects = [source("video", manifest.videoAssetId, manifest.videoChecksumSha256, manifest.videoDurationMs),
      ...manifest.lines.map((line) => source("speech", line.takeAssetId, line.checksumSha256, line.endMs - line.startMs, line.lineId)),
      ...(manifest.mix.musicAssetId ? [source("music", manifest.mix.musicAssetId, manifest.mix.musicChecksumSha256!)] : [])];
    const built = buildVoiceComposeJobSnapshot(preflight, objects);
    return { projectId: manifest.projectId, ...built };
  }

  async commit(input: VoiceComposeCommitInput): Promise<VoiceComposeCommittedAsset | null> {
    let frozen: VoiceComposeJobSnapshot | undefined;
    return this.jobs.succeedJobWithArtifact({
      workspaceId: input.workspaceId, jobId: input.jobId, attemptId: input.attemptId, traceId: input.traceId,
      beforeLock: async (client) => {
        const located = await client.query<Row>("SELECT input_hash,input_snapshot FROM generation_job WHERE id=$1 AND workspace_id=$2 AND project_id=$3", [input.jobId, input.workspaceId, input.projectId]);
        if (!located.rows[0]) fail("NOT_FOUND", "Voice compose job not found");
        frozen = assertVoiceComposeSnapshot(located.rows[0].input_snapshot, String(located.rows[0].input_hash));
        await assertSpeechMixManifestInTransaction(client, frozen.input.manifest);
      },
      persistArtifact: async (client) => {
        if (!frozen) fail("COMPOSE_INPUT_INVALID", "Voice compose snapshot is missing");
        const snapshot = frozen;
        const manifest = snapshot.input.manifest;
        if (manifest.workspaceId !== input.workspaceId || manifest.projectId !== input.projectId || manifest.shotRevisionId !== input.shotRevisionId) fail("COMPOSE_INPUT_INVALID", "Voice output is outside its frozen scope");
        const key = `compose/${input.workspaceId}/${input.projectId}/${input.jobId}/${input.attemptId}/${input.checksumSha256}.mp4`;
        if (input.objectKey !== key || !/^[a-f0-9]{64}$/.test(input.checksumSha256) || !Number.isSafeInteger(input.byteSize) || input.byteSize <= 0 ||
          input.byteSize > VOICE_COMPOSE_RENDER_PROFILE.maxOutputBytes || input.width !== 1080 || input.height !== 1920 ||
          !Number.isSafeInteger(input.durationMs) || Math.abs(input.durationMs - manifest.videoDurationMs) > 80 ||
          !Number.isSafeInteger(input.elapsedMs) || input.elapsedMs < 0 || !/^[a-f0-9]{64}$/.test(input.fontSha256) || input.fontFamily !== "Noto Sans CJK SC" ||
          (input.fontSourceSha256 !== undefined && !/^[a-f0-9]{64}$/.test(input.fontSourceSha256)) ||
          (input.fontSourceFaceIndex !== undefined && (!Number.isSafeInteger(input.fontSourceFaceIndex) || input.fontSourceFaceIndex < 0 || input.fontSourceFaceIndex > 63))) fail("COMPOSE_OUTPUT_INVALID", "Voice compose output does not match its profile");
        await assertHeldVoiceCompose(client, input, snapshot);
        const metadata = { schema: VOICE_COMPOSE_OUTPUT_SCHEMA, manifest, renderProfile: VOICE_COMPOSE_RENDER_PROFILE,
          preflightInputHash: snapshot.preflightInputHash, renderEvidence: { fontSha256: input.fontSha256, fontFamily: input.fontFamily,
            ...(input.fontSourceSha256 ? { fontSourceSha256: input.fontSourceSha256, fontSourceFaceIndex: input.fontSourceFaceIndex } : {}) }, output: { checksumSha256: input.checksumSha256, byteSize: input.byteSize,
            durationMs: input.durationMs, width: input.width, height: input.height, elapsedMs: input.elapsedMs } };
        const inserted = await client.query<Row>(`INSERT INTO asset(workspace_id,project_id,kind,storage_provider,object_key,mime_type,byte_size,checksum_sha256,
          width,height,duration_ms,source_kind,source_job_attempt_id,source_generation_job_id,source_shot_revision_id,provider_configuration_id,provider_request_id,metadata_json)
          VALUES($1,$2,'COMPOSITE','local-compose',$3,'video/mp4',$4,$5,1080,1920,$6,'LOCAL_JOB',$7,$8,$9,NULL,NULL,$10::jsonb)
          RETURNING id,checksum_sha256`, [input.workspaceId, input.projectId, input.objectKey, input.byteSize, input.checksumSha256,
          input.durationMs, input.attemptId, input.jobId, input.shotRevisionId, JSON.stringify(metadata)]);
        const asset = inserted.rows[0];
        if (!asset) fail("ASSET_CONFLICT", "Voice composite was not stored");
        const assetId = String(asset.id);
        await commitSpeechMixDependencies(client, assetId, manifest);
        for (const assetIdSource of [manifest.videoAssetId, ...(manifest.mix.musicAssetId ? [manifest.mix.musicAssetId] : [])]) {
          await client.query("INSERT INTO asset_dependency(workspace_id,project_id,dependent_asset_id,source_asset_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [input.workspaceId, input.projectId, assetId, assetIdSource]);
        }
        await client.query(`INSERT INTO asset_revision_dependency(workspace_id,project_id,dependent_asset_id,shot_revision_id,scene_revision_id,script_revision_id)
          WITH src AS (SELECT r.id AS shot_id,r.source_scene_revision_id AS scene_id FROM shot_revision r WHERE r.id=$4 AND r.workspace_id=$1 AND r.project_id=$2),
          scripts AS (SELECT DISTINCT edge.script_revision_id FROM script_revision_consumer_source edge,src
            WHERE edge.workspace_id=$1 AND edge.project_id=$2 AND ((edge.consumer_type='shot_revision' AND edge.consumer_revision_id=src.shot_id) OR (edge.consumer_type='scene_revision' AND edge.consumer_revision_id=src.scene_id)))
          SELECT $1::uuid,$2::uuid,$3::uuid,shot_id,NULL::uuid,NULL::uuid FROM src UNION ALL
          SELECT $1::uuid,$2::uuid,$3::uuid,NULL::uuid,scene_id,NULL::uuid FROM src UNION ALL
          SELECT $1::uuid,$2::uuid,$3::uuid,NULL::uuid,NULL::uuid,script_revision_id FROM scripts`, [input.workspaceId, input.projectId, assetId, input.shotRevisionId]);
        await assertHeldVoiceCompose(client, input, snapshot);
        await client.query(`INSERT INTO domain_event(workspace_id,project_id,aggregate_type,aggregate_id,event_type,payload_json,trace_id)
          VALUES($1,$2,'Asset',$3,'asset.created',$4::jsonb,$5)`, [input.workspaceId, input.projectId, assetId,
          JSON.stringify({ assetId, kind: "COMPOSITE", schema: VOICE_COMPOSE_OUTPUT_SCHEMA, jobId: input.jobId, attemptId: input.attemptId }), input.traceId]);
        return { id: assetId, checksumSha256: String(asset.checksum_sha256) };
      },
      artifactResponse: (asset) => ({ outputAssetIds: [asset.id], checksumSha256: asset.checksumSha256 }),
    });
  }
}

async function assertHeldVoiceCompose(client: PoolClient, input: VoiceComposeCommitInput, frozen: VoiceComposeJobSnapshot): Promise<void> {
  const held = await client.query<Row>(`SELECT job.input_hash,job.input_snapshot FROM generation_job job
    JOIN job_attempt at ON at.id=$3 AND at.generation_job_id=job.id AND at.workspace_id=job.workspace_id
    WHERE job.id=$1 AND job.workspace_id=$2 AND job.project_id=$4 AND job.source_shot_revision_id=$6
      AND job.kind='MEDIA_COMPOSE' AND job.state='RUNNING' AND job.lease_owner=$5 AND job.cancel_requested_at IS NULL
      AND job.lease_until>clock_timestamp() AND at.finished_at IS NULL AND at.provider_configuration_id IS NULL AND at.provider_request_id IS NULL
      AND at.attempt_no=(SELECT max(n.attempt_no) FROM job_attempt n WHERE n.generation_job_id=job.id AND n.workspace_id=job.workspace_id)`,
  [input.jobId, input.workspaceId, input.attemptId, input.projectId, input.leaseOwner, input.shotRevisionId]);
  if (!held.rows[0] || String(held.rows[0].input_hash) !== speechExactHash(frozen.input) || speechExactHash(held.rows[0].input_snapshot) !== speechExactHash(frozen)) fail("COMPOSE_RESULT_DISCARDED", "Voice compose attempt lost its lease or frozen input");
}

/** Called by the existing composite review transaction, which already holds its project lock. */
export async function assertVoiceComposeReviewInTransaction(client: PoolClient, input: {
  workspaceId: string; projectId: string; shotRevisionId: string; inputHash: string; inputSnapshot: unknown;
}): Promise<void> {
  const snapshot = assertVoiceComposeSnapshot(input.inputSnapshot, input.inputHash);
  const manifest: SpeechMixManifest = snapshot.input.manifest;
  if (snapshot.schema !== VOICE_COMPOSE_JOB_SCHEMA || manifest.workspaceId !== input.workspaceId || manifest.projectId !== input.projectId || manifest.shotRevisionId !== input.shotRevisionId) fail("REVIEW_INVALID_TRANSITION", "Voice composite review lineage is invalid");
  await assertSpeechMixManifestInTransaction(client, manifest);
}
