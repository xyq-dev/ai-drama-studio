import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { AUTO_CREATION_EPISODE_SCHEMA, type AutoBible, type AutoEpisode, type ScriptWorkbenchPlan } from "@ai-drama/contracts";
import { formatAutoEpisode } from "@ai-drama/domain";
import { describe, expect, it } from "vitest";
import { PostgresAutoCreationStore } from "./auto-creation-store";
import { ScriptWorkbenchStore } from "./script-workbench";
import { ScriptWorkbenchTrashStore } from "./script-workbench-trash";
import { ShortSequelStore } from "./short-sequel";
import { TextChainService } from "./text-chain";

const scriptPackageHash = "a".repeat(64);
const firstEpisode: AutoEpisode = { schema: AUTO_CREATION_EPISODE_SCHEMA, episodeNo: 1, title: "失落的星图", scenes: [],
  handoffFacts: ["林澈锁上钟室的门"] };
const bible = { logline: "修钟师找回星图", story: { ending: "星图回到钟室" },
  characters: [{ id: "C1", name: "林澈", identity: "修钟师", voice: "平静", motivation: "想保护星图" }],
  locations: [{ name: "钟室", layout: "圆形窗户", productionNotes: "固定机位" }] } as unknown as AutoBible;
const originalOutline = { episodeNo: 1, title: firstEpisode.title, opening: "钟摆停住", turn: "发现星图", handoff: firstEpisode.handoffFacts[0] };
const nextOutline = { episodeNo: 2, title: "北窗", openingHook: "窗外出现星光", change: "找到了刻度", endingHandoff: "决定去找观星客" };
const plan = (): ScriptWorkbenchPlan => ({
  brief: { genre: "悬疑", audience: "短剧爱好者", productionConstraints: "钟室 · 圆形窗户 · 固定机位", logline: bible.logline,
    targetEpisodeSeconds: 60, dialogueQuota: 12 },
  bible: { ending: bible.story.ending, openThreads: "", characters: [{ id: "C1", name: "林澈", appearance: "修钟师", voice: "平静",
    aliases: "", knownInformation: "想保护星图" }] },
  outline: { episodes: [
    { episodeNo: 1, title: originalOutline.title, openingHook: originalOutline.opening, change: originalOutline.turn, endingHandoff: originalOutline.handoff! },
    { ...nextOutline },
  ] },
});

export function registerShortSequelLineageAcceptance(pool: Pool) {
  const chain = new TextChainService(pool);
  const workbench = new ScriptWorkbenchStore(pool);
  const sequel = new ShortSequelStore(pool);
  const auto = new PostgresAutoCreationStore(pool, chain);
  const trash = new ScriptWorkbenchTrashStore(pool);

  async function tx<T>(fn: (client: PoolClient) => Promise<T>) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function seedOriginal() {
    const workspaceId = (await pool.query<{ id: string }>("INSERT INTO workspace(name) VALUES('星图验收') RETURNING id")).rows[0]!.id;
    const projectId = (await pool.query<{ id: string }>(`INSERT INTO project(workspace_id,title,episode_count,target_episode_seconds)
      VALUES($1,'修钟师与星图',1,60) RETURNING id`, [workspaceId])).rows[0]!.id;
    const scope = { workspaceId, projectId };
    const story = await chain.createStoryRevision({ ...scope, expectedVersion: 1, content: { text: "修钟师找回星图" }, createdBy: "qa" });
    const submittedStory = await chain.transitionReview({ table: "story_revision", workspaceId, revisionId: story.revisionId,
      expectedVersion: story.rowVersion, expectedReviewVersion: 1, to: "IN_REVIEW" });
    await chain.approveStory({ ...scope, revisionId: story.revisionId, expectedVersion: submittedStory.rowVersion,
      expectedReviewVersion: submittedStory.reviewVersion, reviewedBy: "qa" });
    const runId = randomUUID();
    await pool.query(`INSERT INTO auto_creation_run (id,workspace_id,project_id,actor_id,idempotency_key,input_hash,input_json,provider_key,model,
        state,call_cap,quality,story_save,story_revision_id,created_at,updated_at)
      VALUES($1,$2,$3,'qa','original',$4,$5,'openai','synthetic','completed',1,'passed','saved',$6,now(),now())`,
    [runId, workspaceId, projectId, scriptPackageHash, JSON.stringify({ episodeCount: 1, episodeSeconds: 60,
      constraints: { genre: "悬疑", audience: "短剧爱好者" }, providerKey: "openai", model: "synthetic" }), story.revisionId]);
    const stages = [["bible", bible], ["outline", { episodes: [originalOutline] }], ["episode:1", firstEpisode], ["review:1", {}]] as const;
    for (const [ordinal, [key, output]] of stages.entries()) {
      await pool.query(`INSERT INTO auto_creation_stage (run_id,workspace_id,stage_key,ordinal,state,output_json,output_hash,script_save,updated_at)
        VALUES($1,$2,$3,$4,'completed',$5,$6,$7,now())`,
      [runId, workspaceId, key, ordinal, JSON.stringify(output), scriptPackageHash, key === "episode:1" ? "pending" : null]);
    }
    const text = formatAutoEpisode(firstEpisode, bible);
    expect(await auto.placeScripts(workspaceId, projectId, runId, [{ episodeNo: 1, stageKey: "episode:1", text }],
      { acceptStoryChanged: false }, "qa", new Date().toISOString())).toMatchObject({ kind: "ok" });
    const first = (await workbench.snapshot(workspaceId, projectId)).episodes[0]!;
    const scriptRevisionId = first.script!.id;
    const submittedScript = await chain.transitionReview({ table: "script_revision", workspaceId, revisionId: scriptRevisionId,
      expectedVersion: first.rowVersion, expectedReviewVersion: 1, to: "IN_REVIEW" });
    const approvedScript = await tx(client => chain.approveScriptInTransaction(client, { workspaceId, episodeId: first.id,
      revisionId: scriptRevisionId, expectedVersion: submittedScript.rowVersion, expectedReviewVersion: submittedScript.reviewVersion, reviewedBy: "qa" }));
    return { ...scope, firstEpisodeId: first.id, originalStoryRevisionId: story.revisionId, runId, scriptRevisionId, scriptVersion: approvedScript.rowVersion };
  }

  async function savePlan(scope: { workspaceId: string; projectId: string }, value: ScriptWorkbenchPlan, continuationEpisodeNo?: number) {
    const { version: expectedVersion } = (await workbench.snapshot(scope.workspaceId, scope.projectId)).project;
    return tx(client => workbench.savePlan(client, { ...scope, plan: value, expectedVersion, actorId: "qa", traceId: "qa", continuationEpisodeNo }));
  }

  async function approvePlan(scope: { workspaceId: string; projectId: string }, revision: { revisionId: string; rowVersion: number }) {
    const submitted = await chain.transitionReview({ table: "story_revision", workspaceId: scope.workspaceId, revisionId: revision.revisionId,
      expectedVersion: revision.rowVersion, expectedReviewVersion: 1, to: "IN_REVIEW" });
    await chain.approveStory({ ...scope, revisionId: revision.revisionId, expectedVersion: submitted.rowVersion,
      expectedReviewVersion: submitted.reviewVersion, reviewedBy: "qa" });
  }

  describe("short sequel plan and script lineage", () => {
    it("keeps locked script and storyboard current during outline-only extension, then stales their source chain upon confirming changed settings", async () => {
      const scope = await seedOriginal();
      const { workspaceId, projectId, firstEpisodeId: episodeId, scriptRevisionId } = scope;
      const scene = await tx(client => chain.createSceneRevisionInTransaction(client, { workspaceId, projectId, episodeId,
        sourceScriptRevisionId: scriptRevisionId, ordinal: 1, heading: "钟室", timeOfDay: "夜", summary: "修钟师研读星图",
        createdBy: "qa", expectedVersion: scope.scriptVersion }));
      const submitted = await tx(client => chain.reviewSceneShotInTransaction(client, { kind: "scene", workspaceId, projectId, episodeId,
        sceneId: scene.entityId, revisionId: scene.revisionId, expectedVersion: scene.rowVersion, expectedReviewVersion: 1, to: "IN_REVIEW", reviewedBy: "qa" }));
      const confirmed = await tx(client => chain.reviewSceneShotInTransaction(client, { kind: "scene", workspaceId, projectId, episodeId,
        sceneId: scene.entityId, revisionId: scene.revisionId, expectedVersion: submitted.rowVersion, expectedReviewVersion: submitted.reviewVersion,
        to: "APPROVED", reviewedBy: "qa" }));
      const shot = await tx(client => chain.createShotScopedInTransaction(client, { workspaceId, projectId, sceneId: scene.entityId,
        sourceSceneRevisionId: scene.revisionId, ordinal: 1, shotType: "中景", camera: "固定", action: "修钟师摊开图纸",
        dialogue: "", promptText: "虚构钟室", createdBy: "qa", expectedVersion: confirmed.rowVersion }));
      const createSource = async (kind: "character" | "location", name: string) => {
        const { version: expectedVersion } = (await workbench.snapshot(workspaceId, projectId)).project;
        return tx(client => chain.createTextEntityRevisionInTransaction(client, { workspaceId, projectId, kind, name,
          sourceScriptRevisionId: scriptRevisionId, content: { name }, createdBy: "qa", expectedVersion }));
      };
      const character = await createSource("character", "林澈");
      const location = await createSource("location", "钟室");
      const freshness = async () => (await pool.query<{ freshness_status: string }>(`
        SELECT freshness_status FROM script_revision WHERE id=$1
        UNION ALL SELECT freshness_status FROM scene_revision WHERE id=$2
        UNION ALL SELECT freshness_status FROM shot_revision WHERE id=$3
        UNION ALL SELECT freshness_status FROM character_revision WHERE id=$4
        UNION ALL SELECT freshness_status FROM location_revision WHERE id=$5`, [scriptRevisionId, scene.revisionId, shot.revisionId,
        character.revisionId, location.revisionId])).rows.map(row => row.freshness_status);

      await sequel.confirm(workspaceId, projectId, 2, "qa");
      await approvePlan(scope, await savePlan(scope, plan()));
      expect(await freshness()).toEqual(Array(5).fill("CURRENT"));

      const changed = plan();
      changed.bible.characters[0]!.appearance = "戴面具的修钟师";
      changed.brief.productionConstraints = "屋顶 · 俯拍";
      const next = await savePlan(scope, changed);
      expect(await freshness()).toEqual(Array(5).fill("CURRENT"));
      await approvePlan(scope, next);
      expect(await freshness()).toEqual(Array(5).fill("STALE"));
      expect((await chain.listScriptRevisions(workspaceId, projectId, episodeId)).items[0]?.content).toEqual({ text: formatAutoEpisode(firstEpisode, bible) });
    });

    it("rejects rewriting inherited settings and completed earlier outline slots from sequel outline editing", async () => {
      const scope = await seedOriginal();
      await sequel.confirm(scope.workspaceId, scope.projectId, 2, "qa");
      const changedBible = plan();
      changedBible.bible.characters[0]!.appearance = "伪造身份";
      await expect(savePlan(scope, changedBible, 2)).rejects.toMatchObject({ code: "SOURCE_STALE" });
      const changedOutline = plan();
      changedOutline.outline.episodes[0]!.endingHandoff = "林澈离开钟室";
      await expect(savePlan(scope, changedOutline, 2)).rejects.toMatchObject({ code: "SOURCE_STALE" });
      await expect(savePlan(scope, plan(), 2)).resolves.toMatchObject({ revisionNo: 2 });
    });

    it("keeps a placed original episode revision in place when a later script references its package hash", async () => {
      const scope = await seedOriginal();
      const { workspaceId, projectId, firstEpisodeId, scriptRevisionId, runId } = scope;
      const second = await sequel.confirm(workspaceId, projectId, 2, "qa");
      const sequelStory = await savePlan(scope, plan());
      await approvePlan(scope, sequelStory);
      const laterScript = (await pool.query<{ id: string }>(`INSERT INTO script_revision(workspace_id,project_id,episode_id,revision_no,source_story_revision_id,
          content_json,content_hash,created_by) VALUES($1,$2,$3,1,$4,$5,$6,'qa') RETURNING id`, [workspaceId, projectId, second.episodeId,
        sequelStory.revisionId, JSON.stringify({ workbench: { continuation: { previousRevisionId: null, originalRunId: runId, originalEpisodeHash: scriptPackageHash } } }),
        scriptPackageHash])).rows[0]!.id;
      const preview = await trash.previewRevision(workspaceId, projectId, firstEpisodeId, scriptRevisionId);
      expect(preview).toMatchObject({ canDelete: false, dependencies: { other: 1, total: 1 }, references: [{ id: laterScript, kind: "other" }] });
      await expect(trash.trashRevision(workspaceId, projectId, firstEpisodeId, scriptRevisionId, { expectedVersion: preview.version }))
        .rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    });
  });
}
