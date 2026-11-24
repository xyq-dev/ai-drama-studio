import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { JobPersistenceService, MediaAssetRecord, MediaAssetStore } from "@ai-drama/database";
import { MOCK_AUDIO_FIXTURE, MockMediaAdapter } from "@ai-drama/providers";
import { recoverMockSmAttempt, runMockSmJob, type MockSmJob } from "./mock-sm-generation";

function input(capability: MockSmJob["capability"], sourceText: string): MockSmJob {
  return {
    workspaceId: "11111111-1111-4111-8111-111111111111",
    projectId: "22222222-2222-4222-8222-222222222222",
    shotRevisionId: "33333333-3333-4333-8333-333333333333",
    jobId: capability === "subtitle.generate" ? "44444444-4444-4444-8444-444444444444" : "44444444-4444-4444-8444-444444444445",
    dispatchSeq: 1,
    providerConfigurationId: "55555555-5555-4555-8555-555555555555",
    inputHash: "ab".repeat(32),
    inputSnapshot: {
      schema: capability === "subtitle.generate" ? "m3.mock.subtitle.v1" : "m3.mock.music.v1",
      outcome: "success",
      executionMode: "sync",
      capability,
      sourceText,
    },
    traceId: "mock-sm",
    capability,
  };
}

describe("synchronous mock subtitle and music", () => {
  const cue = (body: string) => Buffer.from(`WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n${body}\n`);
  it.each([
    ["subtitle.generate", "已保存对白", cue("已保存对白")],
    ["subtitle.generate", "甲 --> <乙> & 丙\r\n\r\n丁", cue("甲 &lt;乙&gt; &amp; 丙 丁")],
    ["subtitle.generate", "🚌".repeat(90), cue(`${"🚌".repeat(40)}\n${"🚌".repeat(40)}`)],
    ["audio.music", "已保存提示", MOCK_AUDIO_FIXTURE.bytes],
  ] as const)("stores deterministic %s bytes for %s and recovers without another submit", async (capability, sourceText, bytes) => {
    const job = input(capability, sourceText);
    const subtitle = capability === "subtitle.generate";
    const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
    const mimeType = subtitle ? "text/vtt" : "audio/wav";
    const folder = subtitle ? "mock-subtitles" : "mock-music";
    const jobs = {
      acquireQueuedJob: vi.fn(async () => ({ attemptId: "66666666-6666-4666-8666-666666666666", attemptNo: 1 })),
      attachProviderRequest: vi.fn(async () => undefined),
      recordProviderEvent: vi.fn(async () => true),
      failJob: vi.fn(async (failed: { errorMessage: string }) => {
        throw new Error(failed.errorMessage);
      }),
    } as unknown as JobPersistenceService;
    const asset = { id: "77777777-7777-4777-8777-777777777777" } as MediaAssetRecord;
    const completeAttemptWithAsset = vi.fn(async () => asset);
    const assets = {
      assertUsableShot: vi.fn(async () => undefined),
      completeAttemptWithAsset,
    } as unknown as MediaAssetStore;
    const put = vi.fn(async () => undefined);
    const adapter = new MockMediaAdapter();
    const created = await runMockSmJob(job, { jobs, assets, adapter, objects: { put } });
    expect(created).toBe(asset);
    expect(completeAttemptWithAsset).toHaveBeenCalledWith(jobs, expect.objectContaining({
      kind: subtitle ? "SUBTITLE" : "MUSIC",
      mimeType,
      durationMs: subtitle ? 1000 : 100,
      byteSize: bytes.length,
      checksumSha256,
      objectKey: expect.stringContaining(`${folder}/`),
      actualCost: expect.objectContaining({
        kind: "ACTUAL",
        currency: "USD",
        amountDecimal: "0.00000000",
        jobAttemptId: "66666666-6666-4666-8666-666666666666",
        providerRequestId: `mock-media|sync|${capability}|${job.jobId}:1`,
        providerConfigurationId: job.providerConfigurationId,
      }),
    }));
    const recoveryAdapter = new MockMediaAdapter();
    const submit = vi.spyOn(recoveryAdapter, "submit");
    await recoverMockSmAttempt({
      ...job,
      attemptId: "66666666-6666-4666-8666-666666666666",
      providerRequestId: `mock-media|sync|${capability}|${job.jobId}:1`,
    }, { jobs, assets, adapter: recoveryAdapter, objects: { put } });
    expect(submit).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledTimes(2);
    for (const call of [1, 2]) {
      expect(put).toHaveBeenNthCalledWith(call, expect.objectContaining({ bytes, checksumSha256, mimeType }));
    }
  });
});
