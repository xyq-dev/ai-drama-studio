type Queryable = { query(sql: string, values?: unknown[]): Promise<unknown> };

/** Optional tables whose open rows send with the active configuration (each needs the base migrations). */
const OPTIONAL_WORK = [
  { name: "writing_candidate_request", label: "Writing candidate", open: "state IN ('reserved', 'submitted')" },
  { name: "auto_creation_run", label: "Auto creation", open: "state = 'running'" },
  { name: "series_writing_run", label: "Series writing", open: "state = 'running'" },
] as const;

/**
 * Whether no paid text work of the workspace is sending with the active model configuration, so a saved configuration may
 * become active. storageReady() deliberately reports both absent schema and transient probe failures as false; activation
 * must distinguish those cases: only a successful absence check proves no runs exist.
 */
export async function writingWorkspaceIdle(pool: Queryable, workspaceId: string): Promise<boolean> {
  const presence = await pool.query(
    "SELECT to_regclass('title_writing_run') IS NULL AS missing",
  ) as { rows: { missing: boolean }[] };
  // The automatic creation migration requires the base migrations, title writing included: no title table, no
  // automatic run either.
  if (presence.rows[0]?.missing === true) return true;
  if (presence.rows[0]?.missing !== false) throw new Error("Title writing activation probe unavailable");
  const result = await pool.query(
    "SELECT EXISTS(SELECT 1 FROM title_writing_run WHERE workspace_id = $1 AND state = 'running') AS running",
    [workspaceId],
  ) as { rows: { running: boolean }[] };
  if (result.rows[0]?.running !== false) return false;
  // Each optional table (online candidates, automatic creation, series writing) is probed on its own: a missing one is
  // skipped, never read as the whole workspace being idle, and a probe that answers nothing is an error.
  for (const table of OPTIONAL_WORK) {
    const present = await pool.query(`SELECT to_regclass('${table.name}') IS NULL AS missing`) as { rows: { missing: boolean }[] };
    if (present.rows[0]?.missing === true) continue;
    if (present.rows[0]?.missing !== false) throw new Error(`${table.label} activation probe unavailable`);
    const busy = await pool.query(`SELECT EXISTS(SELECT 1 FROM ${table.name} WHERE workspace_id = $1 AND ${table.open}) AS busy`,
      [workspaceId]) as { rows: { busy: boolean }[] };
    if (busy.rows[0]?.busy !== false) return false;
  }
  return true;
}
