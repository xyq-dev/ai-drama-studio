import "reflect-metadata";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpeechGenerationPort } from "@ai-drama/contracts";
import type { SpeechPersistence } from "@ai-drama/database";
import type { ApiEnv } from "../config/env";
import { AuthModule } from "../auth/auth.module";
import { hashPassword } from "../auth/password-hash";
import { SiteAuth } from "../auth/site-auth";
import { SafeExceptionFilter } from "../http/safe-exception.filter";
import { SPEECH_SERVICE, SpeechController } from "./speech.controller";
import { SpeechService } from "./speech.service";

const id = "11111111-1111-4111-8111-111111111111";
const ORIGIN = "https://speech.example.test";
describe("speech HTTP scope, login and CSRF boundaries", () => {
  let app: INestApplication, base: string, cookie: string, csrf: string;
  const store = { storageReady: vi.fn(async () => true), requireProject: vi.fn(), bindings: vi.fn(async () => ({ items: [] })),
    generationInput: vi.fn(async () => ({ workspaceId: id, projectId: id, planRevisionId: id, lineId: id })), select: vi.fn(async () => ({ rowVersion: 3, selection: { takeAssetId: id } })) };
  const port = { capabilities: vi.fn(async () => ({ available: true, catalogVersion: "v1", reasonCode: null, voices: [] })),
    generate: vi.fn(async () => ({ jobId: id, workflowRunId: id, reused: false })) };
  const headers = (extra: Record<string, string> = {}) => ({ cookie, origin: ORIGIN, "x-csrf-token": csrf,
    "content-type": "application/json", "idempotency-key": "permanent-key", "if-match": "2", ...extra });
  beforeAll(async () => {
    const passwordHash = await hashPassword("speech-http-only-password#3", { log2N: 15, r: 8, p: 1, saltBytes: 16, keyBytes: 32 });
    const module = await Test.createTestingModule({ imports: [AuthModule.register({ NODE_ENV: "test" } as ApiEnv,
      { kind: "enabled", auth: new SiteAuth({ username: "admin", passwordHash, publicOrigin: ORIGIN }) })], controllers: [SpeechController],
    providers: [{ provide: SPEECH_SERVICE, useValue: new SpeechService({ workspaceId: id, store: store as unknown as SpeechPersistence, generation: port as unknown as SpeechGenerationPort }) }] }).compile();
    app = module.createNestApplication({ logger: false }); app.setGlobalPrefix("api/v1"); app.useGlobalFilters(new SafeExceptionFilter());
    await app.listen(0, "127.0.0.1"); base = `${await app.getUrl()}/api/v1`;
    const login = await fetch(`${base}/auth/login`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ username: "admin", password: "speech-http-only-password#3" }) });
    cookie = login.headers.getSetCookie().map((v) => v.split(";", 1)[0]).join("; "); csrf = (await login.json() as { csrfToken: string }).csrfToken;
  });
  beforeEach(() => vi.clearAllMocks());
  afterAll(async () => app.close());
  it("rejects anonymous reads and every paid submission before touching persistence or providers", async () => {
    expect((await fetch(`${base}/projects/${id}/speech-capabilities`)).status).toBe(401);
    expect((await fetch(`${base}/speech-plans/${id}/lines/${id}/generate`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    expect(store.storageReady).not.toHaveBeenCalled(); expect(port.generate).not.toHaveBeenCalled();
  });
  it("requires the actual site Origin and CSRF proof for quote, generate and selection", async () => {
    for (const [path, method] of [[`/speech-plans/${id}/lines/${id}/quote`, "POST"], [`/speech-plans/${id}/lines/${id}/generate`, "POST"], [`/speech-plans/${id}/selections/${id}`, "PUT"]]) {
      expect((await fetch(`${base}${path}`, { method, headers: { cookie, origin: ORIGIN, "content-type": "application/json" }, body: "{}" })).status).toBe(403);
      expect((await fetch(`${base}${path}`, { method, headers: headers({ origin: "https://other.test" }), body: "{}" })).status).toBe(403);
    }
    expect(store.storageReady).not.toHaveBeenCalled(); expect(port.generate).not.toHaveBeenCalled();
  });
  it("scopes reads to the server workspace and prevents browser-supplied scope and execution controls", async () => {
    const result = await fetch(`${base}/projects/${id}/voice-bindings`, { headers: { cookie } });
    expect(result.status).toBe(200); expect(result.headers.get("cache-control")).toBe("private, no-store");
    expect(store.bindings).toHaveBeenCalledWith(id, id);
    expect((await fetch(`${base}/projects/not-a-uuid/voice-bindings`, { headers: { cookie } })).status).toBe(400);
    const forged = await fetch(`${base}/speech-plans/${id}/lines/${id}/generate`, { method: "POST", headers: headers(),
      body: JSON.stringify({ quoteId: "q", budgetAuthorizationId: id, workspaceId: id, bypassBudget: true }) });
    expect(forged.status).toBe(400); expect(port.generate).not.toHaveBeenCalled();
  });
  it("passes permanent identity, CAS and exact take hash through explicit selection, with no generation", async () => {
    const body = { takeAssetId: id, expectedTakeChecksumSha256: "a".repeat(64) };
    const result = await fetch(`${base}/speech-plans/${id}/selections/${id}`, { method: "PUT", headers: headers({ "x-trace-id": "speech-trace" }), body: JSON.stringify(body) });
    expect(result.status).toBe(200);
    expect(store.select).toHaveBeenCalledExactlyOnceWith(id, id, id, body, 2,
      { actorId: "server-owner", idempotencyKey: "permanent-key", traceId: "speech-trace" });
    expect(port.generate).not.toHaveBeenCalled();
  });
});
