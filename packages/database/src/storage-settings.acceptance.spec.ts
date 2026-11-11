/** Opt-in, disposable PostgreSQL only. No provider calls or real credentials. Never collected by normal tests. */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrations";
import { checkDisposableAcceptanceEnv, verifyDisposableAcceptanceDatabase } from "./disposable-acceptance-guard";
import { StorageSettingsStore, openStorageSettingsStore, type StorageServerConfiguration } from "./storage-settings-store";
const pattern = /^ads_storage_acceptance_[a-z0-9_]+$/;
if (process.env.STORAGE_SETTINGS_TEST_ALLOW_WRITES !== "true" || process.env.STORAGE_SETTINGS_TEST_ALLOW_DRAFT !== "true") throw new Error("Storage acceptance requires explicit isolated writes and draft flags");
const decision = checkDisposableAcceptanceEnv({ databaseName: process.env.STORAGE_SETTINGS_TEST_DATABASE_NAME, url: process.env.STORAGE_SETTINGS_TEST_DATABASE_URL, businessDatabaseUrl: process.env.DATABASE_URL, namePattern: pattern, nameHint: pattern.source });
if (!decision.ok) throw new Error(`Storage acceptance refused: ${decision.reason}`);
const pool = new Pool({ connectionString: decision.url, max: 8, connectionTimeoutMillis: 5000, statement_timeout: 15000, query_timeout: 20000, application_name: "storage-settings-isolated-acceptance" });
const master = Buffer.alloc(32, 7), legacy: StorageServerConfiguration = { provider: "s3", endpoint: "https://legacy.example.test", region: "us-east-1", bucket: "legacy-bucket", accessKeyId: "synthetic-legacy-id", secretAccessKey: "synthetic-legacy-secret", prefix: "", forcePathStyle: true };
const managed: StorageServerConfiguration = { ...legacy, provider: "oss", endpoint: "https://oss-cn-hangzhou.aliyuncs.com", region: "cn-hangzhou", bucket: "managed-bucket", prefix: "assets/", forcePathStyle: false, accessKeyId: "synthetic-new-id", secretAccessKey: "synthetic-new-secret" };
let baseline: string[];
beforeAll(async () => {
  const safe = await verifyDisposableAcceptanceDatabase(pool, decision.databaseName, pattern); if (!safe.ok) throw new Error(safe.reason);
  const result = await runMigrations(pool); baseline = result.applied;
  await pool.query(await readFile(resolve(__dirname, "../prisma/drafts/20261111000100_storage_settings.sql"), "utf8"));
});
afterAll(async () => { await pool.end(); });
async function world() {
  const workspaceId = (await pool.query("INSERT INTO workspace(name) VALUES('Synthetic storage acceptance') RETURNING id")).rows[0].id as string;
  let time = Date.now();
  const store = new StorageSettingsStore(pool, workspaceId, master, legacy, () => time);
  return { workspaceId, store, key: () => `real-media/${workspaceId}/${randomUUID()}/${randomUUID()}/${randomUUID()}/${"a".repeat(64)}.png`, advance: (ms: number) => { time += ms; } };
}
const save = async (store: StorageSettingsStore, expectedRevision: number, configuration = managed) => store.save({ ...configuration, expectedRevision, secretAction: "replace" }, () => undefined);
async function pass(store: StorageSettingsStore) { const view = await store.view(); await store.recordTest(view.revision, view.draft!.id!, true); }
async function activate(store: StorageSettingsStore) { await pass(store); await store.activate((await store.view()).revision); }
describe("persistent storage revisions on an empty disposable PostgreSQL database", () => {
  it("is a separate draft and GET has no write side effects", async () => {
    expect(baseline.some(name => name.includes("storage_settings"))).toBe(false);
    const w = await world(); await w.store.assertReady(); expect(await w.store.view()).toMatchObject({ revision: 0, draft: null, active: { id: null, source: "environment" } });
    expect((await pool.query("SELECT 1 FROM storage_settings_state WHERE workspace_id=$1", [w.workspaceId])).rowCount).toBe(0);
  });
  it("freezes legacy, preserves all historical targets across switches, restarts and failed-write replay", async () => {
    const w = await world(), before = w.key(), unboundOld = w.key(), after = w.key();
    const original = await w.store.reserve(before); expect(original.source).toBe("environment");
    await save(w.store, 0); expect((await w.store.resolve(unboundOld)).configuration).toEqual(legacy);
    await activate(w.store); const first = await w.store.reserve(after); expect(first.source).toBe("managed"); expect(first.configuration.prefix).toBe("assets");
    await save(w.store, (await w.store.view()).revision, { ...managed, bucket: "second-bucket" }); await activate(w.store);
    expect((await w.store.reserve(after)).id).toBe(first.id); expect((await w.store.resolve(before)).id).toBe(original.id);
    const restarted = new StorageSettingsStore(pool, w.workspaceId, master, { ...legacy, endpoint: "https://changed-environment.test" });
    expect((await restarted.resolve(unboundOld)).configuration).toEqual(legacy); expect((await restarted.resolve(after)).id).toBe(first.id);
    expect((await restarted.reserve(w.key())).configuration.bucket).toBe("second-bucket");
  });
  it("serializes concurrent saves and gives exactly one writer the expected revision", async () => {
    const w = await world(); const results = await Promise.allSettled([save(w.store, 0), save(w.store, 0)]);
    expect(results.filter(v => v.status === "fulfilled")).toHaveLength(1);
    expect(results.find(v => v.status === "rejected")).toMatchObject({ reason: { code: "STORAGE_SETTINGS_CONFLICT" } }); expect((await w.store.view()).revision).toBe(1);
  });
  it("holds an immutable reservation while activation wins concurrently", async () => {
    const w = await world(), key = w.key(); await save(w.store, 0); await pass(w.store);
    const [reservation] = await Promise.all([w.store.reserve(key), w.store.activate(2)]);
    expect((await w.store.reserve(key)).id).toBe(reservation.id); expect((await w.store.resolve(key)).id).toBe(reservation.id);
    expect((await w.store.reserve(w.key())).source).toBe("managed");
  });
  it("cannot activate untested, failed, expired or superseded drafts", async () => {
    const w = await world(); await save(w.store, 0);
    await expect(w.store.activate(1)).rejects.toMatchObject({ code: "STORAGE_SETTINGS_TEST_REQUIRED" });
    await w.store.recordTest(1, (await w.store.view()).draft!.id!, false); await expect(w.store.activate(2)).rejects.toMatchObject({ code: "STORAGE_SETTINGS_TEST_REQUIRED" });
    await pass(w.store); w.advance(15 * 60_000 + 1); await expect(w.store.activate(3)).rejects.toMatchObject({ code: "STORAGE_SETTINGS_TEST_REQUIRED" });
    const prior = await w.store.draftForTest(3); await save(w.store, 3); await expect(w.store.recordTest(3, prior.id!, true)).rejects.toMatchObject({ code: "STORAGE_SETTINGS_CONFLICT" });
    expect((await w.store.view()).test.status).toBe("not_tested");
  });
  it("retains credentials only for the same provider and never stores plaintext or returns either credential", async () => {
    const w = await world(); await save(w.store, 0);
    const { accessKeyId: _id, secretAccessKey: _secret, ...fields } = managed;
    await w.store.save({ ...fields, expectedRevision: 1, secretAction: "keep", prefix: "other" }, () => undefined);
    expect((await w.store.draftForTest(2)).configuration.secretAccessKey).toBe(managed.secretAccessKey);
    await expect(w.store.save({ ...fields, provider: "cos", expectedRevision: 2, secretAction: "keep" }, () => undefined)).rejects.toMatchObject({ code: "STORAGE_SETTINGS_CREDENTIALS_REQUIRED" });
    const dump = JSON.stringify((await pool.query("SELECT * FROM storage_configuration_revision WHERE workspace_id=$1", [w.workspaceId])).rows) + JSON.stringify(await w.store.view());
    for (const secret of [legacy.accessKeyId, legacy.secretAccessKey, managed.accessKeyId, managed.secretAccessKey]) expect(dump).not.toContain(secret);
  });
  it("enforces immutable history, scoped foreign keys, immutable legacy and monotonic state revision in SQL", async () => {
    const w = await world(), other = await world(); await save(w.store, 0); await save(other.store, 0); const key = w.key(); await w.store.reserve(key);
    await expect(pool.query("UPDATE storage_configuration_revision SET source='managed' WHERE workspace_id=$1", [w.workspaceId])).rejects.toThrow();
    await expect(pool.query("DELETE FROM storage_object_binding WHERE workspace_id=$1", [w.workspaceId])).rejects.toThrow();
    await expect(pool.query("UPDATE storage_settings_state SET active_id=draft_id WHERE workspace_id=$1", [w.workspaceId])).rejects.toThrow();
    await expect(pool.query("UPDATE storage_settings_state SET revision=revision+1,legacy_id=draft_id WHERE workspace_id=$1", [w.workspaceId])).rejects.toThrow();
    await expect(pool.query("INSERT INTO storage_object_binding(workspace_id,object_key,configuration_id) VALUES($1,$2,$3)", [w.workspaceId, w.key(), (await other.store.view()).draft!.id])).rejects.toThrow();
    await expect(w.store.reserve(other.key())).rejects.toMatchObject({ code: "STORAGE_OBJECT_KEY_INVALID" });
  });
  it("fails closed on a lost/wrong master even if the console switch is off", async () => {
    const w = await world(); expect(await openStorageSettingsStore(pool, w.workspaceId, {}, legacy)).toBeNull(); await save(w.store, 0);
    await expect(openStorageSettingsStore(pool, w.workspaceId, {}, legacy)).rejects.toMatchObject({ code: "STORAGE_SETTINGS_UNAVAILABLE" });
    await expect(openStorageSettingsStore(pool, w.workspaceId, { STORAGE_SETTINGS_KEY: Buffer.alloc(32, 8).toString("base64") }, legacy)).rejects.toMatchObject({ code: "STORAGE_SETTINGS_UNAVAILABLE" });
    const reopened = await openStorageSettingsStore(pool, w.workspaceId, { STORAGE_SETTINGS_ENABLED: "false", STORAGE_SETTINGS_KEY: master.toString("base64") }, legacy); expect(reopened).not.toBeNull();
  });
});
