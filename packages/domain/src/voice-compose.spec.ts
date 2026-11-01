import { describe, expect, it } from "vitest";
import type { SpeechMixManifest, SpeechMixPreflight } from "@ai-drama/contracts";
import { speechCuesToVtt, speechDialogueHash, speechExactHash } from "./speech";
import { VOICE_COMPOSE_RENDER_PROFILE, assertVoiceComposeSnapshot, assertVoiceMixManifest, buildVoiceComposeJobSnapshot,
  parseVoiceComposeRenderRequest, type VoiceComposeSourceObject } from "./voice-compose";
import { mediaFromFrozenVoiceShot } from "./voice-compose";

const uid = (digit: string) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
export function voiceComposeFixture() {
  const lines: SpeechMixManifest["lines"] = [
    { lineId: uid("1"), lineInputRevisionId: uid("3"), voiceRevisionId: uid("5"), selectionId: uid("7"), takeAssetId: uid("9"), checksumSha256: "1".repeat(64),
      startMs: 0, endMs: 500, pauseAfterMs: 100, displayText: "你来了。", alignmentVersion: "sentence-duration-v1" },
    { lineId: uid("2"), lineInputRevisionId: uid("4"), voiceRevisionId: uid("6"), selectionId: uid("8"), takeAssetId: uid("a"), checksumSha256: "2".repeat(64),
      startMs: 600, endMs: 1200, pauseAfterMs: 0, displayText: "{\\pos(1,1)}<你好🙂>", alignmentVersion: "sentence-duration-v1" },
  ];
  const cues = lines.map((line) => ({ lineId: line.lineId, startMs: line.startMs, endMs: line.endMs, text: line.displayText }));
  const subtitleVtt = speechCuesToVtt(cues);
  const manifest: SpeechMixManifest = { schema: "voice.shot.mix.v1", workspaceId: uid("d"), projectId: uid("e"), shotRevisionId: uid("f"), planRevisionId: uid("c"),
    planHash: "a".repeat(64), selectionHash: speechExactHash(lines.map(({ selectionId, takeAssetId, checksumSha256 }) => ({ selectionId, takeAssetId, checksumSha256 }))),
    videoAssetId: uid("b"), videoChecksumSha256: "3".repeat(64), videoDurationMs: 2000, totalSpeechMs: 1200, lines,
    subtitles: { format: "vtt", alignmentVersion: "sentence-duration-v1", checksumSha256: speechDialogueHash(subtitleVtt), cues },
    mix: { audioOverflow: "reject", audioUnderflow: "pad-silence", sampleRate: 48000, channels: 2, originalAudio: "mute", musicAssetId: null,
      musicChecksumSha256: null, musicGain: 0.25, ducking: true } };
  const sources: VoiceComposeSourceObject[] = [
    { role: "video", assetId: manifest.videoAssetId, checksumSha256: manifest.videoChecksumSha256, storageProvider: "s3", byteSize: 100,
      objectKey: `real-media/${manifest.workspaceId}/${manifest.projectId}/${uid("1")}/${uid("2")}/${manifest.videoChecksumSha256}.mp4` },
    ...lines.map((line) => ({ role: "speech" as const, assetId: line.takeAssetId, lineId: line.lineId, checksumSha256: line.checksumSha256,
      storageProvider: "s3" as const, byteSize: 100, objectKey: `real-media/${manifest.workspaceId}/${manifest.projectId}/${uid("1")}/${uid("2")}/${line.checksumSha256}.wav` })),
  ];
  const preflight: SpeechMixPreflight = { inputHash: speechExactHash(manifest), manifest, subtitleVtt, guards: { planRowVersion: 1,
    assets: sources.map((source) => ({ assetId: source.assetId, rowVersion: 1 })) } };
  return { manifest, preflight, sources };
}

describe("voice compose immutable profile", () => {
  it("exports every audio sentence with its own line and original Job/Attempt while keeping dependency scope exact", () => {
    const { manifest, sources } = voiceComposeFixture();
    const media = sources.map((source) => ({ assetId: source.assetId, workspaceId: manifest.workspaceId, projectId: manifest.projectId,
      kind: source.role === "video" ? "VIDEO" : "AUDIO", checksumSha256: source.checksumSha256, sourceJobId: uid("1"), sourceAttemptId: uid("2") }));
    const edges = sources.map((source) => ({ workspaceId: manifest.workspaceId, projectId: manifest.projectId, sourceAssetId: source.assetId }));
    const input = { workspaceId: manifest.workspaceId, projectId: manifest.projectId, manifest, sourceObjects: sources, media, edges };
    expect(mediaFromFrozenVoiceShot(input).filter((source) => source.role === "audio").map((source) => source.lineId)).toEqual(manifest.lines.map((line) => line.lineId));
    expect(() => mediaFromFrozenVoiceShot({ ...input, edges: edges.slice(1) })).toThrow(/dependencies/);
    expect(() => mediaFromFrozenVoiceShot({ ...input, sourceObjects: [sources[0]!, sources[2]!, sources[1]!] })).toThrow(/sentence/);
    expect(() => mediaFromFrozenVoiceShot({ ...input, media: media.map((row, index) => index === 1 ? { ...row, sourceAttemptId: null } : row) })).toThrow(/generation/);
  });

  it("freezes every selected sentence, timing and exact subtitle text for the new renderer", () => {
    const { manifest, preflight, sources } = voiceComposeFixture();
    const built = buildVoiceComposeJobSnapshot(preflight, sources);
    expect(built.snapshot.input.renderProfile.id).toBe("local-ffmpeg-voice-v1");
    expect(built.snapshot.input.renderProfile.fontId).toBe("noto-sans-cjk-sc");
    expect(assertVoiceComposeSnapshot(built.snapshot, built.inputHash).input.manifest.lines).toEqual(manifest.lines);
    expect(assertVoiceMixManifest(manifest)).toContain("00:00:00.600 --> 00:00:01.200\n{\\pos(1,1)}&lt;你好🙂&gt;");
    expect(() => assertVoiceComposeSnapshot({ ...built.snapshot, input: { ...built.snapshot.input, renderProfile: { ...VOICE_COMPOSE_RENDER_PROFILE, audioOverflow: "trim-to-video-end" } } }, built.inputHash)).toThrow(/profile/);
  });

  it("rejects changed measured takes, source scope, order, text, checksum and overflow", () => {
    for (const patch of [
      (f: ReturnType<typeof voiceComposeFixture>) => { f.manifest.videoDurationMs = 1199; },
      (f: ReturnType<typeof voiceComposeFixture>) => { f.manifest.lines[1]!.startMs = 599; },
      (f: ReturnType<typeof voiceComposeFixture>) => { f.manifest.lines[1]!.displayText = "别的话"; },
      (f: ReturnType<typeof voiceComposeFixture>) => { f.sources.reverse(); },
      (f: ReturnType<typeof voiceComposeFixture>) => { f.sources[1]!.checksumSha256 = "f".repeat(64); },
      (f: ReturnType<typeof voiceComposeFixture>) => { f.sources[1]!.objectKey = f.sources[1]!.objectKey.replace(f.manifest.workspaceId, uid("a")); },
      (f: ReturnType<typeof voiceComposeFixture>) => { f.preflight.subtitleVtt += "changed"; },
    ]) {
      const fixture = voiceComposeFixture(); patch(fixture);
      expect(() => buildVoiceComposeJobSnapshot(fixture.preflight, fixture.sources)).toThrow();
    }
  });

  it("allows deliberately silent composition without inventing speech or captions", () => {
    const { manifest, preflight, sources } = voiceComposeFixture();
    manifest.lines = []; manifest.totalSpeechMs = 0; manifest.selectionHash = speechExactHash([]);
    manifest.subtitles.cues = []; manifest.subtitles.checksumSha256 = speechDialogueHash("WEBVTT\n\n");
    preflight.subtitleVtt = "WEBVTT\n\n"; preflight.inputHash = speechExactHash(manifest);
    expect(buildVoiceComposeJobSnapshot(preflight, sources.slice(0, 1)).snapshot.input.manifest.totalSpeechMs).toBe(0);
  });

  it("accepts only asset selections and an expected preflight hash from the client", () => {
    const { manifest } = voiceComposeFixture();
    expect(parseVoiceComposeRenderRequest({ planRevisionId: manifest.planRevisionId, videoAssetId: manifest.videoAssetId, expectedInputHash: "1".repeat(64) }).originalAudio).toBe("mute");
    for (const extra of [{ objectKey: "/etc/passwd" }, { fontPath: "/font.ttf" }, { workspaceId: uid("d") }, { manifest }]) {
      expect(() => parseVoiceComposeRenderRequest({ planRevisionId: manifest.planRevisionId, videoAssetId: manifest.videoAssetId, expectedInputHash: "1".repeat(64), ...extra })).toThrow(/invalid/);
    }
  });
});
