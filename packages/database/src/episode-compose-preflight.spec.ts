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

function listedCandidate(overrides: Record<string, unknown> = {}) {
  return {
    asset_id: secondAssetId,
    workspace_id: workspaceId,
    project_id: projectId,
    episode_id: episodeId,
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
    mime_type: "video/mp4",
    kind: "COMPOSITE",
    status: "ACTIVE",
    review_status: "APPROVED",
    source_kind: "LOCAL_JOB",
    storage_provider: "local-compose",
    reviewed_content_hash: "ab".repeat(32),
    row_version: 4,
    metadata_json: { schema: "m4.shot.compose.asset.v1", renderProfile: { ...COMPOSE_RENDER_PROFILE } },
    provider_configuration_id: null,
    provider_request_id: null,
    source_generation_job_id: secondJobId,
    source_job_attempt_id: secondAttemptId,
    job_id: secondJobId,
    job_workspace_id: workspaceId,
    job_project_id: projectId,
    job_shot_revision_id: secondRevisionId,
    job_kind: "MEDIA_COMPOSE",
    job_state: "SUCCEEDED",
    job_input_snapshot: { schema: "m4.shot.compose.v1" },
    attempt_id: secondAttemptId,
    attempt_job_id: secondJobId,
    attempt_finished: true,
    attempt_is_latest: true,
    ...overrides,
  };
}

function pageCatalog() {
  const rows = [
    ["01", 1, 1, { metadata_json: { schema: "unknown", renderProfile: { ...COMPOSE_RENDER_PROFILE } } }],
    ["02", 1, 2, { metadata_json: { schema: "m4.shot.compose.asset.v1", renderProfile: { ...COMPOSE_RENDER_PROFILE, crf: 18 } } }],
    ["03", 2, 1, { job_state: "FAILED" }],
    ["04", 2, 2, { attempt_is_latest: false }],
    ["05", 3, 1, { attempt_finished: false }],
    ["06", 3, 2, {}],
    ["07", 4, 1, {}],
  ] as const;
  return rows.map(([suffix, sceneOrdinal, shotOrdinal, overrides]) => listedCandidate({
    asset_id: `44444444-4444-4444-8444-4444444444${suffix}`,
    shot_id: `55555555-5555-4555-8555-5555555555${suffix}`,
    shot_revision_id: `66666666-6666-4666-8666-6666666666${suffix}`,
    source_generation_job_id: `77777777-7777-4777-8777-7777777777${suffix}`,
    source_job_attempt_id: `88888888-8888-4888-8888-8888888888${suffix}`,
    job_id: `77777777-7777-4777-8777-7777777777${suffix}`,
    job_shot_revision_id: `66666666-6666-4666-8666-6666666666${suffix}`,
    attempt_id: `88888888-8888-4888-8888-8888888888${suffix}`,
    attempt_job_id: `77777777-7777-4777-8777-7777777777${suffix}`,
    scene_ordinal: sceneOrdinal,
    shot_ordinal: shotOrdinal,
    ...overrides,
  }));
}

function script(mode: "ok" | "stale" | "review" | "cross-project" | "list" | "page") {
  const statements: string[] = [];
  const candidateReads: Array<{ limit: unknown; returned: number; shotChecks: number }> = [];
  let pendingShotChecks = 0;
  const catalog = pageCatalog();
  const client = {
    async query(sql: string, params: unknown[] = []) {
      const text = sql.replace(/\s+/g, " ").trim();
      statements.push(text);
      if (/^(insert|update|delete|truncate)\b/i.test(text)) throw new Error(`unexpected write: ${text}`);
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
      if (text.startsWith("SELECT id FROM episode")) return { rows: [{ id: episodeId }] };
      if (text.includes("FROM project WHERE")) return { rows: [{ id: projectId }] };
      if (text.includes("FROM stale_recalculation")) return { rows: mode === "stale" ? [{ "?column?": 1 }] : [] };
      if (text.includes("scene_revision.heading")) {
        const previous = candidateReads.at(-1);
        if (previous) previous.shotChecks = pendingShotChecks;
        pendingShotChecks = 0;
        if (mode === "page") {
          const limit = params[6];
          const scene = params[3];
          const shot = params[4];
          const assetId = params[5];
          const matched = catalog.filter((row) => {
            if (scene == null) return true;
            if (row.scene_ordinal !== scene) return row.scene_ordinal > Number(scene);
            if (row.shot_ordinal !== shot) return row.shot_ordinal > Number(shot);
            return String(row.asset_id) > String(assetId);
          });
          const rows = typeof limit === "number" ? matched.slice(0, limit) : matched;
          candidateReads.push({ limit, returned: rows.length, shotChecks: 0 });
          return { rows };
        }
        candidateReads.push({ limit: params[6], returned: 1, shotChecks: 0 });
        return { rows: [listedCandidate()] };
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
        pendingShotChecks += 1;
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
  return {
    client,
    statements,
    candidateReads,
    finishShotChecks() {
      const previous = candidateReads.at(-1);
      if (previous) previous.shotChecks = pendingShotChecks;
      pendingShotChecks = 0;
    },
  };
}

function storeFor(mode: "ok" | "stale" | "review" | "cross-project" | "list" | "page") {
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
    expect(listed.statements.some((statement) => statement.includes("LIMIT $7"))).toBe(true);
    expect(listed.statements.some((statement) => /^(insert|update|delete|truncate)\b/i.test(statement))).toBe(false);
  });

  it("skips ineligible composites and keeps a bounded cursor", async () => {
    const scripted = script("page");
    const pool = { connect: async () => scripted.client as unknown as PoolClient };
    const store = new MediaAssetStore(pool as never);
    const seen: string[] = [];
    let cursor: string | undefined;
    const pages: Array<{ ids: string[]; next: string | null }> = [];
    for (let step = 0; step < 8; step += 1) {
      const before = scripted.candidateReads.length;
      const page = await store.listEpisodeComposeCandidates(workspaceId, projectId, episodeId, cursor, 2);
      scripted.finishShotChecks();
      const reads = scripted.candidateReads.slice(before);
      expect(reads).toHaveLength(1);
      expect(reads[0]).toMatchObject({ limit: 2 });
      expect(reads[0]?.returned).toBeLessThanOrEqual(2);
      expect(reads[0]?.shotChecks).toBeLessThanOrEqual(2);
      for (const assetId of page.items.map((item) => item.assetId)) {
        expect(seen).not.toContain(assetId);
        seen.push(assetId);
      }
      pages.push({ ids: page.items.map((item) => item.assetId), next: page.nextCursor });
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(pages[0]).toEqual({ ids: [], next: expect.any(String) });
    expect(seen).toEqual([
      "44444444-4444-4444-8444-444444444406",
      "44444444-4444-4444-8444-444444444407",
    ]);
    expect(pages.at(-1)?.next).toBeNull();
    expect(scripted.candidateReads.length).toBeLessThan(pageCatalog().length);
    expect(scripted.statements.some((statement) => /^(insert|update|delete|truncate)\b/i.test(statement))).toBe(false);
  });
});
