import { describe, expect, it, vi } from "vitest";
import { requestHash, type JobPersistenceService, type MediaAssetStore, type RuntimeStore, type TextChainService } from "@ai-drama/database";
import { StudioService } from "./studio.service";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const revisionId = "22222222-2222-4222-8222-222222222222";
const context = { actorId: "owner", traceId: "test", idempotencyKey: "same-key" };

function service(options: {
  enabled?: boolean;
  dialogue?: string | null;
  promptText?: string;
  jobs?: { createAndQueueWorkflowJob: ReturnType<typeof vi.fn> };
}): StudioService {
  const jobs = options.jobs ?? { createAndQueueWorkflowJob: vi.fn() };
  const media = {
    prepareShotGenerationInTransaction: vi.fn(async () => ({
      projectId: "33333333-3333-4333-8333-333333333333",
      promptText: options.promptText ?? "saved prompt",
      dialogue: options.dialogue === undefined ? "saved dialogue" : options.dialogue,
    })),
  } as unknown as MediaAssetStore;
  return new StudioService(
    jobs as unknown as JobPersistenceService,
    {} as RuntimeStore,
    {} as TextChainService,
    workspaceId,
    undefined,
    media,
    true,
    "D:\\mock-objects",
    true,
    options.enabled !== false,
  );
}

describe("mock subtitle and music routes", () => {
  it("stays closed when the subtitle-music flag is off even if image and AV are on", async () => {
    const jobs = { createAndQueueWorkflowJob: vi.fn() };
    const closed = service({ enabled: false, jobs });
    await expect(closed.generateShotSubtitle(revisionId, {}, context)).rejects.toMatchObject({ code: "CONFIGURATION_ERROR" });
    await expect(closed.generateShotMusic(revisionId, {}, context)).rejects.toMatchObject({ code: "CONFIGURATION_ERROR" });
    expect(jobs.createAndQueueWorkflowJob).not.toHaveBeenCalled();
  });

  it("rejects empty saved dialogue or prompt before creating a job", async () => {
    const jobs = { createAndQueueWorkflowJob: vi.fn(async (_scope: unknown, factory: (client: unknown) => Promise<unknown>) => factory({})) };
    await expect(service({ dialogue: "  ", jobs }).generateShotSubtitle(revisionId, {}, context))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(service({ promptText: "", jobs }).generateShotMusic(revisionId, {}, context))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("queues both routes and changes the idempotency hash when the body changes", async () => {
    const calls: Array<{ routeKey: string; key: string; requestHash: string; kind: string; capability: string }> = [];
    const jobs = {
      createAndQueueWorkflowJob: vi.fn(async (scope: { routeKey: string; key: string; requestHash: string }, factory: (client: unknown) => Promise<{ kind: string; inputSnapshot: { capability: string } }>) => {
        const built = await factory({});
        calls.push({ ...scope, kind: built.kind, capability: built.inputSnapshot.capability });
        return { status: 202, replayed: false, body: { jobId: built.kind, workflowRunId: "run", dispatchSeq: 1 } };
      }),
    };
    const open = service({ jobs });
    const subtitle = await open.generateShotSubtitle(revisionId, { seed: "fixed" }, context);
    const music = await open.generateShotMusic(revisionId, { seed: "fixed" }, context);
    await open.generateShotSubtitle(revisionId, { seed: "other" }, context);
    expect(subtitle.status).toBe(202);
    expect(music.status).toBe(202);
    expect(calls.map((call) => call.kind)).toEqual(["MEDIA_SUBTITLE", "MEDIA_MUSIC", "MEDIA_SUBTITLE"]);
    expect(calls[0]?.capability).toBe("subtitle.generate");
    expect(calls[1]?.capability).toBe("audio.music");
    expect(calls[0]?.routeKey).toBe(`/shot-revisions/${revisionId}/generate-subtitle`);
    expect(calls[1]?.routeKey).toBe(`/shot-revisions/${revisionId}/generate-music`);
    expect(calls[0]?.key).toBe("same-key");
    expect(calls[0]?.requestHash).toBe(requestHash({ seed: "fixed" }));
    expect(calls[2]?.requestHash).not.toBe(calls[0]?.requestHash);
    await expect(open.generateShotSubtitle(revisionId, {}, { actorId: "owner", traceId: "test" }))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
