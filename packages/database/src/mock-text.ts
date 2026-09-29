import { assertProductionEpisodeSet } from "@ai-drama/domain";
import { sceneBatchOutputSchema, shotBatchOutputSchema, type SceneBatchOutput,
  type ShotBatchOutput, type TextGenerationRequest } from "@ai-drama/contracts";
import type { PoolClient, QueryResultRow } from "pg";
import { PersistenceError, type DatabasePool } from "./job-service";
import { TextChainService } from "./text-chain";

export interface MockSceneSource {
  episodeId: string;
  episodeNo: number;
  episodeVersion: number;
  scriptRevisionId: string;
}

export interface MockSceneSnapshot {
  schema: "m2.mock.scenes.v1";
  projectId: string;
  requestedBy: string;
  outcome: "success";
  episodes: MockSceneSource[];
}

export interface MockShotSource {
  episodeId: string;
  episodeNo: number;
  sceneId: string;
  sceneVersion: number;
  sceneRevisionId: string;
}

export interface MockShotSnapshot {
  schema: "m2.mock.shots.v1";
  projectId: string;
  requestedBy: string;
  outcome: "success";
  scenes: MockShotSource[];
}

export class MockTextService {
  private readonly chain: TextChainService;

  constructor(private readonly pool: DatabasePool) {
    this.chain = new TextChainService(pool);
  }

  async loadSources(workspaceId: string, projectId: string): Promise<MockSceneSource[]> {
    const client = await this.pool.connect();
    try {
      return await this.currentSources(client, workspaceId, projectId);
    } finally {
      client.release();
    }
  }

  async buildGenerationRequest(workspaceId: string,
    snapshot: MockSceneSnapshot | MockShotSnapshot): Promise<TextGenerationRequest> {
    if (!snapshot || typeof snapshot !== "object" || snapshot.outcome !== "success" ||
        typeof snapshot.projectId !== "string") {
      throw new PersistenceError("VALIDATION_ERROR", "Invalid frozen text snapshot");
    }
    if (snapshot.schema === "m2.mock.scenes.v1" &&
        (!Array.isArray(snapshot.episodes) || snapshot.episodes.length !== 3)) {
      throw new PersistenceError("VALIDATION_ERROR", "Invalid frozen Scene snapshot");
    }
    if (snapshot.schema === "m2.mock.shots.v1" &&
        (!Array.isArray(snapshot.scenes) || snapshot.scenes.length !== 3)) {
      throw new PersistenceError("VALIDATION_ERROR", "Invalid frozen Shot snapshot");
    }
    if (snapshot.schema !== "m2.mock.scenes.v1" && snapshot.schema !== "m2.mock.shots.v1") {
      throw new PersistenceError("VALIDATION_ERROR", "Unsupported frozen text snapshot schema");
    }
    const client = await this.pool.connect();
    try {
      if (snapshot.schema === "m2.mock.scenes.v1") {
        const rows = await client.query<{ id: string; content_json: unknown } & QueryResultRow>(
          `SELECT id, content_json FROM script_revision
            WHERE workspace_id = $1 AND project_id = $2 AND id = ANY($3::uuid[])`,
          [workspaceId, snapshot.projectId, snapshot.episodes.map((source) => source.scriptRevisionId)],
        );
        if (rows.rows.length !== snapshot.episodes.length) {
          throw new PersistenceError("REVISION_CONFLICT", "Frozen Script sources are unavailable");
        }
        return { schema: "m2.text.request.v1", kind: "SCENES", projectId: snapshot.projectId,
          sources: snapshot.episodes.map((source) => ({ ...source,
            scriptContent: rows.rows.find((row) => row.id === source.scriptRevisionId)!.content_json })) };
      }
      const rows = await client.query<{
        id: string; heading: string; time_of_day: string | null; summary: string;
      } & QueryResultRow>(
        `SELECT id, heading, time_of_day, summary FROM scene_revision
          WHERE workspace_id = $1 AND project_id = $2 AND id = ANY($3::uuid[])`,
        [workspaceId, snapshot.projectId, snapshot.scenes.map((source) => source.sceneRevisionId)],
      );
      if (rows.rows.length !== snapshot.scenes.length) {
        throw new PersistenceError("REVISION_CONFLICT", "Frozen Scene sources are unavailable");
      }
      return { schema: "m2.text.request.v1", kind: "SHOTS", projectId: snapshot.projectId,
        sources: snapshot.scenes.map((source) => {
          const row = rows.rows.find((item) => item.id === source.sceneRevisionId)!;
          return { ...source, sceneContent: { heading: row.heading,
            timeOfDay: row.time_of_day, summary: row.summary } };
        }) };
    } finally {
      client.release();
    }
  }

  async currentSources(client: PoolClient, workspaceId: string, projectId: string): Promise<MockSceneSource[]> {
    const project = await client.query(
      "SELECT 1 FROM project WHERE id = $1 AND workspace_id = $2 FOR UPDATE",
      [projectId, workspaceId],
    );
    if (!project.rows[0]) throw new PersistenceError("NOT_FOUND", "Project not found");
    const rows = await client.query<{
      id: string; episode_no: number; row_version: number;
      current_script_revision_id: string | null; approved_script_revision_id: string | null;
      review_status: string | null; freshness_status: string | null;
    } & QueryResultRow>(
      `SELECT e.id, e.episode_no, e.row_version, e.current_script_revision_id,
              e.approved_script_revision_id, s.review_status, s.freshness_status
         FROM episode e
         LEFT JOIN script_revision s ON s.id = e.current_script_revision_id
        WHERE e.workspace_id = $1 AND e.project_id = $2 ORDER BY e.episode_no`,
      [workspaceId, projectId],
    );
    try {
      assertProductionEpisodeSet(rows.rows.map((row) => Number(row.episode_no)));
    } catch {
      throw new PersistenceError("EPISODE_SET_INVALID", "Production requires episodes 1, 2, and 3");
    }
    if (rows.rows.some((row) => !row.current_script_revision_id ||
        row.current_script_revision_id !== row.approved_script_revision_id ||
        row.review_status !== "APPROVED" || row.freshness_status !== "CURRENT")) {
      throw new PersistenceError("SCRIPT_REVIEW_REQUIRED", "All three current scripts must be approved and current");
    }
    return rows.rows.map((row) => ({
      episodeId: row.id, episodeNo: Number(row.episode_no),
      episodeVersion: Number(row.row_version), scriptRevisionId: row.current_script_revision_id!,
    }));
  }

  async currentShotSources(client: PoolClient, workspaceId: string, projectId: string): Promise<MockShotSource[]> {
    const episodes = await this.currentSources(client, workspaceId, projectId);
    const pending = await client.query(
      `SELECT 1 FROM stale_recalculation WHERE workspace_id = $1 AND project_id = $2
         AND status IN ('PENDING', 'RUNNING') LIMIT 1`,
      [workspaceId, projectId],
    );
    if (pending.rows[0]) throw new PersistenceError("SOURCE_STALE", "Project dependency propagation is incomplete");
    const scenes = await client.query<{
      id: string; episode_id: string; row_version: number; revision_id: string;
      review_status: string; freshness_status: string;
      script_usable: boolean;
    } & QueryResultRow>(
      `SELECT scene.id, scene.episode_id, scene.row_version,
              revision.id AS revision_id, revision.review_status, revision.freshness_status,
              m2_script_source_is_usable(revision.workspace_id, revision.project_id,
                'scene_revision', revision.id, revision.source_script_revision_id) AS script_usable
         FROM scene JOIN scene_revision revision ON revision.id = scene.current_revision_id
        WHERE scene.workspace_id = $1 AND scene.project_id = $2 AND scene.archived_at IS NULL
          AND revision.ordinal = 1 AND scene.approved_revision_id = revision.id`,
      [workspaceId, projectId],
    );
    if (scenes.rows.length !== 3 || episodes.some((episode) => {
      const scene = scenes.rows.find((row) => row.episode_id === episode.episodeId);
      return !scene || scene.review_status !== "APPROVED" || scene.freshness_status !== "CURRENT" ||
        scene.script_usable !== true;
    })) {
      throw new PersistenceError("REVIEW_REQUIRED", "Each episode needs a current approved Scene at ordinal 1");
    }
    return episodes.map((episode) => {
      const scene = scenes.rows.find((row) => row.episode_id === episode.episodeId)!;
      return { episodeId: episode.episodeId, episodeNo: episode.episodeNo,
        sceneId: scene.id, sceneVersion: Number(scene.row_version), sceneRevisionId: scene.revision_id };
    });
  }

  async persistShots(client: PoolClient, workspaceId: string, snapshot: MockShotSnapshot,
    output: ShotBatchOutput, traceId: string) {
    if (!snapshot || snapshot.schema !== "m2.mock.shots.v1" || snapshot.outcome !== "success" ||
        !Array.isArray(snapshot.scenes) || snapshot.scenes.length !== 3) {
      throw new PersistenceError("VALIDATION_ERROR", "Invalid Mock Shot snapshot");
    }
    const parsed = shotBatchOutputSchema.safeParse(output);
    if (!parsed.success) throw new PersistenceError("VALIDATION_ERROR", "Invalid Shot Adapter output");
    const byScene = new Map(parsed.data.shots.map((shot) => [shot.sceneId, shot]));
    if (byScene.size !== snapshot.scenes.length || snapshot.scenes.some((source) => {
      const shot = byScene.get(source.sceneId);
      return !shot || shot.projectId !== snapshot.projectId || shot.episodeId !== source.episodeId ||
        shot.episodeNo !== source.episodeNo || shot.sourceSceneRevisionId !== source.sceneRevisionId ||
        shot.ordinal !== 1;
    })) throw new PersistenceError("VALIDATION_ERROR", "Shot Adapter output does not match frozen sources");
    const current = await this.currentShotSources(client, workspaceId, snapshot.projectId);
    if (current.length !== snapshot.scenes.length || current.some((scene, index) => {
      const frozen = snapshot.scenes[index];
      return !frozen || scene.episodeId !== frozen.episodeId || scene.episodeNo !== frozen.episodeNo ||
        scene.sceneId !== frozen.sceneId || scene.sceneVersion !== frozen.sceneVersion ||
        scene.sceneRevisionId !== frozen.sceneRevisionId;
    })) {
      throw new PersistenceError("REVISION_CONFLICT", "Mock Shot sources changed since queueing");
    }
    const occupied = await client.query(
      `SELECT 1 FROM shot JOIN shot_revision revision ON revision.id = shot.current_revision_id
        WHERE shot.workspace_id = $1 AND shot.project_id = $2
          AND shot.scene_id = ANY($3::uuid[]) AND shot.archived_at IS NULL
          AND revision.ordinal = 1 LIMIT 1`,
      [workspaceId, snapshot.projectId, current.map((scene) => scene.sceneId)],
    );
    if (occupied.rows[0]) {
      throw new PersistenceError("MOCK_SHOT_SLOT_OCCUPIED", "Scene already has a current Shot at ordinal 1");
    }
    const shots = [];
    for (const scene of current) {
      const generated = byScene.get(scene.sceneId)!;
      shots.push(await this.chain.createShotScopedInTransaction(client, {
        workspaceId, projectId: snapshot.projectId, sceneId: scene.sceneId,
        sourceSceneRevisionId: scene.sceneRevisionId, ordinal: 1,
        shotType: generated.shotType, camera: generated.camera, action: generated.action,
        dialogue: generated.dialogue, durationHint: generated.durationHint,
        promptText: generated.promptText,
        createdBy: snapshot.requestedBy, expectedVersion: scene.sceneVersion, traceId,
      }));
    }
    return { id: shots[0]!.revisionId, shotRevisionIds: shots.map((shot) => shot.revisionId) };
  }

  async persistScenes(client: PoolClient, workspaceId: string, snapshot: MockSceneSnapshot,
    output: SceneBatchOutput, traceId: string) {
    if (snapshot.schema !== "m2.mock.scenes.v1" || snapshot.outcome !== "success" ||
        !Array.isArray(snapshot.episodes) || snapshot.episodes.length !== 3) {
      throw new PersistenceError("VALIDATION_ERROR", "Invalid Mock Scene snapshot");
    }
    const parsed = sceneBatchOutputSchema.safeParse(output);
    if (!parsed.success) throw new PersistenceError("VALIDATION_ERROR", "Invalid Scene Adapter output");
    const byEpisode = new Map(parsed.data.scenes.map((scene) => [scene.episodeId, scene]));
    if (byEpisode.size !== snapshot.episodes.length || snapshot.episodes.some((source) => {
      const scene = byEpisode.get(source.episodeId);
      return !scene || scene.projectId !== snapshot.projectId || scene.episodeNo !== source.episodeNo ||
        scene.sourceScriptRevisionId !== source.scriptRevisionId || scene.ordinal !== 1;
    })) throw new PersistenceError("VALIDATION_ERROR", "Scene Adapter output does not match frozen sources");
    const current = await this.currentSources(client, workspaceId, snapshot.projectId);
    if (current.length !== snapshot.episodes.length || current.some((episode, index) => {
      const frozen = snapshot.episodes[index];
      return !frozen || episode.episodeId !== frozen.episodeId ||
        episode.episodeNo !== frozen.episodeNo || episode.episodeVersion !== frozen.episodeVersion ||
        episode.scriptRevisionId !== frozen.scriptRevisionId;
    })) {
      throw new PersistenceError("REVISION_CONFLICT", "Mock Scene sources changed since queueing");
    }
    const occupied = await client.query<{ episode_id: string } & QueryResultRow>(
      `SELECT scene.episode_id FROM scene
         JOIN scene_revision revision
           ON revision.id = scene.current_revision_id
          AND revision.workspace_id = scene.workspace_id
        WHERE scene.workspace_id = $1 AND scene.project_id = $2
          AND scene.episode_id = ANY($3::uuid[]) AND scene.archived_at IS NULL
          AND revision.ordinal = 1 LIMIT 1`,
      [workspaceId, snapshot.projectId, current.map((episode) => episode.episodeId)],
    );
    if (occupied.rows[0]) {
      throw new PersistenceError("MOCK_SCENE_SLOT_OCCUPIED", "Episode already has a current Scene at ordinal 1");
    }
    const scenes = [];
    for (const episode of snapshot.episodes) {
      const generated = byEpisode.get(episode.episodeId)!;
      scenes.push(await this.chain.createSceneRevisionInTransaction(client, {
        workspaceId, projectId: snapshot.projectId, episodeId: episode.episodeId,
        sourceScriptRevisionId: episode.scriptRevisionId,
        ordinal: generated.ordinal, heading: generated.heading,
        timeOfDay: generated.timeOfDay, summary: generated.summary,
        createdBy: snapshot.requestedBy, expectedVersion: episode.episodeVersion, traceId,
      }));
    }
    return { id: scenes[0]!.revisionId, sceneRevisionIds: scenes.map((scene) => scene.revisionId) };
  }
}
