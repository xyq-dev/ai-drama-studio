import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadApiEnv } from "../config/env";
import { adminBootstrap } from "./admin-bootstrap";
import { claudeSetupState } from "@ai-drama/contracts";
import { AdminModelsService, managedProviderConfigs } from "./admin-models.service";

const CLAUDE_KEY = "sk-ant-api03-test-only-not-a-real-key-0123456789";

const base = {
  DATABASE_URL: "postgresql://unused:unused@127.0.0.1:55432/unused",
  REDIS_URL: "redis://127.0.0.1:56379", S3_ENDPOINT: "http://127.0.0.1:59000", S3_REGION: "us-east-1",
  S3_BUCKET: "test", S3_ACCESS_KEY_ID: "unused", S3_SECRET_ACCESS_KEY: "unused",
  APP_WORKSPACE_ID: "11111111-1111-4111-8111-111111111111",
};
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture(extra: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "admin-runtime-"));
  await chmod(directory, 0o700);
  directories.push(directory);
  const env = loadApiEnv({ ...base, MODEL_ADMIN_ENABLED: "true",
    MODEL_ADMIN_MASTER_KEY: randomBytes(32).toString("hex"), MODEL_ADMIN_CONFIG_PATH: join(directory, "models.enc"),
    OPENAI_API_KEY: "sk-legacy-test-secret",
    TITLE_WRITING_OPENAI_MODELS: "approved-model", ...extra });
  const bootstrap = adminBootstrap(env)!;
  return { env, bootstrap };
}

describe("admin bootstrap boundary", () => {
  it("stays unconfigured by default and ignores .env bootstrap secrets", () => {
    const env = loadApiEnv(base, { MODEL_ADMIN_ENABLED: "true", MODEL_ADMIN_MASTER_KEY: "a".repeat(64), SITE_AUTH_PASSWORD_HASH: "file-hash" });
    expect(env.MODEL_ADMIN_MASTER_KEY).toBeUndefined();
    expect(env.SITE_AUTH_PASSWORD_HASH).toBeUndefined();
    expect(adminBootstrap(env)).toBeNull();
  });
  it("rejects incomplete, relative, repository-local and insecure production configurations without values", async () => {
    const { env } = await fixture();
    const cases = [
      { MODEL_ADMIN_MASTER_KEY: "secret-invalid" }, { MODEL_ADMIN_CONFIG_PATH: "relative.enc" },
      { MODEL_ADMIN_CONFIG_PATH: "/repo/source/key.enc" }, { MODEL_ADMIN_ENABLED: "yes" },
      { MODEL_ADMIN_CONFIG_PATH: "/repo/source/..private/key.enc" },
    ];
    for (const change of cases) {
      expect(() => adminBootstrap({ ...env, ...change }, "/repo/source")).toThrow("管理员配置尚未就绪。");
    }
  });
  it("no longer needs or reads the old administrator token: access is the site login", async () => {
    const { env } = await fixture();
    expect(adminBootstrap(env)?.enabled).toBe(true);
    const legacy = adminBootstrap({ ...env, MODEL_ADMIN_TOKEN: "admin-test-".repeat(5), MODEL_ADMIN_PUBLIC_ORIGIN: "https://drama.example.test" });
    expect(legacy).toEqual(adminBootstrap(env));
    expect(Object.keys(legacy!).sort()).toEqual(["enabled", "masterKey", "path"]);
  });
  it("does not silently discard vault settings when the admin UI is disabled", async () => {
    const { env } = await fixture();
    const config = adminBootstrap({ ...env, MODEL_ADMIN_ENABLED: "false" });
    expect(config?.enabled).toBe(false);
    expect(config?.path).toBe(env.MODEL_ADMIN_CONFIG_PATH);
    expect(() => adminBootstrap({ ...env, MODEL_ADMIN_ENABLED: "false", MODEL_ADMIN_MASTER_KEY: undefined })).toThrow();
  });
});

describe.skipIf(process.platform === "win32")("managed models runtime (real encrypted file, no DB/model calls)", () => {
  it("keeps the current provider frozen until restart, then clears without environment fallback", async () => {
    const { env, bootstrap } = await fixture();
    const idle = vi.fn(async () => true);
    const first = await AdminModelsService.open(env, bootstrap, idle);
    const changed = await first.updateProvider("openai", { expectedRevision: 0, models: ["approved-model"], secretAction: "clear" });
    expect(changed.saved.providers.find((item) => item.providerKey === "openai")?.keyConfigured).toBe(false);
    expect(changed.active.providers.find((item) => item.providerKey === "openai")?.keyConfigured).toBe(true);
    expect(changed.pendingRestart).toBe(true);
    expect(managedProviderConfigs(first.runtimeSettings()).openai.ok).toBe(true);
    const restarted = await AdminModelsService.open(env, bootstrap, idle);
    expect(managedProviderConfigs(restarted.runtimeSettings()).openai.ok).toBe(false);
    expect((await restarted.view()).pendingRestart).toBe(false);
    expect((await restarted.view()).titleWriting.enabled).toBe(false);
    expect(JSON.stringify(changed)).not.toContain("sk-legacy-test-secret");
    expect(await readFile(bootstrap.path, "utf8")).not.toContain("sk-legacy-test-secret");
  });
  it("defers activation for running jobs, including limit changes; needs a later restart to apply", async () => {
    const { env, bootstrap } = await fixture();
    const first = await AdminModelsService.open(env, bootstrap, async () => true);
    await first.updateLimits({ expectedRevision: 0, defaultProvider: "openai", maxCallsPerDay: 8, maxActiveRuns: 2 });
    const busy = await AdminModelsService.open(env, bootstrap, async () => false);
    expect(busy.runtimeSettings().maxCallsPerDay).toBe(30);
    expect(busy.runtimeSettings().maxActiveRuns).toBe(1);
    expect((await busy.view()).activationDeferred).toBe(true);
    expect((await busy.view()).saved.maxCallsPerDay).toBe(8);
    const next = await AdminModelsService.open(env, bootstrap, async () => true);
    expect(next.runtimeSettings().maxCallsPerDay).toBe(8);
    expect(next.runtimeSettings().defaultProvider).toBe("openai");
  });
  it("does not apply a pending config if checking running tasks fails", async () => {
    const { env, bootstrap } = await fixture();
    const first = await AdminModelsService.open(env, bootstrap, async () => true);
    await first.updateLimits({ expectedRevision: 0, defaultProvider: null, maxCallsPerDay: 8, maxActiveRuns: 1 });
    await expect(AdminModelsService.open(env, bootstrap, async () => { throw new Error("database unavailable"); })).rejects.toThrow();
    expect((await first.view()).activeRevision).toBe(0);
  });
  it("a Claude key alone is a complete setup: default model, Claude as default, applied only after a restart", async () => {
    const { env, bootstrap } = await fixture({ TITLE_WRITING_ENABLED: "true" });
    const storage = vi.fn(async () => ({ titleWriting: true, claude: true, candidates: false }));
    const first = await AdminModelsService.open(env, bootstrap, async () => true, { enabled: true, productionBlocked: false, siteOperator: true }, storage);
    expect(claudeSetupState(await first.view()).state).toBe("key_missing");
    const saved = await first.updateProvider("anthropic", { expectedRevision: 0, models: [], secretAction: "replace", apiKey: CLAUDE_KEY });
    const claude = saved.saved.providers.find((item) => item.providerKey === "anthropic")!;
    expect(claude).toMatchObject({ keyConfigured: true, models: ["claude-opus-5-5"], ready: true });
    expect(saved.saved.defaultProvider).toBe("anthropic");
    // Saved is not applied: the running API still has no Claude, and the console says so.
    expect(saved.pendingRestart).toBe(true);
    expect(claudeSetupState(saved).state).toBe("pending_restart");
    expect(JSON.stringify(saved)).not.toContain(CLAUDE_KEY);
    expect(await readFile(bootstrap.path, "utf8")).not.toContain(CLAUDE_KEY);
    // OpenAI is untouched: its key and models stay as they were.
    expect(saved.saved.providers.find((item) => item.providerKey === "openai")).toMatchObject({ keyConfigured: true, models: ["approved-model"] });
    const restarted = await AdminModelsService.open(env, bootstrap, async () => true, { enabled: true, productionBlocked: false, siteOperator: true }, storage);
    const view = await restarted.view();
    expect(managedProviderConfigs(restarted.runtimeSettings()).anthropic).toMatchObject({ ok: true, models: ["claude-opus-5-5"] });
    expect(restarted.runtimeSettings().defaultProvider).toBe("anthropic");
    expect(view.storage).toEqual({ titleWriting: true, claude: true, candidates: false });
    expect(claudeSetupState(view)).toEqual({ state: "migration_missing", migrations: ["20261016000200_writing_candidate"] });
    storage.mockResolvedValue({ titleWriting: true, claude: true, candidates: true });
    expect(claudeSetupState(await restarted.view()).state).toBe("ready");
  });
  it("refuses anything but an Anthropic Console API key before saving, and never replaces a default already chosen", async () => {
    const { env, bootstrap } = await fixture();
    const service = await AdminModelsService.open(env, bootstrap, async () => true);
    for (const apiKey of ["sk-ant-oat01-claude-code-oauth-token-abcdef", "sk-ant-admin01-admin-key-abcdefghij", "sk-proj-openai-like-key-abcdef"]) {
      await expect(service.updateProvider("anthropic", { expectedRevision: 0, models: [], secretAction: "replace", apiKey })).rejects.toMatchObject({ code: "ADMIN_CONFIG_KEY_FORMAT", status: 400 });
    }
    expect((await service.view()).savedRevision).toBe(0);
    await service.updateLimits({ expectedRevision: 0, defaultProvider: "openai", maxCallsPerDay: 30, maxActiveRuns: 1 });
    const saved = await service.updateProvider("anthropic", { expectedRevision: 1, models: ["claude-sonnet-5-5"], secretAction: "replace", apiKey: CLAUDE_KEY });
    expect(saved.saved.defaultProvider).toBe("openai");
    expect(saved.saved.providers.find((item) => item.providerKey === "anthropic")?.models).toEqual(["claude-sonnet-5-5"]);
  });
  it("cannot enable production calls by configuring a valid provider", async () => {
    const { env, bootstrap } = await fixture({ NODE_ENV: "production", TITLE_WRITING_ENABLED: "true" });
    const service = await AdminModelsService.open(env, bootstrap, async () => true);
    expect((await service.view()).titleWriting).toMatchObject({ enabled: false, productionBlocked: true });
  });
});
