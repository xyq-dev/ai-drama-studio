import "reflect-metadata";
import { Controller, Get, Module, Req, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  formatCreatorPlanUnpricedAmount,
  LEGACY_OWNER_ACCOUNT_ID,
  mayPostCreatorLedgerEntry,
} from "@ai-drama/domain";
import { PersistenceError, storeOwnerAccountFilter } from "@ai-drama/database";
import type { ApiEnv } from "../config/env";
import { SafeExceptionFilter } from "../http/safe-exception.filter";
import { AuthModule } from "../auth/auth.module";
import { hashPassword } from "../auth/password-hash";
import { SiteAuth, type CreatorLoginDirectory } from "../auth/site-auth";

const ORIGIN = "https://drama.example.test";
const OPERATOR = "admin";
const PASSWORD = "test-only-site-password-Qm7#x";
const ALICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ALICE_PROJECT = "11111111-1111-4111-8111-111111111101";
const BOB_PROJECT = "11111111-1111-4111-8111-111111111102";
const LEGACY_PROJECT = "11111111-1111-4111-8111-111111111103";
const MISSING_PROJECT = "11111111-1111-4111-8111-111111111199";
const BOB_RUN = "22222222-2222-4222-8222-222222222202";

let HASH = "";
let ALICE_HASH = "";
let BOB_HASH = "";

const ownedBy = new Map<string, string>([
  [ALICE_PROJECT, ALICE],
  [BOB_PROJECT, BOB],
  [LEGACY_PROJECT, LEGACY_OWNER_ACCOUNT_ID],
]);
const runOwner = new Map<string, string>([[BOB_RUN, BOB]]);

function requireOwnedProject(projectId: string): { id: string } {
  const owner = storeOwnerAccountFilter();
  const actual = ownedBy.get(projectId);
  if (!actual || (owner && actual !== owner)) {
    throw new PersistenceError("NOT_FOUND", "Project not found");
  }
  return { id: projectId };
}

function requireOwnedRun(runId: string): { id: string } {
  const owner = storeOwnerAccountFilter();
  const actual = runOwner.get(runId);
  if (!actual || (owner && actual !== owner)) {
    throw new PersistenceError("NOT_FOUND", "Workflow run not found");
  }
  return { id: runId };
}

function param(request: { params?: Record<string, string> }, name: string): string {
  return request.params?.[name] ?? "";
}

class FixtureRoutes {
  list() {
    const owner = storeOwnerAccountFilter();
    const items = [...ownedBy.entries()]
      .filter(([, accountId]) => !owner || accountId === owner)
      .map(([id]) => ({ id }));
    return { items };
  }

  get(request: { params?: Record<string, string> }) {
    return requireOwnedProject(param(request, "projectId"));
  }

  autoLatest(request: { params?: Record<string, string> }) {
    requireOwnedProject(param(request, "projectId"));
    return { runId: `${param(request, "projectId")}-auto` };
  }

  download(request: { params?: Record<string, string> }) {
    requireOwnedProject(param(request, "projectId"));
    return { ok: true };
  }

  exportManifest(request: { params?: Record<string, string> }) {
    requireOwnedProject(param(request, "projectId"));
    return { ok: true };
  }

  workflow(request: { params?: Record<string, string> }) {
    return requireOwnedRun(param(request, "runId"));
  }
}

function route(path: string, method: keyof FixtureRoutes) {
  Get(path)(FixtureRoutes.prototype, method, Object.getOwnPropertyDescriptor(FixtureRoutes.prototype, method)!);
  Req()(FixtureRoutes.prototype, method, 0);
}
route("projects", "list");
route("projects/:projectId", "get");
route("projects/:projectId/auto-runs/latest", "autoLatest");
route("projects/:projectId/episodes/:episodeId/composites/:assetId/download", "download");
route("projects/:projectId/episodes/:episodeId/composites/:assetId/export-manifest", "exportManifest");
route("workflow-runs/:runId", "workflow");
Controller()(FixtureRoutes);

describe("creator isolation fixtures (phase 4)", () => {
  let app: INestApplication | undefined;
  let base = "";

  beforeAll(async () => {
    HASH = await hashPassword(PASSWORD, { log2N: 15, r: 8, p: 1, saltBytes: 16, keyBytes: 32 });
    ALICE_HASH = await hashPassword("alice-fixture-password", { log2N: 15, r: 8, p: 1, saltBytes: 16, keyBytes: 32 });
    BOB_HASH = await hashPassword("bob-fixture-password", { log2N: 15, r: 8, p: 1, saltBytes: 16, keyBytes: 32 });
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function start(options: { registrationEnabled?: boolean } = {}) {
    const creators: CreatorLoginDirectory = {
      findActiveByUsername: async (username) => {
        if (username === "alice") return { id: ALICE, username: "alice", passwordHash: ALICE_HASH };
        if (username === "bob") return { id: BOB, username: "bob", passwordHash: BOB_HASH };
        return null;
      },
    };
    const auth = new SiteAuth(
      { username: OPERATOR, passwordHash: HASH, publicOrigin: ORIGIN },
      { creators, publicRegistrationEnabled: options.registrationEnabled === true },
    );
    class Routes {}
    Module({ controllers: [FixtureRoutes] })(Routes);
    const module = await Test.createTestingModule({
      imports: [AuthModule.register({ NODE_ENV: "test", APP_WORKSPACE_ID: "11111111-1111-4111-8111-111111111111" } as ApiEnv,
        { kind: "enabled", auth }), Routes],
    }).compile();
    app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix("api/v1");
    app.useGlobalFilters(new SafeExceptionFilter());
    await app.listen(0, "127.0.0.1");
    base = `${await app.getUrl()}/api/v1`;
  }

  async function login(username: string, password: string) {
    const response = await fetch(`${base}/auth/login`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    expect(response.status).toBe(200);
    const cookie = response.headers.getSetCookie().find((item) => item.startsWith("__Host-ads_session="))!.split(";", 1)[0]!;
    return { cookie, body: await response.json() as Record<string, unknown> };
  }

  it("flag off: unauthenticated session reports registration closed; POST /auth/register is 403", async () => {
    await start({ registrationEnabled: false });
    const session = await fetch(`${base}/auth/session`);
    expect(session.status).toBe(200);
    expect(await session.json()).toEqual({
      enabled: true, authenticated: false, publicRegistrationEnabled: false,
    });
    const register = await fetch(`${base}/auth/register`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ username: "newbie", password: "password-1234" }),
    });
    expect(register.status).toBe(403);
    expect(await register.json()).toMatchObject({ error: { code: "AUTH_REGISTRATION_DISABLED" } });
  });

  it("flag on: unauthenticated session reports the flag so /register can open the form", async () => {
    await start({ registrationEnabled: true });
    const session = await fetch(`${base}/auth/session`);
    expect(session.status).toBe(200);
    expect(await session.json()).toEqual({
      enabled: true, authenticated: false, publicRegistrationEnabled: true,
    });
  });

  it("two creators only list their own works; legacy works stay invisible to new creators", async () => {
    await start();
    const alice = await login("alice", "alice-fixture-password");
    const bob = await login("bob", "bob-fixture-password");
    const aliceList = await (await fetch(`${base}/projects`, { headers: { cookie: alice.cookie } })).json() as { items: Array<{ id: string }> };
    const bobList = await (await fetch(`${base}/projects`, { headers: { cookie: bob.cookie } })).json() as { items: Array<{ id: string }> };
    expect(aliceList.items.map((item) => item.id)).toEqual([ALICE_PROJECT]);
    expect(bobList.items.map((item) => item.id)).toEqual([BOB_PROJECT]);
    expect(aliceList.items.map((item) => item.id)).not.toContain(LEGACY_PROJECT);
    expect(bobList.items.map((item) => item.id)).not.toContain(LEGACY_PROJECT);
  });

  it("cross-account project/run/download/export/auto-creation look like the same opaque 404 as a missing id", async () => {
    await start();
    const alice = await login("alice", "alice-fixture-password");
    const headers = { cookie: alice.cookie };
    const missing = await fetch(`${base}/projects/${MISSING_PROJECT}`, { headers });
    const cross = await fetch(`${base}/projects/${BOB_PROJECT}`, { headers });
    const legacy = await fetch(`${base}/projects/${LEGACY_PROJECT}`, { headers });
    const auto = await fetch(`${base}/projects/${BOB_PROJECT}/auto-runs/latest`, { headers });
    const download = await fetch(`${base}/projects/${BOB_PROJECT}/episodes/${MISSING_PROJECT}/composites/${MISSING_PROJECT}/download`, { headers });
    const exported = await fetch(`${base}/projects/${BOB_PROJECT}/episodes/${MISSING_PROJECT}/composites/${MISSING_PROJECT}/export-manifest`, { headers });
    const run = await fetch(`${base}/workflow-runs/${BOB_RUN}`, { headers });
    for (const response of [missing, cross, legacy, auto, download, exported, run]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
    }
  });

  it("keeps 尚未计价 and unconfirmed ledger posts as non-billing failures", () => {
    expect(formatCreatorPlanUnpricedAmount()).toBe("尚未计价");
    expect(mayPostCreatorLedgerEntry({ confirmed: false })).toBe(false);
    expect(mayPostCreatorLedgerEntry({ confirmed: true })).toBe(true);
  });
});
