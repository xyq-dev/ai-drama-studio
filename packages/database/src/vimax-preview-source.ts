import { createHash } from "node:crypto";
import type { QueryResultRow } from "pg";
import { SCRIPT_BREAKDOWN_LIMITS, type VimaxPlatformSourceSnapshot } from "@ai-drama/contracts";
import { scriptTextOf } from "@ai-drama/domain";
import type { DatabasePool } from "./job-service";

type Row = QueryResultRow & Record<string, unknown>;
export type VimaxPreviewSourceRead =
  | { kind: "ok"; source: VimaxPlatformSourceSnapshot }
  | { kind: "not_found" | "series_not_enabled" | "script_review_required" | "script_unsupported" | "too_many_characters" | "characters_unsupported" };

/** Read a single database snapshot. It neither freezes a task nor grants permission to save a candidate. */
export class VimaxPreviewSourceStore {
  constructor(private readonly pool: DatabasePool) {}

  async read(workspaceId: string, projectId: string, episodeId: string): Promise<VimaxPreviewSourceRead> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      try {
        // to_jsonb preserves the pre-series schema's short-drama behavior without probing or altering the schema.
        const project = await client.query<Row>(
          `SELECT COALESCE(to_jsonb(project) ->> 'writing_mode', 'short') AS writing_mode
             FROM project WHERE id = $1 AND workspace_id = $2`,
          [projectId, workspaceId],
        );
        if (!project.rows[0]) return { kind: "not_found" };
        if (project.rows[0].writing_mode !== "short") return { kind: "series_not_enabled" };
        const episode = await client.query<Row>(
          `SELECT episode_no, current_script_revision_id, approved_script_revision_id FROM episode
            WHERE id = $1 AND project_id = $2 AND workspace_id = $3`,
          [episodeId, projectId, workspaceId],
        );
        const ep = episode.rows[0];
        if (!ep) return { kind: "not_found" };
        const currentId = ep.current_script_revision_id;
        if (typeof currentId !== "string" || ep.approved_script_revision_id !== currentId) {
          return { kind: "script_review_required" };
        }
        const script = await client.query<Row>(
          `SELECT revision_no, content_json, review_status, freshness_status FROM script_revision
            WHERE id = $1 AND episode_id = $2 AND project_id = $3 AND workspace_id = $4`,
          [currentId, episodeId, projectId, workspaceId],
        );
        const revision = script.rows[0];
        if (!revision || revision.review_status !== "APPROVED" || revision.freshness_status !== "CURRENT") {
          return { kind: "script_review_required" };
        }
        const scriptText = scriptTextOf(revision.content_json);
        const episodeNo = Number(ep.episode_no);
        if (scriptText === null || scriptText.trim().length === 0 || scriptText.includes("\u0000")
          || scriptText.length > SCRIPT_BREAKDOWN_LIMITS.scriptMaxChars
          || !Number.isInteger(episodeNo) || episodeNo < 1 || episodeNo > 6) {
          return { kind: "script_unsupported" };
        }
        const characters = await client.query<Row>(
          `SELECT c.id, c.current_revision_id, c.name, r.id AS revision_id, r.freshness_status FROM character c
             LEFT JOIN character_revision r ON r.id = c.current_revision_id AND r.character_id = c.id
               AND r.workspace_id = c.workspace_id AND r.project_id = c.project_id
            WHERE c.project_id = $1 AND c.workspace_id = $2 AND c.archived_at IS NULL
            ORDER BY c.created_at, c.id LIMIT $3`,
          [projectId, workspaceId, SCRIPT_BREAKDOWN_LIMITS.maxCharacters + 1],
        );
        if (characters.rows.length > SCRIPT_BREAKDOWN_LIMITS.maxCharacters) return { kind: "too_many_characters" };
        // Never silently shrink the source by dropping an unready character from the project's identity collection.
        if (characters.rows.some((character) => character.revision_id !== character.current_revision_id
          || character.freshness_status !== "CURRENT" || typeof character.name !== "string" || character.name.trim().length === 0
          || character.name.length > SCRIPT_BREAKDOWN_LIMITS.speakerMaxChars || character.name.includes("\u0000"))) {
          return { kind: "characters_unsupported" };
        }
        return { kind: "ok", source: {
          schema: "ads.vimax-platform-source.v1", projectId, episodeId, episodeNo,
          scriptRevisionId: currentId, scriptRevisionNo: Number(revision.revision_no), scriptText,
          // The revision's structured content hash is intentionally not used for the raw UTF-8 text identity.
          scriptContentHash: createHash("sha256").update(scriptText, "utf8").digest("hex"),
          characters: characters.rows.map((character, index) => ({ key: `C${String(index + 1)}`,
            characterId: String(character.id), revisionId: String(character.current_revision_id), name: String(character.name) })),
        } };
      } finally {
        // Even success ends the read-only transaction without a commit or any business write.
        await client.query("ROLLBACK");
      }
    } finally {
      client.release();
    }
  }
}
