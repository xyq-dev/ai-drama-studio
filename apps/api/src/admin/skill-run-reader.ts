import type { DatabasePool } from "@ai-drama/database";
import { skillRunSchema, type SkillRunView } from "@ai-drama/contracts";

// Skills share the existing request/asset lifecycle. Legacy runs without the frozen
// skill marker must never be attributed to a new adapter.
const textSources = [
  { table: "writing_candidate_request", marker: "input_json->>'skill'", version: "input_json->>'skillVersion'", skill: "short-drama-write" },
  { table: "vimax_planning_request", marker: "frozen_json#>>'{request,skill}'", version: "frozen_json->>'skillVersion'", skill: "short-drama-storyboard" },
] as const;

function safeReasons(codes: (string | null)[]) {
  return [...new Set(codes.filter((code): code is string => typeof code === "string" && /^[A-Za-z0-9_]{1,128}$/.test(code)))].slice(0, 64);
}

export async function readSkillRuns(pool: DatabasePool, workspaceId: string): Promise<SkillRunView[]> {
  const db = await pool.connect();
  try {
    const names = [...textSources.map(({ table }) => table), "asset"];
    const ready = await db.query<{ name: string }>(
      "SELECT name FROM unnest($1::text[]) AS rel(name) WHERE to_regclass(name) IS NOT NULL", [names],
    );
    const tables = new Set(ready.rows.map(({ name }) => name));
    // Only these compile-time relation names/expressions enter the SQL.
    const sources = textSources.filter(({ table }) => tables.has(table)).map(({ table, marker, version, skill }) =>
      `(SELECT id, project_id, '${skill}'::text AS skill, ${version} AS version, COALESCE(finished_at, created_at) AS at,
          CASE state WHEN 'completed' THEN 'succeeded' WHEN 'rejected' THEN 'failed' WHEN 'unknown' THEN 'unknown'
                     ELSE 'running' END AS status, ARRAY[error_code]::text[] AS reasons
        FROM ${table} WHERE workspace_id = $1 AND ${marker} = '${skill}'
        ORDER BY at DESC, id DESC LIMIT 30)`,
    );
    if (tables.has("asset")) sources.push(`(SELECT a.id, a.project_id, 'qc-skill'::text AS skill, qc->>'version' AS version,
      a.created_at AS at, CASE qc->>'status' WHEN 'PASS' THEN 'succeeded' WHEN 'FAIL' THEN 'issues' ELSE 'unknown' END AS status,
      CASE WHEN qc->>'reason' IS NOT NULL THEN ARRAY[qc->>'reason']
          ELSE ARRAY(SELECT DISTINCT f->>'code' FROM jsonb_array_elements(
              CASE WHEN jsonb_typeof(qc->'findings') = 'array' THEN qc->'findings' ELSE '[]'::jsonb END) f) END AS reasons
      FROM asset a CROSS JOIN LATERAL (SELECT a.metadata_json->'qualityReport' AS qc) report
      WHERE a.workspace_id = $1 AND a.kind='COMPOSITE' AND a.metadata_json->>'schema'='m4.episode.compose.asset.v1'
        AND qc->>'skill'='qc-skill'
      ORDER BY a.created_at DESC, a.id DESC LIMIT 30)`);
    if (!sources.length) return [];
    const result = await db.query<{
      id: string; skill: string; version: string; project: string; at: Date; status: string; reasons: (string | null)[];
    }>(`SELECT r.id, r.skill, r.version, p.title AS project, r.at, r.status, r.reasons
        FROM (${sources.join(" UNION ALL ")}) r JOIN project p ON p.id = r.project_id AND p.workspace_id = $1
        ORDER BY r.at DESC, r.id DESC LIMIT 30`, [workspaceId]);
    return result.rows.map(row => skillRunSchema.parse({
      ...row, version: row.version ?? "", at: row.at.toISOString(), reasons: safeReasons(row.reasons),
    }));
  } finally { db.release(); }
}
