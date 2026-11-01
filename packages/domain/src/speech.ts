import { SPEECH_MIX_SCHEMA, type SpeechGenerationInput, type SpeechMixManifest, type SpeechMixPreflight,
  type SpeechMixRequest, type SpeechPlanLine, type SpeechPlanPut, type SpeechSelection, type SpeechVoiceRevision } from "@ai-drama/contracts";
import { DomainError } from "./errors";
import { createHash } from "node:crypto";

export function speechDialogueHash(dialogue: string): string { return createHash("sha256").update(dialogue).digest("hex"); }
function fail(code: string, message: string): never { throw new DomainError(code, message); }
function validSpeechText(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const point = value.charCodeAt(index);
    if (point === 0) return false;
    if (point >= 0xd800 && point <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (point >= 0xdc00 && point <= 0xdfff) return false;
  }
  return true;
}
/** Preserve exact text bytes: generic text-chain hashing normalizes Unicode and line endings. */
export function speechExactHash(value: unknown): string {
  function serialize(item: unknown): string {
    if (item === null || typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map((entry) => entry === undefined ? "null" : serialize(entry)).join(",")}]`;
    if (item && typeof item === "object") {
      return `{${Object.entries(item).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, entry]) => `${JSON.stringify(key)}:${serialize(entry)}`).join(",")}}`;
    }
    return fail("SPEECH_PLAN_INVALID", "Speech hash only accepts finite JSON");
  }
  return createHash("sha256").update(serialize(value)).digest("hex");
}
export class SpeechAudioOverflowError extends DomainError {
  constructor(readonly overflowMs: number) { super("SPEECH_AUDIO_OVERFLOW", `Speech exceeds the measured video by ${overflowMs} ms`); }
}
/** Explicit source spans, never inferred speaker attribution. Only a matching speaker label may be omitted. */
export function validateSpeechPlanSource(dialogue: string, body: SpeechPlanPut, voices: Map<string, { voice: SpeechVoiceRevision; speakerName: string }>): void {
  if (speechDialogueHash(dialogue) !== body.sourceDialogueHash) fail("SPEECH_SOURCE_CHANGED", "Saved dialogue changed");
  const ids = new Set<string>();
  for (const line of body.lines) {
    if (ids.has(line.lineId)) fail("SPEECH_PLAN_INVALID", "Duplicate line identity");
    ids.add(line.lineId);
    if (line.sourceStart >= line.sourceEnd || dialogue.slice(line.sourceStart, line.sourceEnd) !== line.displayText || !line.displayText.trim() || !validSpeechText(line.displayText)) {
      fail("SPEECH_SOURCE_MISMATCH", "Every line must preserve an exact nonempty source span");
    }
    const selected = voices.get(line.speakerBindingRevisionId);
    if (!selected) fail("SPEECH_VOICE_STALE", "A current explicit speaker voice is required");
    if ([...line.displayText].length > (selected.voice.capabilities.maxTextCharacters ?? 2000)) fail("SPEECH_LINE_TOO_LONG", "Split this source span into shorter sentences supported by the voice");
    if (!selected.voice.capabilities.emotions.includes(line.emotion) || line.speed < selected.voice.capabilities.speedMin || line.speed > selected.voice.capabilities.speedMax) {
      fail("SPEECH_PARAMETER_UNSUPPORTED", "This voice does not support the requested performance");
    }
  }
  let cursor = 0;
  for (const line of [...body.lines].sort((a, b) => a.sourceStart - b.sourceStart)) {
    if (line.sourceStart < cursor) fail("SPEECH_SOURCE_MISMATCH", "Source spans overlap");
    const gap = dialogue.slice(cursor, line.sourceStart).trim();
    const name = voices.get(line.speakerBindingRevisionId)!.speakerName;
    if (gap && gap !== `${name}：` && gap !== `${name}:`) fail("SPEECH_SOURCE_MISMATCH", "Source dialogue was omitted or attributed to another speaker");
    cursor = line.sourceEnd;
  }
  if (dialogue.slice(cursor).trim()) fail("SPEECH_SOURCE_MISMATCH", "All saved dialogue must be represented");
}
/** Order and pauses affect the mix, while the exact voice/text/performance determine paid audio reuse. */
export function speechLineInputHash(shotRevisionId: string, line: Pick<SpeechPlanLine, "lineId" | "speakerBindingRevisionId" | "displayText" | "emotion" | "speed">,
  voice: SpeechVoiceRevision): string {
  return speechExactHash({ schema: "voice.line.input.v1", shotRevisionId, lineId: line.lineId,
    voiceRevisionId: voice.id, voiceHash: voice.contentHash, displayText: line.displayText, spokenText: line.displayText,
    emotion: line.emotion, speed: line.speed, processingVersion: "speech-source-v1" });
}
export interface SpeechMixTakeFacts {
  assetId: string; lineInputRevisionId: string; voiceRevisionId: string; checksumSha256: string; durationMs: number;
  status: string; rowVersion: number;
}
export interface SpeechMixAssetFacts { assetId: string; checksumSha256: string; durationMs: number; rowVersion: number; status: string }
const validDuration = (value: number) => Number.isSafeInteger(value) && value > 0 && value <= 90_000;
export function buildSpeechMixPreflight(input: {
  workspaceId: string; projectId: string; shotRevisionId: string; planRevisionId: string; planHash: string; planRowVersion: number;
  lines: SpeechPlanLine[]; selections: SpeechSelection[]; takes: SpeechMixTakeFacts[];
  video: SpeechMixAssetFacts; music: SpeechMixAssetFacts | null; request: SpeechMixRequest;
}): SpeechMixPreflight {
  if (input.video.status !== "ACTIVE" || !validDuration(input.video.durationMs)) fail("SPEECH_VIDEO_INVALID", "An active measured video is required");
  if (input.request.musicAssetId && (!input.music || input.music.assetId !== input.request.musicAssetId || input.music.status !== "ACTIVE")) {
    fail("SPEECH_MUSIC_INVALID", "Selected music is unavailable");
  }
  const selections = new Map(input.selections.map((value) => [value.lineId, value]));
  const takes = new Map(input.takes.map((value) => [value.assetId, value]));
  let cursor = 0;
  const lines: SpeechMixManifest["lines"] = input.lines.map((line) => {
    const selection = selections.get(line.lineId);
    if (!selection) fail("SPEECH_SELECTION_MISSING", "Every line needs an explicit selected take");
    const take = takes.get(selection.takeAssetId);
    if (!take || take.status !== "ACTIVE" || !validDuration(take.durationMs) || take.lineInputRevisionId !== line.lineInputRevisionId
      || take.voiceRevisionId !== line.speakerBindingRevisionId || take.checksumSha256 !== selection.checksumSha256
      || selection.lineInputRevisionId !== line.lineInputRevisionId) fail("SPEECH_SELECTION_STALE", "The selected take no longer matches this line");
    const startMs = cursor, endMs = startMs + take.durationMs;
    cursor = endMs + line.pauseAfterMs;
    return { lineId: line.lineId, lineInputRevisionId: line.lineInputRevisionId, voiceRevisionId: line.speakerBindingRevisionId,
      selectionId: selection.id, takeAssetId: take.assetId, checksumSha256: take.checksumSha256,
      startMs, endMs, pauseAfterMs: line.pauseAfterMs, displayText: line.displayText, alignmentVersion: "sentence-duration-v1" };
  });
  if (cursor > input.video.durationMs) throw new SpeechAudioOverflowError(cursor - input.video.durationMs);
  const cues = lines.map((line) => ({ lineId: line.lineId, startMs: line.startMs, endMs: line.endMs, text: line.displayText }));
  const subtitleVtt = speechCuesToVtt(cues);
  const manifest: SpeechMixManifest = { schema: SPEECH_MIX_SCHEMA, workspaceId: input.workspaceId, projectId: input.projectId,
    shotRevisionId: input.shotRevisionId, planRevisionId: input.planRevisionId, planHash: input.planHash,
    selectionHash: speechExactHash(lines.map(({ selectionId, takeAssetId, checksumSha256 }) => ({ selectionId, takeAssetId, checksumSha256 }))),
    videoAssetId: input.video.assetId, videoChecksumSha256: input.video.checksumSha256, videoDurationMs: input.video.durationMs,
    totalSpeechMs: cursor, lines, subtitles: { format: "vtt", alignmentVersion: "sentence-duration-v1", checksumSha256: speechDialogueHash(subtitleVtt), cues },
    mix: { audioOverflow: "reject", audioUnderflow: "pad-silence", sampleRate: 48000, channels: 2,
      originalAudio: input.request.originalAudio, musicAssetId: input.music?.assetId ?? null, musicChecksumSha256: input.music?.checksumSha256 ?? null,
      musicGain: input.request.musicGain, ducking: input.request.ducking } };
  const assets = [input.video, ...(input.music ? [input.music] : []), ...input.takes.filter((take) => lines.some((line) => line.takeAssetId === take.assetId))]
    .map((value) => ({ assetId: value.assetId, rowVersion: value.rowVersion }));
  return { inputHash: speechExactHash(manifest), manifest, subtitleVtt, guards: { planRowVersion: input.planRowVersion, assets } };
}
/** Sentence cues use measured audio boundaries; text is escaped as WebVTT plain text. */
export function speechCuesToVtt(cues: Array<{ startMs: number; endMs: number; text: string }>): string {
  let end = 0;
  const timestamp = (ms: number) => `${String(Math.floor(ms / 3_600_000)).padStart(2, "0")}:${String(Math.floor(ms / 60_000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
  // A blank payload line would terminate a WebVTT cue. Keep that visible blank line with an invisible word joiner;
  // the authoritative displayText and renderer text files remain the original text, including every paragraph.
  const escaped = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r\n?/g, "\n")
    .split("\n").map((part) => /^[\t \f\v]*$/.test(part) ? `${part}\u2060` : part).join("\n");
  return `WEBVTT\n\n${cues.map((cue, index) => {
    if (!Number.isSafeInteger(cue.startMs) || !Number.isSafeInteger(cue.endMs) || cue.startMs < end || cue.endMs <= cue.startMs) fail("SPEECH_SUBTITLE_INVALID", "Subtitle times must be monotonic measured intervals");
    end = cue.endMs;
    return `${index + 1}\n${timestamp(cue.startMs)} --> ${timestamp(cue.endMs)}\n${escaped(cue.text)}\n`;
  }).join("\n")}`;
}
/** Frozen generation records must retain source identity; arrangement changes do not rewrite old candidates. */
export function speechGenerationSnapshot(input: SpeechGenerationInput): { schema: "voice.line.generation.v1"; speech: SpeechGenerationInput } {
  return { schema: "voice.line.generation.v1", speech: input };
}
