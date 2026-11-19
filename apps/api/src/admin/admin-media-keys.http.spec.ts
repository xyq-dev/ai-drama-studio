import "reflect-metadata";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AdminMediaKeysView } from "@ai-drama/contracts";
import type { ApiEnv } from "../config/env";
import { SafeExceptionFilter } from "../http/safe-exception.filter";
import { AuthModule } from "../auth/auth.module";
import { hashPassword } from "../auth/password-hash";
import { SiteAuth, type SiteAuthState } from "../auth/site-auth";
import { setAdminResponseHeaders, type AdminHeaderResponse } from "./admin-auth";
import { ADMIN_MEDIA_KEYS_SERVICE, AdminMediaKeysController } from "./admin-media-keys.controller";

const PASSWORD = "test-only-site-password-Qm7#x";
const SECRET = "synthetic-media-key-never-echo";
const ORIGIN = "https://drama.example.test";
let HASH = "";

const VIEW: AdminMediaKeysView = {
  savedRevision: 0,
  pendingRestart: false,
  source: "environment",
  slots: [
    {
      slot: "OPENAI_MEDIA_API_KEY",
      label: "OpenAI 生图",
      hint: "hint",
      keyConfigured: false,
      status: "empty",
      managed: false,
      source: "none",
    },
  ],
  validation: "local_only",
  notices: ["填写密钥不等于自动发起付费生成"],
};

function backend() {
  return {
    view: vi.fn(async () => VIEW),
    updateSlot: vi.fn(async () => ({ ...VIEW, savedRevision: 1, source: "managed" as const })),
  };
}

beforeAll(async () => {
  HASH = await hashPassword(PASSWORD, { log2N: 15, r: 8, p: 1, saltBytes: 16, keyBytes: 32 });
});

describe("administrator media keys real HTTP boundary (site login)", () => {
  let app: INestApplication | undefined;
  let base: string;
  let store: ReturnType<typeof backend>;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function start(options: { site?: "enabled" | "disabled"; backendMissing?: boolean; creator?: boolean } = {}) {
    await app?.close();
    store = backend();
    const kind = options.site ?? "enabled";
    const state: SiteAuthState =
      kind === "enabled"
        ? { kind, auth: new SiteAuth({ username: "admin", passwordHash: HASH, publicOrigin: ORIGIN }) }
        : { kind };
    const module = await Test.createTestingModule({
      imports: [AuthModule.register({ NODE_ENV: "test" } as ApiEnv, state)],
      controllers: [AdminMediaKeysController],
      providers: [{ provide: ADMIN_MEDIA_KEYS_SERVICE, useValue: options.backendMissing ? null : store }],
    }).compile();
    app = module.createNestApplication({ logger: false });
    app.use("/api/v1/admin", (_request: unknown, response: AdminHeaderResponse, next: () => void) => {
      setAdminResponseHeaders(response);
      next();
    });
    app.setGlobalPrefix("api/v1");
    app.useGlobalFilters(new SafeExceptionFilter());
    await app.listen(0, "127.0.0.1");
    base = `${await app.getUrl()}/api/v1`;
  }

  const request = (path: string, init?: RequestInit) => fetch(`${base}${path}`, init);

  async function signedIn() {
    const response = await request("/auth/login", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: PASSWORD }),
    });
    expect(response.status).toBe(200);
    const cookie = response.headers
      .getSetCookie()
      .filter((item) => /^__Host-ads_(session|csrf)=/.test(item))
      .map((item) => item.split(";", 1)[0])
      .join("; ");
    const view = (await response.json()) as { csrfToken: string };
    return { cookie, csrf: view.csrfToken };
  }

  it("refuses anonymous and unconfigured access without leaking secrets", async () => {
    await start();
    const anonymous = await request("/admin/media-keys");
    expect(anonymous.status).toBe(401);
    expect(JSON.stringify(await anonymous.json())).not.toContain(SECRET);

    await start({ backendMissing: true });
    const session = await signedIn();
    const missing = await request("/admin/media-keys", { headers: { cookie: session.cookie } });
    expect(missing.status).toBe(503);
  });

  it("lets an operator read a redacted view and save with CSRF", async () => {
    await start();
    const session = await signedIn();
    const read = await request("/admin/media-keys", { headers: { cookie: session.cookie } });
    expect(read.status).toBe(200);
    expect(read.headers.get("cache-control")).toBe("private, no-store");
    const body = await read.json();
    expect(JSON.stringify(body)).not.toContain(SECRET);
    expect(body.validation).toBe("local_only");

    const write = await request("/admin/media-keys", {
      method: "PUT",
      headers: {
        cookie: session.cookie,
        origin: ORIGIN,
        "x-csrf-token": session.csrf,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        expectedRevision: 0,
        slot: "DASHSCOPE_MEDIA_API_KEY",
        secretAction: "replace",
        apiKey: SECRET,
      }),
    });
    expect(write.status).toBe(200);
    expect(store.updateSlot).toHaveBeenCalledOnce();
    expect(JSON.stringify(await write.json())).not.toContain(SECRET);
  });

  it("rejects writes without CSRF or with a non-JSON content type", async () => {
    await start();
    const session = await signedIn();
    const noCsrf = await request("/admin/media-keys", {
      method: "PUT",
      headers: { cookie: session.cookie, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: 0, slot: "MINIMAX_API_KEY", secretAction: "clear" }),
    });
    expect(noCsrf.status).toBe(403);
    expect(store.updateSlot).not.toHaveBeenCalled();
  });
});
