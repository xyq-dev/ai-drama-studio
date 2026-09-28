import type { PoolClient } from "pg";
import { PersistenceError } from "./job-service";

export const SCRIPT_DEPENDENCY_CONSUMERS = [
  "scene_revision",
  "shot_revision",
  "character_revision",
  "location_revision",
] as const;
export type ScriptDependencyConsumer = (typeof SCRIPT_DEPENDENCY_CONSUMERS)[number];

/** These are the complete script inputs consumed by this revision, recorded before review. */
export interface ScriptDependencyBinding {
  workspaceId: string;
  projectId: string;
  consumerType: ScriptDependencyConsumer;
  parentId: string;
  revisionId: string;
  sourceScriptRevisionId: string;
  sourcePaths: readonly (readonly string[])[];
  expectedVersion: number;
  traceId?: string;
}

export function validateScriptDependencyBinding(input: ScriptDependencyBinding): void {
  if (
    !SCRIPT_DEPENDENCY_CONSUMERS.includes(input.consumerType) ||
    !Array.isArray(input.sourcePaths) ||
    input.sourcePaths.length === 0 ||
    input.sourcePaths.length > 64 ||
    input.sourcePaths.some(
      (path) =>
        !Array.isArray(path) ||
        path.length > 32 ||
        path.some((token) => typeof token !== "string" || token.length === 0),
    )
  ) {
    throw new PersistenceError(
      "INVALID_SOURCE_REFERENCE",
      "Script dependencies require 1..64 explicit JSON paths",
    );
  }
  const keys = input.sourcePaths.map((path) => JSON.stringify(path));
  if (new Set(keys).size !== keys.length) {
    throw new PersistenceError(
      "INVALID_SOURCE_REFERENCE",
      "Script dependency paths must be distinct",
    );
  }
}

export async function insertScriptDependencies(
  client: PoolClient,
  input: ScriptDependencyBinding,
): Promise<void> {
  const column = `${input.consumerType}_id`;
  for (const path of input.sourcePaths) {
    // The database derives the immutable value/hash from the locked source, not from client claims.
    await client.query(
      `INSERT INTO script_source_dependency
        (workspace_id, project_id, script_revision_id, consumer_type, consumer_revision_id,
         ${column}, source_path, source_value, source_value_hash)
       VALUES ($1, $2, $3, $4, $5, $5, $6::text[], 'null'::jsonb, '')`,
      [
        input.workspaceId,
        input.projectId,
        input.sourceScriptRevisionId,
        input.consumerType,
        input.revisionId,
        path,
      ],
    );
  }
}

/** $1 workspace, $2 replaced script; fixed replacement facts also survive delayed continuation. */
export function affectedScriptConsumerIds(consumerType: ScriptDependencyConsumer): string {
  return `SELECT edge.consumer_revision_id AS id
    FROM script_revision_consumer_source edge
    JOIN script_revision source ON source.id = edge.script_revision_id
      AND source.workspace_id = edge.workspace_id AND source.project_id = edge.project_id
    JOIN script_revision root ON root.id = $2 AND root.workspace_id = $1 AND root.project_id = edge.project_id
    LEFT JOIN script_revision_replacement replacement ON replacement.previous_script_revision_id = root.id
      AND replacement.workspace_id = root.workspace_id AND replacement.project_id = root.project_id
   WHERE edge.workspace_id = $1 AND edge.consumer_type = '${consumerType}'
     AND ((replacement.previous_script_revision_id IS NULL AND source.id = root.id)
       OR (replacement.previous_script_revision_id IS NOT NULL
         AND source.episode_id = replacement.episode_id AND source.revision_no <= root.revision_no
         AND edge.created_at <= replacement.created_at
         AND m2_script_source_matches(edge.workspace_id, edge.project_id, edge.consumer_type,
               edge.consumer_revision_id, source.id, replacement.new_script_revision_id) IS NOT TRUE))`;
}
