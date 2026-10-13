import { describe, expect, it, vi } from "vitest";
import { PersistenceError, type CharacterReferenceStore, type JobPersistenceService, type RuntimeStore } from "@ai-drama/database";
import { MockMediaAdapter } from "@ai-drama/providers";
import { CharacterReferenceRecovery, runMockCharacterReferenceJob, type MockCharacterReferenceJob } from "./mock-character-reference";

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

describe("character reference lease recovery isolates each attempt (closeout item 6)", () => {
  const row = (jobId: string) => ({ workspaceId: input.workspaceId, jobId, attemptId: `attempt-${jobId}`,
    providerConfigurationId: input.providerConfigurationId, providerRequestId: `mock-media|sync|image.generate|${jobId}:1`,
    cancelRequested: false });

  function recovery(options: { complete: (jobId: string) => Promise<unknown>; load?: (jobId: string) => Promise<unknown>;
    failJob?: () => Promise<unknown> }) {
    const jobs = {
      failJob: vi.fn(options.failJob ?? (async () => "failed")),
      recordProviderEvent: vi.fn(async () => true),
      recoverExpiredLease: vi.fn(async () => "requeued"),
      confirmCancellation: vi.fn(async () => undefined),
    } as unknown as JobPersistenceService;
    const store = {
      listExpiredMockMedia: vi.fn(async () => ["permanent", "transient", "sibling"].map(row)),
      loadCharacterReferenceExecution: vi.fn(async (_workspace: string, jobId: string) => (options.load
        ? options.load(jobId)
        : { workspaceId: input.workspaceId, jobId, projectId: input.projectId, state: "RUNNING", inputSnapshot: input.inputSnapshot })),
    } as unknown as RuntimeStore;
    const references = { completeGeneration: vi.fn(async (_jobs: unknown, call: { jobId: string }) => options.complete(call.jobId)) } as unknown as CharacterReferenceStore;
    const adapter = new MockMediaAdapter();
    const submit = vi.spyOn(adapter, "submit");
    return { jobs, references, submit,
      run: () => new CharacterReferenceRecovery(jobs, store, { references, adapter, objects: { put: async () => undefined } }, true).reconcileOnce() };
  }

  it("ends only the permanently refused attempt, keeps a transient one for the next pass, and reports it", async () => {
    const transient = Object.assign(new Error("Connection terminated unexpectedly"), {});
    const { jobs, references, submit, run } = recovery({ complete: async (jobId) => {
      if (jobId === "permanent") throw new PersistenceError("SOURCE_STALE", "Character revision is STALE");
      if (jobId === "transient") throw transient;
      return { id: `asset-${jobId}` };
    } });
    const failure = await run().then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([transient]);
    expect(jobs.failJob).toHaveBeenCalledTimes(1);
    expect(jobs.failJob).toHaveBeenCalledWith(expect.objectContaining({ jobId: "permanent", attemptId: "attempt-permanent",
      errorCode: "MOCK_REFERENCE_REJECTED", retryable: false }));
    expect(references.completeGeneration).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ jobId: "sibling" }));
    expect(submit).not.toHaveBeenCalled();
  });

  it("does not let a failed read of one execution skip its siblings", async () => {
    const fault = new Error("statement timeout");
    const { references, run } = recovery({ complete: async (jobId) => ({ id: jobId }),
      load: async (jobId) => {
        if (jobId === "permanent") throw fault;
        return { workspaceId: input.workspaceId, jobId, projectId: input.projectId, state: "RUNNING", inputSnapshot: input.inputSnapshot };
      } });
    await expect(run()).rejects.toMatchObject({ errors: [fault] });
    expect(vi.mocked(references.completeGeneration).mock.calls.map((call) => (call[1] as { jobId: string }).jobId))
      .toEqual(["transient", "sibling"]);
  });

  it("reports a failed settlement of a permanent refusal instead of swallowing it, but ignores a terminal race", async () => {
    const settle = new Error("deadlock detected");
    const reported = recovery({ complete: async (jobId) => {
      if (jobId === "permanent") throw new PersistenceError("REVIEW_REQUIRED", "refused");
      return { id: jobId };
    }, failJob: async () => { throw settle; } });
    await expect(reported.run()).rejects.toMatchObject({ errors: [settle] });

    const raced = recovery({ complete: async (jobId) => {
      if (jobId === "permanent") throw new PersistenceError("REVIEW_REQUIRED", "refused");
      return { id: jobId };
    }, failJob: async () => { throw new PersistenceError("ATTEMPT_SUPERSEDED", "newer attempt"); } });
    await expect(raced.run()).resolves.toBeUndefined();
  });
});
