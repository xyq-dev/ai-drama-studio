import type { PoolClient, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import { MediaAssetStore } from "./media-assets";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const episodeId = "33333333-3333-4333-8333-333333333333";
const olderId = "44444444-4444-4444-8444-444444444441";
const newerSameId = "44444444-4444-4444-8444-444444444449";
const microId = "55555555-5555-4555-8555-555555555555";
const sameInstant = "2020-01-01T00:00:00.100001Z";
const nextMicrosecond = "2020-01-01T00:00:00.100002Z";

function row(assetId: string, createdAt: string): QueryResultRow {
  return {
    asset_id: assetId,
    status: "ACTIVE",
    review_status: "DRAFT",
    row_version: 1,
    checksum_sha256: "ab".repeat(32),
    width: 1080,
    height: 1920,
    duration_ms: 2000,
    source_generation_job_id: null,
    created_at: new Date("2020-01-01T00:00:00.100Z"),
    created_at_text: createdAt,
    metadata_json: { schema: "m4.episode.compose.asset.v1", manifest: { episodeId, segments: [] } },
  };
}

function store() {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    async query(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (sql.includes("FROM episode")) return { rows: [{ id: episodeId }] };
      if (!sql.includes("created_at_text")) throw new Error(sql);
      const createdAt = params[4];
      const assetId = params[5];
      const limit = params[6];
      const catalog = [row(microId, nextMicrosecond), row(newerSameId, sameInstant), row(olderId, sameInstant)];
      const start = createdAt == null ? 0 : catalog.findIndex((item) => item.created_at_text === createdAt && item.asset_id === assetId) + 1;
      return { rows: catalog.slice(start, start + Number(limit)) };
    },
    release() { return undefined; },
  };
  return {
    queries,
    assets: new MediaAssetStore({ connect: async () => client as unknown as PoolClient } as never),
  };
}

describe("episode composite cursor", () => {
  it("pages newest first with the exact database timestamp text", async () => {
    const { assets, queries } = store();
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let step = 0; step < 5; step += 1) {
      const page = await assets.listEpisodeComposites(workspaceId, projectId, episodeId, cursor, 1);
      expect(page.items.length).toBeLessThanOrEqual(1);
      for (const item of page.items) {
        expect(seen).not.toContain(item.assetId);
        expect(item.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
        seen.push(item.assetId);
      }
      if (!page.nextCursor) break;
      const decoded = JSON.parse(Buffer.from(page.nextCursor, "base64url").toString("utf8")) as { createdAt: string; assetId: string };
      expect(decoded.createdAt).toBe(page.items[0]?.createdAt);
      expect(decoded.createdAt).not.toBe(new Date(decoded.createdAt).toISOString());
      cursor = page.nextCursor;
    }
    expect(seen).toEqual([microId, newerSameId, olderId]);
    const listSql = queries.map((query) => query.sql).filter((sql) => sql.includes("created_at_text"));
    expect(listSql[0]).toContain("to_char(asset.created_at AT TIME ZONE 'UTC'");
    expect(listSql[0]).toContain("ORDER BY asset.created_at DESC, asset.id DESC");
    expect(listSql[0]).toContain("(asset.created_at, asset.id) < ($5::timestamptz, $6::uuid)");
    expect(queries.filter((query) => query.sql.includes("created_at_text"))[1]?.params[4]).toBe(nextMicrosecond);
    expect(queries.filter((query) => query.sql.includes("created_at_text"))[2]?.params[4]).toBe(sameInstant);
  });
});
