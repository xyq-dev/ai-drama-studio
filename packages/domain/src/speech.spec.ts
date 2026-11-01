import { describe, expect, it } from "vitest";
import type { SpeechPlanLine, SpeechPlanPut, SpeechSelection, SpeechVoiceRevision } from "@ai-drama/contracts";
import { buildSpeechMixPreflight, speechCuesToVtt, speechDialogueHash, speechExactHash, speechLineInputHash, validateSpeechPlanSource } from "./speech";

const uid = (digit: string) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const voice: SpeechVoiceRevision = { id: uid("1"), bindingId: uid("2"), contentHash: "a".repeat(64), catalogVoiceId: "Cherry", name: "Cherry",
  providerConfigurationId: uid("3"), providerConfigurationVersion: "v1", providerKey: "dashscope-media", model: "qwen3-tts-flash", modelVersion: "v1",
  voiceId: "Cherry", locale: "zh-CN", rightsRef: "authorized-preset", capabilities: { emotions: ["neutral"], speedMin: 1, speedMax: 1 } };
const dialogue = "林夏：你来了。\n林夏：🙂再见。";
const lines: SpeechPlanLine[] = [{ lineId: uid("4"), lineInputRevisionId: uid("5"), inputHash: "b".repeat(64), speakerBindingRevisionId: voice.id,
  sourceStart: 3, sourceEnd: 7, displayText: "你来了。", emotion: "neutral", speed: 1, pauseAfterMs: 300 },
{ lineId: uid("6"), lineInputRevisionId: uid("7"), inputHash: "c".repeat(64), speakerBindingRevisionId: voice.id,
  sourceStart: 11, sourceEnd: 16, displayText: "🙂再见。", emotion: "neutral", speed: 1, pauseAfterMs: 0 }];
const plan = (): SpeechPlanPut => ({ sourceDialogueHash: speechDialogueHash(dialogue), lines: lines.map(({ lineInputRevisionId: _id, inputHash: _hash, ...value }) => value), timingPolicy: "sequential-reject-overflow" });
const voices = () => new Map([[voice.id, { voice, speakerName: "林夏" }]]);
const selections: SpeechSelection[] = lines.map((line, index) => ({ id: uid(String(index + 8)), lineId: line.lineId, lineInputRevisionId: line.lineInputRevisionId,
  takeAssetId: uid(String(index + 1)), checksumSha256: String(index + 1).repeat(64), selectedBy: "owner", selectedAt: "2026-11-01T00:00:00Z", inheritedFromSelectionId: null }));
function mix(videoDurationMs = 6000) {
  return { workspaceId: uid("1"), projectId: uid("2"), shotRevisionId: uid("3"), planRevisionId: uid("4"), planHash: "e".repeat(64), planRowVersion: 3, lines, selections,
    takes: lines.map((line, index) => ({ assetId: selections[index]!.takeAssetId, lineInputRevisionId: line.lineInputRevisionId, voiceRevisionId: voice.id,
      checksumSha256: selections[index]!.checksumSha256, durationMs: index === 0 ? 1500 : 2200, status: "ACTIVE", rowVersion: 1 })),
    video: { assetId: uid("5"), checksumSha256: "d".repeat(64), durationMs: videoDurationMs, status: "ACTIVE", rowVersion: 2 }, music: null,
    request: { videoAssetId: uid("5"), originalAudio: "mute" as const, musicGain: 0.25, ducking: true } };
}
describe("speech source and independent line identity", () => {
  it("preserves exact UTF-16 spans while removing only an explicitly matching speaker label", () => {
    expect(() => validateSpeechPlanSource(dialogue, plan(), voices())).not.toThrow();
    const changed = plan(); changed.lines[0]!.displayText = "你走了。";
    expect(() => validateSpeechPlanSource(dialogue, changed, voices())).toThrow(expect.objectContaining({ code: "SPEECH_SOURCE_MISMATCH" }));
    expect(() => validateSpeechPlanSource(dialogue, plan(), new Map([[voice.id, { voice, speakerName: "别人" }]]))).toThrow(expect.objectContaining({ code: "SPEECH_SOURCE_MISMATCH" }));
  });
  it("rejects omissions, duplicates, overlap, stale voices and unimplemented emotions or speed", () => {
    const omitted = plan(); omitted.lines.pop();
    expect(() => validateSpeechPlanSource(dialogue, omitted, voices())).toThrow(expect.objectContaining({ code: "SPEECH_SOURCE_MISMATCH" }));
    const duplicate = plan(); duplicate.lines.push(duplicate.lines[0]!);
    expect(() => validateSpeechPlanSource(dialogue, duplicate, voices())).toThrow(expect.objectContaining({ code: "SPEECH_PLAN_INVALID" }));
    expect(() => validateSpeechPlanSource(dialogue, plan(), new Map())).toThrow(expect.objectContaining({ code: "SPEECH_VOICE_STALE" }));
    for (const patch of [{ emotion: "happy" }, { speed: 1.2 }]) {
      const changed = plan(); Object.assign(changed.lines[0]!, patch);
      expect(() => validateSpeechPlanSource(dialogue, changed, voices())).toThrow(expect.objectContaining({ code: "SPEECH_PARAMETER_UNSUPPORTED" }));
    }
  });
  it("keeps audio identity when order or pauses change, and changes it for voice, text or performance", () => {
    const a = speechLineInputHash(uid("3"), lines[0]!, voice);
    const paused = { ...lines[0]!, pauseAfterMs: 900 };
    expect(speechLineInputHash(uid("3"), paused, voice)).toBe(a);
    expect(speechLineInputHash(uid("3"), { ...lines[0]!, displayText: "换一句" }, voice)).not.toBe(a);
    expect(speechLineInputHash(uid("3"), lines[0]!, { ...voice, id: uid("9") })).not.toBe(a);
  });
  it("distinguishes Unicode normalization and line endings in audio, plan and permanent-command hashes", () => {
    expect(speechExactHash({ text: "é", a: 1 })).not.toBe(speechExactHash({ text: "e\u0301", a: 1 }));
    expect(speechExactHash({ text: "a\r\nb" })).not.toBe(speechExactHash({ text: "a\nb" }));
    expect(speechExactHash({ text: "é", a: 1 })).toBe(speechExactHash({ a: 1, text: "é" }));
    expect(speechLineInputHash(uid("3"), { ...lines[0]!, displayText: "é" }, voice))
      .not.toBe(speechLineInputHash(uid("3"), { ...lines[0]!, displayText: "e\u0301" }, voice));
  });
  it("refuses source ranges splitting a Unicode surrogate pair before PostgreSQL or a provider sees them", () => {
    const broken = plan();
    broken.lines[1] = { ...broken.lines[1]!, sourceEnd: 12, displayText: dialogue.slice(11, 12) };
    expect(() => validateSpeechPlanSource(dialogue, broken, voices())).toThrow(expect.objectContaining({ code: "SPEECH_SOURCE_MISMATCH" }));
  });
  it("rejects a source line exceeding the actual voice capability before a quote or paid intent", () => {
    const restricted = new Map([[voice.id, { voice: { ...voice, capabilities: { ...voice.capabilities, maxTextCharacters: 3 } }, speakerName: "林夏" }]]);
    expect(() => validateSpeechPlanSource(dialogue, plan(), restricted)).toThrow(expect.objectContaining({ code: "SPEECH_LINE_TOO_LONG" }));
  });
});
describe("measured speech timeline and sentence captions", () => {
  it("generates real cues from selected take durations and natural silence, preserving all audio", () => {
    const output = buildSpeechMixPreflight(mix());
    expect(output.manifest.totalSpeechMs).toBe(4000);
    expect(output.manifest.lines.map(({ startMs, endMs }) => [startMs, endMs])).toEqual([[0, 1500], [1800, 4000]]);
    expect(output.subtitleVtt).toContain("00:00:01.800 --> 00:00:04.000\n🙂再见。");
    expect(output.manifest.mix.audioOverflow).toBe("reject");
    expect(output.manifest.subtitles.checksumSha256).toBe(speechDialogueHash(output.subtitleVtt));
  });
  it("rejects measured overflow including pauses instead of truncating the tail", () => {
    expect(() => buildSpeechMixPreflight(mix(3900))).toThrow(expect.objectContaining({ code: "SPEECH_AUDIO_OVERFLOW", overflowMs: 100 }));
  });
  it("requires explicit selections and their exact input/voice/checksum", () => {
    const missing = mix(); missing.selections = [];
    expect(() => buildSpeechMixPreflight(missing)).toThrow(expect.objectContaining({ code: "SPEECH_SELECTION_MISSING" }));
    const stale = mix(); stale.takes[0]!.checksumSha256 = "f".repeat(64);
    expect(() => buildSpeechMixPreflight(stale)).toThrow(expect.objectContaining({ code: "SPEECH_SELECTION_STALE" }));
  });
  it("supports a deliberately silent shot and safely escapes caption control markup", () => {
    const silent = mix(); silent.lines = []; silent.selections = []; silent.takes = [];
    expect(buildSpeechMixPreflight(silent).subtitleVtt).toBe("WEBVTT\n\n");
    expect(speechCuesToVtt([{ startMs: 0, endMs: 1000, text: "<b>& -->\n\n文本" }])).toContain("&lt;b&gt;&amp; --&gt;\n\u2060\n文本");
    expect(() => speechCuesToVtt([{ startMs: 3, endMs: 2, text: "x" }])).toThrow(expect.objectContaining({ code: "SPEECH_SUBTITLE_INVALID" }));
  });
  it("preserves multiline dialogue as literal VTT payload without admitting cue, tag, ASS or timing injection", () => {
    const text = "原文\r\n\r\n00:00:50.000 --> 99:59:59.999\n<c.red>不要变红</c> &lt;本来就是实体&gt;\n{\\pos(0,0)}\\N%{eif:1:d}\n\t \n下一段";
    const vtt = speechCuesToVtt([{ startMs: 123, endMs: 2345, text }, { startMs: 3456, endMs: 4000, text: "第二句" }]);
    const blocks = vtt.trimEnd().split("\n\n");
    expect(blocks).toHaveLength(3); // Header + exactly the two server-owned cues.
    expect(blocks[1]!.split("\n").slice(0, 2)).toEqual(["1", "00:00:00.123 --> 00:00:02.345"]);
    expect(blocks[2]!.split("\n").slice(0, 2)).toEqual(["2", "00:00:03.456 --> 00:00:04.000"]);
    expect(vtt.match(/-->/g)).toHaveLength(2);
    expect(vtt).toContain("00:00:50.000 --&gt; 99:59:59.999");
    expect(vtt).toContain("&lt;c.red&gt;不要变红&lt;/c&gt; &amp;lt;本来就是实体&amp;gt;");
    const payload = blocks[1]!.split("\n").slice(2).join("\n").replace(/\u2060/g, "")
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    expect(payload).toBe(text.replace(/\r\n?/g, "\n"));
    expect(payload).toContain("{\\pos(0,0)}\\N%{eif:1:d}");
    expect(text).toContain("\r\n\r\n"); // The raw source itself was never normalized or changed.
  });
});
