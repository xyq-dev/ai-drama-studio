// Scripted query client. This file does not open PostgreSQL.
import { describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { COMPOSE_RENDER_PROFILE } from "@ai-drama/domain";
import { MediaAssetStore } from "./media-assets";
import { PersistenceError } from "./job-service";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const episodeId = "33333333-3333-4333-8333-333333333333";
const sceneRevisionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const firstAssetId = "44444444-4444-4444-8444-444444444442";
const secondAssetId = "44444444-4444-4444-8444-444444444441";
const firstShotId = "55555555-5555-4555-8555-555555555552";
const secondShotId = "55555555-5555-4555-8555-555555555551";
const firstRevisionId = "66666666-6666-4666-8666-666666666662";
const secondRevisionId = "66666666-6666-4666-8666-666666666661";
const firstJobId = "77777777-7777-4777-8777-777777777772";
const secondJobId = "77777777-7777-4777-8777-777777777771";
const firstAttemptId = "88888888-8888-4888-8888-888888888882";
const secondAttemptId = "88888888-8888-4888-8888-888888888881";

function assetRow(id: string, shotRevisionId: string, jobId: string, attemptId: string, project = projectId) {
  return {
    id,
    workspace_id: workspaceId,
    project_id: project,
    kind: "COMPOSITE",
    mime_type: "video/mp4",
    byte_size: "2048",
    checksum_sha256: "ab".repeat(32),
    width: 1080,
    height: 1920,
    duration_ms: id === firstAssetId ? "1500" : "2500",
    status: "ACTIVE",
    review_status: "APPROVED",
    storage_provider: "local-compose",
    source_kind: "LOCAL_JOB",
    source_job_attempt_id: attemptId,
    source_generation_job_id: jobId,
    source_shot_revision_id: shotRevisionId,
    provider_configuration_id: null,
    provider_request_id: null,
    reviewed_content_hash: "ab".repeat(32),
    row_version: 4,
    metadata_json: { schema: "m4.shot.compose.asset.v1", renderProfile: { ...COMPOSE_RENDER_PROFILE } },
  };
}

function script(mode: "ok" | "stale" | "review" | "cross-project" | "list") {
  const statements: string[] = [];
  const client = {
    async query(sql: string) {
      const text = sql.replace(/\s+/g, " ").trim();
      statements.push(text);
      if (/^(insert|update|delete|truncate)\b/i.test(text)) throw new Error(`unexpected write: ${text}`);
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
      if (text.startsWith("SELECT id FROM episode")) return { rows: [{ id: episodeId }] };
      if (text.includes("FROM project WHERE")) return { rows: [{ id: projectId }] };
      if (text.includes("FROM stale_recalculation")) return { rows: mode === "stale" ? [{ "?column?": 1 }] : [] };
      if (text.includes("scene_revision.heading")) {
        return {
          rows: [{
            asset_id: secondAssetId,
            shot_id: secondShotId,
            shot_revision_id: secondRevisionId,
            scene_id: "99999999-9999-4999-8999-999999999999",
            scene_ordinal: 2,
            scene_heading: "INT. ROOM",
            shot_ordinal: 1,
            checksum_sha256: "ab".repeat(32),
            byte_size: "2048",
            width: 1080,
            height: 1920,
            duration_ms: "2500",
            review_status: "APPROVED",
            row_version: 4,
          }],
        };
      }
      if (text.includes("FROM asset")) {
        if (mode === "cross-project") {
          return { rows: [assetRow(secondAssetId, secondRevisionId, secondJobId, secondAttemptId, "35353535-3535-4353-8353-353535353535"), assetRow(firstAssetId, firstRevisionId, firstJobId, firstAttemptId)] };
        }
        return {
          rows: [
            assetRow(secondAssetId, secondRevisionId, secondJobId, secondAttemptId),
            assetRow(firstAssetId, firstRevisionId, firstJobId, firstAttemptId),
          ].sort((left, right) => left.id < right.id ? -1 : 1),
        };
      }
      if (text.includes("FROM generation_job")) {
        return {
          rows: [
            { id: secondJobId, workspace_id: workspaceId, project_id: projectId, source_shot_revision_id: secondRevisionId, kind: "MEDIA_COMPOSE", state: "SUCCEEDED", input_snapshot: { schema: "m4.shot.compose.v1" } },
            { id: firstJobId, workspace_id: workspaceId, project_id: projectId, source_shot_revision_id: firstRevisionId, kind: "MEDIA_COMPOSE", state: "SUCCEEDED", input_snapshot: { schema: "m4.shot.compose.v1" } },
          ].sort((left, right) => left.id < right.id ? -1 : 1),
        };
      }
      if (text.includes("FROM job_attempt")) {
        return {
          rows: [
            { id: secondAttemptId, generation_job_id: secondJobId, finished: true, is_latest: true },
            { id: firstAttemptId, generation_job_id: firstJobId, finished: true, is_latest: true },
          ].sort((left, right) => left.id < right.id ? -1 : 1),
        };
      }
      if (text.includes("AS shot_revision_id")) {
        return {
          rows: [
            { shot_revision_id: secondRevisionId, shot_id: secondShotId, episode_id: episodeId },
            { shot_revision_id: firstRevisionId, shot_id: firstShotId, episode_id: episodeId },
          ],
        };
      }
      if (text.includes("AS ok, revision.source_scene_revision_id")) {
        return { rows: [{ ok: mode !== "review", source_scene_revision_id: sceneRevisionId }] };
      }
      if (text.includes("consumer_type = 'scene_revision'")) return { rows: [{ script_revision_id: sceneRevisionId }] };
      if (text.includes("m2_script_source_is_usable")) return { rows: [{ ok: true }] };
      if (text.includes("FROM shot_character_reference")) return { rows: [] };
      if (text.includes("consumer_type = 'shot_revision'")) return { rows: [] };
      throw new Error(`unexpected query: ${text}`);
    },
    release() {
      return undefined;
    },
  };
  return { client, statements };
}

function storeFor(mode: "ok" | "stale" | "review" | "cross-project" | "list") {
  const scripted = script(mode);
  const pool = { connect: async () => scripted.client as unknown as PoolClient };
  return { store: new MediaAssetStore(pool as never), statements: scripted.statements };
}

describe("episode compose preflight persistence", () => {
  it("keeps the requested order and commits without writing business rows", async () => {
    const { store, statements } = storeFor("ok");
    const result = await store.preflightEpisodeCompose(workspaceId, projectId, episodeId, [firstAssetId, secondAssetId]);
    expect(result.manifest.segments.map((segment) => segment.assetId)).toEqual([firstAssetId, secondAssetId]);
    expect(result.manifest.segments.map((segment) => [segment.startMs, segment.endMs])).toEqual([[0, 1500], [1500, 4000]]);
    expect(result.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(statements.at(-1)).toBe("COMMIT");
    expect(statements.some((statement) => /^(insert|update|delete|truncate)\b/i.test(statement))).toBe(false);
  });

  it("blocks a pending stale recalculation and an old shot revision", async () => {
    const stale = storeFor("stale");
    await expect(stale.store.preflightEpisodeCompose(workspaceId, projectId, episodeId, [firstAssetId, secondAssetId])).rejects.toBeInstanceOf(PersistenceError);
    await expect(stale.store.preflightEpisodeCompose(workspaceId, projectId, episodeId, [firstAssetId, secondAssetId])).rejects.toMatchObject({
      code: "STALE_RECALCULATION_PENDING",
    });
    expect(stale.statements.at(-1)).toBe("ROLLBACK");
    const review = storeFor("review");
    await expect(review.store.preflightEpisodeCompose(workspaceId, projectId, episodeId, [firstAssetId, secondAssetId])).rejects.toMatchObject({
      code: "REVIEW_REQUIRED",
    });
    expect(review.statements.some((statement) => /^(insert|update|delete|truncate)\b/i.test(statement))).toBe(false);
  });

  it("rejects a composite from another project and lists a candidate without a storage path", async () => {
    const crossed = storeFor("cross-project");
    await expect(crossed.store.preflightEpisodeCompose(workspaceId, projectId, episodeId, [firstAssetId, secondAssetId])).rejects.toMatchObject({
      code: "COMPOSE_INPUT_INVALID",
    });
    const listed = storeFor("list");
    const page = await listed.store.listEpisodeComposeCandidates(workspaceId, projectId, episodeId, undefined, 20);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ assetId: secondAssetId, sceneHeading: "INT. ROOM", durationMs: 2500 });
    expect(JSON.stringify(page)).not.toMatch(/objectKey|object_key|storage_provider/);
    expect(listed.statements.some((statement) => /^(insert|update|delete|truncate)\b/i.test(statement))).toBe(false);
  });
});
