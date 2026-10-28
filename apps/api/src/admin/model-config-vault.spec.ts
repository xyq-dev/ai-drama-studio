import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminLimitsUpdate, AdminProviderUpdate } from "@ai-drama/contracts";
import { DEEPSEEK_BACKUP_SUFFIX, ModelConfigVault, V1_BACKUP_SUFFIX, type ManagedModelSettings } from "./model-config-vault";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename), open: vi.fn(actual.open), link: vi.fn(actual.link) };
});

const SECRET = "sk-vault-private-test-123456789";
const FORMAT = "ai-drama-studio.admin-model-vault.v2";
const FORMAT_V1 = "ai-drama-studio.admin-model-vault.v1";
const FILES = ["model-config.enc", "model-config.enc.initialized"];
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const initial = (): ManagedModelSettings => ({
  revision: 0, defaultProvider: "anthropic", maxCallsPerDay: 30, maxActiveRuns: 1,
  providers: {
    openai: { apiKey: null, baseUrl: "https://api.openai.com/v1/responses", models: [] },
    anthropic: { apiKey: null, baseUrl: "https://api.anthropic.com/v1/messages", models: ["claude-test"] },
    deepseek: { apiKey: null, baseUrl: DEEPSEEK_URL, models: [] },
  },
});
const update = (expectedRevision = 0): AdminProviderUpdate => ({
  expectedRevision, secretAction: "replace", apiKey: SECRET, models: ["claude-test"],
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

async function seal(path: string, masterKey: Buffer, value: unknown, aad = FORMAT, format = FORMAT) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", masterKey, nonce);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  await fs.writeFile(path, JSON.stringify({ format, nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") }), { mode: 0o600 });
}

/** What the released (v1) code reads: the v1 envelope, the v1 AAD and the v1 document. */
function openV1(bytes: Buffer, masterKey: Buffer): Record<string, unknown> {
  const envelope = JSON.parse(bytes.toString("utf8")) as { format: string; nonce: string; tag: string; ciphertext: string };
  expect(envelope.format).toBe(FORMAT_V1);
  const decipher = createDecipheriv("aes-256-gcm", masterKey, Buffer.from(envelope.nonce, "base64"));
  decipher.setAAD(Buffer.from(FORMAT_V1));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8")) as Record<string, unknown>;
}

const QWEN_SECRET = "sk-retired-qwen-secret-0123456789";
const DEEPSEEK_SECRET = "sk-retired-deepseek-secret-012345";
const OPENAI_SECRET = "sk-kept-openai-secret-0123456789";
/** A configuration as the released three-provider console saved it: saved revision 3, active 2 (a restart pending). */
function v1Document() {
  const settings = (revision: number, defaultProvider: string) => ({
    revision, defaultProvider, maxCallsPerDay: 12, maxActiveRuns: 2,
    providers: {
      qwen: { apiKey: QWEN_SECRET, baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", models: ["qwen3.7-plus-2026-05-26"] },
      openai: { apiKey: OPENAI_SECRET, baseUrl: "https://api.openai.com/v1/responses", models: ["gpt-6-luna", "gpt-6-astra"] },
      deepseek: { apiKey: DEEPSEEK_SECRET, baseUrl: "https://api.deepseek.com/chat/completions", models: ["deepseek-flash"] },
    },
  });
  return {
    active: settings(2, "qwen"),
    saved: settings(3, "qwen"),
    audit: [
      { at: "2026-10-10T00:00:00.000Z", action: "provider_updated", providerKey: "qwen", revision: 1 },
      { at: "2026-10-10T00:01:00.000Z", action: "provider_updated", providerKey: "openai", revision: 2 },
      { at: "2026-10-10T00:02:00.000Z", action: "activated", revision: 2 },
      { at: "2026-10-10T00:03:00.000Z", action: "provider_updated", providerKey: "deepseek", revision: 3 },
    ],
  };
}

/** A private directory holding a v1 vault file and its marker, exactly as the released code left it. */
async function v1Harness() {
  const directory = await fs.mkdtemp(join(tmpdir(), "ads-admin-vault-v1-"));
  directories.push(directory);
  await fs.chmod(directory, 0o700);
  const path = join(directory, "model-config.enc");
  const masterKey = randomBytes(32);
  await seal(path, masterKey, v1Document(), FORMAT_V1, FORMAT_V1);
  await fs.writeFile(`${path}.initialized`, `${FORMAT_V1}.initialized\n`, { mode: 0o600 });
  const original = await fs.readFile(path);
  return { directory, path, masterKey, original, open: () => ModelConfigVault.open({ path, masterKey, initial: initial() }) };
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(fs.rename).mockReset();
  vi.mocked(fs.open).mockReset();
  vi.mocked(fs.link).mockReset();
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
    one.saved.providers.anthropic.models.push("not-saved");
    h.settings.providers.anthropic.apiKey = "mutated-external-secret";
    expect((await h.vault.read()).saved.providers.anthropic).toEqual(initial().providers.anthropic);
    expect(await fs.readdir(h.directory)).toEqual(FILES);
    expect((await fs.stat(`${h.path}.initialized`)).mode & 0o777).toBe(0o600);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("encrypts all saved settings, uses 600 files, and restores them after restart", async () => {
    const h = await harness();
    await h.vault.updateProvider("anthropic", update());
    const encrypted = await fs.readFile(h.path, "utf8");
    for (const plaintext of [SECRET, "claude-test", "maxCallsPerDay", "api.anthropic.com"]) expect(encrypted).not.toContain(plaintext);
    expect((await fs.stat(h.path)).mode & 0o777).toBe(0o600);
    const doc = await (await h.reopen()).read();
    expect(doc.saved.revision).toBe(1);
    expect(doc.saved.providers.anthropic.apiKey).toBe(SECRET);
    expect(doc.active.providers.anthropic.apiKey).toBeNull();
    expect(doc.audit).toEqual([expect.objectContaining({ action: "provider_updated", revision: 1, providerKey: "anthropic" })]);
    expect(JSON.stringify(doc.audit)).not.toContain(SECRET);
    expect(await fs.readdir(h.directory)).toEqual(FILES);
  });

  it("uses a fresh GCM nonce for every save", async () => {
    const h = await harness();
    await h.vault.updateProvider("anthropic", update());
    const first = JSON.parse(await fs.readFile(h.path, "utf8"));
    await h.vault.updateProvider("anthropic", { ...update(1), secretAction: "keep", apiKey: undefined });
    const second = JSON.parse(await fs.readFile(h.path, "utf8"));
    expect(first.nonce).not.toBe(second.nonce);
    expect(Buffer.from(first.nonce, "base64")).toHaveLength(12);
  });

  it("does not fall back to initial settings for wrong master keys or altered authentication tags", async () => {
    const h = await harness();
    await h.vault.updateProvider("anthropic", update());
    await expect(ModelConfigVault.open({ path: h.path, masterKey: randomBytes(32), initial: initial() }))
      .rejects.toMatchObject({ status: 503, code: "ADMIN_CONFIG_STORAGE_UNAVAILABLE" });
    const before = await fs.readFile(h.path, "utf8");
    const envelope = JSON.parse(before);
    envelope.tag = randomBytes(16).toString("base64");
    await fs.writeFile(h.path, JSON.stringify(envelope));
    await expect(h.reopen()).rejects.toMatchObject({ status: 503 });
    await expect(h.vault.updateProvider("anthropic", update(1))).rejects.toMatchObject({ status: 503 });
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
    await h.vault.updateProvider("anthropic", update());
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
    await h.vault.updateProvider("anthropic", update());
    await fs.unlink(h.path);
    await expect(h.vault.read()).rejects.toMatchObject({ status: 503 });
    await expect(h.vault.updateProvider("anthropic", update())).rejects.toMatchObject({ status: 503 });
    await expect(h.reopen()).rejects.toMatchObject({ status: 503 });
    expect(await fs.readdir(h.directory)).toEqual(["model-config.enc.initialized"]);
  });

  it("refuses a missing vault after restart instead of reviving credentials from the environment", async () => {
    const h = await harness();
    await h.vault.updateProvider("anthropic", update());
    await h.vault.activateIfIdle(async () => true);
    await h.vault.updateProvider("anthropic", { expectedRevision: 1, models: [], secretAction: "clear" });
    await h.vault.activateIfIdle(async () => true);
    await fs.unlink(h.path);
    const obsoleteEnvironment = initial();
    obsoleteEnvironment.providers.anthropic.apiKey = SECRET;
    await expect(ModelConfigVault.open({ path: h.path, masterKey: h.masterKey, initial: obsoleteEnvironment })).rejects.toMatchObject({ status: 503 });
    expect(await fs.readdir(h.directory)).toEqual(["model-config.enc.initialized"]);
  });

  it("recovers an interrupted first initialization only from the verified ciphertext", async () => {
    const h = await harness();
    await h.vault.updateProvider("anthropic", update());
    await fs.unlink(`${h.path}.initialized`);
    await expect(h.vault.read()).rejects.toMatchObject({ status: 503 });
    const changedEnvironment = initial();
    changedEnvironment.providers.anthropic.apiKey = "different-environment-key";
    const recovered = await ModelConfigVault.open({ path: h.path, masterKey: h.masterKey, initial: changedEnvironment });
    expect((await recovered.read()).saved.providers.anthropic.apiKey).toBe(SECRET);
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
    first.providers.anthropic.apiKey = SECRET;
    await expect(ModelConfigVault.open({ path: h.path, masterKey: h.masterKey, initial: first })).rejects.toMatchObject({ status: 503 });
    expect(await fs.readdir(h.directory)).toEqual(["model-config.enc"]);
    vi.mocked(fs.rename).mockReset();
    const recovered = await h.reopen();
    expect((await recovered.read()).active.providers.anthropic.apiKey).toBe(SECRET);
    expect(await fs.readdir(h.directory)).toEqual(FILES);
  });

  it("serializes same-instance writes and rejects stale revisions", async () => {
    const h = await harness();
    const results = await Promise.allSettled([h.vault.updateProvider("anthropic", update()), h.vault.updateProvider("anthropic", update())]);
    expect(results.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(results.find((entry) => entry.status === "rejected")).toMatchObject({ reason: { status: 409, code: "ADMIN_CONFIG_CONFLICT" } });
    expect((await h.vault.read()).saved.revision).toBe(1);
  });

  it("uses an exclusive filesystem lock for CAS across independent vault instances", async () => {
    const h = await harness();
    const other = await h.reopen();
    const results = await Promise.allSettled([h.vault.updateProvider("anthropic", update()), other.updateProvider("anthropic", update())]);
    expect(results.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(results.find((entry) => entry.status === "rejected")).toMatchObject({ reason: { status: 409 } });
    expect((await h.vault.read()).saved.revision).toBe(1);
    await expect(other.updateProvider("anthropic", update())).rejects.toMatchObject({ code: "ADMIN_CONFIG_CONFLICT" });
    expect(await fs.readdir(h.directory)).toEqual(FILES);
  });

  it("never steals a leftover writer lock", async () => {
    const h = await harness();
    await fs.writeFile(`${h.path}.lock`, "old lock", { mode: 0o600 });
    await expect(h.vault.updateProvider("anthropic", update())).rejects.toMatchObject({ status: 409, code: "ADMIN_CONFIG_BUSY" });
    expect(await fs.readFile(`${h.path}.lock`, "utf8")).toBe("old lock");
  });

  it("keeps, replaces, and clears secrets explicitly, without applying them to the active settings", async () => {
    const h = await harness();
    await h.vault.updateProvider("anthropic", update());
    await h.vault.updateProvider("anthropic", { expectedRevision: 1, secretAction: "keep", models: ["another-model"] });
    expect((await h.vault.read()).saved.providers.anthropic.apiKey).toBe(SECRET);
    await h.vault.updateProvider("anthropic", { expectedRevision: 2, secretAction: "clear", models: [] });
    const doc = await h.vault.read();
    expect(doc.saved.providers.anthropic).toMatchObject({ apiKey: null, models: [] });
    expect(doc.active.revision).toBe(0);
    await expect(h.vault.updateProvider("anthropic", { expectedRevision: 3, secretAction: "keep", models: [], apiKey: SECRET })).rejects.toMatchObject({ status: 400 });
  });

  it.each([
    ["anthropic", "http://api.anthropic.com/v1/messages"],
    ["anthropic", "https://127.0.0.1/v1/messages"],
    ["anthropic", "https://api.anthropic.com.attacker.test/v1/messages"],
    ["anthropic", "https://secret@api.anthropic.com/v1/messages"],
    ["anthropic", "https://api.anthropic.com/v1/messages?key=secret"],
    ["anthropic", ""],
    ["openai", "https://example.com/v1/responses"],
    ["openai", "https://api.openai.com/v1/responses#secret"],
  ] as const)("rejects endpoint override %s %s", async (key, baseUrl) => {
    const h = await harness();
    await expect(h.vault.updateProvider(key, { ...update(), baseUrl })).rejects.toMatchObject({ status: 400 });
    expect(await fs.readdir(h.directory)).toEqual(FILES);
  });

  it("accepts only allowed incomplete settings and refuses enable/token/unknown fields", async () => {
    const h = await harness();
    await h.vault.updateProvider("anthropic", { expectedRevision: 0, models: [], secretAction: "clear" });
    expect((await h.vault.read()).saved.providers.anthropic).toEqual({ models: [], baseUrl: "https://api.anthropic.com/v1/messages", apiKey: null });
    // The retired provider cannot be edited at all.
    await expect(h.vault.updateProvider("qwen" as "openai", update(1))).rejects.toMatchObject({ status: 400 });
    const limits: AdminLimitsUpdate = { expectedRevision: 1, defaultProvider: null, maxCallsPerDay: 8, maxActiveRuns: 1 };
    await expect(h.vault.updateLimits({ ...limits, enabled: true } as AdminLimitsUpdate)).rejects.toMatchObject({ status: 400 });
    await expect(h.vault.updateLimits({ ...limits, operatorToken: SECRET } as AdminLimitsUpdate)).rejects.toMatchObject({ status: 400 });
    await expect(h.vault.updateLimits({ ...limits, maxCallsPerDay: 501 })).rejects.toMatchObject({ status: 400 });
    await h.vault.updateLimits(limits);
    expect((await h.vault.read()).saved).toMatchObject({ revision: 2, maxCallsPerDay: 8, defaultProvider: null });
  });

  it("preserves the old ciphertext and cleans temporary/lock files when atomic replacement fails", async () => {
    const h = await harness();
    await h.vault.updateProvider("anthropic", update());
    const before = await fs.readFile(h.path);
    const rename = vi.mocked(fs.rename).mockRejectedValueOnce(Object.assign(new Error(`path=${h.path}, secret=${SECRET}`), { code: "EIO" }));
    await expect(h.vault.updateProvider("anthropic", { expectedRevision: 1, models: [], secretAction: "clear" }))
      .rejects.toMatchObject({ status: 503, message: "模型配置存储不可用，请联系管理员。" });
    expect(await fs.readFile(h.path)).toEqual(before);
    expect(await fs.readdir(h.directory)).toEqual(FILES);
    rename.mockReset();
    await h.vault.updateProvider("anthropic", { expectedRevision: 1, models: [], secretAction: "clear" });
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
    await expect(h.vault.updateProvider("anthropic", update())).rejects.toMatchObject({ status: 503 });
    spy.mockReset();
    // A reported write failure can be ambiguous after rename. CAS/read resolves it without replaying secrets.
    expect((await h.vault.read()).saved.revision).toBe(1);
    expect(await fs.readdir(h.directory)).toEqual(FILES);
  });

  it("keeps old active credentials while a run can recover, then activates only at an idle startup", async () => {
    const h = await harness();
    await h.vault.updateProvider("anthropic", update());
    const notIdle = vi.fn(async () => false);
    const deferred = await (await h.reopen()).activateIfIdle(notIdle);
    expect(deferred).toMatchObject({ deferred: true, active: { revision: 0 } });
    expect(deferred.active.providers.anthropic.apiKey).toBeNull();
    expect((await h.vault.read()).saved.revision).toBe(1);
    const activated = await (await h.reopen()).activateIfIdle(async () => true);
    expect(activated).toMatchObject({ deferred: false, active: { revision: 1 } });
    expect(activated.active.providers.anthropic.apiKey).toBe(SECRET);
    const noPending = vi.fn(async () => false);
    await (await h.reopen()).activateIfIdle(noPending);
    expect(noPending).not.toHaveBeenCalled();
    expect((await h.vault.read()).audit.filter((entry) => entry.action === "activated")).toHaveLength(1);
  });

  it("does not activate pending settings if the running-job check fails", async () => {
    const h = await harness();
    await h.vault.updateProvider("anthropic", update());
    await expect(h.vault.activateIfIdle(async () => { throw new Error("database disconnected"); })).rejects.toMatchObject({ status: 503 });
    expect((await h.vault.read()).active.revision).toBe(0);
    expect(await fs.readdir(h.directory)).toEqual(FILES);
  });

  it("bounds audit history without recording keys or model strings", async () => {
    const h = await harness();
    for (let revision = 0; revision < 55; revision++) {
      await h.vault.updateProvider("anthropic", update(revision));
    }
    const doc = await h.vault.read();
    expect(doc.audit).toHaveLength(50);
    expect(doc.audit[0]?.revision).toBe(6);
    expect(JSON.stringify(doc.audit)).not.toContain(SECRET);
    expect(JSON.stringify(doc.audit)).not.toContain("claude-test");
  });
});

describe.skipIf(process.platform === "win32")("ModelConfigVault upgrade of a released three-provider (v1) file", () => {
  it("reads a v1 file with the same master key, converting it in memory without writing anything", async () => {
    const h = await v1Harness();
    const vault = await h.open();
    const doc = await vault.read();
    // OpenAI keeps its key, models, order and endpoint; Claude starts unconfigured; the retired default is unset.
    // DeepSeek is active again, but its v1 key and models are never carried over: it starts unconfigured.
    expect(doc.saved).toEqual({ revision: 3, defaultProvider: null, maxCallsPerDay: 12, maxActiveRuns: 2, providers: {
      openai: { apiKey: OPENAI_SECRET, baseUrl: "https://api.openai.com/v1/responses", models: ["gpt-6-luna", "gpt-6-astra"] },
      anthropic: { apiKey: null, baseUrl: "https://api.anthropic.com/v1/messages", models: [] },
      deepseek: { apiKey: null, baseUrl: DEEPSEEK_URL, models: [] },
    } });
    // The pending restart is kept: active is still revision 2.
    expect(doc.active.revision).toBe(2);
    expect(doc.active.defaultProvider).toBeNull();
    // The audit history keeps its retired provider names as recorded.
    expect(doc.audit.map((item) => [item.action, item.providerKey ?? null, item.revision])).toEqual([
      ["provider_updated", "qwen", 1], ["provider_updated", "openai", 2], ["activated", null, 2], ["provider_updated", "deepseek", 3],
    ]);
    expect(doc.retired).toEqual({ providers: ["qwen", "deepseek"], retiredDefault: "qwen" });
    // The retired secrets are not part of the live document.
    expect(JSON.stringify(doc)).not.toContain(QWEN_SECRET);
    expect(JSON.stringify(doc)).not.toContain(DEEPSEEK_SECRET);
    expect(await vault.retiredNote()).toEqual({ providers: ["qwen", "deepseek"], retiredDefault: "qwen", backupKept: false });
    // Opening and reading wrote nothing: the released code can still read the file.
    expect(await fs.readFile(h.path)).toEqual(h.original);
    expect(await fs.readdir(h.directory)).toEqual(FILES);
    expect((openV1(await fs.readFile(h.path), h.masterKey).saved as { defaultProvider: string }).defaultProvider).toBe("qwen");
  });

  it("the first save keeps the exact v1 file as a private backup, then writes v2 atomically", async () => {
    const h = await v1Harness();
    const vault = await h.open();
    await vault.updateProvider("anthropic", { expectedRevision: 3, secretAction: "replace", apiKey: SECRET, models: ["claude-opus-5-5"] });
    const backup = `${h.path}${V1_BACKUP_SUFFIX}`;
    expect((await fs.readdir(h.directory)).sort()).toEqual([...FILES, `model-config.enc${V1_BACKUP_SUFFIX}`].sort());
    expect(await fs.readFile(backup)).toEqual(h.original);
    expect((await fs.stat(backup)).mode & 0o777).toBe(0o600);
    // The backup is still ciphertext, readable only with the master key, with every retired secret intact.
    for (const secret of [QWEN_SECRET, DEEPSEEK_SECRET, OPENAI_SECRET, SECRET]) expect((await fs.readFile(backup)).toString()).not.toContain(secret);
    const restoredV1 = openV1(await fs.readFile(backup), h.masterKey) as { saved: { providers: { qwen: { apiKey: string } } } };
    expect(restoredV1.saved.providers.qwen.apiKey).toBe(QWEN_SECRET);
    // The live file is v2 now, with the upgrade recorded and nothing secret in the audit.
    expect(JSON.parse(await fs.readFile(h.path, "utf8")).format).toBe(FORMAT);
    const doc = await (await h.open()).read();
    expect(doc.saved).toMatchObject({ revision: 4, defaultProvider: null });
    expect(doc.saved.providers.anthropic).toEqual({ apiKey: SECRET, baseUrl: "https://api.anthropic.com/v1/messages", models: ["claude-opus-5-5"] });
    expect(doc.saved.providers.openai.apiKey).toBe(OPENAI_SECRET);
    expect(doc.active.revision).toBe(2);
    expect(doc.audit.slice(-2).map((item) => [item.action, item.providerKey ?? null, item.revision]))
      .toEqual([["provider_updated", "anthropic", 4], ["format_upgraded", null, 4]]);
    expect(doc.retired).toEqual({ providers: ["qwen", "deepseek"], retiredDefault: "qwen" });
    expect(await (await h.open()).retiredNote()).toMatchObject({ backupKept: true });
    expect(JSON.stringify(doc)).not.toContain(QWEN_SECRET);
    // Later saves never touch the backup again.
    await (await h.open()).updateLimits({ expectedRevision: 4, defaultProvider: "anthropic", maxCallsPerDay: 12, maxActiveRuns: 2 });
    expect(await fs.readFile(backup)).toEqual(h.original);
  });

  it("restoring the backup is a byte-for-byte rollback to the released file", async () => {
    const h = await v1Harness();
    await (await h.open()).updateLimits({ expectedRevision: 3, defaultProvider: "openai", maxCallsPerDay: 12, maxActiveRuns: 2 });
    await fs.copyFile(`${h.path}${V1_BACKUP_SUFFIX}`, h.path);
    expect(await fs.readFile(h.path)).toEqual(h.original);
    expect(openV1(await fs.readFile(h.path), h.masterKey)).toEqual(v1Document());
    // The restored file still opens in this version too (converted again in memory).
    expect((await (await h.open()).read()).saved.revision).toBe(3);
  });

  it("activating the pending v1 settings at an idle startup upgrades the same way and keeps the retired default unset", async () => {
    const h = await v1Harness();
    const result = await (await h.open()).activateIfIdle(async () => true);
    expect(result).toMatchObject({ deferred: false, active: { revision: 3, defaultProvider: null } });
    expect(result.active.providers.openai.apiKey).toBe(OPENAI_SECRET);
    expect(await fs.readFile(`${h.path}${V1_BACKUP_SUFFIX}`)).toEqual(h.original);
    expect((await (await h.open()).read()).audit.slice(-2).map((item) => item.action)).toEqual(["activated", "format_upgraded"]);
  });

  it("a deferred activation over a v1 file writes nothing", async () => {
    const h = await v1Harness();
    const result = await (await h.open()).activateIfIdle(async () => false);
    expect(result).toMatchObject({ deferred: true, active: { revision: 2, defaultProvider: null } });
    expect(await fs.readFile(h.path)).toEqual(h.original);
    expect(await fs.readdir(h.directory)).toEqual(FILES);
  });

  it("a failed replace leaves the v1 file in place; the retry reuses the same backup", async () => {
    const h = await v1Harness();
    const vault = await h.open();
    const rename = vi.mocked(fs.rename).mockImplementationOnce(async () => { throw Object.assign(new Error(`EIO ${h.path} ${QWEN_SECRET}`), { code: "EIO" }); });
    const failure = await vault.updateLimits({ expectedRevision: 3, defaultProvider: "openai", maxCallsPerDay: 12, maxActiveRuns: 2 }).catch((error: Error) => error);
    expect(failure).toMatchObject({ status: 503, message: "模型配置存储不可用，请联系管理员。" });
    expect(String(failure)).not.toContain(QWEN_SECRET);
    rename.mockReset();
    expect(await fs.readFile(h.path)).toEqual(h.original);
    expect(await fs.readFile(`${h.path}${V1_BACKUP_SUFFIX}`)).toEqual(h.original);
    await vault.updateLimits({ expectedRevision: 3, defaultProvider: "openai", maxCallsPerDay: 12, maxActiveRuns: 2 });
    expect((await (await h.open()).read()).saved).toMatchObject({ revision: 4, defaultProvider: "openai" });
    expect(await fs.readFile(`${h.path}${V1_BACKUP_SUFFIX}`)).toEqual(h.original);
  });

  it("never overwrites a different existing backup: the write is refused and the v1 file stays", async () => {
    const h = await v1Harness();
    await fs.writeFile(`${h.path}${V1_BACKUP_SUFFIX}`, "an older backup", { mode: 0o600 });
    await expect((await h.open()).updateLimits({ expectedRevision: 3, defaultProvider: null, maxCallsPerDay: 12, maxActiveRuns: 2 }))
      .rejects.toMatchObject({ status: 503 });
    expect(await fs.readFile(`${h.path}${V1_BACKUP_SUFFIX}`, "utf8")).toBe("an older backup");
    expect(await fs.readFile(h.path)).toEqual(h.original);
  });

  it("a v1 file with a wrong key, a v2 AAD or a malformed document is refused, never replaced by environment settings", async () => {
    const h = await v1Harness();
    await expect(ModelConfigVault.open({ path: h.path, masterKey: randomBytes(32), initial: initial() })).rejects.toMatchObject({ status: 503 });
    await seal(h.path, h.masterKey, v1Document(), FORMAT, FORMAT_V1);
    await expect(h.open()).rejects.toMatchObject({ status: 503 });
    await seal(h.path, h.masterKey, { ...v1Document(), enabled: true }, FORMAT_V1, FORMAT_V1);
    await expect(h.open()).rejects.toMatchObject({ status: 503 });
    const unknownProvider = v1Document();
    (unknownProvider.saved as { defaultProvider: string }).defaultProvider = "gemini";
    await seal(h.path, h.masterKey, unknownProvider, FORMAT_V1, FORMAT_V1);
    await expect(h.open()).rejects.toMatchObject({ status: 503 });
    expect(await fs.readdir(h.directory)).toEqual(FILES);
  });

  it("reports a retired default that only the still-active settings name", async () => {
    const h = await v1Harness();
    const doc = v1Document();
    (doc.saved as { defaultProvider: string }).defaultProvider = "openai";
    await seal(h.path, h.masterKey, doc, FORMAT_V1, FORMAT_V1);
    const converted = await (await h.open()).read();
    expect([converted.saved.defaultProvider, converted.active.defaultProvider]).toEqual(["openai", null]);
    expect(converted.retired?.retiredDefault).toBe("qwen");
  });

  it("an unlocked read racing the upgrade cannot make a later write record a second upgrade", async () => {
    const h = await v1Harness();
    const vault = await h.open();
    const view = vault.read();
    await vault.updateLimits({ expectedRevision: 3, defaultProvider: "openai", maxCallsPerDay: 12, maxActiveRuns: 2 });
    await view;
    await vault.updateLimits({ expectedRevision: 4, defaultProvider: "openai", maxCallsPerDay: 11, maxActiveRuns: 2 });
    expect((await vault.read()).audit.filter((item) => item.action === "format_upgraded")).toHaveLength(1);
  });

  it("a v1 file whose saved and active revisions agree converts to equal saved and active settings", async () => {
    const h = await v1Harness();
    const same = v1Document();
    same.active = structuredClone(same.saved);
    await seal(h.path, h.masterKey, same, FORMAT_V1, FORMAT_V1);
    const doc = await (await h.open()).read();
    expect(doc.active).toEqual(doc.saved);
  });
});

/** What the release before DeepSeek reads: the v2 envelope and document, with exactly the openai and anthropic entries. */
function openV2(bytes: Buffer, masterKey: Buffer): { active: Record<string, unknown>; saved: Record<string, unknown> } {
  const envelope = JSON.parse(bytes.toString("utf8")) as { format: string; nonce: string; tag: string; ciphertext: string };
  expect(envelope.format).toBe(FORMAT);
  const decipher = createDecipheriv("aes-256-gcm", masterKey, Buffer.from(envelope.nonce, "base64"));
  decipher.setAAD(Buffer.from(FORMAT));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64")), decipher.final()]).toString("utf8")) as never;
}
/** True when the release before DeepSeek could read this file: no DeepSeek entry and no DeepSeek default in either settings. */
function readableByPreviousRelease(bytes: Buffer, masterKey: Buffer): boolean {
  const doc = openV2(bytes, masterKey);
  return [doc.active, doc.saved].every((settings) => {
    const record = settings as { defaultProvider: unknown; providers: Record<string, unknown> };
    return record.defaultProvider !== "deepseek" && Object.keys(record.providers).sort().join(",") === "anthropic,openai";
  });
}
const DEEPSEEK_KEY = "fake-deepseek-vault-test-key-0123";

describe.skipIf(process.platform === "win32")("ModelConfigVault with DeepSeek active again (two-provider v2 file upgraded in place)", () => {
  it("a file written before DeepSeek is read without any write, and DeepSeek reads as unconfigured", async () => {
    const h = await harness();
    await h.vault.updateProvider("anthropic", update());
    const before = await fs.readFile(h.path);
    expect(readableByPreviousRelease(before, h.masterKey)).toBe(true);
    const doc = await (await h.reopen()).read();
    expect(doc.saved.providers.deepseek).toEqual({ apiKey: null, baseUrl: DEEPSEEK_URL, models: [] });
    expect(doc.active.providers.deepseek).toEqual({ apiKey: null, baseUrl: DEEPSEEK_URL, models: [] });
    expect(await fs.readFile(h.path)).toEqual(before);
    expect(await fs.readdir(h.directory)).toEqual(FILES);
  });

  it("saves that leave DeepSeek unset keep the file readable by the previous release and make no backup", async () => {
    const h = await harness();
    await h.vault.updateProvider("anthropic", update());
    await h.vault.updateProvider("openai", { expectedRevision: 1, secretAction: "replace", apiKey: SECRET, models: ["gpt-6-luna"] });
    await h.vault.updateLimits({ expectedRevision: 2, defaultProvider: "openai", maxCallsPerDay: 9, maxActiveRuns: 1 });
    await h.vault.activateIfIdle(async () => true);
    expect(readableByPreviousRelease(await fs.readFile(h.path), h.masterKey)).toBe(true);
    expect(await fs.readdir(h.directory)).toEqual(FILES);
  });

  it("the first DeepSeek save keeps the exact earlier file as a private backup, once, and makes DeepSeek the default", async () => {
    const h = await harness();
    await h.vault.updateProvider("anthropic", { ...update(), workspaceAction: "replace", workspaceId: "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ" });
    const original = await fs.readFile(h.path);
    await h.vault.updateProvider("deepseek", { expectedRevision: 1, secretAction: "replace", apiKey: DEEPSEEK_KEY, models: ["deepseek-flash"] },
      { makeDefault: true });
    const backup = `${h.path}${DEEPSEEK_BACKUP_SUFFIX}`;
    expect((await fs.readdir(h.directory)).sort()).toEqual([...FILES, `model-config.enc${DEEPSEEK_BACKUP_SUFFIX}`].sort());
    expect(await fs.readFile(backup)).toEqual(original);
    expect((await fs.stat(backup)).mode & 0o777).toBe(0o600);
    expect(readableByPreviousRelease(await fs.readFile(backup), h.masterKey)).toBe(true);
    // The live file now needs this release; the key stays ciphertext only.
    const live = await fs.readFile(h.path);
    expect(live.toString()).not.toContain(DEEPSEEK_KEY);
    expect(readableByPreviousRelease(live, h.masterKey)).toBe(false);
    const doc = await (await h.reopen()).read();
    expect(doc.saved).toMatchObject({ revision: 2, defaultProvider: "deepseek" });
    expect(doc.saved.providers.deepseek).toEqual({ apiKey: DEEPSEEK_KEY, baseUrl: DEEPSEEK_URL, models: ["deepseek-flash"] });
    // Claude's key and workspace, OpenAI and the active (pending restart) settings are untouched.
    expect(doc.saved.providers.anthropic).toEqual({ apiKey: SECRET, baseUrl: "https://api.anthropic.com/v1/messages", models: ["claude-test"],
      workspaceId: "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ" });
    expect(doc.active).toMatchObject({ revision: 0, defaultProvider: "anthropic" });
    expect(doc.active.providers.deepseek.apiKey).toBeNull();
    expect(doc.audit.at(-1)).toMatchObject({ action: "provider_updated", providerKey: "deepseek", revision: 2 });
    expect(JSON.stringify(doc.audit)).not.toContain(DEEPSEEK_KEY);
    // A later save never replaces the kept backup.
    const reopened = await h.reopen();
    await reopened.updateProvider("deepseek", { expectedRevision: 2, secretAction: "replace", apiKey: `${DEEPSEEK_KEY}-2`, models: ["deepseek-flash"] }, { makeDefault: true });
    expect(await fs.readFile(backup)).toEqual(original);
    // Activation copies DeepSeek into the active settings at the next start.
    const active = await (await h.reopen()).activateIfIdle(async () => true);
    expect(active.active).toMatchObject({ revision: 3, defaultProvider: "deepseek" });
    expect(active.active.providers.deepseek.apiKey).toBe(`${DEEPSEEK_KEY}-2`);
  });

  it("clearing the DeepSeek key also clears its models and its default, so the file is readable by the previous release again", async () => {
    const h = await harness();
    await h.vault.updateProvider("deepseek", { expectedRevision: 0, secretAction: "replace", apiKey: DEEPSEEK_KEY, models: ["deepseek-flash"] }, { makeDefault: true });
    await h.vault.activateIfIdle(async () => true);
    await h.vault.updateProvider("deepseek", { expectedRevision: 1, secretAction: "clear", models: ["deepseek-flash"] });
    let doc = await h.vault.read();
    expect(doc.saved.defaultProvider).toBeNull();
    expect(doc.saved.providers.deepseek).toEqual({ apiKey: null, baseUrl: DEEPSEEK_URL, models: [] });
    // Active still holds DeepSeek until the restart applies the cleared settings.
    expect(readableByPreviousRelease(await fs.readFile(h.path), h.masterKey)).toBe(false);
    await h.vault.activateIfIdle(async () => true);
    doc = await h.vault.read();
    expect(doc.active.providers.deepseek.apiKey).toBeNull();
    expect(readableByPreviousRelease(await fs.readFile(h.path), h.masterKey)).toBe(true);
  });

  it("refuses a DeepSeek default without a DeepSeek key, a DeepSeek workspace and another endpoint, writing nothing", async () => {
    const h = await harness();
    const before = await fs.readFile(h.path);
    await expect(h.vault.updateLimits({ expectedRevision: 0, defaultProvider: "deepseek", maxCallsPerDay: 9, maxActiveRuns: 1 })).rejects.toMatchObject({ status: 400 });
    await expect(h.vault.updateProvider("deepseek", { expectedRevision: 0, secretAction: "replace", apiKey: DEEPSEEK_KEY, models: ["deepseek-flash"],
      workspaceAction: "replace", workspaceId: "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ" })).rejects.toMatchObject({ status: 400 });
    await expect(h.vault.updateProvider("deepseek", { expectedRevision: 0, secretAction: "replace", apiKey: DEEPSEEK_KEY, models: ["deepseek-flash"],
      baseUrl: "https://proxy.example.test/chat/completions" })).rejects.toMatchObject({ status: 400 });
    expect(await fs.readFile(h.path)).toEqual(before);
    expect(await fs.readdir(h.directory)).toEqual(FILES);
  });

  it("a v1 file never brings its old DeepSeek key back, even when DeepSeek is saved again later", async () => {
    const h = await v1Harness();
    const vault = await h.open();
    await vault.updateProvider("deepseek", { expectedRevision: 3, secretAction: "replace", apiKey: DEEPSEEK_KEY, models: ["deepseek-flash"] }, { makeDefault: true });
    const doc = await (await h.open()).read();
    expect(doc.saved.providers.deepseek.apiKey).toBe(DEEPSEEK_KEY);
    expect(JSON.stringify(doc)).not.toContain(DEEPSEEK_SECRET);
    // The v1 file is kept as its own backup; it is not the file from before DeepSeek, so no second backup is made from it.
    expect(await fs.readFile(`${h.path}${V1_BACKUP_SUFFIX}`)).toEqual(h.original);
    expect((await fs.readdir(h.directory)).sort()).toEqual([...FILES, `model-config.enc${V1_BACKUP_SUFFIX}`].sort());
    expect(doc.retired).toEqual({ providers: ["qwen", "deepseek"], retiredDefault: "qwen" });
  });
});

describe.skipIf(process.platform === "win32")("ModelConfigVault: the backup from before DeepSeek is complete and intact, or nothing is replaced", () => {
  const BACKUP = `model-config.enc${DEEPSEEK_BACKUP_SUFFIX}`;
  const saveDeepseek = (vault: ModelConfigVault, expectedRevision: number, apiKey = DEEPSEEK_KEY) =>
    vault.updateProvider("deepseek", { expectedRevision, secretAction: "replace", apiKey, models: ["deepseek-flash"] }, { makeDefault: true });

  /** A vault with a saved Claude key and Workspace ID, so a refused write can be seen to keep every other setting. */
  async function prepared() {
    const h = await harness();
    await h.vault.updateProvider("anthropic", { ...update(), workspaceAction: "replace", workspaceId: "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ" });
    return { ...h, original: await fs.readFile(h.path) };
  }

  /** The live file is the one from before the refused save, readable, with its revisions and settings unchanged. */
  async function liveKept(h: Awaited<ReturnType<typeof prepared>>) {
    expect(await fs.readFile(h.path)).toEqual(h.original);
    const doc = await (await h.reopen()).read();
    expect([doc.saved.revision, doc.active.revision]).toEqual([1, 0]);
    expect(doc.saved.providers.anthropic).toMatchObject({ apiKey: SECRET, workspaceId: "wrkspc_01JwQvzr7rXLA5AGx3HKfFUJ" });
    expect(doc.saved.providers.deepseek.apiKey).toBeNull();
    expect((await fs.readdir(h.directory)).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock"))).toEqual([]);
  }

  it.each([
    ["an empty file", async (path: string) => { await fs.writeFile(path, Buffer.alloc(0), { mode: 0o600 }); }],
    ["a truncated copy", async (path: string, original: Buffer) => { await fs.writeFile(path, original.subarray(0, Math.floor(original.length / 2)), { mode: 0o600 }); }],
    ["a world-readable copy", async (path: string, original: Buffer) => { await fs.writeFile(path, original, { mode: 0o600 }); await fs.chmod(path, 0o644); }],
    ["a symbolic link", async (path: string, _original: Buffer, live: string) => { await fs.symlink(live, path); }],
    ["a copy under another master key", async (path: string) => {
      const other = await harness();
      await other.vault.updateProvider("anthropic", update());
      await fs.writeFile(path, await fs.readFile(other.path), { mode: 0o600 });
    }],
  ] as const)("refuses to go on over %s at the backup name, and keeps the live configuration whole", async (_name, make) => {
    const h = await prepared();
    await make(`${h.path}${DEEPSEEK_BACKUP_SUFFIX}`, h.original, h.path);
    const before = await fs.lstat(`${h.path}${DEEPSEEK_BACKUP_SUFFIX}`);
    await expect(saveDeepseek(h.vault, 1)).rejects.toMatchObject({ status: 503 });
    await liveKept(h);
    // The damaged backup is not overwritten either.
    const after = await fs.lstat(`${h.path}${DEEPSEEK_BACKUP_SUFFIX}`);
    expect([after.size, after.mode, after.isSymbolicLink()]).toEqual([before.size, before.mode, before.isSymbolicLink()]);
  });

  it("refuses a backup of this vault that already holds DeepSeek (not readable by the release before it)", async () => {
    const h = await prepared();
    await saveDeepseek(h.vault, 1);
    const withDeepseek = await fs.readFile(h.path);
    // Back to the shape without DeepSeek, then replace the kept backup with a file of this vault that holds DeepSeek.
    await h.vault.updateProvider("deepseek", { expectedRevision: 2, secretAction: "clear", models: [] });
    await h.vault.activateIfIdle(async () => true);
    const live = await fs.readFile(h.path);
    await fs.rm(`${h.path}${DEEPSEEK_BACKUP_SUFFIX}`);
    await fs.writeFile(`${h.path}${DEEPSEEK_BACKUP_SUFFIX}`, withDeepseek, { mode: 0o600 });
    await expect(saveDeepseek(h.vault, 3)).rejects.toMatchObject({ status: 503 });
    expect(await fs.readFile(h.path)).toEqual(live);
    expect(await fs.readFile(`${h.path}${DEEPSEEK_BACKUP_SUFFIX}`)).toEqual(withDeepseek);
  });

  it("a backup that fails while being written is never published: the next save writes it whole, then saves", async () => {
    const h = await prepared();
    vi.mocked(fs.link).mockRejectedValueOnce(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
    await expect(saveDeepseek(h.vault, 1)).rejects.toMatchObject({ status: 503 });
    await liveKept(h);
    expect((await fs.readdir(h.directory)).sort()).toEqual([...FILES].sort());
    await saveDeepseek(h.vault, 1);
    expect(await fs.readFile(`${h.path}${DEEPSEEK_BACKUP_SUFFIX}`)).toEqual(h.original);
    expect((await fs.stat(`${h.path}${DEEPSEEK_BACKUP_SUFFIX}`)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(`${h.path}${DEEPSEEK_BACKUP_SUFFIX}`)).nlink).toBe(1);
    expect((await fs.readdir(h.directory)).sort()).toEqual([...FILES, BACKUP].sort());
    const doc = await (await h.reopen()).read();
    expect([doc.saved.revision, doc.saved.defaultProvider, doc.saved.providers.deepseek.apiKey]).toEqual([2, "deepseek", DEEPSEEK_KEY]);
  });

  it("keeps the earliest intact backup although the live file changed since: it is checked, not compared with the live bytes", async () => {
    const h = await prepared();
    await saveDeepseek(h.vault, 1);
    await h.vault.updateProvider("deepseek", { expectedRevision: 2, secretAction: "clear", models: [] });
    await h.vault.updateLimits({ expectedRevision: 3, defaultProvider: "openai", maxCallsPerDay: 11, maxActiveRuns: 1 });
    await h.vault.activateIfIdle(async () => true);
    expect(await fs.readFile(h.path)).not.toEqual(h.original);
    await saveDeepseek(h.vault, 4, `${DEEPSEEK_KEY}-2`);
    expect(await fs.readFile(`${h.path}${DEEPSEEK_BACKUP_SUFFIX}`)).toEqual(h.original);
    const doc = await (await h.reopen()).read();
    expect([doc.saved.revision, doc.saved.defaultProvider, doc.saved.providers.deepseek.apiKey]).toEqual([5, "deepseek", `${DEEPSEEK_KEY}-2`]);
  });
});
