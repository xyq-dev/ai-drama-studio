import "reflect-metadata";
import { Controller, Get, Module, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  LEGACY_OWNER_ACCOUNT_ID,
  mayPostCreatorLedgerEntry,
} from "@ai-drama/domain";
import {
  runWithStoreCreatorAccess,
  storeOwnerAccountFilter,
} from "@ai-drama/database";
import type { ApiEnv } from "../config/env";
import { SafeExceptionFilter } from "../http/safe-exception.filter";
import { AuthModule } from "../auth/auth.module";
import { hashPassword } from "../auth/password-hash";
import { SiteAuth, type CreatorLoginDirectory } from "../auth/site-auth";
import { MEMBERSHIP_STORE, MemoryMembershipStore } from "../membership/membership-store";
import { runWithCreatorAccess } from "../auth/creator-access";

const ORIGIN = "https://drama.example.test";
const OPERATOR = "admin";
const PASSWORD = "test-only-site-password-Qm7#x";
let HASH = "";

class ProbeRoutes {
  mine() {
    return { ownerFilter: storeOwnerAccountFilter(), legacy: LEGACY_OWNER_ACCOUNT_ID };
  }
}
Get("probe/mine")(ProbeRoutes.prototype, "mine", Object.getOwnPropertyDescriptor(ProbeRoutes.prototype, "mine")!);
Controller()(ProbeRoutes);

describe("creator isolation access scope (phase 4)", () => {
  let app: INestApplication | undefined;
  let base = "";

  beforeAll(async () => {
    HASH = await hashPassword(PASSWORD, { log2N: 15, r: 8, p: 1, saltBytes: 16, keyBytes: 32 });
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function start(creators: CreatorLoginDirectory | null = null, membership: MemoryMembershipStore | null = null) {
    const auth = new SiteAuth(
      { username: OPERATOR, passwordHash: HASH, publicOrigin: ORIGIN },
      { creators, publicRegistrationEnabled: false },
    );
    class Routes {}
    Module({ controllers: [ProbeRoutes] })(Routes);
    const module = await Test.createTestingModule({
      imports: [AuthModule.register({ NODE_ENV: "test", APP_WORKSPACE_ID: "11111111-1111-4111-8111-111111111111" } as ApiEnv,
        { kind: "enabled", auth }), Routes],
    }).overrideProvider(MEMBERSHIP_STORE).useValue(membership).compile();
    app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix("api/v1");
    app.useGlobalFilters(new SafeExceptionFilter());
    await app.listen(0, "127.0.0.1");
    base = `${await app.getUrl()}/api/v1`;
    return auth;
  }

  it("operator login still works and binds legacy ownership for 我的作品 filter", async () => {
    await start();
    const login = await fetch(`${base}/auth/login`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ username: OPERATOR, password: PASSWORD }),
    });
    expect(login.status).toBe(200);
    const session = await login.json() as { role: string; accountId: string; publicRegistrationEnabled: boolean };
    expect(session.role).toBe("operator");
    expect(session.accountId).toBe(LEGACY_OWNER_ACCOUNT_ID);
    expect(session.publicRegistrationEnabled).toBe(false);
    const cookie = login.headers.getSetCookie().find((item) => item.startsWith("__Host-ads_session="))!.split(";", 1)[0]!;
    const probe = await fetch(`${base}/probe/mine`, { headers: { cookie } });
    expect(probe.status).toBe(200);
    expect(await probe.json()).toEqual({ ownerFilter: LEGACY_OWNER_ACCOUNT_ID, legacy: LEGACY_OWNER_ACCOUNT_ID });
    // Operator ops view clears the ALS owner filter (acceptance fixtures use this across multi-workspace DBs).
    const ops = await fetch(`${base}/probe/mine?view=ops`, { headers: { cookie } });
    expect(ops.status).toBe(200);
    expect(await ops.json()).toEqual({ ownerFilter: null, legacy: LEGACY_OWNER_ACCOUNT_ID });
  });

  it("site auth disabled opens ALS so fixtures are not owner-filtered", async () => {
    class Routes {}
    Module({ controllers: [ProbeRoutes] })(Routes);
    const module = await Test.createTestingModule({
      imports: [AuthModule.register({ NODE_ENV: "test" } as ApiEnv, { kind: "disabled" }), Routes],
    }).compile();
    app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix("api/v1");
    app.useGlobalFilters(new SafeExceptionFilter());
    await app.listen(0, "127.0.0.1");
    base = `${await app.getUrl()}/api/v1`;
    const probe = await fetch(`${base}/probe/mine`);
    expect(probe.status).toBe(200);
    expect(await probe.json()).toEqual({ ownerFilter: null, legacy: LEGACY_OWNER_ACCOUNT_ID });
  });

  it("two creator scopes do not share an owner filter", () => {
    const a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const seen: Array<string | null> = [];
    runWithCreatorAccess({
      kind: "scoped", role: "creator", accountId: a, username: "alice", opsView: false,
    }, () => { seen.push(storeOwnerAccountFilter()); });
    runWithCreatorAccess({
      kind: "scoped", role: "creator", accountId: b, username: "bob", opsView: false,
    }, () => { seen.push(storeOwnerAccountFilter()); });
    expect(seen).toEqual([a, b]);
  });

  it("operator ops view clears the owner filter; creator cannot", () => {
    expect(runWithCreatorAccess({
      kind: "scoped", role: "operator", accountId: LEGACY_OWNER_ACCOUNT_ID, username: "admin", opsView: true,
    }, () => storeOwnerAccountFilter())).toBeNull();
    expect(runWithCreatorAccess({
      kind: "scoped", role: "creator", accountId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", username: "cara", opsView: true,
    }, () => storeOwnerAccountFilter())).toBe("cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  });

  it("public registration stays default-off on the auth object", async () => {
    const auth = await start();
    expect(auth.registrationEnabled()).toBe(false);
  });

  it("unconfirmed ledger posts are refused by domain rule", () => {
    expect(mayPostCreatorLedgerEntry({ confirmed: false })).toBe(false);
    expect(mayPostCreatorLedgerEntry({ confirmed: true })).toBe(true);
  });

  it("preflights the signed-in creator's writing balance over HTTP without reserving or disclosing the ledger", async () => {
    const id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const workspace = "11111111-1111-4111-8111-111111111111";
    const membership = new MemoryMembershipStore();
    await start({ findActiveByUsername: async username => username === "alice" ? { id, username, passwordHash: HASH } : null }, membership);
    const login = await fetch(`${base}/auth/login`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", password: PASSWORD }) });
    expect(login.status).toBe(200);
    const cookie = login.headers.getSetCookie().find(item => item.startsWith("__Host-ads_session="))!.split(";", 1)[0]!;
    async function preflight() {
      const res = await fetch(`${base}/account/membership?preflight=writing`, { headers: { cookie } });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toContain("no-store");
      return res.json();
    }
    expect(await preflight()).toEqual({ denial: "MEMBERSHIP_REQUIRED" });
    const details = { code: "one", name: "编剧", description: "", unitPriceAmount: null, unitPriceCurrency: null, active: true };
    const plan = await membership.savePlan(workspace, { ...details, features: [{ feature: "writing", enabled: true, includedUnits: 1 }] });
    await membership.grant(workspace, { accountId: id, planId: plan.id, startsAt: new Date(Date.now()-60000),
      endsAt: new Date(Date.now()+60000), reason: "测试", grantedBy: null });
    const before = await membership.ledger(workspace, id);
    expect(await preflight()).toEqual({ denial: null });
    expect(await preflight()).toEqual({ denial: null });
    expect(await membership.ledger(workspace, id)).toEqual(before);
    expect((await membership.balances(workspace, id)).writing).toBe(1);
    await membership.savePlan(workspace, { ...details, id: plan.id, features: [{ feature: "writing", enabled: false, includedUnits: 1 }] });
    expect(await preflight()).toEqual({ denial: "FEATURE_NOT_INCLUDED" });
    await membership.savePlan(workspace, { ...details, id: plan.id, features: [{ feature: "writing", enabled: true, includedUnits: 1 }] });
    await membership.adjust(workspace, { accountId: id, feature: "writing", delta: -1, reason: "测试", actorId: "fixture-operator" });
    expect(await preflight()).toEqual({ denial: "QUOTA_EXHAUSTED" });
  });

  it("creator directory authenticates a fixture creator without touching operator password", async () => {
    const creatorId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const creatorHash = await hashPassword("creator-fixture-password", { log2N: 15, r: 8, p: 1, saltBytes: 16, keyBytes: 32 });
    await start({
      findActiveByUsername: async (username) => username === "alice"
        ? { id: creatorId, username: "alice", passwordHash: creatorHash }
        : null,
    });
    const login = await fetch(`${base}/auth/login`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "creator-fixture-password" }),
    });
    expect(login.status).toBe(200);
    const session = await login.json() as { role: string; accountId: string; username: string };
    expect(session).toMatchObject({ role: "creator", accountId: creatorId, username: "alice" });
    const cookie = login.headers.getSetCookie().find((item) => item.startsWith("__Host-ads_session="))!.split(";", 1)[0]!;
    const probe = await fetch(`${base}/probe/mine`, { headers: { cookie } });
    expect(await probe.json()).toEqual({ ownerFilter: creatorId, legacy: LEGACY_OWNER_ACCOUNT_ID });
  });

  it("store ALS open access keeps null owner filter for legacy tests", () => {
    expect(runWithStoreCreatorAccess({ kind: "open" }, () => storeOwnerAccountFilter())).toBeNull();
  });

  it("signed-out session probe returns the registration flag (default off)", async () => {
    await start();
    const response = await fetch(`${base}/auth/session`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      enabled: true, authenticated: false, publicRegistrationEnabled: false,
    });
  });
});
