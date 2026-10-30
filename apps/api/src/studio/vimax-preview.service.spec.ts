import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { vimaxPlatformPreviewResponseSchema, type VimaxPlatformSourceSnapshot } from "@ai-drama/contracts";
import type { VimaxPreviewSourceRead } from "@ai-drama/database";
import { VimaxPreviewService } from "./vimax-preview.service";

const fixture = JSON.parse(readFileSync(resolve(__dirname, "../../../../scripts/vimax-evaluation/fixtures/single-scene.json"), "utf8")) as {
  input: VimaxPlatformSourceSnapshot & Record<string, unknown>; candidate: unknown; supplements: unknown;
};
const I = fixture.input;
const SOURCE: VimaxPlatformSourceSnapshot = {
  schema: "ads.vimax-platform-source.v1", projectId: I.projectId, episodeId: I.episodeId, episodeNo: I.episodeNo,
  scriptRevisionId: I.scriptRevisionId, scriptRevisionNo: 2, scriptContentHash: I.scriptContentHash,
  scriptText: I.scriptText, characters: I.characters,
};
const body = () => structuredClone({
  schema: "ads.vimax-platform-preview.request.v1", source: {
    scriptRevisionId: SOURCE.scriptRevisionId, scriptContentHash: SOURCE.scriptContentHash, characters: SOURCE.characters,
  }, sceneSpans: I.sceneSpans, selectedSceneKeys: I.selectedSceneKeys, sourceDialogue: I.sourceDialogue,
  requirements: I.requirements, candidate: fixture.candidate, supplements: fixture.supplements,
});
function setup(read: VimaxPreviewSourceRead = { kind: "ok", source: structuredClone(SOURCE) }, nodeEnv: "test" | "production" = "test") {
  const source = { read: vi.fn(async () => read) };
  const service = new VimaxPreviewService({ workspaceId: "workspace-server", nodeEnv, source,
    clock: () => new Date("2026-10-31T00:00:00.000Z") });
  return { source, service };
}
afterEach(() => { vi.unstubAllGlobals(); });

describe("ViMax platform preview validates a fresh source without calls or persistence", () => {
  it("reads source directly and previews only using server text, with a versioned read-only response", async () => {
    const fetchSpy = vi.fn(() => { throw new Error("network forbidden"); });
    vi.stubGlobal("fetch", fetchSpy);
    const { source, service } = setup();
    expect(await service.source(SOURCE.projectId, SOURCE.episodeId)).toEqual({ status: 200, body: SOURCE });
    const request = body();
    const before = structuredClone(request);
    const result = await service.preview(SOURCE.projectId, SOURCE.episodeId, request);
    expect(result.status).toBe(200);
    const response = vimaxPlatformPreviewResponseSchema.parse(result.body);
    expect(response.source).toEqual(SOURCE);
    expect(response.report.status).toBe("ready_for_review");
    expect(response.report.writeAllowed).toBe(false);
    expect(response.report.gaps).toContain("source_can_change_after_preview");
    expect(response.verifiedAt).toBe("2026-10-31T00:00:00.000Z");
    expect(response.modelCalls).toBe(0);
    expect(response.persisted).toBe(false);
    expect(request).toEqual(before);
    expect(source.read).toHaveBeenCalledTimes(2);
    expect(source.read).toHaveBeenLastCalledWith("workspace-server", SOURCE.projectId, SOURCE.episodeId);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses production before source reads", async () => {
    const { source, service } = setup(undefined, "production");
    expect((await service.source(SOURCE.projectId, SOURCE.episodeId)).status).toBe(404);
    expect((await service.preview(SOURCE.projectId, SOURCE.episodeId, body())).status).toBe(404);
    expect(source.read).not.toHaveBeenCalled();
  });

  it.each([
    ["not_found", 404, "VIMAX_PREVIEW_SOURCE_NOT_FOUND"],
    ["series_not_enabled", 409, "SERIES_MEDIA_NOT_ENABLED"],
    ["script_review_required", 409, "VIMAX_PREVIEW_SCRIPT_REVIEW_REQUIRED"],
    ["script_unsupported", 409, "VIMAX_PREVIEW_SCRIPT_UNSUPPORTED"],
    ["too_many_characters", 409, "VIMAX_PREVIEW_TOO_MANY_CHARACTERS"],
    ["characters_unsupported", 409, "VIMAX_PREVIEW_CHARACTERS_UNSUPPORTED"],
  ] as const)("reports %s explicitly on both routes", async (kind, status, code) => {
    const { service } = setup({ kind });
    for (const result of [await service.source(SOURCE.projectId, SOURCE.episodeId),
      await service.preview(SOURCE.projectId, SOURCE.episodeId, body())]) {
      expect(result.status).toBe(status);
      expect(result.body).toMatchObject({ error: { code } });
    }
  });

  it.each(["revision", "hash", "name", "character_revision", "identity", "order", "missing"])(
    "refuses changed source %s before evaluating a candidate", async (change) => {
      const { service } = setup();
      const request = body();
      if (change === "revision") request.source.scriptRevisionId = "99999999-9999-4999-8999-999999999999";
      if (change === "hash") request.source.scriptContentHash = "0".repeat(64);
      if (change === "name") request.source.characters[0]!.name = "同名替换";
      if (change === "character_revision") request.source.characters[0]!.revisionId = "99999999-9999-4999-8999-999999999999";
      if (change === "identity") request.source.characters[0]!.characterId = "99999999-9999-4999-8999-999999999999";
      if (change === "order") request.source.characters.reverse();
      if (change === "missing") request.source.characters.pop();
      const result = await service.preview(SOURCE.projectId, SOURCE.episodeId, request);
      expect(result.status).toBe(409);
      expect(result.body).toMatchObject({ error: { code: "VIMAX_PREVIEW_SOURCE_CHANGED" } });
    },
  );

  it("rejects browser-supplied text, approval claims and workspace rather than trusting them", async () => {
    const { service, source } = setup();
    for (const extra of [{ scriptText: "伪造" }, { reviewStatus: "APPROVED" }, { workspaceId: "browser" }]) {
      expect((await service.preview(SOURCE.projectId, SOURCE.episodeId, { ...body(), ...extra })).status).toBe(400);
    }
    expect(source.read).not.toHaveBeenCalled();
  });

  it("caps the complete HTTP envelope without reading sources", async () => {
    const { service, source } = setup();
    const result = await service.preview(SOURCE.projectId, SOURCE.episodeId, { x: "a".repeat(300 * 1024) });
    expect(result.status).toBe(413);
    expect(source.read).not.toHaveBeenCalled();
  });

  it("returns a blocked read-only report for changed dialogue without leaking rejected lines", async () => {
    const { service } = setup();
    const request = body() as ReturnType<typeof body> & { supplements: { shots: Array<{ dialogue: Array<{ line: string }> }> } };
    request.supplements.shots[0]!.dialogue[0]!.line = "THIS-REJECTED-TEXT-MUST-NOT-LEAK";
    const result = await service.preview(SOURCE.projectId, SOURCE.episodeId, request);
    expect(result.status).toBe(200);
    const response = vimaxPlatformPreviewResponseSchema.parse(result.body);
    expect(response.report.status).toBe("blocked");
    expect(response.report.writeAllowed).toBe(false);
    expect(JSON.stringify(response.report)).not.toContain("THIS-REJECTED-TEXT-MUST-NOT-LEAK");
  });
});
