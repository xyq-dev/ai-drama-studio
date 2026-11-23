import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminOpsStore } from "./admin-ops-store";
import { runWithStoreCreatorAccess } from "./creator-access-context";
import { ADMIN_WORK_ACTIONS_MIGRATION, GUARDED_SINGLE_MIGRATIONS, STAFF_MEMBERSHIP_MIGRATION, runMigrations } from "./migrations";
import { ScriptWorkbenchTrashStore } from "./script-workbench-trash";

if (!process.env.DATABASE_URL) throw new Error("An isolated integration DATABASE_URL is required");
const schema = `admin_works_${randomUUID().replaceAll("-", "")}`;
const root = new Pool({connectionString: process.env.DATABASE_URL});
const pool = new Pool({connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}`, max: 10});
const admin = new AdminOpsStore(pool);
const creator = new ScriptWorkbenchTrashStore(pool);
const draftPath = join(__dirname, "../prisma/drafts/20261111000300_script_workbench_trash.sql");
const byOwner = <T>(owner: string, run: () => T) =>
  runWithStoreCreatorAccess({kind: "scoped", ownerAccountId: owner, actorId: `creator:${owner}`}, run);

async function workspace() {
  return String((await pool.query("INSERT INTO workspace(name) VALUES('管理端验收') RETURNING id")).rows[0].id);
}
async function seed(ws: string, username: string, title: string) {
  const owner: string = (await pool.query(`INSERT INTO creator_account(id, workspace_id,username,password_hash,status)
    VALUES(gen_random_uuid(), $1, $2, 'synthetic','ACTIVE') RETURNING id`, [ws,username])).rows[0].id;
  const id: string = (await pool.query(`INSERT INTO project(workspace_id,title,owner_account_id) VALUES($1,$2,$3) RETURNING id`, [ws,title,owner])).rows[0].id;
  return { id, owner };
}
const trash = (ws: string,id: string,expectedVersion: number,reason = "验收：清理测试作品") =>
  admin.adminTrashWork(ws,id,{expectedVersion,actor:"operator-1",reason});
const restore = (ws: string,id: string,expectedVersion: number) => admin.adminRestoreWork(ws,id,{expectedVersion,actor:"operator-2"});
const startWork = (ws: string,id: string) => pool.query(`INSERT INTO workflow_run(workspace_id,project_id,type,requested_by,input_snapshot)
  VALUES ($1,$2,'fixture','fixture','{}') RETURNING id`, [ws,id]);

async function setupSchema(name: string) {
  await root.query(`CREATE SCHEMA "${name}"`);
  // Each test schema has a private migration ledger; only expose pgcrypto from public.
  await root.query(`CREATE FUNCTION "${name}".digest(text,text) RETURNS bytea LANGUAGE SQL IMMUTABLE
    AS 'SELECT public.digest($1,$2)'`);
}

beforeAll(async () => {
  await root.query("CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public");
  await setupSchema(schema);
  await runMigrations(pool, undefined, {before: STAFF_MEMBERSHIP_MIGRATION});
});
afterAll(async () => {
  await pool.end();
  try { await root.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await root.end(); }
});

describe("admin management of works in private PostgreSQL schema", () => {
  it("preserves earlier listings and logs, fails closed for mutation until upgraded, and installs with the old trash draft already present", async () => {
    const ws = await workspace();
    const { id } = await seed(ws,"author","原有作品");
    const only = { name: ADMIN_WORK_ACTIONS_MIGRATION, requires: GUARDED_SINGLE_MIGRATIONS[ADMIN_WORK_ACTIONS_MIGRATION]! };
    await expect(runMigrations(pool, undefined, { only })).rejects.toThrow(`Required migrations not applied: ${STAFF_MEMBERSHIP_MIGRATION}`);
    expect((await runMigrations(pool, undefined, { before: ADMIN_WORK_ACTIONS_MIGRATION })).applied).toEqual([STAFF_MEMBERSHIP_MIGRATION]);
    await pool.query(`INSERT INTO staff_role (id, workspace_id, code, name, permissions)
      VALUES (gen_random_uuid(), $1, 'reviewer', '审核员', ARRAY['review_works'])`, [ws]);
    const readRoles = async () => (await pool.query<{ code: string; permissions: string[] }>(
      "SELECT code, permissions FROM staff_role WHERE workspace_id = $1 ORDER BY code", [ws])).rows;
    const priorRoles = await readRoles();
    expect(priorRoles.map(role => role.code)).toEqual(["ops_admin", "reviewer", "super_admin"]);
    expect(priorRoles.every(role => !role.permissions.includes("manage_works"))).toBe(true);
    expect((await admin.listWorks(ws)).workManagementReady).toBe(false);
    expect(await admin.listAdminWorkLogs(ws)).toEqual([]);
    await expect(trash(ws,id,1)).rejects.toMatchObject({code:"WORKBENCH_UNAVAILABLE"});
    await pool.query(await readFile(draftPath,"utf8"));
    expect((await runMigrations(pool)).applied).toEqual([ADMIN_WORK_ACTIONS_MIGRATION]);
    expect((await runMigrations(pool)).applied).toEqual([]);
    expect(await readRoles()).toEqual(priorRoles.map(role => role.code === "super_admin"
      ? { ...role, permissions: [...role.permissions, "manage_works"] } : role));
    expect((await admin.listWorks(ws)).workManagementReady).toBe(true);
  });

  it("searches by owner, soft-deletes, protects creator access, records private audit and restores the exact original owner", async () => {
    const ws = await workspace(), other = await workspace();
    const {id,owner} = await seed(ws,"writer_1","最后一班车");
    const second = await seed(ws,"writerX1","其他作品");
    expect((await admin.listWorks(ws,{q:"writer_1"})).items.map(row=>row.id)).toEqual([id]);
    expect(await admin.previewAdminWorkTrash(other,id)).toMatchObject({eligible:false,version:null});
    expect(await admin.previewAdminWorkTrash(ws,id)).toMatchObject({eligible:true,version:1});
    await trash(ws,id,1);
    expect(await admin.getWork(ws,id)).toBeNull();
    expect((await admin.listWorks(ws)).total).toBe(1);
    const deleted = (await admin.listTrashedWorks(ws,{q:"writer_1"})).items;
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatchObject({id,version:2,ownerName:"writer_1",deletedBy:"operator-1",reason:"验收：清理测试作品"});
    expect(await admin.listTrashedWorks(other)).toMatchObject({items:[],total:0});
    const log = (await admin.listAdminWorkLogs(ws))[0]!;
    expect(log).toMatchObject({projectId:id,title:"最后一班车",action:"trash",actor:"operator-1"});
    expect(await admin.getAdminWorkLog(ws,log.id)).toEqual(log);
    expect(await admin.getAdminWorkLog(other,log.id)).toBeNull();
    expect((await byOwner(owner,()=>creator.listTrash(ws))).items).toHaveLength(0);
    await expect(byOwner(owner,()=>creator.restoreProject(ws,id,{expectedVersion:2}))).rejects.toMatchObject({code:"NOT_FOUND"});
    await expect(byOwner(second.owner,()=>creator.restoreProject(ws,id,{expectedVersion:2}))).rejects.toMatchObject({code:"NOT_FOUND"});
    await expect(restore(other,id,2)).rejects.toMatchObject({code:"NOT_FOUND"});
    await restore(ws,id,2);
    expect(await admin.getWork(ws,id)).toMatchObject({ownerAccountId:owner});
    expect((await admin.listAdminWorkLogs(ws)).map(row=>row.action)).toEqual(["restore","trash"]);
    expect((await pool.query("SELECT count(*)::int AS n FROM domain_event WHERE project_id=$1", [id])).rows[0].n).toBe(0);

    await byOwner(owner,()=>creator.trashProject(ws,id,{expectedVersion:3}));
    expect((await admin.listTrashedWorks(ws)).items[0]).toMatchObject({id,deletedBy:"writer_1",reason:null});
    expect((await byOwner(owner,()=>creator.listTrash(ws))).items[0]?.id).toBe(id);
    expect((await byOwner(second.owner,()=>creator.listTrash(ws))).items).toHaveLength(0);
    await byOwner(owner,()=>creator.restoreProject(ws,id,{expectedVersion:4}));
    expect((await admin.listAdminWorkLogs(ws))).toHaveLength(2);
  });

  it("rechecks busy works, concurrent mutations and retries against a locked version", async () => {
    const ws = await workspace();
    const {id} = await seed(ws,"busy","生成中");
    expect((await admin.previewAdminWorkTrash(ws,id)).eligible).toBe(true);
    const workflow = await startWork(ws,id);
    expect((await admin.previewAdminWorkTrash(ws,id)).eligible).toBe(false);
    await expect(trash(ws,id,1)).rejects.toMatchObject({code:"REVISION_CONFLICT"});
    await pool.query("UPDATE workflow_run SET status='SUCCEEDED' WHERE id=$1",[workflow.rows[0].id]);
    const results = await Promise.allSettled([trash(ws,id,1),trash(ws,id,1)]);
    expect(results.filter(x=>x.status==="fulfilled")).toHaveLength(1);
    expect(await admin.listAdminWorkLogs(ws)).toHaveLength(1);
    await expect(startWork(ws,id)).rejects.toMatchObject({code:"23514"});
    await expect(pool.query("UPDATE workflow_run SET status='RUNNING' WHERE id=$1",[workflow.rows[0].id])).rejects.toMatchObject({code:"23514"});
    await expect(restore(ws,id,1)).rejects.toMatchObject({code:"REVISION_CONFLICT"});
    await restore(ws,id,2);
    await expect(trash(ws,id,1)).rejects.toMatchObject({code:"REVISION_CONFLICT"});
    expect(await admin.listAdminWorkLogs(ws)).toHaveLength(2);
  });

  it("reports unrecorded legacy deletion and retains microsecond cursor precision", async () => {
    const ws = await workspace();
    const {id} = await seed(ws,"legacy-a","A"); const {id:b} = await seed(ws,"legacy-b","B");
    const instant = "2026-01-01T00:00:00.123456Z";
    await pool.query("UPDATE project SET status='ARCHIVED',archived_at=$1 WHERE id=ANY($2::uuid[])",[instant,[id,b]]);
    const first = await admin.listTrashedWorks(ws,{limit:1});
    expect(first.items[0]).toMatchObject({deletedBy:null,reason:null});
    const next = await admin.listTrashedWorks(ws,{limit:1,cursor:first.nextCursor!});
    expect(next.items).toHaveLength(1);
    expect(next.items[0]?.id).not.toEqual(first.items[0]?.id);
    expect(next.nextCursor).toBeNull();
  });

  it("rolls back the project write if recording its audit fails", async () => {
    const ws = await workspace();
    const {id} = await seed(ws,"audit","审计事务");
    await pool.query("ALTER TABLE admin_work_action ADD CONSTRAINT test_audit_failure CHECK (reason IS DISTINCT FROM 'rejected-by-database')");
    try {
      await expect(trash(ws,id,1,"rejected-by-database")).rejects.toMatchObject({code:"23514"});
      expect(await admin.previewAdminWorkTrash(ws,id)).toMatchObject({eligible:true,version:1});
      expect(await admin.listAdminWorkLogs(ws)).toEqual([]);
    } finally { await pool.query("ALTER TABLE admin_work_action DROP CONSTRAINT test_audit_failure"); }
  });

  it("supports installations where the formal migration precedes the optional creator trash draft", async () => {
    const freshSchema = `${schema}_new`;
    const fresh = new Pool({connectionString: process.env.DATABASE_URL, options: `-c search_path=${freshSchema}`});
    await setupSchema(freshSchema);
    try {
      await runMigrations(fresh);
      await fresh.query(await readFile(draftPath,"utf8"));
      expect((await fresh.query("SELECT 1 FROM pg_trigger WHERE tgrelid='workflow_run'::regclass AND tgname='workbench_active_project_insert'")).rowCount).toBe(1);
    } finally {
      await fresh.end();
      await root.query(`DROP SCHEMA "${freshSchema}" CASCADE`);
    }
  });
});
