import { resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { MockMediaAdapter } from "@ai-drama/providers";
import { startQueueRuntime, type RuntimeHandle } from "./start-runtime";

const harness = vi.hoisted(() => {
  const state = {
    rows: [] as Array<{
      workspaceId: string;
      jobId: string;
      attemptId: string;
      providerConfigurationId: string;
      providerRequestId: string;
      cancelRequested: boolean;
    }>,
    executions: new Map<string, Record<string, unknown>>(),
    referenceRows: [] as Array<{
      workspaceId: string;
      jobId: string;
      attemptId: string;
      providerConfigurationId: string;
      providerRequestId: string | null;
      cancelRequested: boolean;
    }>,
    /** Thrown by the shot-media or reference execution read while set, as a transient database fault would be. */
    mediaFault: null as Error | null,
    referenceFault: null as Error | null,
    recoveryErrors: [] as string[],
    objectsConstructed: 0,
    failJob: vi.fn(async (input: { jobId: string }) => {
      state.rows = state.rows.filter((row) => row.jobId !== input.jobId);
      return "failed" as const;
    }),
    complete: vi.fn(async (_jobs: unknown, input: { generationJobId: string }) => {
      state.rows = state.rows.filter((row) => row.jobId !== input.generationJobId);
      return { id: "asset" };
    }),
    confirmCancellation: vi.fn(async (input: { jobId: string }) => {
      state.rows = state.rows.filter((row) => row.jobId !== input.jobId);
    }),
    put: vi.fn(async () => undefined),
    referenceComplete: vi.fn(async (_jobs: unknown, input: { jobId: string }) => {
      state.referenceRows = state.referenceRows.filter((row) => row.jobId !== input.jobId);
      return { id: "reference-asset" };
    }),
    recoverExpiredLease: vi.fn(async (input: { jobId: string }) => {
      state.referenceRows = state.referenceRows.filter((row) => row.jobId !== input.jobId);
      return "requeued" as const;
    }),
  };
  return state;
});

vi.mock("@ai-drama/database", async () => {
  const actual = await vi.importActual<typeof import("@ai-drama/database")>("@ai-drama/database");
  return {
    ...actual,
    createPostgresPool: () => ({
      connect: async () => { throw new Error("unexpected connect"); },
      query: async () => { throw new Error("unexpected query"); },
      end: async () => undefined,
      totalCount: 0,
    }),
    closePostgresPool: async () => undefined,
    TextChainService: class {
      async continueStaleRecalculation(): Promise<boolean> { return false; }
    },
    RuntimeStore: class {
      listUndispatched = async () => [];
      listOrphanQueued = async () => [];
      listExpiredRunning = async () => [];
      listWaitingExternal = async () => [];
      listExpiredMockMedia = async (_limit: number, _now?: Date, kinds?: string[]) =>
        kinds?.includes("MEDIA_CHARACTER_REFERENCE") ? harness.referenceRows : harness.rows;
      loadMockMediaExecution = async (_workspaceId: string, jobId: string) => {
        if (harness.mediaFault) throw harness.mediaFault;
        return harness.executions.get(jobId) ?? null;
      };
      loadCharacterReferenceExecution = async (_workspaceId: string, jobId: string) => {
        if (harness.referenceFault) throw harness.referenceFault;
        return harness.executions.get(jobId) ?? null;
      };
      markDispatched = async () => undefined;
      recordDispatchFailure = async () => undefined;
    },
    JobPersistenceService: class {
      failJob = (input: { jobId: string }) => harness.failJob(input);
      confirmCancellation = (input: { jobId: string }) => harness.confirmCancellation(input);
      recordProviderEvent = async () => true;
      recoverExpiredLease = (input: { jobId: string }) => harness.recoverExpiredLease(input);
      redispatchQueuedJob = async () => undefined;
    },
    CharacterReferenceStore: class {
      completeGeneration = (jobs: unknown, input: { jobId: string }) => harness.referenceComplete(jobs, input);
    },
    MediaAssetStore: class {
      completeAttemptWithAsset = (jobs: unknown, input: { generationJobId: string }) => harness.complete(jobs, input);
      assertUsableShot = async () => undefined;
    },
  };
});

vi.mock("./bullmq-queue", () => ({
  BullMqQueue: class {
    enqueue = async () => "enqueued" as const;
    hasDispatch = async () => false;
    close = async () => undefined;
  },
  startBullWorker: () => ({ on: () => undefined, close: async () => undefined }),
}));

vi.mock("./local-mock-objects", () => ({
  LocalMockObjects: class {
    constructor() { harness.objectsConstructed += 1; }
    put = (input: unknown) => harness.put(input);
  },
}));

const directory = resolve("tmp-mock-av-review");

function resetHarness(): void {
  harness.rows = [];
  harness.referenceRows = [];
  harness.mediaFault = null;
  harness.referenceFault = null;
  harness.recoveryErrors = [];
  harness.referenceComplete.mockClear();
  harness.recoverExpiredLease.mockClear();
  harness.executions.clear();
  harness.objectsConstructed = 0;
  harness.failJob.mockClear();
  harness.complete.mockClear();
  harness.confirmCancellation.mockClear();
  harness.put.mockClear();
}

function bind(kind: "MEDIA_IMAGE" | "MEDIA_VIDEO" | "MEDIA_TTS" | "MEDIA_SUBTITLE" | "MEDIA_MUSIC", cancelRequested = false): void {
  const capability = kind === "MEDIA_IMAGE" ? "image.generate"
    : kind === "MEDIA_VIDEO" ? "video.generate"
      : kind === "MEDIA_TTS" ? "audio.tts"
        : kind === "MEDIA_SUBTITLE" ? "subtitle.generate"
          : "audio.music";
  const providerRequestId = kind === "MEDIA_IMAGE"
    ? `mock-media|image.generate|${kind}:1`
    : `mock-media|sync|${capability}|${kind}:1`;
  harness.rows.push({
    workspaceId: "workspace", jobId: kind, attemptId: `attempt-${kind}`,
    providerConfigurationId: "provider", providerRequestId, cancelRequested,
  });
  harness.executions.set(kind, {
    workspaceId: "workspace", jobId: kind, projectId: "project", kind,
    shotRevisionId: "shot", providerConfigurationId: "provider",
    inputHash: "ab".repeat(32),
    inputSnapshot: kind === "MEDIA_IMAGE"
      ? { schema: "m3.mock.image.v1", shotRevisionId: "shot", seed: null, outcome: "success", bypassCache: false }
      : { outcome: "success", executionMode: "sync", capability },
    state: "RUNNING", cancelRequested,
  });
}

async function boot(options: { mockObjectDir?: string; mockImageEnabled?: boolean; mockAvEnabled?: boolean; mockSmEnabled?: boolean }): Promise<RuntimeHandle> {
  return startQueueRuntime({
    databaseUrl: "postgresql://unused:unused@127.0.0.1/unused",
    redisUrl: "redis://127.0.0.1:6379",
    dispatchIntervalMs: 60_000,
    reconcileIntervalMs: 15,
    staleRecalculationIntervalMs: 60_000,
    onRecoveryError: (message: string) => { harness.recoveryErrors.push(message); },
    ...options,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

it("rejects production and a relative mock directory before creating storage", async () => {
  resetHarness();
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    await expect(boot({ mockObjectDir: directory, mockImageEnabled: true, mockAvEnabled: true }))
      .rejects.toThrow(/forbidden in production/i);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
  await expect(boot({ mockObjectDir: "relative-mock", mockImageEnabled: true })).rejects.toThrow(/absolute/i);
  expect(harness.objectsConstructed).toBe(0);
});

it("recovers an image and fails a bound video when only the image flag is on", async () => {
  resetHarness();
  bind("MEDIA_IMAGE");
  bind("MEDIA_VIDEO");
  const inspect = vi.spyOn(MockMediaAdapter.prototype, "inspect");
  const runtime = await boot({ mockObjectDir: directory, mockImageEnabled: true, mockAvEnabled: false });
  try {
    await vi.waitFor(() => {
      expect(harness.complete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: "IMAGE" }));
      expect(harness.failJob).toHaveBeenCalledWith(expect.objectContaining({
        jobId: "MEDIA_VIDEO", attemptId: "attempt-MEDIA_VIDEO",
        errorCode: "MOCK_MEDIA_NOT_CONFIGURED", retryable: false,
      }));
    });
  } finally {
    await runtime.shutdown();
  }
  expect(inspect.mock.calls.map((call) => call[0])).toEqual(["mock-media|image.generate|MEDIA_IMAGE:1"]);
  expect(harness.put).toHaveBeenCalledTimes(1);
  expect(harness.complete).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: "VIDEO" }));
});

it("recovers speech and fails a bound image when only the AV flag is on", async () => {
  resetHarness();
  bind("MEDIA_IMAGE");
  bind("MEDIA_TTS");
  const inspect = vi.spyOn(MockMediaAdapter.prototype, "inspect");
  const runtime = await boot({ mockObjectDir: directory, mockImageEnabled: false, mockAvEnabled: true });
  try {
    await vi.waitFor(() => {
      expect(harness.complete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        kind: "AUDIO",
        actualCost: expect.objectContaining({ kind: "ACTUAL", amountDecimal: "0.00000000" }),
      }));
      expect(harness.failJob).toHaveBeenCalledWith(expect.objectContaining({
        jobId: "MEDIA_IMAGE", errorCode: "MOCK_MEDIA_NOT_CONFIGURED", retryable: false,
      }));
    });
  } finally {
    await runtime.shutdown();
  }
  expect(inspect.mock.calls.map((call) => call[0])).toEqual(["mock-media|sync|audio.tts|MEDIA_TTS:1"]);
  expect(harness.put).toHaveBeenCalledWith(expect.objectContaining({ mimeType: "audio/wav" }));
});

it("fails bound media without inspect when flags are omitted or storage is absent", async () => {
  resetHarness();
  bind("MEDIA_VIDEO");
  bind("MEDIA_IMAGE");
  const inspect = vi.spyOn(MockMediaAdapter.prototype, "inspect");
  const runtime = await boot({ mockObjectDir: directory });
  try {
    await vi.waitFor(() => expect(harness.failJob).toHaveBeenCalledTimes(2));
  } finally {
    await runtime.shutdown();
  }
  expect(inspect).not.toHaveBeenCalled();
  expect(harness.put).not.toHaveBeenCalled();
  expect(harness.complete).not.toHaveBeenCalled();
  expect(harness.objectsConstructed).toBe(1);

  resetHarness();
  bind("MEDIA_VIDEO");
  const withoutDir = await boot({ mockAvEnabled: true, mockImageEnabled: true });
  try {
    await vi.waitFor(() => expect(harness.failJob).toHaveBeenCalledWith(expect.objectContaining({
      jobId: "MEDIA_VIDEO", errorCode: "MOCK_MEDIA_NOT_CONFIGURED", retryable: false,
    })));
  } finally {
    await withoutDir.shutdown();
  }
  expect(harness.objectsConstructed).toBe(0);
  expect(inspect).not.toHaveBeenCalled();
  expect(harness.put).not.toHaveBeenCalled();
});

it("recovers subtitle and music only when their flag is on and leaves video on the AV flag", async () => {
  resetHarness();
  bind("MEDIA_SUBTITLE");
  bind("MEDIA_MUSIC");
  bind("MEDIA_VIDEO");
  const runtime = await boot({ mockObjectDir: directory, mockImageEnabled: false, mockAvEnabled: false, mockSmEnabled: true });
  try {
    await vi.waitFor(() => {
      expect(harness.complete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        kind: "SUBTITLE",
        actualCost: expect.objectContaining({ kind: "ACTUAL", amountDecimal: "0.00000000" }),
      }));
      expect(harness.complete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: "MUSIC" }));
      expect(harness.failJob).toHaveBeenCalledWith(expect.objectContaining({
        jobId: "MEDIA_VIDEO", errorCode: "MOCK_MEDIA_NOT_CONFIGURED", retryable: false,
      }));
    });
  } finally {
    await runtime.shutdown();
  }
  expect(harness.put).toHaveBeenCalledWith(expect.objectContaining({ mimeType: "text/vtt" }));
  expect(harness.put).toHaveBeenCalledWith(expect.objectContaining({ key: expect.stringContaining("mock-music/") }));
  expect(harness.complete).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: "VIDEO" }));

  resetHarness();
  bind("MEDIA_VIDEO");
  bind("MEDIA_SUBTITLE");
  const avOnly = await boot({ mockObjectDir: directory, mockAvEnabled: true, mockSmEnabled: false });
  try {
    await vi.waitFor(() => {
      expect(harness.complete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: "VIDEO" }));
      expect(harness.failJob).toHaveBeenCalledWith(expect.objectContaining({
        jobId: "MEDIA_SUBTITLE", errorCode: "MOCK_MEDIA_NOT_CONFIGURED", retryable: false,
      }));
    });
  } finally {
    await avOnly.shutdown();
  }
});

it("cancels a disabled video without inspecting or writing an asset", async () => {
  resetHarness();
  bind("MEDIA_VIDEO", true);
  const inspect = vi.spyOn(MockMediaAdapter.prototype, "inspect");
  const runtime = await boot({ mockObjectDir: directory, mockImageEnabled: true, mockAvEnabled: false });
  try {
    await vi.waitFor(() => expect(harness.confirmCancellation).toHaveBeenCalledWith(expect.objectContaining({
      jobId: "MEDIA_VIDEO", attemptId: "attempt-MEDIA_VIDEO",
    })));
  } finally {
    await runtime.shutdown();
  }
  expect(harness.failJob).not.toHaveBeenCalled();
  expect(inspect).not.toHaveBeenCalled();
  expect(harness.put).not.toHaveBeenCalled();
  expect(harness.complete).not.toHaveBeenCalled();
});

function bindReference(jobId: string, bound: boolean): void {
  harness.referenceRows.push({
    workspaceId: "workspace", jobId, attemptId: `attempt-${jobId}`, providerConfigurationId: "provider",
    providerRequestId: bound ? `mock-media|sync|image.generate|${jobId}:1` : null, cancelRequested: false,
  });
  harness.executions.set(jobId, {
    workspaceId: "workspace", jobId, projectId: "project", kind: "MEDIA_CHARACTER_REFERENCE", state: "RUNNING",
    inputSnapshot: { schema: "m3.mock.character-reference.v1", characterRevisionId: "33333333-3333-4333-8333-333333333333",
      characterContentHash: "cd".repeat(32), seed: null, bypassCache: false, outcome: "success", executionMode: "sync",
      capability: "image.generate" },
  });
}

it("keeps recovering character references while shot media recovery fails, then recovers media once the fault clears (closeout item 6)", async () => {
  resetHarness();
  bind("MEDIA_IMAGE");
  bindReference("ref-unsent", false);
  bindReference("ref-bound", true);
  harness.mediaFault = Object.assign(new Error("Connection terminated unexpectedly"), { name: "ConnectionError" });
  const submit = vi.spyOn(MockMediaAdapter.prototype, "submit");
  const runtime = await boot({ mockObjectDir: directory, mockImageEnabled: true });
  try {
    await vi.waitFor(() => {
      expect(harness.recoverExpiredLease).toHaveBeenCalledWith(expect.objectContaining({ jobId: "ref-unsent" }));
      expect(harness.referenceComplete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        jobId: "ref-bound", attemptId: "attempt-ref-bound", providerRequestId: "mock-media|sync|image.generate|ref-bound:1" }));
      expect(harness.recoveryErrors.some((line) => line.startsWith("mock-media recovery failed: AggregateError (ConnectionError)"))).toBe(true);
    });
    // The transient fault left the image attempt alone: not failed, not completed.
    expect(harness.complete).not.toHaveBeenCalled();
    expect(harness.failJob).not.toHaveBeenCalled();
    harness.mediaFault = null;
    await vi.waitFor(() => {
      expect(harness.complete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: "IMAGE" }));
    });
  } finally {
    await runtime.shutdown();
  }
  // A bound reference request is inspected and persisted, never submitted again.
  expect(submit).not.toHaveBeenCalled();
  expect(harness.referenceComplete).toHaveBeenCalledTimes(1);
  expect(harness.complete).toHaveBeenCalledTimes(1);
  expect(harness.recoveryErrors.every((line) => !line.includes("Connection terminated"))).toBe(true);
});

it("keeps recovering shot media while character reference recovery fails, then recovers references (closeout item 6)", async () => {
  resetHarness();
  bind("MEDIA_IMAGE");
  bindReference("ref-bound", true);
  harness.referenceFault = Object.assign(new Error("EIO: i/o error"), { name: "IoError", code: "EIO" });
  const runtime = await boot({ mockObjectDir: directory, mockImageEnabled: true });
  try {
    await vi.waitFor(() => {
      expect(harness.complete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: "IMAGE" }));
      expect(harness.recoveryErrors.some((line) => line.startsWith("character-reference recovery failed: AggregateError (IoError)"))).toBe(true);
    });
    expect(harness.referenceComplete).not.toHaveBeenCalled();
    expect(harness.failJob).not.toHaveBeenCalled();
    harness.referenceFault = null;
    await vi.waitFor(() => {
      expect(harness.referenceComplete).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ jobId: "ref-bound" }));
    });
  } finally {
    await runtime.shutdown();
  }
  expect(harness.complete).toHaveBeenCalledTimes(1);
});
