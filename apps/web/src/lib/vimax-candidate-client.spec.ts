// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VIMAX_CANDIDATE_PLACE_SHOTS_SCHEMA, VIMAX_CANDIDATE_SAVE_SCENE_SCHEMA } from "@ai-drama/contracts";
import { VimaxCandidateClient } from "./vimax-candidate-client";
import { vimaxCandidateFixture } from "./vimax-candidate-test-fixtures";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const other = "10000000-0000-4000-8000-000000000099";
beforeEach(() => { document.cookie = "ads_csrf=; Max-Age=0"; });
const sceneBody = { schema: VIMAX_CANDIDATE_SAVE_SCENE_SCHEMA, expectedVersion: 1, confirmedReview: true as const };
const shotsBody = { schema: VIMAX_CANDIDATE_PLACE_SHOTS_SCHEMA, expectedVersion: 2, confirmedReview: true as const };

describe("persistent Vimax candidate client", () => {
  it("reads scoped targets, a page and one candidate with no-store and same-origin credentials", async () => {
    const f = vimaxCandidateFixture();
    const fetch = vi.fn(async (path: string, _init?: RequestInit) => json(path.endsWith("/targets") ? f.targets : path.includes("?") ? f.page : f.stored));
    const client = new VimaxCandidateClient(fetch);
    expect(await client.targets(f.source.projectId, f.source.episodeId)).toEqual(f.targets);
    expect(await client.list(f.source.projectId, f.source.episodeId)).toEqual(f.page);
    expect(await client.get(f.source.projectId, f.source.episodeId, f.candidateId)).toEqual(f.stored);
    expect(fetch.mock.calls.every(([, init]) => init?.method === "GET" && init.cache === "no-store" && init.credentials === "same-origin")).toBe(true);
    expect(fetch.mock.calls[1]![0]).toContain("?limit=10");
  });
  it.each(["scope", "target", "duplicate", "incomplete"])("rejects invalid target receipts: %s", async (kind) => {
    const f = vimaxCandidateFixture();
    const value: unknown = kind === "incomplete" ? {} : f.targets;
    if (kind === "scope") f.targets.source.projectId = other;
    if (kind === "target") f.targets.targets[0]!.sourceScriptRevisionId = other;
    if (kind === "duplicate") f.targets.targets.push(structuredClone(f.targets.targets[0]!));
    await expect(new VimaxCandidateClient(async () => json(value)).targets(f.source.projectId, f.source.episodeId)).rejects.toMatchObject({ code: "VIMAX_CANDIDATE_UNCONFIRMED" });
  });
  it.each(["foreign", "duplicate", "receipt", "frozen", "eligibility"])("rejects a bad persisted candidate page: %s", async (kind) => {
    const f = vimaxCandidateFixture();
    if (kind === "foreign") f.page.items[0]!.episodeId = other;
    if (kind === "duplicate") f.page.items.push(structuredClone(f.page.items[0]!));
    if (kind === "receipt") f.page.items[0] = { ...f.sceneSaved, sceneReceipt: { ...f.sceneReceipt, candidateId: other } };
    if (kind === "frozen") f.page.items[0]!.frozen.request.requirements.style = "其他创作要求";
    if (kind === "eligibility") f.page.items[0]!.eligibility.canPlaceShots = true;
    await expect(new VimaxCandidateClient(async () => json(f.page)).list(f.source.projectId, f.source.episodeId)).rejects.toMatchObject({ code: "VIMAX_CANDIDATE_UNCONFIRMED" });
  });
  it("sends exact create identity and CSRF, then accepts a replay whose resource advanced", async () => {
    const f = vimaxCandidateFixture();
    document.cookie = `ads_csrf=${"x".repeat(43)}`;
    const fetch = vi.fn(async (_path: string, _init?: RequestInit) => json({ schema: "ads.vimax-candidate.create-response.v1", replayed: true, candidate: f.shotsSaved }));
    const result = await new VimaxCandidateClient(fetch).create(f.source.projectId, f.source.episodeId, f.create, f.createKey);
    expect(result.candidate.state).toBe("shots_saved");
    const init = fetch.mock.calls[0]![1]!;
    expect(JSON.parse(String(init.body))).toEqual(f.create);
    expect(new Headers(init.headers).get("Idempotency-Key")).toBe(f.createKey);
    expect(new Headers(init.headers).get("X-CSRF-Token")).toBe("x".repeat(43));
    expect(new Headers(init.headers).has("X-Operator-Token")).toBe(false);
  });
  it.each(["key", "source", "target", "body"])("rejects a create receipt belonging to another request: %s", async (kind) => {
    const f = vimaxCandidateFixture(); const saved = structuredClone(f.stored);
    if (kind === "key") saved.requestKey = other;
    if (kind === "source") saved.frozen.source.scriptContentHash = "0".repeat(64);
    if (kind === "target") saved.frozen.target.sceneRevisionId = other;
    if (kind === "body") saved.frozen.request.requirements.style = "另一个要求";
    await expect(new VimaxCandidateClient(async () => json({ schema: "ads.vimax-candidate.create-response.v1", replayed: false, candidate: saved }))
      .create(f.source.projectId, f.source.episodeId, f.create, f.createKey)).rejects.toMatchObject({ code: "VIMAX_CANDIDATE_UNCONFIRMED" });
  });
  it("verifies scene and shot receipts against the exact candidate, including historical replay", async () => {
    const f = vimaxCandidateFixture();
    const client = new VimaxCandidateClient(async (path) => json({ schema: "ads.vimax-candidate.write-response.v1", replayed: true,
      receipt: path.endsWith("/scene") ? f.sceneReceipt : f.shotsReceipt }));
    expect((await client.saveScene(f.source.projectId, f.source.episodeId, f.candidateId, sceneBody, f.sceneKey, undefined, f.shotsSaved)).receipt).toEqual(f.sceneReceipt);
    expect((await client.placeShots(f.source.projectId, f.source.episodeId, f.candidateId, shotsBody, f.shotsKey, undefined, f.approved)).receipt).toEqual(f.shotsReceipt);
  });
  it("cannot confirm a shot receipt without the candidate's saved-scene lineage", async () => {
    const f = vimaxCandidateFixture();
    const client = new VimaxCandidateClient(async () => json({ schema: "ads.vimax-candidate.write-response.v1", replayed: true, receipt: f.shotsReceipt }));
    await expect(client.placeShots(f.source.projectId, f.source.episodeId, f.candidateId, shotsBody, f.shotsKey, undefined, f.stored))
      .rejects.toMatchObject({ code: "VIMAX_CANDIDATE_UNCONFIRMED" });
  });
  it.each(["scope", "candidate", "key", "version", "operation", "scene", "savedRevision", "count", "index", "ids"])("rejects an unconfirmed write receipt: %s", async (kind) => {
    const f = vimaxCandidateFixture(); const receipt = structuredClone(f.shotsReceipt);
    if (kind === "scope") receipt.projectId = other;
    if (kind === "candidate") receipt.candidateId = other;
    if (kind === "key") receipt.idempotencyKey = other;
    if (kind === "version") (receipt as unknown as { rowVersion: number }).rowVersion = 4;
    if (kind === "scene") receipt.sceneId = other;
    if (kind === "savedRevision") receipt.sceneRevisionId = other;
    if (kind === "count") receipt.shots.pop();
    if (kind === "index") receipt.shots[0]!.index = 1;
    if (kind === "ids") receipt.shots[1]!.shotId = receipt.shots[0]!.shotId;
    const received = kind === "operation" ? f.sceneReceipt : receipt;
    await expect(new VimaxCandidateClient(async () => json({ schema: "ads.vimax-candidate.write-response.v1", replayed: false, receipt: received }))
      .placeShots(f.source.projectId, f.source.episodeId, f.candidateId, shotsBody, f.shotsKey, undefined, f.approved)).rejects.toMatchObject({ code: "VIMAX_CANDIDATE_UNCONFIRMED" });
  });
  it.each([400, 401, 403, 404, 409, 413, 422, 500, 503])("keeps HTTP %i failures explicit without displaying rejected private prose", async (status) => {
    const f = vimaxCandidateFixture();
    await expect(new VimaxCandidateClient(async () => json({ error: { code: "FIXED_CODE", message: "private source text" } }, status))
      .create(f.source.projectId, f.source.episodeId, f.create, f.createKey)).rejects.toMatchObject({ status, code: "FIXED_CODE", message: expect.not.stringContaining("private source text") });
  });
  it("distinguishes frozen-candidate storage refusal from the HTTP request-size limit", async () => {
    const f = vimaxCandidateFixture();
    const client = new VimaxCandidateClient(async () => json({ error: { code: "VIMAX_CANDIDATE_FROZEN_TOO_LARGE", message: "private source text" } }, 413));
    await expect(client.create(f.source.projectId, f.source.episodeId, f.create, f.createKey)).rejects.toMatchObject({
      status: 413, code: "VIMAX_CANDIDATE_FROZEN_TOO_LARGE", message: "冻结后的完整候选超出保存范围，请缩小方案后重新保存。",
    });
  });
  it("does not send invalid identity/body or over-limit creative requests", async () => {
    const f = vimaxCandidateFixture(); const fetch = vi.fn(); const client = new VimaxCandidateClient(fetch);
    await expect(client.create(f.source.projectId, f.source.episodeId, {} as never, f.createKey)).rejects.toMatchObject({ status: 400 });
    await expect(client.create(f.source.projectId, f.source.episodeId, f.create, "bad\nkey")).rejects.toMatchObject({ status: 400 });
    await expect(client.get(f.source.projectId, f.source.episodeId, "bad/id")).rejects.toMatchObject({ status: 400 });
    await expect(client.list(f.source.projectId, f.source.episodeId, { limit: 21 })).rejects.toMatchObject({ status: 400 });
    const large = structuredClone(f.create); const text = "中".repeat(4000);
    for (const shot of large.request.candidate.storyboard) { shot.visual_desc = text; shot.audio_desc = text; }
    for (const shot of large.request.candidate.shot_descriptions) {
      shot.visual_desc = text; shot.audio_desc = text; shot.variation_reason = text; shot.ff_desc = text; shot.lf_desc = text; shot.motion_desc = text;
    }
    for (const character of large.request.candidate.characters) { character.static_features = text; character.dynamic_features = text; }
    await expect(client.create(f.source.projectId, f.source.episodeId, large, f.createKey)).rejects.toMatchObject({ status: 413 });
    expect(fetch).not.toHaveBeenCalled();
  });
});
