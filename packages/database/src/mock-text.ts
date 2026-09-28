import { assertProductionEpisodeSet } from "@ai-drama/domain";
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

  async persistScenes(client: PoolClient, workspaceId: string, snapshot: MockSceneSnapshot, traceId: string) {
    if (snapshot.schema !== "m2.mock.scenes.v1" || snapshot.outcome !== "success" ||
        !Array.isArray(snapshot.episodes) || snapshot.episodes.length !== 3) {
      throw new PersistenceError("VALIDATION_ERROR", "Invalid Mock Scene snapshot");
    }
    const current = await this.currentSources(client, workspaceId, snapshot.projectId);
    if (JSON.stringify(current) !== JSON.stringify(snapshot.episodes)) {
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
      scenes.push(await this.chain.createSceneRevisionInTransaction(client, {
        workspaceId, projectId: snapshot.projectId, episodeId: episode.episodeId,
        sourceScriptRevisionId: episode.scriptRevisionId,
        ordinal: 1, heading: `Episode ${episode.episodeNo} · Opening`,
        summary: `Mock draft based on approved Script revision ${episode.scriptRevisionId}.`,
        createdBy: snapshot.requestedBy, expectedVersion: episode.episodeVersion, traceId,
      }));
    }
    return { id: scenes[0]!.revisionId, sceneRevisionIds: scenes.map((scene) => scene.revisionId) };
  }
}
