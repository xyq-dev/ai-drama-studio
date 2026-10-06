import { describe, expect, it, vi } from "vitest";
import { PersistenceError, type CharacterReferenceStore, type JobPersistenceService } from "@ai-drama/database";
import { MockMediaAdapter } from "@ai-drama/providers";
import { runMockCharacterReferenceJob, type MockCharacterReferenceJob } from "./mock-character-reference";

const REVISION = "33333333-3333-4333-8333-333333333333";
const input: MockCharacterReferenceJob = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
  jobId: "44444444-4444-4444-8444-444444444444",
  dispatchSeq: 1,
  providerConfigurationId: "55555555-5555-4555-8555-555555555555",
  inputHash: "ab".repeat(32),
  inputSnapshot: { schema: "m3.mock.character-reference.v1", characterRevisionId: REVISION,
    characterContentHash: "cd".repeat(32), seed: null, bypassCache: false, outcome: "success", executionMode: "sync",
    capability: "image.generate" },
  traceId: "reference-test",
};

function fakes(complete: () => Promise<unknown>) {
  const jobs = {
    acquireQueuedJob: vi.fn(async () => ({ attemptId: "66666666-6666-4666-8666-666666666666", attemptNo: 1 })),
    attachProviderRequest: vi.fn(async () => undefined),
    failJob: vi.fn(async () => "failed"),
  } as unknown as JobPersistenceService;
  const references = { completeGeneration: vi.fn(complete) } as unknown as CharacterReferenceStore;
  const put = vi.fn(async () => undefined);
  return { jobs, references, put };
}

describe("Mock character reference generation", () => {
  it("stores the fixed PNG and completes it against the frozen character revision with its own cost", async () => {
    const { jobs, references, put } = fakes(async () => ({ id: "asset-1" }));
    const result = await runMockCharacterReferenceJob(input, { jobs, references, adapter: new MockMediaAdapter(), objects: { put } });
    expect(result).toEqual({ id: "asset-1" });
    expect(put).toHaveBeenCalledWith(expect.objectContaining({ mimeType: "image/png",
      key: expect.stringMatching(new RegExp(`^mock-images/${input.projectId}/${input.jobId}/[0-9a-f]{64}\\.png$`)) }));
    const call = vi.mocked(references.completeGeneration).mock.calls[0]?.[1];
    expect(call).toMatchObject({ characterRevisionId: REVISION, jobId: input.jobId,
      providerRequestId: `mock-media|sync|image.generate|${input.jobId}:1`,
      actualCost: expect.objectContaining({ kind: "ACTUAL", generationJobId: input.jobId }) });
    expect(jobs.failJob).not.toHaveBeenCalled();
  });

  it("fails permanently on a snapshot that is not a reference job, before attaching a request", async () => {
    const { jobs, references, put } = fakes(async () => ({ id: "never" }));
    await runMockCharacterReferenceJob({ ...input, inputSnapshot: { schema: "m3.mock.image.v1" } },
      { jobs, references, adapter: new MockMediaAdapter(), objects: { put } });
    expect(jobs.attachProviderRequest).not.toHaveBeenCalled();
    expect(jobs.failJob).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "MOCK_REFERENCE_REJECTED", retryable: false }));
  });

  it("fails permanently when the reference storage or gate refuses the completion", async () => {
    for (const code of ["CHARACTER_REFERENCE_STORAGE_UNAVAILABLE", "SOURCE_STALE", "SCRIPT_REVIEW_REQUIRED"]) {
      const { jobs, references, put } = fakes(async () => { throw new PersistenceError(code, "refused"); });
      await runMockCharacterReferenceJob(input, { jobs, references, adapter: new MockMediaAdapter(), objects: { put } });
      expect(jobs.failJob).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "MOCK_REFERENCE_REJECTED", retryable: false }));
    }
  });

  it("keeps a retryable failure after the request was attached for lease recovery", async () => {
    const { jobs, references, put } = fakes(async () => { throw new Error("disk busy"); });
    await expect(runMockCharacterReferenceJob(input, { jobs, references, adapter: new MockMediaAdapter(), objects: { put } }))
      .rejects.toThrow("disk busy");
    expect(jobs.failJob).not.toHaveBeenCalled();
  });
});
