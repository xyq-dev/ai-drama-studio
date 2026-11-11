import "reflect-metadata";
import { Module, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresPool, runMigrations } from "@ai-drama/database";
import type { ScriptWorkbenchPlan } from "@ai-drama/contracts";
import { checkDisposableAcceptanceEnv, verifyDisposableAcceptanceDatabase } from "../../../../packages/database/src/disposable-acceptance-guard";
import { AuthModule } from "../auth/auth.module";
import { hashPassword } from "../auth/password-hash";
import type { ApiEnv } from "../config/env";
import { SafeExceptionFilter } from "../http/safe-exception.filter";
import { ScriptWorkbenchController, SCRIPT_WORKBENCH_SERVICE } from "./script-workbench.controller";
import { ScriptWorkbenchService } from "./script-workbench.service";

const pattern = /^ads_workbench_acceptance_[a-z0-9_]+$/;
if (process.env.SCRIPT_WORKBENCH_TEST_ALLOW_WRITES !== "true" || process.env.SCRIPT_WORKBENCH_TEST_ALLOW_DRAFT !== "true") throw new Error("Explicit disposable-write and draft flags required");
const decision = checkDisposableAcceptanceEnv({ databaseName: process.env.SCRIPT_WORKBENCH_TEST_DATABASE_NAME,
  url: process.env.SCRIPT_WORKBENCH_TEST_DATABASE_URL, businessDatabaseUrl: process.env.DATABASE_URL, namePattern: pattern, nameHint: pattern.source });
if (!decision.ok) throw new Error(decision.reason);
const pool = createPostgresPool({ connectionString: decision.url, connectionTimeoutMs: 2000, statementTimeoutMs: 15000, queryTimeoutMs: 15000 });
const workspaceId = randomUUID(); const otherWorkspaceId = randomUUID(); const projectId = randomUUID(); const otherProjectId = randomUUID();
const origin = "https://workbench.example.test";
const password = "test-only-workbench-password-938#";
let app: INestApplication; let base = ""; let readHeaders: Record<string, string>; let writeHeaders: Record<string, string>;
const plan: ScriptWorkbenchPlan = { brief: { genre: "悬疑", audience: "悬疑爱好者", productionConstraints: "两人一室", logline: "找出真相", targetEpisodeSeconds: 27, dialogueQuota: 4 },
  bible: { ending: "真相公开", openThreads: "无", characters: [{ id: "R01", name: "青", appearance: "青衣", voice: "清晰", aliases: "阿青", knownInformation: "见过信" }] },
  outline: { episodes: [{ episodeNo: 1, title: "来客", openingHook: "门响", change: "发现信", endingHandoff: "门开" }] } };
function request(path: string, init: RequestInit = {}) { return fetch(`${base}${path}`, { redirect: "manual", ...init }); }
function write(path: string, body: unknown, headers: Record<string, string> = {}) {
  return request(path, { method: "POST", headers: { ...writeHeaders, "idempotency-key": randomUUID(), "if-match": "1", ...headers }, body: JSON.stringify(body) });
}
beforeAll(async () => {
  const safe = await verifyDisposableAcceptanceDatabase(pool as Parameters<typeof verifyDisposableAcceptanceDatabase>[0], decision.databaseName, pattern);
  if (!safe.ok) throw new Error(safe.reason);
  await runMigrations(pool);
  await pool.query(await readFile(resolve("../../packages/database/prisma/drafts/20261111000300_script_workbench_trash.sql"), "utf8"));
  await pool.query("INSERT INTO workspace(id,name) VALUES($1,'workbench HTTP'),($2,'other workspace')", [workspaceId, otherWorkspaceId]);
  await pool.query("INSERT INTO project(id,workspace_id,title,episode_count,target_episode_seconds) VALUES($1,$2,'HTTP验收',1,60),($3,$4,'其他空间',1,60)", [projectId, workspaceId, otherProjectId, otherWorkspaceId]);
  const hash = await hashPassword(password, { log2N: 15, r: 8, p: 1, saltBytes: 16, keyBytes: 32 });
  const env = { NODE_ENV: "test", SITE_AUTH_ENABLED: "true", SITE_AUTH_USERNAME: "qa", SITE_AUTH_PASSWORD_HASH: hash, SITE_AUTH_PUBLIC_ORIGIN: origin } as ApiEnv;
  class Routes {}
  Module({ controllers: [ScriptWorkbenchController], providers: [{ provide: SCRIPT_WORKBENCH_SERVICE, useValue: new ScriptWorkbenchService(pool, workspaceId) }] })(Routes);
  const module = await Test.createTestingModule({ imports: [AuthModule.register(env), Routes] }).compile();
  app = module.createNestApplication({ logger: false }); app.setGlobalPrefix("api/v1"); app.useGlobalFilters(new SafeExceptionFilter());
  await app.listen(0, "127.0.0.1"); base = `${await app.getUrl()}/api/v1`;
  const login = await request("/auth/login", { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ username: "qa", password }) });
  expect(login.status).toBe(200);
  const cookies = login.headers.getSetCookie().filter(value => value.startsWith("__Host-ads_")).map(value => value.split(";", 1)[0]).join("; ");
  const session = await login.json() as { csrfToken: string };
  readHeaders = { cookie: cookies }; writeHeaders = { cookie: cookies, origin, "content-type": "application/json", "x-csrf-token": session.csrfToken };
});
afterAll(async () => { await app?.close(); await pool.end(); });

describe("script workbench HTTP boundaries", () => {
  it("requires authentication for both workbench and trash reads", async () => {
    expect((await request(`/projects/${projectId}/script-workbench`)).status).toBe(401);
    expect((await request("/script-workbench/trash")).status).toBe(401);
  });
  it("rejects authenticated mutations without CSRF or from a foreign origin", async () => {
    expect((await request(`/projects/${projectId}/script-workbench/plan`, { method: "POST", headers: { ...readHeaders, origin, "content-type": "application/json" }, body: JSON.stringify({ plan }) })).status).toBe(403);
    expect((await write(`/projects/${projectId}/script-workbench/plan`, { plan }, { origin: "https://foreign.example.test" })).status).toBe(403);
    expect((await request(`/projects/${projectId}/script-workbench/trash`, { method: "POST", headers: { ...readHeaders, origin, "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: 1 }) })).status).toBe(403);
  });
  it("rejects browser-supplied workspace scope, invalid IDs, malformed plans and missing versions", async () => {
    expect((await write(`/projects/${projectId}/script-workbench/plan`, { plan, workspaceId: otherWorkspaceId })).status).toBe(400);
    expect((await write(`/projects/${projectId}/script-workbench/plan`, { plan: { ...plan, brief: { ...plan.brief, dialogueQuota: -1 } } })).status).toBe(400);
    expect((await write(`/projects/${projectId}/script-workbench/plan`, { plan }, { "if-match": "" })).status).toBe(400);
    expect((await request("/projects/not-a-uuid/script-workbench", { headers: readHeaders })).status).toBe(400);
  });
  it("never exposes another workspace through snapshot, preview, or a forged write", async () => {
    expect((await request(`/projects/${otherProjectId}/script-workbench`, { headers: readHeaders })).status).toBe(404);
    expect((await request(`/projects/${otherProjectId}/script-workbench/deletion-preview`, { headers: readHeaders })).status).toBe(404);
    expect((await write(`/projects/${otherProjectId}/script-workbench/plan`, { plan })).status).toBe(404);
  });
  it("persists a valid plan, returns no-store snapshots, replays its key and rejects stale saves", async () => {
    const key = randomUUID(); const path = `/projects/${projectId}/script-workbench/plan`;
    const first = await write(path, { plan }, { "idempotency-key": key }); expect(first.status).toBe(201);
    const firstBody = await first.json();
    const retry = await write(path, { plan }, { "idempotency-key": key }); expect(retry.status).toBe(201); expect(await retry.json()).toEqual(firstBody);
    expect((await write(path, { plan })).status).toBe(409);
    const snapshot = await request(`/projects/${projectId}/script-workbench`, { headers: readHeaders });
    expect(snapshot.status).toBe(200); expect(snapshot.headers.get("cache-control")).toBe("no-store");
    expect(await snapshot.json()).toMatchObject({ story: { reviewStatus: "DRAFT", content: { workbench: { plan } } }, project: { version: 2 } });
  });
});
