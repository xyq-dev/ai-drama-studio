import { randomUUID } from "node:crypto";
import { createPostgresPool } from "@ai-drama/database";
import { expect, it } from "vitest";
import { readSkillRuns } from "./skill-run-reader";

it("reads only actual marked skill runs in the operator workspace and surfaces QC defects", async () => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL required for skill integration test");
  const pool = createPostgresPool({ connectionString, connectionTimeoutMs: 2000, statementTimeoutMs: 10000, queryTimeoutMs: 10000 });
  const db = await pool.connect();
  let returned = false;
  try {
    await db.query(`
      CREATE TEMP TABLE project(id uuid, workspace_id uuid, title text);
      CREATE TEMP TABLE writing_candidate_request(id uuid, project_id uuid, workspace_id uuid,
        input_json jsonb, created_at timestamptz DEFAULT now(), finished_at timestamptz, state text, error_code text);
      CREATE TEMP TABLE vimax_planning_request(LIKE writing_candidate_request INCLUDING DEFAULTS, frozen_json jsonb);
      CREATE TEMP TABLE asset(id uuid, project_id uuid, workspace_id uuid, kind text, metadata_json jsonb, created_at timestamptz DEFAULT now());
    `);
    const ws = randomUUID(), other = randomUUID(), project = randomUUID(), otherProject = randomUUID();
    await db.query("INSERT INTO project VALUES ($1,$2,'第一集'),($3,$4,'其他工作区')", [project, ws, otherProject, other]);
    const write = { skill: "short-drama-write", skillVersion: "w1", instruction: "作品的私有资料" };
    for (const [workspace, projectId, input] of [[ws, project, write], [other, otherProject, write], [ws, project, {}]]) {
      await db.query("INSERT INTO writing_candidate_request(id,workspace_id,project_id,input_json,state) VALUES ($1,$2,$3,$4,'completed')",
        [randomUUID(), workspace, projectId, input]);
    }
    await db.query("INSERT INTO vimax_planning_request(id,workspace_id,project_id,frozen_json,state,error_code) VALUES ($1,$2,$3,$4,'rejected','LIMIT')",
      [randomUUID(), ws, project, { request: { skill: "short-drama-storyboard" }, skillVersion: "s1" }]);
    await db.query("INSERT INTO asset(id,workspace_id,project_id,kind,metadata_json) VALUES ($1,$2,$3,'COMPOSITE',$4)",
      [randomUUID(), ws, project, { schema: "m4.episode.compose.asset.v1", qualityReport: {
        skill: "qc-skill", version: "q1", status: "FAIL", findings: [{ code: "BLACK" }, { code: "SILENCE" }],
      } }]);
    db.release();
    returned = true;
    const runs = await readSkillRuns(pool, ws);
    expect(runs).toHaveLength(3);
    expect(runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ skill: "short-drama-write", status: "succeeded", version: "w1" }),
      expect.objectContaining({ skill: "short-drama-storyboard", status: "failed", reasons: ["LIMIT"] }),
      expect.objectContaining({ skill: "qc-skill", status: "issues", reasons: expect.arrayContaining(["BLACK","SILENCE"]) }),
    ]));
    expect(JSON.stringify(runs)).not.toContain("私有资料");
    expect(runs.every(row => row.project === "第一集")).toBe(true);
  } finally {
    if (!returned) db.release(true);
    await pool.end();
  }
});
