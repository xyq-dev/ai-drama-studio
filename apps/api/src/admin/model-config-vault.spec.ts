import { createCipheriv, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminLimitsUpdate, AdminProviderUpdate } from "@ai-drama/contracts";
import { ModelConfigVault, type ManagedModelSettings } from "./model-config-vault";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename), open: vi.fn(actual.open) };
});

const SECRET = "sk-vault-private-test-123456789";
const FORMAT = "ai-drama-studio.admin-model-vault.v1";
const FILES = ["model-config.enc", "model-config.enc.initialized"];
const initial = (): ManagedModelSettings => ({
  revision: 0, defaultProvider: "qwen", maxCallsPerDay: 30, maxActiveRuns: 1,
  providers: {
    qwen: { apiKey: null, baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", models: ["qwen-test"] },
    openai: { apiKey: null, baseUrl: "https://api.openai.com/v1/responses", models: [] },
    deepseek: { apiKey: null, baseUrl: "https://api.deepseek.com/chat/completions", models: [] },
  },
});
const update = (expectedRevision = 0): AdminProviderUpdate => ({
  expectedRevision, secretAction: "replace", apiKey: SECRET, models: ["qwen-test"],
});
const directories: string[] = [];

async function harness() {
  const directory = await fs.mkdtemp(join(tmpdir(), "ads-admin-vault-"));
  directories.push(directory);
  await fs.chmod(directory, 0o700);
  const path = join(directory, "model-config.enc");
  const masterKey = randomBytes(32);
  const settings = initial();
  const vault = await ModelConfigVault.open({ path, masterKey, initial: settings });
  return { directory, path, masterKey, settings, vault,
    reopen: () => ModelConfigVault.open({ path, masterKey, initial: initial() }) };
}

async function seal(path: string, masterKey: Buffer, value: unknown, aad = FORMAT) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, nonce);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  await fs.writeFile(path, JSON.stringify({ format: FORMAT, nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") }), { mode: 0o600 });
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(fs.rename).mockReset();
  vi.mocked(fs.open).mockReset();
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

// The first release supports Linux/POSIX private files. A Windows backend cannot claim POSIX ACL safety.
describe.skipIf(process.platform === "win32")("ModelConfigVault real private files", () => {
  it("persists the initial environment snapshot once without sending, and returns independent copies", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const h = await harness();
    const one = await h.vault.read();
    one.saved.providers.qwen.models.push("not-saved");
    h.settings.providers.qwen.apiKey = "mutated-external-secret";
    expect((await h.vault.read()).saved.providers.qwen).toEqual(initial().providers.qwen);
    expect(await fs.readdir(h.directory)).toEqual(FILES);
    expect((await fs.stat(`${h.path}.initialized`)).mode & 0o777).toBe(0o600);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("encrypts all saved settings, uses 600 files, and restores them after restart", async () => {
    const h = await harness();
    await h.vault.updateProvider("qwen", update());
    const encrypted = await fs.readFile(h.path, "utf8");
    for (const plaintext of [SECRET, "qwen-test", "maxCallsPerDay", "dashscope.aliyuncs.com"]) expect(encrypted).not.toContain(plaintext);
    expect((await fs.stat(h.path)).mode & 0o777).toBe(0o600);
    const doc = await (await h.reopen()).read();
    expect(doc.saved.revision).toBe(1);
    expect(doc.saved.providers.qwen.apiKey).toBe(SECRET);
    expect(doc.active.providers.qwen.apiKey).toBeNull();
    expect(doc.audit).toEqual([expect.objectContaining({ action: "provider_updated", revision: 1, providerKey: "qwen" })]);
    expect(JSON.stringify(doc.audit)).not.toContain(SECRET);
    expect(await fs.readdir(h.directory)).toEqual(FILES);
  });

  it("uses a fresh GCM nonce for every save", async () => {
    const h = await harness();
    await h.vault.updateProvider("qwen", update());
    const first = JSON.parse(await fs.readFile(h.path, "utf8"));
    await h.vault.updateProvider("qwen", { ...update(1), secretAction: "keep", apiKey: undefined });
    const second = JSON.parse(await fs.readFile(h.path, "utf8"));
    expect(first.nonce).not.toBe(second.nonce);
    expect(Buffer.from(first.nonce, "base64")).toHaveLength(12);
  });

  it("does not fall back to initial settings for wrong master keys or altered authentication tags", async () => {
    const h = await harness();
    await h.vault.updateProvider("qwen", update());
    await expect(ModelConfigVault.open({ path: h.path, masterKey: randomBytes(32), initial: initial() }))
      .rejects.toMatchObject({ status: 503, code: "ADMIN_CONFIG_STORAGE_UNAVAILABLE" });
    const before = await fs.readFile(h.path, "utf8");
    const envelope = JSON.parse(before);
    envelope.tag = randomBytes(16).toString("base64");
    await fs.writeFile(h.path, JSON.stringify(envelope));
    await expect(h.reopen()).rejects.toMatchObject({ status: 503 });
    await expect(h.vault.updateProvider("qwen", update(1))).rejects.toMatchObject({ status: 503 });
    expect(await fs.readFile(h.path, "utf8")).toBe(JSON.stringify(envelope));
  });

  it("authenticates the application/format AAD", async () => {
    const h = await harness();
    const settings = initial();
    await seal(h.path, h.masterKey, { saved: settings, active: settings, audit: [] }, "some-other-application");
    await expect(h.reopen()).rejects.toMatchObject({ status: 503 });
  });

  it("validates decrypted settings rather than trusting authenticated JSON", async () => {
    const h = await harness();
    const settings = initial();
    settings.providers.openai.baseUrl = "http://127.0.0.1/private";
    await seal(h.path, h.masterKey, { saved: settings, active: settings, audit: [] });
    await expect(h.reopen()).rejects.toMatchObject({ status: 503 });
    settings.providers.openai.baseUrl = initial().providers.openai.baseUrl;
    await seal(h.path, h.masterKey, { saved: settings, active: settings, audit: [], enabled: true });
    await expect(h.reopen()).rejects.toMatchObject({ status: 503 });
  });

  it("rejects oversized files and malformed encrypted envelopes without leaking data", async () => {
    const h = await harness();
    await fs.writeFile(h.path, Buffer.alloc(256 * 1024 + 1), { mode: 0o600 });
    await expect(h.reopen()).rejects.toMatchObject({ status: 503 });
    await fs.writeFile(h.path, SECRET);
    const error = await h.reopen().catch((value: Error) => value);
    expect(String(error)).not.toContain(SECRET);
    expect(String(error)).not.toContain(h.directory);
    expect(String(error)).toContain("模型配置存储不可用");
  });

  it("rejects symlinked files, directory chains, and non-private permissions", async () => {
    const h = await harness();
    const sibling = join(h.directory, "real-secret");
    const original = await fs.readFile(h.path);
    await fs.writeFile(sibling, "private", { mode: 0o600 });
    await fs.unlink(h.path);
    await fs.symlink(sibling, h.path);
    await expect(h.reopen()).rejects.toMatchObject({ status: 503 });
    await fs.unlink(h.path);
    await fs.writeFile(h.path, original, { mode: 0o600 });
    await fs.chmod(h.directory, 0o755);
    await expect(h.reopen()).rejects.toMatchObject({ status: 503 });
    await fs.chmod(h.directory, 0o700);
    await h.vault.updateProvider("qwen", update());
    await fs.chmod(h.path, 0o644);
    await expect(h.reopen()).rejects.toMatchObject({ status: 503 });
    await fs.chmod(h.path, 0o600);
    const alias = join(h.directory, "alias");
    await fs.symlink(h.directory, alias);
    await expect(ModelConfigVault.open({ path: join(alias, "model-config.enc"), masterKey: h.masterKey, initial: initial() })).rejects.toMatchObject({ status: 503 });
  });

  it("refuses relative paths and malformed master keys", async () => {
    await expect(ModelConfigVault.open({ path: "secrets.enc", masterKey: randomBytes(32), initial: initial() })).rejects.toMatchObject({ status: 503 });
    const h = await harness();
    await expect(ModelConfigVault.open({ path: h.path, masterKey: randomBytes(16), initial: initial() })).rejects.toMatchObject({ status: 503 });
  });

  it("does not silently revert to environment settings if an observed vault is removed", async () => {
    const h = await harness();
    await h.vault.updateProvider("qwen", update());
    await fs.unlink(h.path);
    await expect(h.vault.read()).rejects.toMatchObject({ status: 503 });
    await expect(h.vault.updateProvider("qwen", update())).rejects.toMatchObject({ status: 503 });
    await expect(h.reopen()).rejects.toMatchObject({ status: 503 });
    expect(await fs.readdir(h.directory)).toEqual(["model-config.enc.initialized"]);
  });

  it("refuses a missing vault after restart instead of reviving credentials from the environment", async () => {
    const h = await harness();
    await h.vault.updateProvider("qwen", update());
    await h.vault.activateIfIdle(async () => true);
    await h.vault.updateProvider("qwen", { expectedRevision: 1, models: [], secretAction: "clear" });
    await h.vault.activateIfIdle(async () => true);
    await fs.unlink(h.path);
    const obsoleteEnvironment = initial();
    obsoleteEnvironment.providers.qwen.apiKey = SECRET;
    await expect(ModelConfigVault.open({ path: h.path, masterKey: h.masterKey, initial: obsoleteEnvironment })).rejects.toMatchObject({ status: 503 });
    expect(await fs.readdir(h.directory)).toEqual(["model-config.enc.initialized"]);
  });

  it("recovers an interrupted first initialization only from the verified ciphertext", async () => {
    const h = await harness();
    await h.vault.updateProvider("qwen", update());
    await fs.unlink(`${h.path}.initialized`);
    await expect(h.vault.read()).rejects.toMatchObject({ status: 503 });
    const changedEnvironment = initial();
    changedEnvironment.providers.qwen.apiKey = "different-environment-key";
    const recovered = await ModelConfigVault.open({ path: h.path, masterKey: h.masterKey, initial: changedEnvironment });
    expect((await recovered.read()).saved.providers.qwen.apiKey).toBe(SECRET);
    expect(await fs.readdir(h.directory)).toEqual(FILES);
    await fs.writeFile(`${h.path}.initialized`, "corrupt marker");
    await expect(h.reopen()).rejects.toMatchObject({ status: 503 });
  });

  it("leaves a verified baseline after a failed marker write and never reloads new environment settings", async () => {
    const h = await harness();
    await fs.unlink(h.path);
    await fs.unlink(`${h.path}.initialized`);
    const { rename } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (to === `${h.path}.initialized`) throw new Error("marker rename EIO");
      return rename(from, to);
    });
    const first = initial();
    first.providers.qwen.apiKey = SECRET;
    await expect(ModelConfigVault.open({ path: h.path, masterKey: h.masterKey, initial: first })).rejects.toMatchObject({ status: 503 });
    expect(await fs.readdir(h.directory)).toEqual(["model-config.enc"]);
    vi.mocked(fs.rename).mockReset();
    const recovered = await h.reopen();
    expect((await recovered.read()).active.providers.qwen.apiKey).toBe(SECRET);
    expect(await fs.readdir(h.directory)).toEqual(FILES);
  });

  it("serializes same-instance writes and rejects stale revisions", async () => {
    const h = await harness();
    const results = await Promise.allSettled([h.vault.updateProvider("qwen", update()), h.vault.updateProvider("qwen", update())]);
    expect(results.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(results.find((entry) => entry.status === "rejected")).toMatchObject({ reason: { status: 409, code: "ADMIN_CONFIG_CONFLICT" } });
    expect((await h.vault.read()).saved.revision).toBe(1);
  });

  it("uses an exclusive filesystem lock for CAS across independent vault instances", async () => {
    const h = await harness();
    const other = await h.reopen();
    const results = await Promise.allSettled([h.vault.updateProvider("qwen", update()), other.updateProvider("qwen", update())]);
    expect(results.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(results.find((entry) => entry.status === "rejected")).toMatchObject({ reason: { status: 409 } });
    expect((await h.vault.read()).saved.revision).toBe(1);
    await expect(other.updateProvider("qwen", update())).rejects.toMatchObject({ code: "ADMIN_CONFIG_CONFLICT" });
    expect(await fs.readdir(h.directory)).toEqual(FILES);
  });

  it("never steals a leftover writer lock", async () => {
    const h = await harness();
    await fs.writeFile(`${h.path}.lock`, "old lock", { mode: 0o600 });
    await expect(h.vault.updateProvider("qwen", update())).rejects.toMatchObject({ status: 409, code: "ADMIN_CONFIG_BUSY" });
    expect(await fs.readFile(`${h.path}.lock`, "utf8")).toBe("old lock");
  });

  it("keeps, replaces, and clears secrets explicitly, without applying them to the active settings", async () => {
    const h = await harness();
    await h.vault.updateProvider("qwen", update());
    await h.vault.updateProvider("qwen", { expectedRevision: 1, secretAction: "keep", models: ["another-model"] });
    expect((await h.vault.read()).saved.providers.qwen.apiKey).toBe(SECRET);
    await h.vault.updateProvider("qwen", { expectedRevision: 2, secretAction: "clear", models: [] });
    const doc = await h.vault.read();
    expect(doc.saved.providers.qwen).toMatchObject({ apiKey: null, models: [] });
    expect(doc.active.revision).toBe(0);
    await expect(h.vault.updateProvider("qwen", { expectedRevision: 3, secretAction: "keep", models: [], apiKey: SECRET })).rejects.toMatchObject({ status: 400 });
  });

  it.each([
    ["qwen", "http://dashscope.aliyuncs.com/compatible-mode/v1"],
    ["qwen", "https://127.0.0.1/compatible-mode/v1"],
    ["qwen", "https://dashscope.aliyuncs.com.attacker.test/compatible-mode/v1"],
    ["qwen", "https://secret@dashscope.aliyuncs.com/compatible-mode/v1"],
    ["qwen", "https://dashscope.aliyuncs.com/compatible-mode/v1?key=secret"],
    ["openai", "https://example.com/v1/responses"],
    ["deepseek", "https://api.deepseek.com/chat/completions#secret"],
  ] as const)("rejects endpoint override %s %s", async (key, baseUrl) => {
    const h = await harness();
    await expect(h.vault.updateProvider(key, { ...update(), baseUrl })).rejects.toMatchObject({ status: 400 });
    expect(await fs.readdir(h.directory)).toEqual(FILES);
  });

  it("accepts only allowed incomplete settings and refuses enable/token/unknown fields", async () => {
    const h = await harness();
    await h.vault.updateProvider("qwen", { expectedRevision: 0, models: [], baseUrl: "", secretAction: "clear" });
    expect((await h.vault.read()).saved.providers.qwen).toEqual({ models: [], baseUrl: "", apiKey: null });
    const limits: AdminLimitsUpdate = { expectedRevision: 1, defaultProvider: null, maxCallsPerDay: 8, maxActiveRuns: 1 };
    await expect(h.vault.updateLimits({ ...limits, enabled: true } as AdminLimitsUpdate)).rejects.toMatchObject({ status: 400 });
    await expect(h.vault.updateLimits({ ...limits, operatorToken: SECRET } as AdminLimitsUpdate)).rejects.toMatchObject({ status: 400 });
    await expect(h.vault.updateLimits({ ...limits, maxCallsPerDay: 501 })).rejects.toMatchObject({ status: 400 });
    await h.vault.updateLimits(limits);
    expect((await h.vault.read()).saved).toMatchObject({ revision: 2, maxCallsPerDay: 8, defaultProvider: null });
  });

  it("preserves the old ciphertext and cleans temporary/lock files when atomic replacement fails", async () => {
    const h = await harness();
    await h.vault.updateProvider("qwen", update());
    const before = await fs.readFile(h.path);
    const rename = vi.mocked(fs.rename).mockRejectedValueOnce(Object.assign(new Error(`path=${h.path}, secret=${SECRET}`), { code: "EIO" }));
    await expect(h.vault.updateProvider("qwen", { expectedRevision: 1, models: [], secretAction: "clear" }))
      .rejects.toMatchObject({ status: 503, message: "模型配置存储不可用，请联系管理员。" });
    expect(await fs.readFile(h.path)).toEqual(before);
    expect(await fs.readdir(h.directory)).toEqual(FILES);
    rename.mockReset();
    await h.vault.updateProvider("qwen", { expectedRevision: 1, models: [], secretAction: "clear" });
    expect((await h.vault.read()).saved.revision).toBe(2);
  });

  it("returns an error if directory sync fails after rename; never falsely claims a durable success", async () => {
    const h = await harness();
    const { open } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const spy = vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === h.directory) vi.spyOn(handle, "sync").mockRejectedValueOnce(new Error("EIO"));
      return handle;
    });
    await expect(h.vault.updateProvider("qwen", update())).rejects.toMatchObject({ status: 503 });
    spy.mockReset();
    // A reported write failure can be ambiguous after rename. CAS/read resolves it without replaying secrets.
    expect((await h.vault.read()).saved.revision).toBe(1);
    expect(await fs.readdir(h.directory)).toEqual(FILES);
  });

  it("keeps old active credentials while a run can recover, then activates only at an idle startup", async () => {
    const h = await harness();
    await h.vault.updateProvider("qwen", update());
    const notIdle = vi.fn(async () => false);
    const deferred = await (await h.reopen()).activateIfIdle(notIdle);
    expect(deferred).toMatchObject({ deferred: true, active: { revision: 0 } });
    expect(deferred.active.providers.qwen.apiKey).toBeNull();
    expect((await h.vault.read()).saved.revision).toBe(1);
    const activated = await (await h.reopen()).activateIfIdle(async () => true);
    expect(activated).toMatchObject({ deferred: false, active: { revision: 1 } });
    expect(activated.active.providers.qwen.apiKey).toBe(SECRET);
    const noPending = vi.fn(async () => false);
    await (await h.reopen()).activateIfIdle(noPending);
    expect(noPending).not.toHaveBeenCalled();
    expect((await h.vault.read()).audit.filter((entry) => entry.action === "activated")).toHaveLength(1);
  });

  it("does not activate pending settings if the running-job check fails", async () => {
    const h = await harness();
    await h.vault.updateProvider("qwen", update());
    await expect(h.vault.activateIfIdle(async () => { throw new Error("database disconnected"); })).rejects.toMatchObject({ status: 503 });
    expect((await h.vault.read()).active.revision).toBe(0);
    expect(await fs.readdir(h.directory)).toEqual(FILES);
  });

  it("bounds audit history without recording keys or model strings", async () => {
    const h = await harness();
    for (let revision = 0; revision < 55; revision++) {
      await h.vault.updateProvider("qwen", update(revision));
    }
    const doc = await h.vault.read();
    expect(doc.audit).toHaveLength(50);
    expect(doc.audit[0]?.revision).toBe(6);
    expect(JSON.stringify(doc.audit)).not.toContain(SECRET);
    expect(JSON.stringify(doc.audit)).not.toContain("qwen-test");
  });
});
