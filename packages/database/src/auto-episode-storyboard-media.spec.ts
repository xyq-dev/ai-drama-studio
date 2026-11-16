import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { adoptAutoStoryboardImage, autoStoryboardMediaReadiness, readAutoStoryboardShots } from "./auto-episode-storyboard-media";

const scope = { workspaceId: "w", projectId: "p", runId: "run" };
const shot = { shotId: "shot", shotRevisionId: "current", caption: "一号镜头" };
const asClient = (query: ReturnType<typeof vi.fn>) => ({ query }) as unknown as PoolClient;

describe("automatic episode storyboard images", () => {
  it("retains a usable preview and kept image even when a later job is unresolved", async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes("DISTINCT ON (revision.shot_id)")
      ? [{ shot_id: "shot", id: "latest-job", quote_id: "latest-quote", state: "WAITING_EXTERNAL", receipt_state: "UNKNOWN" }]
      : sql.includes("DISTINCT ON (asset.source_shot_revision_id)") ? [{ source_shot_revision_id: "current", id: "existing-preview" }]
        : [{ shot_revision_id: "current", asset_id: "existing-kept" }] }));
    const result = await readAutoStoryboardShots(asClient(query), scope, [shot], true, true);
    expect(result).toEqual([{ ...shot, state: "unknown", jobId: "latest-job", quoteId: "latest-quote", previewAssetId: "existing-preview", keptAssetId: "existing-kept" }]);
    for (const [sql] of query.mock.calls) expect(sql).toContain("job.input_snapshot#>>'{autoStoryboard,runId}'=$3");
    expect(query.mock.calls[0]?.[0]).toContain("revision.shot_id=ANY($5::uuid[])");
    expect(query.mock.calls[1]?.[0]).toContain("asset.status='ACTIVE'");
    expect(query.mock.calls[1]?.[0]).toContain("job.state='SUCCEEDED'");
  });

  it("treats selection table capability separately from character references and leaves absence read-only", async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [{ selection: false, characters: true }] }));
    const client = asClient(query);
    expect(await autoStoryboardMediaReadiness(client)).toEqual({ selectionAvailable: false, characterReferencesAvailable: true });
    await expect(adoptAutoStoryboardImage(client, scope, "current", { assetId: "asset", expectedSelectedAssetId: null, actorId: "actor" }))
      .rejects.toMatchObject({ code: "AUTO_STORYBOARD_SELECTION_UNAVAILABLE" });
    expect(query.mock.calls.every(([sql]) => sql.includes("to_regclass"))).toBe(true);
  });

  it("does not overwrite a ComfyUI selection and writes only a same-run current OpenAI candidate", async () => {
    let previous: { asset_id: string; run_id: string | null; usable: boolean } | null = { asset_id: "comfyui-image", run_id: null, usable: true };
    const query = vi.fn(async (sql: string, _values?: unknown[]) => ({ rows: sql.includes("to_regclass") ? [{ selection: true }]
      : sql.includes("FOR UPDATE OF chosen") ? previous ? [previous] : []
        : sql.includes("SELECT asset.checksum_sha256") ? [{ checksum_sha256: "a".repeat(64) }] : [] }));
    const client = asClient(query);
    const input = { assetId: "new-image", expectedSelectedAssetId: null, actorId: "actor" };
    await expect(adoptAutoStoryboardImage(client, scope, "current", input)).rejects.toMatchObject({ code: "REFERENCE_SELECTION_CONFLICT" });
    expect(query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(false);
    previous = null;
    await expect(adoptAutoStoryboardImage(client, scope, "current", input)).resolves.toEqual({ selectedAssetId: "new-image" });
    const candidate = query.mock.calls.find(([sql]) => sql.includes("SELECT asset.checksum_sha256"));
    expect(candidate?.[0]).toContain("job.input_snapshot#>>'{configuration,providerKey}'='openai-media'");
    expect(candidate?.[1]).toEqual(["w", "p", "run", "current", "new-image"]);
    expect(query.mock.calls.find(([sql]) => sql.startsWith("INSERT"))?.[1]).toEqual(["w", "p", "current", "new-image", "a".repeat(64), "actor"]);
  });
});
