// Scripted query client. This file does not open PostgreSQL.
// Non-ACTIVE, REJECTED, and bad metadata are asserted with constructed rows in the domain spec.
import { describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { MediaAssetStore } from "./media-assets";
import { PersistenceError } from "./job-service";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const shotRevisionId = "33333333-3333-4333-8333-333333333333";
const sceneRevisionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const videoId = "44444444-4444-4444-8444-444444444444";
const jobId = "66666666-6666-4666-8666-666666666666";
const attemptId = "77777777-7777-4777-8777-777777777777";
const providerConfigurationId = "88888888-8888-4888-8888-888888888888";
const requestId = `mock-media|sync|video.generate|${jobId}:1`;

function script(mode: "ok" | "missing-shot" | "review" | "stale" | "missing-asset") {
  const statements: string[] = [];
  const client = {
    async query(sql: string) {
      statements.push(sql.replace(/\s+/g, " ").trim());
      const text = statements[statements.length - 1] ?? "";
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
      if (/^(insert|update|delete|truncate)\b/i.test(text)) throw new Error(`unexpected write: ${text}`);
      if (text.startsWith("SELECT project_id FROM shot_revision")) {
        return { rows: mode === "missing-shot" ? [] : [{ project_id: projectId }] };
      }
      if (text.includes("FROM project WHERE")) return { rows: [{ id: projectId }] };
      if (text.includes("FROM stale_recalculation")) return { rows: mode === "stale" ? [{ "?column?": 1 }] : [] };
      if (text.includes("AS ok, revision.source_scene_revision_id")) {
        return { rows: [{ ok: mode !== "review", source_scene_revision_id: sceneRevisionId }] };
      }
      if (text.includes("consumer_type = 'scene_revision'")) return { rows: [{ script_revision_id: sceneRevisionId }] };
      if (text.includes("m2_script_source_is_usable")) return { rows: [{ ok: true }] };
      if (text.includes("FROM shot_character_reference")) return { rows: [] };
      if (text.includes("consumer_type = 'shot_revision'")) return { rows: [] };
      if (text.includes("FROM asset")) {
        return {
          rows: mode === "missing-asset" ? [] : [{
            id: videoId,
            workspace_id: workspaceId,
            project_id: projectId,
            kind: "VIDEO",
            storage_provider: "mock-object-store",
            mime_type: "video/mp4",
            byte_size: "1552",
            checksum_sha256: "ab".repeat(32),
            width: 16,
            height: 16,
            duration_ms: "1000",
            status: "ACTIVE",
            review_status: "DRAFT",
            source_job_attempt_id: attemptId,
            source_generation_job_id: jobId,
            source_shot_revision_id: shotRevisionId,
            provider_configuration_id: providerConfigurationId,
            provider_request_id: requestId,
            row_version: 4,
          }],
        };
      }
      if (text.includes("FROM generation_job")) {
        return { rows: [{ id: jobId, workspace_id: workspaceId, project_id: projectId, source_shot_revision_id: shotRevisionId, kind: "MEDIA_VIDEO", state: "SUCCEEDED" }] };
      }
      if (text.includes("FROM job_attempt")) {
        return { rows: [{ id: attemptId, generation_job_id: jobId, attempt_no: 1, provider_request_id: requestId, provider_configuration_id: providerConfigurationId, finished: true }] };
      }
      throw new Error(`unexpected query: ${text}`);
    },
    release() {
      return undefined;
    },
  };
  return { client, statements };
}

function storeFor(mode: "ok" | "missing-shot" | "review" | "stale" | "missing-asset") {
  const scripted = script(mode);
  const pool = { connect: async () => scripted.client as unknown as PoolClient };
  return { store: new MediaAssetStore(pool), statements: scripted.statements };
}

const selection = { videoAssetId: videoId, audioAssetId: null, musicAssetId: null, subtitleAssetId: null };

describe("compose preflight store", () => {
  it("locks the shot and assets, then returns a manifest without writing", async () => {
    const { store, statements } = storeFor("ok");
    const result = await store.preflightCompose(workspaceId, shotRevisionId, selection);
    expect(result.schema).toBe("m4.shot.compose.preflight.v1");
    expect(result.manifest.plan.durationMs).toBe(1000);
    expect(result.guards.assets[0]).toEqual({ role: "video", assetId: videoId, rowVersion: 4 });
    expect(statements[0]).toBe("BEGIN");
    expect(statements.at(-1)).toBe("COMMIT");
    expect(statements.some((sql) => sql.includes("FROM project") && sql.includes("FOR UPDATE"))).toBe(true);
    expect(statements.some((sql) => sql.includes("FROM asset") && sql.includes("FOR UPDATE"))).toBe(true);
    expect(statements.some((sql) => /^(insert|update|delete|truncate)\b/i.test(sql))).toBe(false);
  });

  it("surfaces the existing shot gates and a missing asset", async () => {
    await expect(storeFor("missing-shot").store.preflightCompose(workspaceId, shotRevisionId, selection)).rejects.toMatchObject({
      name: "PersistenceError",
      code: "NOT_FOUND",
    });
    await expect(storeFor("missing-asset").store.preflightCompose(workspaceId, shotRevisionId, selection)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(storeFor("review").store.preflightCompose(workspaceId, shotRevisionId, selection)).rejects.toMatchObject({
      code: "REVIEW_REQUIRED",
    });
    const stale = storeFor("stale");
    await expect(stale.store.preflightCompose(workspaceId, shotRevisionId, selection)).rejects.toBeInstanceOf(PersistenceError);
    await expect(stale.store.preflightCompose(workspaceId, shotRevisionId, selection)).rejects.toMatchObject({
      code: "STALE_RECALCULATION_PENDING",
    });
    expect(stale.statements.some((sql) => sql.includes("FROM asset"))).toBe(false);
    expect(stale.statements.at(-1)).toBe("ROLLBACK");
  });
});
