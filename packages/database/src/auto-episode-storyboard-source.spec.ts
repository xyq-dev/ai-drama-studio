import { describe, expect, it, vi } from "vitest";
import { readAutoEpisodeStoryboardSources, requireAutoEpisodeStoryboardShot } from "./auto-episode-storyboard-source";

type QueryClient = Parameters<typeof readAutoEpisodeStoryboardSources>[0];

const scope = {
  workspaceId: "10000000-0000-4000-8000-000000000001",
  projectId: "10000000-0000-4000-8000-000000000002",
  runId: "10000000-0000-4000-8000-000000000003",
};
const episodeId = "10000000-0000-4000-8000-000000000004";
const shotId = "10000000-0000-4000-8000-000000000005";
const shotRevisionId = "10000000-0000-4000-8000-000000000006";
const otherShotRevisionId = "10000000-0000-4000-8000-000000000007";
const sceneId = "10000000-0000-4000-8000-000000000008";
const otherSceneId = "10000000-0000-4000-8000-000000000009";
const otherEpisodeId = "10000000-0000-4000-8000-000000000010";
const otherShotId = "10000000-0000-4000-8000-000000000011";

const eligible = {
  episode_no: 1, episode_id: episodeId, package_complete: true, story_saved: true, story_approved: true,
  script_placed: true, script_approved: true, scene_id: sceneId, scene_ready: true, scene_source_stale: false,
  shot_id: shotId, shot_revision_id: shotRevisionId,
  shot_usable: true, action: "\n 林青推开门。 ", actor_names: ["林青"], location_name: "车站",
};

type MockSourceRow = Omit<typeof eligible, "shot_id" | "shot_revision_id"> & {
  shot_id: string | null;
  shot_revision_id: string | null;
};

function fakeClient(rows: MockSourceRow[], projectExists = true) {
  const query = vi.fn(async (sql: string, values: unknown[]) => {
    if (sql.includes("FOR UPDATE")) {
      expect(values).toEqual([scope.workspaceId, scope.projectId]);
      return { rows: projectExists ? [{ id: scope.projectId }] : [] };
    }
    expect(values.slice(0, 3)).toEqual([scope.workspaceId, scope.projectId, scope.runId]);
    expect(sql).toContain("script_revision_replacement");
    expect(sql).toMatch(/replacement\.previous_script_revision_id\s*=\s*lineage\.revision_id/);
    expect(sql).toMatch(/placed\.episode_id\s*=\s*episode\.id/);
    expect(sql).toMatch(/current_script\.source_story_revision_id\s*=\s*scoped\.approved_story_revision_id/);
    expect(sql).toMatch(/scene_revision\.source_script_revision_id\s*=\s*episode\.current_script_revision_id/);
    expect(sql).toMatch(/scene\.archived_at IS NULL/);
    expect(sql).toMatch(/shot\.archived_at IS NULL/);
    const target = values[3];
    const targetEpisode = rows.find((row) => row.shot_revision_id === target)?.episode_id;
    return { rows: targetEpisode ? rows.filter((row) => row.episode_id === targetEpisode) : rows };
  });
  return { query: query as unknown as QueryClient["query"], querySpy: query };
}

describe("automatic writing storyboard sources", () => {
  it("exposes an eligible current shot with a bounded caption derived from the saved shot", async () => {
    const client = fakeClient([eligible]);
    expect(await readAutoEpisodeStoryboardSources(client, scope)).toEqual([{
      episodeNo: 1, episodeId, blocked: null, shots: [{ shotId, shotRevisionId, caption: "车站 · 林青 · 林青推开门。" }],
    }]);
    expect(client.querySpy).toHaveBeenCalledTimes(1);
    const [longCaption] = await readAutoEpisodeStoryboardSources(fakeClient([{ ...eligible, action: "字".repeat(1000) }]), scope);
    expect(longCaption?.shots[0]?.caption.length).toBeLessThanOrEqual(220);
  });

  it.each([
    ["writing_not_finished", { package_complete: false }],
    ["story_not_saved", { story_saved: false }],
    ["story_review_required", { story_approved: false }],
    ["script_not_placed", { script_placed: false }],
    ["script_review_required", { script_approved: false }],
    ["shots_not_ready", { shot_id: null, shot_revision_id: null }],
    ["shot_source_stale", { shot_usable: false }],
  ] as const)("returns %s without exposing blocked shot sources", async (blocked, row) => {
    const client = fakeClient([{ ...eligible, ...row }]);
    expect(await readAutoEpisodeStoryboardSources(client, scope)).toEqual([{ episodeNo: 1, episodeId, blocked, shots: [] }]);
    await expect(requireAutoEpisodeStoryboardShot(client, scope, shotRevisionId)).rejects.toMatchObject({
      code: "AUTO_STORYBOARD_SOURCE_NOT_READY",
    });
  });

  it("blocks the whole episode when an active scene contains an invalid current shot", async () => {
    const client = fakeClient([eligible, { ...eligible, shot_revision_id: otherShotRevisionId, shot_usable: false }]);
    expect(await readAutoEpisodeStoryboardSources(client, scope)).toEqual([{ episodeNo: 1, episodeId, blocked: "shot_source_stale", shots: [] }]);
    await expect(requireAutoEpisodeStoryboardShot(client, scope, shotRevisionId)).rejects.toMatchObject({ code: "AUTO_STORYBOARD_SOURCE_NOT_READY" });
  });

  it.each([true, false])("blocks a partially boarded episode if the next active scene has no shots (approved=%s)", async (sceneReady) => {
    const client = fakeClient([eligible, { ...eligible, scene_id: otherSceneId, scene_ready: sceneReady,
      shot_id: null, shot_revision_id: null }]);
    expect(await readAutoEpisodeStoryboardSources(client, scope)).toEqual([{ episodeNo: 1, episodeId, blocked: "shots_not_ready", shots: [] }]);
    await expect(requireAutoEpisodeStoryboardShot(client, scope, shotRevisionId)).rejects.toMatchObject({ code: "AUTO_STORYBOARD_SOURCE_NOT_READY" });
  });

  it("reports an active old-script scene as stale even without a current shot", async () => {
    const client = fakeClient([eligible, { ...eligible, scene_id: otherSceneId, scene_source_stale: true,
      shot_id: null, shot_revision_id: null }]);
    expect(await readAutoEpisodeStoryboardSources(client, scope)).toEqual([{ episodeNo: 1, episodeId, blocked: "shot_source_stale", shots: [] }]);
  });

  it("keeps a complete episode available when another is blocked", async () => {
    const client = fakeClient([{ ...eligible, shot_usable: false }, { ...eligible, episode_no: 2, episode_id: otherEpisodeId,
      scene_id: otherSceneId, shot_id: otherShotId, shot_revision_id: otherShotRevisionId }]);
    const episodes = await readAutoEpisodeStoryboardSources(client, scope);
    expect(episodes.map(({ episodeNo, blocked }) => ({ episodeNo, blocked }))).toEqual([
      { episodeNo: 1, blocked: "shot_source_stale" }, { episodeNo: 2, blocked: null },
    ]);
    await expect(requireAutoEpisodeStoryboardShot(client, scope, otherShotRevisionId)).resolves.toMatchObject({ episodeNo: 2, episodeId: otherEpisodeId });
  });

  it("returns all usable shots across active scenes", async () => {
    const client = fakeClient([eligible, { ...eligible, scene_id: otherSceneId, shot_id: otherShotId, shot_revision_id: otherShotRevisionId }]);
    const [episode] = await readAutoEpisodeStoryboardSources(client, scope);
    expect(episode?.blocked).toBeNull();
    expect(episode?.shots.map((shot) => shot.shotRevisionId)).toEqual([shotRevisionId, otherShotRevisionId]);
    await expect(requireAutoEpisodeStoryboardShot(client, scope, shotRevisionId)).resolves.toMatchObject({ shotRevisionId });
  });

  it("locks a project before checking a target and rejects a shot outside the run", async () => {
    const client = fakeClient([eligible]);
    await expect(requireAutoEpisodeStoryboardShot(client, scope, shotRevisionId)).resolves.toMatchObject({ episodeNo: 1, episodeId, shotId, shotRevisionId });
    expect(client.querySpy.mock.calls[0]?.[0]).toContain("FOR UPDATE");
    expect(client.querySpy.mock.calls[1]?.[1]).toEqual([scope.workspaceId, scope.projectId, scope.runId, shotRevisionId]);
    await expect(requireAutoEpisodeStoryboardShot(client, scope, otherShotRevisionId)).rejects.toMatchObject({ code: "AUTO_STORYBOARD_SOURCE_NOT_READY" });
  });

  it("treats a missing or foreign run and an unavailable project as not found", async () => {
    await expect(readAutoEpisodeStoryboardSources(fakeClient([]), scope)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(requireAutoEpisodeStoryboardShot(fakeClient([]), scope, shotRevisionId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(requireAutoEpisodeStoryboardShot(fakeClient([eligible], false), scope, shotRevisionId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
