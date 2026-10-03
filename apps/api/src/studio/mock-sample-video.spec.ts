import { describe, expect, it, vi } from "vitest";
import { SAMPLE_VIDEO_SCHEMA } from "@ai-drama/contracts";
import { requestHash, type JobPersistenceService, type MediaAssetStore, type RuntimeStore, type TextChainService } from "@ai-drama/database";
import { StudioService } from "./studio.service";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const revisionId = "22222222-2222-4222-8222-222222222222";
const context = { actorId: "owner", traceId: "test", idempotencyKey: "sample-key" };

function service(sampleEnabled: boolean, jobs: { createAndQueueWorkflowJob: ReturnType<typeof vi.fn> }): StudioService {
  const media = {
    prepareShotGenerationInTransaction: vi.fn(async () => ({
      projectId: "33333333-3333-4333-8333-333333333333",
      promptText: "技术验收样片",
      dialogue: "技术验收样片",
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
    true,
    false,
    null,
    false,
    sampleEnabled,
  );
}

describe("sample video requests", () => {
  it("keeps the one-second video snapshot when fixtureId is omitted", async () => {
    const calls: Array<{ requestHash: string; schema: string }> = [];
    const jobs = {
      createAndQueueWorkflowJob: vi.fn(async (scope: { requestHash: string }, factory: (client: unknown) => Promise<{ inputSnapshot: { schema: string } }>) => {
        const built = await factory({});
        calls.push({ requestHash: scope.requestHash, schema: built.inputSnapshot.schema });
        return { status: 202, replayed: false, body: { jobId: "job", workflowRunId: "run", dispatchSeq: 1 } };
      }),
    };
    const open = service(false, jobs);
    await open.generateShotVideo(revisionId, {}, context);
    expect(calls[0]?.schema).toBe("m3.mock.video.v1");
    expect(calls[0]?.requestHash).toBe(requestHash({}));
  });

  it("freezes the selected fixture and rejects the same key with a different fixture before queueing a second body", async () => {
    const calls: Array<{ requestHash: string; schema: string; fixtureId?: string }> = [];
    const jobs = {
      createAndQueueWorkflowJob: vi.fn(async (scope: { requestHash: string }, factory: (client: unknown) => Promise<{ inputSnapshot: { schema: string; fixtureId?: string } }>) => {
        const built = await factory({});
        calls.push({ requestHash: scope.requestHash, schema: built.inputSnapshot.schema, fixtureId: built.inputSnapshot.fixtureId });
        return { status: 202, replayed: false, body: { jobId: "job", workflowRunId: "run", dispatchSeq: 1 } };
      }),
    };
    const open = service(true, jobs);
    await open.generateShotVideo(revisionId, { fixtureId: "sample-15s-a-v1" }, context);
    await open.generateShotVideo(revisionId, { fixtureId: "sample-15s-b-v1" }, context);
    expect(calls.map((call) => call.schema)).toEqual([SAMPLE_VIDEO_SCHEMA, SAMPLE_VIDEO_SCHEMA]);
    expect(calls[0]?.fixtureId).toBe("sample-15s-a-v1");
    expect(calls[1]?.requestHash).not.toBe(calls[0]?.requestHash);
    await expect(service(false, jobs).generateShotVideo(revisionId, { fixtureId: "sample-15s-a-v1" }, context))
      .rejects.toMatchObject({ code: "CONFIGURATION_ERROR" });
    await expect(open.generateShotVideo(revisionId, { fixtureId: "other" }, context))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(open.generateShotImage(revisionId, { fixtureId: "sample-15s-a-v1" }, context))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(open.generateShotSubtitle(revisionId, { fixtureId: "sample-15s-a-v1" }, context))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(open.generateShotMusic(revisionId, { fixtureId: "sample-15s-a-v1" }, context))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(open.generateShotTts(revisionId, { fixtureId: "sample-15s-a-v1" }, context))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
