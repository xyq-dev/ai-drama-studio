import type { PoolClient, QueryResultRow } from "pg";
import type { DatabasePool } from "./job-service";
import { PersistenceError } from "./job-service";

/**
 * The migration that adds a project's episode plan (prisma/migrations/20261011000100_episode_plan): the episode count
 * (1–6), the per-episode target seconds (60 or 90, NULL when never recorded) and the wider episode and title writing
 * step ranges. Until it is recorded and its columns exist, every project is a three-episode project without a target,
 * and projects with a plan are refused before anything is written.
 */
export const EPISODE_PLAN_MIGRATION = "20261011000100_episode_plan";

export const EPISODE_PLAN_COLUMNS = ["episode_count", "target_episode_seconds"] as const;

export interface ProjectEpisodePlan {
  /** 1–6 for a project created with a plan; 3 for every other project. */
  episodeCount: number;
  /** 60 or 90 for a project created with a plan; null when no target was ever recorded. */
  targetEpisodeSeconds: number | null;
}

/** A project without a recorded plan: the three-episode scope, target unknown. */
export const LEGACY_EPISODE_PLAN: ProjectEpisodePlan = { episodeCount: 3, targetEpisodeSeconds: null };

type Queryable = Pick<PoolClient, "query">;

async function columnsPresent(client: Queryable): Promise<boolean> {
  const columns = await client.query<{ column_name: string } & QueryResultRow>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'project' AND column_name = ANY($1::text[])`,
    [[...EPISODE_PLAN_COLUMNS]],
  );
  return EPISODE_PLAN_COLUMNS.every((name) => columns.rows.some((row) => row.column_name === name));
}

/**
 * True only when the episode plan migration is recorded as applied and both project columns exist. Safe inside a
 * transaction: it never reads a table that may be missing, so it cannot abort the caller's transaction.
 */
export async function episodePlanReadyIn(client: Queryable): Promise<boolean> {
  const table = await client.query<{ present: boolean } & QueryResultRow>(
    "SELECT to_regclass('schema_migration') IS NOT NULL AS present",
  );
  if (table.rows[0]?.present !== true) return false;
  const recorded = await client.query("SELECT 1 FROM schema_migration WHERE name = $1", [EPISODE_PLAN_MIGRATION]);
  if (!recorded.rows[0]) return false;
  return columnsPresent(client);
}

/**
 * The plan of one project as stored. Without the plan columns (a database before the migration) every project reads
 * as the three-episode scope. Throws NOT_FOUND when the project is not in this workspace.
 */
export async function projectEpisodePlanIn(client: Queryable, workspaceId: string, projectId: string): Promise<ProjectEpisodePlan> {
  if (!await columnsPresent(client)) {
    const exists = await client.query("SELECT 1 FROM project WHERE id = $1 AND workspace_id = $2", [projectId, workspaceId]);
    if (!exists.rows[0]) throw new PersistenceError("NOT_FOUND", "Project not found");
    return { ...LEGACY_EPISODE_PLAN };
  }
  const result = await client.query<{ episode_count: number; target_episode_seconds: number | null } & QueryResultRow>(
    "SELECT episode_count, target_episode_seconds FROM project WHERE id = $1 AND workspace_id = $2",
    [projectId, workspaceId],
  );
  const row = result.rows[0];
  if (!row) throw new PersistenceError("NOT_FOUND", "Project not found");
  return {
    episodeCount: Number(row.episode_count),
    targetEpisodeSeconds: row.target_episode_seconds === null ? null : Number(row.target_episode_seconds),
  };
}

/** Pool-level reads of the episode plan for the API. */
export class EpisodePlanStore {
  // Once applied a migration stays applied, so only a positive answer is remembered.
  private readyConfirmed = false;

  constructor(private readonly pool: DatabasePool) {}

  /** False, never an error, when the database cannot be reached or read: readiness is a refusal, not a failure. */
  async ready(): Promise<boolean> {
    if (this.readyConfirmed) return true;
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch {
      return false;
    }
    try {
      this.readyConfirmed = await episodePlanReadyIn(client);
      return this.readyConfirmed;
    } catch {
      return false;
    } finally {
      client.release();
    }
  }

  async read(workspaceId: string, projectId: string): Promise<ProjectEpisodePlan> {
    const client = await this.pool.connect();
    try {
      return await projectEpisodePlanIn(client, workspaceId, projectId);
    } finally {
      client.release();
    }
  }
}
