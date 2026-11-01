import { describe, expect, it, vi } from "vitest";
import type { SpeechMixManifest, SpeechMixPreflight } from "@ai-drama/contracts";
import { buildVoiceComposeJobSnapshot, speechDialogueHash, speechExactHash } from "@ai-drama/domain";
import { PostgresVoiceComposeStore } from "./voice-compose-store";
import { JobPersistenceService } from "./job-service";
import { assertSpeechMixManifestInTransaction, commitSpeechMixDependencies, speechMixPreflightInTransaction } from "./speech-store";

vi.mock("./speech-store", () => ({ assertSpeechMixManifestInTransaction: vi.fn(async () => undefined),
  commitSpeechMixDependencies: vi.fn(async () => undefined), speechMixPreflightInTransaction: vi.fn() }));
const uid = (digit: string) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
function fixture() {
  const manifest: SpeechMixManifest = { schema: "voice.shot.mix.v1", workspaceId: uid("1"), projectId: uid("2"), shotRevisionId: uid("3"), planRevisionId: uid("4"),
    planHash: "a".repeat(64), selectionHash: speechExactHash([]), videoAssetId: uid("5"), videoChecksumSha256: "b".repeat(64), videoDurationMs: 2000, totalSpeechMs: 0, lines: [],
    subtitles: { format: "vtt", alignmentVersion: "sentence-duration-v1", checksumSha256: speechDialogueHash("WEBVTT\n\n"), cues: [] },
    mix: { audioOverflow: "reject", audioUnderflow: "pad-silence", sampleRate: 48000, channels: 2, originalAudio: "mute", musicAssetId: null, musicChecksumSha256: null, musicGain: 0.25, ducking: true } };
  const preflight: SpeechMixPreflight = { manifest, subtitleVtt: "WEBVTT\n\n", inputHash: speechExactHash(manifest), guards: { planRowVersion: 1, assets: [{ assetId: manifest.videoAssetId, rowVersion: 1 }] } };
  const objectKey = `real-media/${manifest.workspaceId}/${manifest.projectId}/${uid("6")}/${uid("7")}/${manifest.videoChecksumSha256}.mp4`;
  const built = buildVoiceComposeJobSnapshot(preflight, [{ role: "video", assetId: manifest.videoAssetId, storageProvider: "s3", objectKey, byteSize: 100, checksumSha256: manifest.videoChecksumSha256 }]);
  const row = { id: manifest.videoAssetId, status: "ACTIVE", review_status: "DRAFT", source_kind: "PROVIDER", kind: "VIDEO", mime_type: "video/mp4", source_job_kind: "MEDIA_VIDEO", source_job_state: "SUCCEEDED",
    source_attempt_id: uid("7"),source_generation_job_id: uid("6"),source_input_hash:"e".repeat(64),source_input_snapshot:{schema:"real-media.v1"},
    attempt_finished: true, latest_attempt: true, provider_configuration_id: uid("8"), provider_request_id: "remote-task", attempt_provider_id: uid("8"), attempt_request_id: "remote-task", checksum_sha256: manifest.videoChecksumSha256,
    duration_ms: 2000, storage_provider: "s3", object_key: objectKey, byte_size: 100 };
  const receipt = {job_attempt_id:uid("7"),generation_job_id:uid("6"),provider_configuration_id:uid("8"),provider_request_id:"remote-task",input_hash:"e".repeat(64),state:"SUCCEEDED",provider_key:"dashscope-media",capability:"video.generate"};
  return { manifest, preflight, built, row, receipt };
}
describe("voice compose source and commit transactions", () => {
  it("aborts the real core completion transaction before locking a job when its source gate rejects", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const release = vi.fn();
    const client = { query, release };
    const jobs = new JobPersistenceService({ connect: async () => client } as never);
    const sourceChanged = new Error("source changed");
    await expect(jobs.succeedJobWithArtifact({ workspaceId: uid("1"), jobId: uid("2"), attemptId: uid("3"), traceId: "trace",
      beforeLock: async (heldClient) => { expect(heldClient).toBe(client); throw sourceChanged; },
    })).rejects.toBe(sourceChanged);
    expect(query.mock.calls).toEqual([["BEGIN"], ["ROLLBACK"]]);
    expect(release).toHaveBeenCalledOnce();
  });

  it("uses the transaction preflight and refuses stale hashes and storage impersonation", async () => {
    const { manifest, preflight, row, receipt } = fixture();
    vi.mocked(speechMixPreflightInTransaction).mockResolvedValue(preflight);
    const query = vi.fn(async (sql:string) => ({ rows: sql.includes("FROM real_media_submission") ? [receipt] : [row] }));
    const store = new PostgresVoiceComposeStore({} as never, {} as never);
    const request = { planRevisionId: manifest.planRevisionId, videoAssetId: manifest.videoAssetId, expectedInputHash: preflight.inputHash, originalAudio: "mute" as const, musicGain: 0.25, ducking: true };
    const frozen = await store.freezeInTransaction({ query } as never, manifest.workspaceId, manifest.shotRevisionId, request);
    expect(frozen.snapshot.input.manifest).toEqual(manifest);
    expect(speechMixPreflightInTransaction).toHaveBeenCalledWith(expect.objectContaining({ query }), manifest.workspaceId, manifest.planRevisionId, request);
    query.mockClear();
    await expect(store.freezeInTransaction({ query } as never, manifest.workspaceId, manifest.shotRevisionId, { ...request, expectedInputHash: "f".repeat(64) })).rejects.toMatchObject({ code: "COMPOSE_INPUT_CHANGED" });
    expect(query).not.toHaveBeenCalled();
    query.mockImplementation(async (sql: string) => ({ rows: sql.includes("FROM real_media_submission") ? [{ ...receipt, state: "UNKNOWN" }] : [row] }));
    await expect(store.freezeInTransaction({ query } as never, manifest.workspaceId, manifest.shotRevisionId, request)).rejects.toMatchObject({ code: "COMPOSE_INPUT_INVALID" });
    query.mockImplementation(async () => ({ rows: [{ ...row, storage_provider: "mock-object-store" }] }));
    await expect(store.freezeInTransaction({ query } as never, manifest.workspaceId, manifest.shotRevisionId, request)).rejects.toMatchObject({ code: "COMPOSE_INPUT_INVALID" });
  });
  it("locks and rechecks the speech project before core Job locks, then records typed and media dependencies atomically", async () => {
    const { manifest, built } = fixture();
    const order: string[] = [];
    vi.mocked(assertSpeechMixManifestInTransaction).mockImplementation(async () => { order.push("project-source-lock"); });
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith("SELECT input_hash") || sql.startsWith("SELECT job.input_hash")) return { rows: [{ input_hash: built.inputHash, input_snapshot: built.snapshot }] };
      if (sql.startsWith("INSERT INTO asset(")) return { rows: [{ id: uid("9"), checksum_sha256: "c".repeat(64) }] };
      return { rows: [] };
    });
    const client = { query };
    const succeedJobWithArtifact = vi.fn(async (input: { beforeLock(c: unknown): Promise<void>; persistArtifact(c: unknown): Promise<unknown> }) => {
      await input.beforeLock(client); order.push("core-job-lock"); return input.persistArtifact(client);
    });
    const store = new PostgresVoiceComposeStore({} as never, { succeedJobWithArtifact } as never);
    const jobId = uid("a"), attemptId = uid("b"), checksumSha256 = "c".repeat(64);
    const result = await store.commit({ workspaceId: manifest.workspaceId, projectId: manifest.projectId, shotRevisionId: manifest.shotRevisionId,
      jobId, attemptId, leaseOwner: "worker", traceId: "trace", objectKey: `compose/${manifest.workspaceId}/${manifest.projectId}/${jobId}/${attemptId}/${checksumSha256}.mp4`, checksumSha256,
      byteSize: 100, width: 1080, height: 1920, durationMs: 2000, elapsedMs: 12, fontSha256: "d".repeat(64), fontFamily: "Noto Sans CJK SC" });
    expect(order.slice(0, 2)).toEqual(["project-source-lock", "core-job-lock"]);
    expect(result?.id).toBe(uid("9"));
    expect(commitSpeechMixDependencies).toHaveBeenCalledWith(client, uid("9"), manifest);
    expect(query.mock.calls.some(([sql]) => sql.includes("asset_revision_dependency"))).toBe(true);
    expect(query.mock.calls.some(([sql]) => sql.includes("asset_dependency"))).toBe(true);
  });
});
