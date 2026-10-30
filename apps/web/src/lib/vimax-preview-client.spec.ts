import { describe, expect, it, vi } from "vitest";
import { VIMAX_PLATFORM_PREVIEW_MAX_BYTES } from "@ai-drama/contracts";
import { parseVimaxPreviewImport, VimaxPreviewClient } from "./vimax-preview-client";
import { vimaxPreviewFixture } from "./vimax-preview-test-fixtures";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const other = "11111111-1111-4111-8111-111111111111";

describe("platform Vimax import", () => {
  it("accepts only the versioned platform request and preserves source references", () => {
    const { request } = vimaxPreviewFixture();
    expect(parseVimaxPreviewImport(JSON.stringify(request))).toEqual(request);
  });
  it.each(["{", "null", "{}", JSON.stringify({ schema: "ads.vimax-evaluation.report.v1", status: "ready_for_review", writeAllowed: false })])("rejects malformed, missing or offline report input: %s", (text) => {
    expect(() => parseVimaxPreviewImport(text)).toThrow();
  });
  it("bounds UTF-8 bytes before parsing", () => {
    expect(() => parseVimaxPreviewImport("中".repeat(Math.floor(VIMAX_PLATFORM_PREVIEW_MAX_BYTES / 3) + 1))).toThrow("300 KB");
  });
  it("rejects browser-supplied authority and unknown fields", () => {
    const { request } = vimaxPreviewFixture();
    expect(() => parseVimaxPreviewImport(JSON.stringify({ ...request, reviewStatus: "APPROVED" }))).toThrow("格式不完整");
  });
});

describe("platform Vimax client receipts", () => {
  it("uses same-origin no-store requests and checks the complete scoped source", async () => {
    const { source } = vimaxPreviewFixture();
    const fetch = vi.fn(async () => json(source));
    const client = new VimaxPreviewClient(fetch);
    expect(await client.source(source.projectId, source.episodeId)).toEqual(source);
    expect(fetch.mock.calls[0]).toEqual([`/api/v1/projects/${source.projectId}/episodes/${source.episodeId}/vimax-preview/source`, expect.objectContaining({ method: "GET", cache: "no-store", credentials: "same-origin" })]);
  });
  it.each(["project", "episode", "missing"])("rejects foreign or incomplete source: %s", async (kind) => {
    const { source } = vimaxPreviewFixture();
    const body = kind === "project" ? { ...source, projectId: other } : kind === "episode" ? { ...source, episodeId: other } : { schema: source.schema };
    await expect(new VimaxPreviewClient(async () => json(body)).source(source.projectId, source.episodeId)).rejects.toMatchObject({ code: "PREVIEW_UNCONFIRMED" });
  });
  it("previews with the exact imported body and no provider or write credentials", async () => {
    const { source, request, response } = vimaxPreviewFixture();
    const fetch = vi.fn(async () => json(response));
    const client = new VimaxPreviewClient(fetch);
    expect(await client.preview(source.projectId, source.episodeId, request)).toEqual(response);
    expect(fetch.mock.calls[0]).toEqual([`/api/v1/projects/${source.projectId}/episodes/${source.episodeId}/vimax-preview`, expect.objectContaining({ method: "POST", cache: "no-store", credentials: "same-origin", body: JSON.stringify(request) })]);
    const headers = new Headers((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers);
    expect(headers.has("X-Operator-Token")).toBe(false);
    expect(headers.has("Idempotency-Key")).toBe(false);
  });
  it("accepts the same valid request with a different object key insertion order", async () => {
    const { source, request, response } = vimaxPreviewFixture();
    const reordered = { ...request,
      requirements: { style: request.requirements.style, targetSceneSeconds: request.requirements.targetSceneSeconds, aspectRatio: request.requirements.aspectRatio },
      sceneSpans: request.sceneSpans.map((scene) => ({ description: scene.description, timeOfDay: scene.timeOfDay, heading: scene.heading, end: scene.end, start: scene.start, key: scene.key })),
    };
    expect(await new VimaxPreviewClient(async () => json(response)).preview(source.projectId, source.episodeId, reordered)).toEqual(response);
  });
  it.each(["foreignScope", "changedSource", "foreignProvenance", "missingProvenance", "changedScene", "changedText", "changedShots", "changedCandidate", "paid", "saved", "writeAllowed", "wrongSchema", "incomplete"])("rejects a non-matching successful response: %s", async (kind) => {
    const { source, request, response } = vimaxPreviewFixture();
    if (response.report.status !== "ready_for_review") throw new Error("fixture");
    const body = structuredClone(response) as unknown as Record<string, unknown>;
    const changed = response;
    if (changed.report.status !== "ready_for_review") throw new Error("fixture");
    if (kind === "foreignScope") changed.source.episodeId = other;
    if (kind === "changedSource") changed.source.scriptContentHash = "d".repeat(64);
    if (kind === "foreignProvenance") changed.report.provenance!.projectId = other;
    if (kind === "missingProvenance") changed.report.provenance = null;
    if (kind === "changedScene") changed.report.review.scene.heading = "另一个场景";
    if (kind === "changedText") changed.report.review.sourceSceneText = "其他原文";
    if (kind === "changedShots") changed.report.review.shots[0]!.action = "其他动作";
    if (kind === "changedCandidate") changed.report.review.candidate.storyboard[0]!.visual_desc = "其他画面";
    if (kind === "paid") body.modelCalls = 1;
    if (kind === "saved") body.persisted = true;
    if (kind === "writeAllowed") (body.report as Record<string, unknown>).writeAllowed = true;
    if (kind === "wrongSchema") body.schema = "ads.vimax-evaluation.report.v1";
    if (kind === "incomplete") delete body.source;
    const received = ["paid", "saved", "writeAllowed", "wrongSchema", "incomplete"].includes(kind) ? body : changed;
    await expect(new VimaxPreviewClient(async () => json(received)).preview(source.projectId, source.episodeId, request)).rejects.toMatchObject({ code: "PREVIEW_UNCONFIRMED" });
  });
  it("accepts a complete blocked report without inventing review data", async () => {
    const { source, request, response } = vimaxPreviewFixture();
    const blocked = { ...response, report: { ...response.report, status: "blocked", diagnostics: [{ code: "dialogue_changed", path: "supplements.shots[0]" }], review: null } };
    const value = await new VimaxPreviewClient(async () => json(blocked)).preview(source.projectId, source.episodeId, request);
    expect(value.report.status).toBe("blocked");
    expect(value.report.review).toBeNull();
  });
  it.each([400, 409, 500])("keeps explicit HTTP %i failures distinct without echoing rejected prose", async (status) => {
    const { source, request } = vimaxPreviewFixture();
    await expect(new VimaxPreviewClient(async () => json({ error: { code: "SOURCE_CHANGED", message: "private rejected text" } }, status))
      .preview(source.projectId, source.episodeId, request)).rejects.toMatchObject({ status, code: "SOURCE_CHANGED", message: expect.not.stringContaining("private rejected text") });
  });
  it("does not send an invalid request", async () => {
    const { source } = vimaxPreviewFixture();
    const fetch = vi.fn();
    await expect(new VimaxPreviewClient(fetch).preview(source.projectId, source.episodeId, {} as never)).rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });
});
