import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpeechMixManifest, SpeechMixPreflight } from "@ai-drama/contracts";
import { buildVoiceComposeJobSnapshot, speechCuesToVtt, speechDialogueHash, speechExactHash, type VoiceComposeSourceObject } from "@ai-drama/domain";
import { runVoiceComposeJob, stageVoiceComposeSources } from "./voice-compose-job";

const uid = (digit: string) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const roots: string[] = [];
async function root() { const path = await mkdtemp(join(tmpdir(), "voice-compose-")); roots.push(path); return path; }
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
function fixture() {
  const video = Buffer.from("staged-video-bytes"), speech = [Buffer.from("first-audio"), Buffer.from("second-audio")];
  const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const lines: SpeechMixManifest["lines"] = speech.map((bytes, index) => ({ lineId: uid(String(index + 4)), lineInputRevisionId: uid(String(index + 6)),
    voiceRevisionId: uid("8"), selectionId: uid(String(index + 1)), takeAssetId: uid(String(index + 2)), checksumSha256: sha(bytes),
    startMs: index * 600, endMs: index * 600 + 500, pauseAfterMs: index === 0 ? 100 : 0, displayText: index === 0 ? "你来了。" : "真相在这里。", alignmentVersion: "sentence-duration-v1" }));
  const cues = lines.map((line) => ({ lineId: line.lineId, startMs: line.startMs, endMs: line.endMs, text: line.displayText }));
  const subtitleVtt = speechCuesToVtt(cues);
  const manifest: SpeechMixManifest = { schema: "voice.shot.mix.v1", workspaceId: uid("a"), projectId: uid("b"), shotRevisionId: uid("c"), planRevisionId: uid("d"),
    planHash: "1".repeat(64), selectionHash: speechExactHash(lines.map(({ selectionId, takeAssetId, checksumSha256 }) => ({ selectionId, takeAssetId, checksumSha256 }))),
    videoAssetId: uid("e"), videoChecksumSha256: sha(video), videoDurationMs: 2000, totalSpeechMs: 1100, lines,
    subtitles: { format: "vtt", alignmentVersion: "sentence-duration-v1", checksumSha256: speechDialogueHash(subtitleVtt), cues },
    mix: { audioOverflow: "reject", audioUnderflow: "pad-silence", sampleRate: 48000, channels: 2, originalAudio: "mute", musicAssetId: null, musicChecksumSha256: null, musicGain: 0.25, ducking: true } };
  const source = (role: VoiceComposeSourceObject["role"], assetId: string, bytes: Buffer, lineId?: string): VoiceComposeSourceObject => ({ role, assetId, ...(lineId ? { lineId } : {}),
    checksumSha256: sha(bytes), byteSize: bytes.length, storageProvider: "s3", objectKey: `real-media/${manifest.workspaceId}/${manifest.projectId}/${uid("1")}/${uid("2")}/${sha(bytes)}.${role === "video" ? "mp4" : "wav"}` });
  const sources = [source("video", manifest.videoAssetId, video), ...lines.map((line, index) => source("speech", line.takeAssetId, speech[index]!, line.lineId))];
  const preflight: SpeechMixPreflight = { manifest, subtitleVtt, inputHash: speechExactHash(manifest), guards: { planRowVersion: 1, assets: sources.map((item) => ({ assetId: item.assetId, rowVersion: 1 })) } };
  return { manifest, subtitleVtt, built: buildVoiceComposeJobSnapshot(preflight, sources), bytes: new Map(sources.map((item, index) => [item.assetId, index === 0 ? video : speech[index - 1]!])) };
}
describe("voice compose source staging", () => {
  it("stages every take in sentence order with its exact immutable VTT and full measured plan", async () => {
    const { manifest, subtitleVtt, built, bytes } = fixture();
    const attemptDir = await root();
    const stageVerified = vi.fn(async (source: { assetId: string }, target: string) => {
      await writeFile(target, bytes.get(source.assetId)!, { flag: "wx" });
    });
    await stageVoiceComposeSources(attemptDir, built.snapshot, { objectReader: { stageVerified } });
    expect(stageVerified).toHaveBeenCalledTimes(3);
    expect(await readFile(join(attemptDir, "speech-000.wav"))).toEqual(bytes.get(manifest.lines[0]!.takeAssetId));
    expect(await readFile(join(attemptDir, "speech-001.wav"))).toEqual(bytes.get(manifest.lines[1]!.takeAssetId));
    expect(await readFile(join(attemptDir, "subtitles.vtt"), "utf8")).toBe(subtitleVtt);
    expect(JSON.parse(await readFile(join(attemptDir, "voice-plan.json"), "utf8"))).toEqual(manifest);
    expect(stageVerified.mock.calls.map(([, path]) => path.split("/").pop())).toEqual(["video.mp4", "speech-000.wav", "speech-001.wav"]);
  });

  it("does not stage or launch another render when queue acquisition loses to an existing attempt", async () => {
    const { manifest, built } = fixture();
    const stageVerified = vi.fn(), commit = vi.fn(), failJob = vi.fn();
    await runVoiceComposeJob({ workspaceId: manifest.workspaceId, projectId: manifest.projectId, shotRevisionId: manifest.shotRevisionId,
      jobId: uid("f"), dispatchSeq: 1, inputHash: built.inputHash, inputSnapshot: built.snapshot, traceId: "trace" }, {
      jobs: { acquireQueuedJob: vi.fn(async () => null), failJob } as never, voiceStore: { commit }, objectReader: { stageVerified },
      workDir: await root(), objectDir: await root(), pythonBin: "must-not-start", pythonPath: "", leaseOwner: "worker", leaseMs: 30_000,
    });
    expect(stageVerified).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled(); expect(failJob).not.toHaveBeenCalled();
  });
});
