import { creatorAccountIdFromActor } from "@ai-drama/domain";

/** Before staff accounts, the workbench stored every creator's ViMax records under server-owner. */
export function vimaxActorMatch(table: "c" | "vimax_planning_request", parameter: number, actor: string): string {
  const direct = `${table}.actor_id = $${parameter}`;
  if (!creatorAccountIdFromActor(actor)) return direct;
  return `(${direct} OR (${table}.actor_id = 'server-owner' AND EXISTS (
    SELECT 1 FROM project owned
    WHERE owned.workspace_id = ${table}.workspace_id AND owned.id = ${table}.project_id
      AND 'creator:' || (to_jsonb(owned)->>'owner_account_id') = $${parameter}
  )))`;
}
