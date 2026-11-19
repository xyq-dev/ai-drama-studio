import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerRealMediaRuntime } from "@ai-drama/providers";
import { loadApiEnv } from "../config/env";
import { adminBootstrap } from "./admin-bootstrap";
import { AdminMediaKeysService } from "./admin-media-keys.service";

const SYNTHETIC = "synthetic-openai-media-key-never-live";
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const base = {
  DATABASE_URL: "postgresql://unused:unused@127.0.0.1:55432/unused",
  REDIS_URL: "redis://127.0.0.1:56379",
  S3_ENDPOINT: "http://127.0.0.1:59000",
  S3_REGION: "us-east-1",
  S3_BUCKET: "test",
  S3_ACCESS_KEY_ID: "unused",
  S3_SECRET_ACCESS_KEY: "unused",
  APP_WORKSPACE_ID: WORKSPACE,
};
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(extra: Record<string, string> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "admin-media-keys-"));
  await chmod(directory, 0o700);
  directories.push(directory);
  const env = loadApiEnv({
    ...base,
    MODEL_ADMIN_ENABLED: "true",
    MODEL_ADMIN_MASTER_KEY: randomBytes(32).toString("hex"),
    MODEL_ADMIN_CONFIG_PATH: join(directory, "models.enc"),
    ...extra,
  });
  return { env, bootstrap: adminBootstrap(env)!, directory };
}

describe.skipIf(process.platform === "win32")("admin media keys service", () => {
  it("hot-reloads a replaced key into the runtime and never returns the secret", async () => {
    const { bootstrap } = await fixture();
    const processMediaEnv = {
      OPENAI_MEDIA_API_KEY: "stale-env-openai-media-key",
      DASHSCOPE_MEDIA_API_KEY: "env-dashscope-media-key",
      REAL_MEDIA_ENABLED: "false",
    };
    const runtime = new ServerRealMediaRuntime(WORKSPACE, processMediaEnv, false);
    const service = await AdminMediaKeysService.open(bootstrap, processMediaEnv, runtime);
    const before = await service.view();
    expect(before.slots.find((s) => s.slot === "OPENAI_MEDIA_API_KEY")).toMatchObject({
      status: "saved",
      source: "environment",
      managed: false,
    });
    expect(JSON.stringify(before)).not.toContain("stale-env-openai-media-key");

    const saved = await service.updateSlot({
      expectedRevision: 0,
      slot: "OPENAI_MEDIA_API_KEY",
      secretAction: "replace",
      apiKey: SYNTHETIC,
    });
    expect(saved.pendingRestart).toBe(false);
    expect(saved.slots.find((s) => s.slot === "OPENAI_MEDIA_API_KEY")).toMatchObject({
      status: "saved",
      source: "managed",
      managed: true,
      keyConfigured: true,
      priceConfigured: false,
      serviceState: "saved_not_ready",
    });
    expect(JSON.stringify(saved)).not.toContain(SYNTHETIC);
    expect(runtime.mediaEnvironment().OPENAI_MEDIA_API_KEY).toBe(SYNTHETIC);
    expect(await readFile(join(bootstrap.path.replace(/models\.enc$/, "media-keys.enc")), "utf8")).not.toContain(SYNTHETIC);
  });

  it("managed clear never falls back to a stale environment secret", async () => {
    const { bootstrap } = await fixture();
    const processMediaEnv = { MINIMAX_API_KEY: "stale-env-minimax-key-value" };
    const runtime = new ServerRealMediaRuntime(WORKSPACE, processMediaEnv, false);
    const reload = vi.spyOn(runtime, "reloadMediaApiKeys");
    const service = await AdminMediaKeysService.open(bootstrap, processMediaEnv, runtime);
    await service.updateSlot({ expectedRevision: 0, slot: "MINIMAX_API_KEY", secretAction: "replace", apiKey: "synthetic-minimax-key-aa" });
    const cleared = await service.updateSlot({ expectedRevision: 1, slot: "MINIMAX_API_KEY", secretAction: "clear" });
    expect(cleared.slots.find((s) => s.slot === "MINIMAX_API_KEY")).toMatchObject({
      status: "empty",
      managed: true,
      source: "none",
      keyConfigured: false,
      serviceState: "unconfigured",
    });
    expect(runtime.mediaEnvironment().MINIMAX_API_KEY).toBeUndefined();
    expect(reload).toHaveBeenCalled();
    expect(JSON.stringify(cleared)).not.toMatch(/stale-env-minimax|synthetic-minimax/);
  });

  it("leaves never-managed slots on env fallback", async () => {
    const { bootstrap } = await fixture();
    const processMediaEnv = { DASHSCOPE_MEDIA_API_KEY: "env-only-dashscope-media-key" };
    const runtime = new ServerRealMediaRuntime(WORKSPACE, processMediaEnv, false);
    const service = await AdminMediaKeysService.open(bootstrap, processMediaEnv, runtime);
    await service.updateSlot({
      expectedRevision: 0,
      slot: "OPENAI_MEDIA_API_KEY",
      secretAction: "replace",
      apiKey: SYNTHETIC,
    });
    const view = await service.view();
    expect(view.slots.find((s) => s.slot === "DASHSCOPE_MEDIA_API_KEY")).toMatchObject({
      managed: false,
      source: "environment",
      keyConfigured: true,
    });
    expect(runtime.mediaEnvironment().DASHSCOPE_MEDIA_API_KEY).toBe("env-only-dashscope-media-key");
  });
});
