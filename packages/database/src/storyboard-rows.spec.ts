import { describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "./job-service";
import { TextChainService } from "./text-chain";

const scope = ["workspace", "project", "episode", "scene"] as const;
const sample = { id: "shot", row_version: 2, current_revision_id: "revision", approved_revision_id: "revision",
  review_version: 1, review_status: "APPROVED", freshness_status: "CURRENT", cursor_sort: "0:1" };

function fake(options: { portraits?: boolean; selections?: boolean; outOfScope?: boolean } = {}) {
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes("to_regclass")) return { rows: [{ portraits: options.portraits, selections: options.selections }] };
    if (sql.startsWith("SELECT 1 FROM scene") || sql.startsWith("SELECT id FROM project")) return { rows: [{ id: "parent" }] };
    if (sql.includes("SELECT 1 FROM shot")) return { rows: options.outOfScope ? [] : [{ id: "shot" }] };
    if (sql.includes("UPDATE shot SET archived_at")) return { rows: [{ current_revision_id: null }] };
    if (sql.includes("WITH shot_page AS")) return { rows: [{ ...sample, storyboard: { ordinal: 1, candidates: [], selectedAssetId: null } }] };
    if (sql.includes("LEFT JOIN shot_revision") && values) return { rows: [sample] };
    return { rows: [] };
  });
  const client = { query, release: vi.fn() };
  const pool = { connect: async () => client } as unknown as DatabasePool;
  return { chain: new TextChainService(pool), client, query };
}

describe("storyboard collection view", () => {
  it("keeps the existing listing lightweight and gates optional draft joins", async () => {
    const { chain, query } = fake();
    const plain = await chain.listShots(...scope);
    expect(plain.items[0]).not.toHaveProperty("storyboard");
    expect(query.mock.calls.some(([sql]) => sql.includes("to_regclass"))).toBe(false);
    const rich = await chain.listShots(...scope, undefined, 20, true);
    expect(rich.items[0]?.storyboard).toMatchObject({ ordinal: 1, candidates: [], selectedAssetId: null });
    const [sql, params] = query.mock.calls.find(([text]) => text.includes("WITH shot_page AS"))!;
    expect(sql).not.toMatch(/JOIN character_reference_selection|FROM comfyui_shot_image_selection/);
    expect(sql).toContain("asset.source_shot_revision_id = revision.id");
    expect(params).toEqual([...scope.slice(0, 3), 21, scope[3]]);
  });

  it("uses selected references and candidate scope only when optional tables are present", async () => {
    const { chain, query } = fake({ portraits: true, selections: true });
    await chain.listShots(...scope, undefined, 20, true);
    const [sql] = query.mock.calls.find(([text]) => text.includes("WITH shot_page AS"))!;
    expect(sql).toContain("JOIN character_reference_selection portrait");
    expect(sql).toContain("chosen.project_id = $2 AND chosen.shot_revision_id = revision.id");
    expect(sql).toContain("selected.status = 'ACTIVE' AND selected.review_status <> 'REJECTED'");
    expect(sql).not.toMatch(/object_key|metadata_json/);
  });

  it("archives only in the named workspace/project/episode/scene and uses the expected version", async () => {
    const { chain, client, query } = fake();
    const input = { workspaceId: scope[0], projectId: scope[1], episodeId: scope[2], sceneId: scope[3],
      shotId: "shot", rowVersion: 7, traceId: "trace" };
    const txClient = client as unknown as Parameters<TextChainService["archiveShotInTransaction"]>[0];
    await expect(chain.archiveShotInTransaction(txClient, input)).resolves.toEqual({ shotId: "shot", archived: true });
    expect(query.mock.calls.find(([text]) => text.includes("SELECT 1 FROM shot"))?.[1]).toEqual(["shot", ...scope]);
    expect(query.mock.calls.find(([text]) => text.includes("UPDATE shot SET archived_at"))?.[1]).toEqual(["shot", ...scope.slice(0, 3), 7]);
    const refused = fake({ outOfScope: true });
    await expect(refused.chain.archiveShotInTransaction(refused.client as unknown as typeof txClient, input)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(refused.query.mock.calls.some(([text]) => text.includes("UPDATE shot SET archived_at"))).toBe(false);
  });
});
