import { SPEECH_MAX_LINES, SPEECH_MIX_SCHEMA, speechMixRequestSchema, type SpeechMixManifest, type SpeechMixPreflight,
  type SpeechMixRequest } from "@ai-drama/contracts";
import { COMPOSE_OUTPUT_MAX_BYTES } from "./compose-render";
import { DomainError } from "./errors";
import { speechCuesToVtt, speechDialogueHash, speechExactHash } from "./speech";
import { assertDependencyEdges, type EpisodeExportMedia, type FrozenShotMediaInput } from "./episode-export";

export const VOICE_COMPOSE_JOB_SCHEMA = "m4.shot.voice-compose.v1";
export const VOICE_COMPOSE_OUTPUT_SCHEMA = "m4.shot.voice-compose.asset.v1";
export const VOICE_COMPOSE_RENDER_PROFILE = {
  id: "local-ffmpeg-voice-v1", width: 1080, height: 1920, frameRate: 25, container: "mp4",
  videoCodec: "libx264", pixelFormat: "yuv420p", crf: 23, preset: "veryfast", faststart: true,
  videoFit: "contain-center-black", audioCodec: "aac", audioSampleRate: 48000, audioChannels: 2,
  speechTiming: "measured-sentence-v1", audioOverflow: "reject", audioUnderflow: "pad-silence",
  speechGain: 1, ambienceGain: 0.25, duckingGain: 0.2, duckingAttackMs: 50, duckingReleaseMs: 200,
  peakLimit: true, subtitleMode: "burn-in-plain-text", fontId: "noto-sans-cjk-sc", fontStyleVersion: "m4-voice-subtitle-style-v1",
  subtitleFontSize: 48, subtitleLineSpacing: 8, subtitleBottomMargin: 96, subtitleMaxWidthUnits: 36, subtitleMaxLines: 16,
  subtitleColor: "white", subtitleBoxColor: "black@0.55", subtitleBoxBorder: 12,
  ffmpegThreads: 2, renderTimeoutSec: 300, probeTimeoutSec: 30, maxOutputBytes: COMPOSE_OUTPUT_MAX_BYTES,
} as const;

export interface VoiceComposeRenderRequest extends SpeechMixRequest { planRevisionId: string; expectedInputHash: string }
export interface VoiceComposeSourceObject {
  role: "video" | "speech" | "music";
  assetId: string;
  lineId?: string;
  storageProvider: "s3" | "mock-object-store";
  objectKey: string;
  byteSize: number;
  checksumSha256: string;
}
export interface VoiceComposeJobSnapshot {
  schema: typeof VOICE_COMPOSE_JOB_SCHEMA;
  input: { manifest: SpeechMixManifest; renderProfile: typeof VOICE_COMPOSE_RENDER_PROFILE; sourceObjects: VoiceComposeSourceObject[] };
  preflightInputHash: string;
  guards: SpeechMixPreflight["guards"];
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
function fail(message: string): never { throw new DomainError("COMPOSE_INPUT_INVALID", message); }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }

export function parseVoiceComposeRenderRequest(body: unknown): VoiceComposeRenderRequest {
  if (!record(body) || Object.keys(body).some((key) => !["planRevisionId", "expectedInputHash", "videoAssetId", "musicAssetId", "originalAudio", "musicGain", "ducking"].includes(key)) ||
    typeof body.planRevisionId !== "string" || !UUID.test(body.planRevisionId) || typeof body.expectedInputHash !== "string" || !HASH.test(body.expectedInputHash)) {
    throw new DomainError("VALIDATION_ERROR", "Voice compose request is invalid");
  }
  const { planRevisionId, expectedInputHash, ...mix } = body;
  const parsed = speechMixRequestSchema.safeParse(mix);
  if (!parsed.success) throw new DomainError("VALIDATION_ERROR", "Voice compose mix settings are invalid");
  return { ...parsed.data, planRevisionId: planRevisionId.toLowerCase(), expectedInputHash };
}

/** The new profile rejects overflow; legacy single-audio trimming remains its own unchanged profile. */
export function assertVoiceMixManifest(manifest: SpeechMixManifest): string {
  if (!record(manifest) || manifest.schema !== SPEECH_MIX_SCHEMA ||
    ![manifest.workspaceId, manifest.projectId, manifest.shotRevisionId, manifest.planRevisionId, manifest.videoAssetId].every((id) => typeof id === "string" && UUID.test(id)) ||
    ![manifest.planHash, manifest.selectionHash, manifest.videoChecksumSha256].every((hash) => typeof hash === "string" && HASH.test(hash)) ||
    !Number.isSafeInteger(manifest.videoDurationMs) || manifest.videoDurationMs <= 0 || manifest.videoDurationMs > 90_000 ||
    !Array.isArray(manifest.lines) || manifest.lines.length > SPEECH_MAX_LINES ||
    !record(manifest.mix) || manifest.mix.audioOverflow !== "reject" || manifest.mix.audioUnderflow !== "pad-silence" ||
    manifest.mix.sampleRate !== 48000 || manifest.mix.channels !== 2 || !["mute", "confirmed-ambience"].includes(manifest.mix.originalAudio) ||
    !Number.isFinite(manifest.mix.musicGain) || manifest.mix.musicGain < 0 || manifest.mix.musicGain > 1 || typeof manifest.mix.ducking !== "boolean") fail("Frozen voice manifest is invalid");
  let cursor = 0;
  const ids = new Set<string>();
  for (const line of manifest.lines) {
    if (!record(line) || ![line.lineId, line.lineInputRevisionId, line.voiceRevisionId, line.selectionId, line.takeAssetId].every((id) => typeof id === "string" && UUID.test(id)) ||
      ids.has(line.lineId) || !HASH.test(line.checksumSha256) || line.alignmentVersion !== "sentence-duration-v1" ||
      !Number.isSafeInteger(line.startMs) || !Number.isSafeInteger(line.endMs) || line.startMs !== cursor || line.endMs <= line.startMs ||
      !Number.isSafeInteger(line.pauseAfterMs) || line.pauseAfterMs < 0 || line.pauseAfterMs > 5000 ||
      typeof line.displayText !== "string" || !line.displayText.trim()) fail("Frozen voice sentence timing is invalid");
    cursor = line.endMs + line.pauseAfterMs;
    ids.add(line.lineId);
  }
  if (manifest.totalSpeechMs !== cursor || cursor > manifest.videoDurationMs) fail("Frozen speech exceeds the measured video duration");
  if (manifest.selectionHash !== speechExactHash(manifest.lines.map(({ selectionId, takeAssetId, checksumSha256 }) => ({ selectionId, takeAssetId, checksumSha256 })))) fail("Frozen voice selection identity is invalid");
  if (manifest.mix.musicAssetId === null ? manifest.mix.musicChecksumSha256 !== null :
    !UUID.test(manifest.mix.musicAssetId) || typeof manifest.mix.musicChecksumSha256 !== "string" || !HASH.test(manifest.mix.musicChecksumSha256)) fail("Frozen voice music identity is invalid");
  const cues = manifest.lines.map((line) => ({ lineId: line.lineId, startMs: line.startMs, endMs: line.endMs, text: line.displayText }));
  if (!record(manifest.subtitles) || manifest.subtitles.format !== "vtt" || manifest.subtitles.alignmentVersion !== "sentence-duration-v1" ||
    speechExactHash(manifest.subtitles.cues) !== speechExactHash(cues)) fail("Frozen voice subtitles do not match the selected sentences");
  const vtt = speechCuesToVtt(cues);
  if (speechDialogueHash(vtt) !== manifest.subtitles.checksumSha256) fail("Frozen voice subtitle checksum does not match");
  return vtt;
}

export function buildVoiceComposeJobSnapshot(preflight: SpeechMixPreflight, sourceObjects: readonly VoiceComposeSourceObject[]): { snapshot: VoiceComposeJobSnapshot; inputHash: string } {
  const manifest = preflight.manifest;
  const subtitleVtt = assertVoiceMixManifest(manifest);
  if (preflight.inputHash !== speechExactHash(manifest) || preflight.subtitleVtt !== subtitleVtt) fail("Voice preflight content changed");
  const expected = [
    { role: "video", assetId: manifest.videoAssetId, checksumSha256: manifest.videoChecksumSha256 },
    ...manifest.lines.map((line) => ({ role: "speech", assetId: line.takeAssetId, checksumSha256: line.checksumSha256, lineId: line.lineId })),
    ...(manifest.mix.musicAssetId ? [{ role: "music", assetId: manifest.mix.musicAssetId, checksumSha256: manifest.mix.musicChecksumSha256! }] : []),
  ];
  if (sourceObjects.length !== expected.length) fail("Voice compose source count does not match the manifest");
  sourceObjects.forEach((source, index) => {
    const match = expected[index];
    if (!match || source.role !== match.role || source.assetId !== match.assetId || source.checksumSha256 !== match.checksumSha256 ||
      source.lineId !== ("lineId" in match ? match.lineId : undefined) || !Number.isSafeInteger(source.byteSize) || source.byteSize <= 0 ||
      !["s3", "mock-object-store"].includes(source.storageProvider) || !source.objectKey || source.objectKey.includes("..") || source.objectKey.includes("\\") || source.objectKey.startsWith("/")) fail("Voice compose source does not match the manifest");
    if (source.storageProvider === "s3") {
      const suffix = source.objectKey.slice(`real-media/${manifest.workspaceId}/${manifest.projectId}/`.length);
      const parts = suffix.split("/");
      if (!source.objectKey.startsWith(`real-media/${manifest.workspaceId}/${manifest.projectId}/`) || parts.length !== 3 || !UUID.test(parts[0] ?? "") || !UUID.test(parts[1] ?? "") ||
        parts[2] !== `${source.checksumSha256}.${source.role === "video" ? "mp4" : "wav"}`) fail("Voice compose S3 object is outside its source scope");
    }
  });
  const input = { manifest, renderProfile: VOICE_COMPOSE_RENDER_PROFILE, sourceObjects: sourceObjects.map((source) => ({ ...source })) };
  return { snapshot: { schema: VOICE_COMPOSE_JOB_SCHEMA, input, preflightInputHash: preflight.inputHash, guards: preflight.guards }, inputHash: speechExactHash(input) };
}

export function assertVoiceComposeSnapshot(value: unknown, inputHash: string): VoiceComposeJobSnapshot {
  if (!record(value) || value.schema !== VOICE_COMPOSE_JOB_SCHEMA || !record(value.input) || !Array.isArray(value.input.sourceObjects) || !record(value.guards) ||
    speechExactHash(value.input.renderProfile) !== speechExactHash(VOICE_COMPOSE_RENDER_PROFILE)) fail("Voice compose renderer profile is invalid");
  const snapshot = value as unknown as VoiceComposeJobSnapshot;
  const vtt = assertVoiceMixManifest(snapshot.input.manifest);
  const rebuilt = buildVoiceComposeJobSnapshot({ inputHash: snapshot.preflightInputHash, manifest: snapshot.input.manifest, subtitleVtt: vtt, guards: snapshot.guards }, snapshot.input.sourceObjects);
  if (rebuilt.inputHash !== inputHash) fail("Voice compose frozen input hash is invalid");
  return snapshot;
}

/** Voice sentences deliberately repeat the audio role; every take still retains its exact line and Job/Attempt. */
export function mediaFromFrozenVoiceShot(input: {
  workspaceId: string; projectId: string; manifest: SpeechMixManifest; sourceObjects: readonly VoiceComposeSourceObject[];
  edges: FrozenShotMediaInput["edges"]; media: FrozenShotMediaInput["media"];
}): EpisodeExportMedia[] {
  assertVoiceMixManifest(input.manifest);
  const manifest = input.manifest;
  if (manifest.workspaceId !== input.workspaceId || manifest.projectId !== input.projectId) fail("Frozen voice export is outside this project");
  const expected: Array<{ sourceRole: VoiceComposeSourceObject["role"]; role: EpisodeExportMedia["role"]; assetId: string; checksumSha256: string; kind: string; lineId?: string }> = [
    { sourceRole: "video", role: "video", assetId: manifest.videoAssetId, checksumSha256: manifest.videoChecksumSha256, kind: "VIDEO" },
    ...manifest.lines.map((line) => ({ sourceRole: "speech" as const, role: "audio" as const, assetId: line.takeAssetId, checksumSha256: line.checksumSha256, kind: "AUDIO", lineId: line.lineId })),
    ...(manifest.mix.musicAssetId ? [{ sourceRole: "music" as const, role: "music" as const, assetId: manifest.mix.musicAssetId, checksumSha256: manifest.mix.musicChecksumSha256!, kind: "MUSIC" }] : []),
  ];
  if (input.sourceObjects.length !== expected.length || input.sourceObjects.some((source, index) => {
    const match = expected[index];
    return !match || source.role !== match.sourceRole || source.assetId !== match.assetId || source.checksumSha256 !== match.checksumSha256 || source.lineId !== match.lineId;
  })) fail("Frozen voice export objects do not match every selected sentence");
  const ids = [...new Set(expected.map((source) => source.assetId))];
  assertDependencyEdges(input.workspaceId, input.projectId, ids, input.edges);
  const rows = new Map(input.media.map((row) => [row.assetId, row]));
  if (rows.size !== input.media.length || rows.size !== ids.length) fail("Frozen voice media has unexpected or duplicate assets");
  return expected.map((source) => {
    const row = rows.get(source.assetId);
    if (!row || row.workspaceId !== input.workspaceId || row.projectId !== input.projectId || row.kind !== source.kind || row.checksumSha256 !== source.checksumSha256 ||
      !row.sourceJobId || !row.sourceAttemptId) fail("Frozen voice media does not match its stored generation");
    return { role: source.role, kind: row.kind, assetId: row.assetId, checksumSha256: row.checksumSha256,
      sourceJobId: row.sourceJobId, sourceAttemptId: row.sourceAttemptId, ...(source.lineId ? { lineId: source.lineId } : {}) };
  });
}
