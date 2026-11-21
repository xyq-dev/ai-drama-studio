import "reflect-metadata";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ApiEnv } from "../config/env";
import { SafeExceptionFilter } from "../http/safe-exception.filter";
import { AuthModule } from "../auth/auth.module";
import { hashPassword } from "../auth/password-hash";
import { SiteAuth, type SiteAuthState } from "../auth/site-auth";
import { setAdminResponseHeaders, type AdminHeaderResponse } from "./admin-auth";
import { FEATURE_CONFIG_SERVICE, FeatureConfigController } from "./feature-config.controller";

const PASSWORD = "test-only-site-password-Qm7#x";
const SECRET = "synthetic-feature-key-never-echo";
const ORIGIN = "https://drama.example.test";
let HASH = "";

function backend() {
  return {
    view: vi.fn(async () => ({ revision: 0, validation: "local_only", features: [] })),
    saveDraft: vi.fn(async () => ({ revision: 1, validation: "local_only", features: [] })),
    testDraft: vi.fn(async () => ({ view: { revision: 2, validation: "local_only", features: [] }, probe: { ok: true, message: "ok" } })),
    enable: vi.fn(),
    operatorUsage: vi.fn(async () => ({ scope: "episode_production", records: [], totals: [], projects: [], episodes: [], footnote: "未知", projectId: null, episodeId: null })),
    operatorUsageDetail: vi.fn(),
  };
}

beforeAll(async () => {
  HASH = await hashPassword(PASSWORD, { log2N: 15, r: 8, p: 1, saltBytes: 16, keyBytes: 32 });
});

describe("feature config HTTP boundary", () => {
  let app: INestApplication | undefined;
  let base: string;
  let store: ReturnType<typeof backend>;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function start(options: { creator?: boolean; backendMissing?: boolean } = {}) {
    await app?.close();
    store = backend();
    const state: SiteAuthState = {
      kind: "enabled",
      auth: new SiteAuth(
        { username: "admin", passwordHash: HASH, publicOrigin: ORIGIN },
        {
          creators: {
            findActiveByUsername: async (username: string) => username === "creator-a"
              ? { id: "creator-account", username, passwordHash: HASH }
              : null,
          },
        },
      ),
    };
    const module = await Test.createTestingModule({
      imports: [AuthModule.register({ NODE_ENV: "test" } as ApiEnv, state)],
      controllers: [FeatureConfigController],
      providers: [{ provide: FEATURE_CONFIG_SERVICE, useValue: options.backendMissing ? null : store }],
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
    void options.creator;
  }

  const request = (path: string, init?: RequestInit) => fetch(`${base}${path}`, init);

  async function login(username: string) {
    const response = await request("/auth/login", {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ username, password: PASSWORD }),
    });
    expect(response.status).toBe(200);
    const cookie = response.headers.getSetCookie().filter((item) => /^__Host-ads_(session|csrf)=/.test(item))
      .map((item) => item.split(";", 1)[0]).join("; ");
    const view = await response.json() as { csrfToken: string; role: string };
    return { cookie, csrf: view.csrfToken, role: view.role };
  }

  it("rejects anonymous callers and creators before any config is read", async () => {
    await start();
    expect((await request("/admin/features")).status).toBe(401);
    expect(store.view).not.toHaveBeenCalled();
    const creator = await login("creator-a");
    expect(creator.role).toBe("creator");
    const denied = await request("/admin/features", { headers: { cookie: creator.cookie } });
    expect(denied.status).toBe(401);
    const usage = await request("/admin/usage", { headers: { cookie: creator.cookie } });
    expect(usage.status).toBe(401);
    expect(JSON.stringify(await denied.json())).not.toContain(SECRET);
    expect(store.view).not.toHaveBeenCalled();
    expect(store.operatorUsage).not.toHaveBeenCalled();
  });

  it("does not call the probe when the test body is not an explicit confirmation", async () => {
    await start();
    const operator = await login("admin");
    const response = await request("/admin/features/storyboard/test", {
      method: "POST",
      headers: { cookie: operator.cookie, origin: ORIGIN, "content-type": "application/json", "x-csrf-token": operator.csrf },
      body: JSON.stringify({ expectedRevision: 1, vendor: "openai", confirmCost: false, apiKey: SECRET }),
    });
    expect(response.status).toBe(400);
    expect(store.testDraft).not.toHaveBeenCalled();
    expect(JSON.stringify(await response.json())).not.toContain(SECRET);
  });
});
