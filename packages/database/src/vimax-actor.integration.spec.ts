import { Pool } from "pg";
import { expect, it } from "vitest";
import { vimaxActorMatch } from "./vimax-actor";

it("limits the legacy ViMax actor to projects owned by the requesting creator in the same workspace", async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for PostgreSQL integration tests");
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const owner = "00000000-0000-4000-8000-000000000001";
  const other = "00000000-0000-4000-8000-000000000002";
  try {
    for (const alias of ["c", "vimax_planning_request"] as const) {
      for (const [actor, expected] of [
        [`creator:${owner}`, ["legacy-owned", "own"]],
        [`creator:${other}`, ["legacy-other"]],
        ["unrelated-staff", []],
      ] as const) {
        const result = await pool.query<{ name: string }>(`
          WITH project(id, workspace_id, owner_account_id) AS (VALUES
            ('one', 'first', $2::uuid), ('two', 'first', $3::uuid), ('one', 'foreign', $3::uuid)),
          records(name, project_id, workspace_id, actor_id) AS (VALUES
            ('legacy-owned', 'one', 'first', 'server-owner'), ('legacy-other', 'two', 'first', 'server-owner'),
            ('own', 'one', 'first', 'creator:' || $2::text), ('orphan', 'absent', 'first', 'server-owner'))
          SELECT name FROM records ${alias} WHERE ${vimaxActorMatch(alias, 1, actor)} ORDER BY name
        `, [actor, owner, other]);
        expect(result.rows.map(row => row.name)).toEqual(expected);
      }
    }
  } finally {
    await pool.end();
  }
});
