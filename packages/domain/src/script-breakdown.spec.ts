import { describe, expect, it } from "vitest";
import {
  SCRIPT_BREAKDOWN_INPUT_SCHEMA,
  SCRIPT_BREAKDOWN_OUTPUT_SCHEMA,
  SCRIPT_BREAKDOWN_PROMPT_VERSION,
  scriptBreakdownJsonSchema,
  type ScriptBreakdownFrozenInput,
  type ScriptBreakdownOutput,
} from "@ai-drama/contracts";
import {
  breakdownDialogueText,
  breakdownShotPromptText,
  buildScriptBreakdownPrompt,
  lineInScript,
  normalizeForMatch,
  plannedTotalSeconds,
  scriptTextOf,
  validateScriptBreakdownOutput,
} from "./script-breakdown";

const SCRIPT = [
  "第 2 集 监控之外",
  "场 1 便利店 夜",
  "林夏盯着监控屏幕。",
  "林夏：这不是我。",
  "场 2 天台 夜",
  "周野推开铁门。",
  "周野：“你终于来了。”",
].join("\n");

function input(overrides: Partial<ScriptBreakdownFrozenInput> = {}): ScriptBreakdownFrozenInput {
  return {
    schema: SCRIPT_BREAKDOWN_INPUT_SCHEMA,
    promptVersion: SCRIPT_BREAKDOWN_PROMPT_VERSION,
    episodeId: "33333333-3333-4333-8333-333333333333",
    episodeNo: 2,
    scriptRevisionId: "44444444-4444-4444-8444-444444444444",
    scriptRevisionNo: 3,
    scriptContentHash: "a".repeat(64),
    scriptText: SCRIPT,
    targetEpisodeSeconds: 60,
    characters: [
      { key: "C1", characterId: "55555555-5555-4555-8555-555555555555", revisionId: "66666666-6666-4666-8666-666666666666", name: "林夏" },
      { key: "C2", characterId: "77777777-7777-4777-8777-777777777777", revisionId: "88888888-8888-4888-8888-888888888888", name: "周野" },
    ],
    replace: { scenes: [], shots: [] },
    providerKey: "qwen",
    model: "q-1",
    ...overrides,
  };
}

function output(overrides: Partial<ScriptBreakdownOutput> = {}): ScriptBreakdownOutput {
  return {
    schema: SCRIPT_BREAKDOWN_OUTPUT_SCHEMA,
    episodeNo: 2,
    scenes: [
      { key: "S1", heading: "便利店", timeOfDay: "夜", description: "林夏发现监控画面里的人不是自己。" },
      { key: "S2", heading: "天台", timeOfDay: "夜", description: "周野在天台等林夏。" },
    ],
    shots: [
      { key: "S1-1", sceneKey: "S1", shotType: "中景", camera: "缓慢推近监控屏幕", action: "林夏盯着监控屏幕", dialogue: [], characterKeys: ["C1"], plannedSeconds: 4 },
      { key: "S1-2", sceneKey: "S1", shotType: "近景", camera: "固定机位", action: "林夏后退半步", dialogue: [{ speaker: "林夏", line: "这不是我。" }], characterKeys: ["C1"], plannedSeconds: 3 },
      { key: "S2-1", sceneKey: "S2", shotType: "全景", camera: "从铁门后跟拍", action: "周野推开铁门", dialogue: [{ speaker: "周野", line: "你终于来了。" }], characterKeys: ["C2"], plannedSeconds: 5 },
    ],
    ...overrides,
  };
}

const check = (value: unknown, frozen = input()) => validateScriptBreakdownOutput(typeof value === "string" ? value : JSON.stringify(value), frozen);

describe("script breakdown prompt", () => {
  it("is built only from the frozen copy: the script text, its episode, the character keys and the bounds", () => {
    const prompt = buildScriptBreakdownPrompt(input());
    expect(prompt.user).toContain("把第 2 集剧本拆成场景和镜头");
    expect(prompt.user).toContain(`剧本正文（开始）\n${SCRIPT}\n剧本正文（结束）`);
    expect(prompt.user).toContain("C1：林夏");
    expect(prompt.user).toContain("C2：周野");
    expect(prompt.user).toContain("每集目标约 60 秒");
    expect(prompt.user).toContain("场景 1–8 场");
    expect(prompt.user).toContain("镜头共 1–20 镜");
    expect(prompt.user).toContain("逐字摘自剧本正文");
    expect(prompt.system).toContain("预计时长是计划，不是成片时长");
    // Another script gives another prompt: nothing is cached across sources.
    expect(buildScriptBreakdownPrompt(input({ scriptText: "场 1 码头\n老周：走。" })).user).not.toContain("便利店");
  });

  it("tells the model to reference no character when the work has none, and says when no target was recorded", () => {
    const prompt = buildScriptBreakdownPrompt(input({ characters: [], targetEpisodeSeconds: null }));
    expect(prompt.user).toContain("characterKeys 一律输出空数组");
    expect(prompt.user).toContain("作品没有记录每集目标时长");
  });

  it("gives OpenAI a strict schema pinned to the episode", () => {
    const schema = scriptBreakdownJsonSchema(4).schema as { properties: { episodeNo: { enum: number[] } }; required: string[] };
    expect(schema.properties.episodeNo.enum).toEqual([4]);
    expect(schema.required).toEqual(["schema", "episodeNo", "scenes", "shots"]);
  });
});

describe("script breakdown output checks", () => {
  it("accepts a valid answer with variable numbers of scenes and shots, as given", () => {
    const result = check(output());
    expect(result).toEqual({ ok: true, output: output() });
    if (!result.ok) return;
    expect(plannedTotalSeconds(result.output)).toBe(12);
    const one = output({ scenes: [output().scenes[0]!], shots: [{ ...output().shots[0]!, plannedSeconds: 6 }] });
    expect(check(one).ok).toBe(true);
  });

  it("refuses an empty answer, invalid JSON and a truncated JSON answer as invalid_json", () => {
    expect(check("")).toEqual({ ok: false, code: "invalid_json" });
    expect(check("not json")).toEqual({ ok: false, code: "invalid_json" });
    const full = JSON.stringify(output());
    expect(check(full.slice(0, Math.floor(full.length * 0.7)))).toEqual({ ok: false, code: "invalid_json" });
    expect(check("[1,2]")).toEqual({ ok: false, code: "invalid_json" });
  });

  it("refuses an answer for another episode", () => {
    expect(check(output({ episodeNo: 3 }))).toEqual({ ok: false, code: "episode_mismatch" });
    expect(check({ ...output(), episodeNo: 3, extra: true })).toEqual({ ok: false, code: "episode_mismatch" });
  });

  it("refuses schema violations: extra fields, a wrong schema name, too many shots, durations outside 2–10 seconds", () => {
    expect(check({ ...output(), extra: 1 })).toEqual({ ok: false, code: "invalid_output" });
    expect(check({ ...output(), schema: "other" })).toEqual({ ok: false, code: "invalid_output" });
    const many = Array.from({ length: 21 }, (_, index) => ({ ...output().shots[0]!, key: `S1-${String((index % 8) + 1)}` }));
    expect(check(output({ shots: many }))).toEqual({ ok: false, code: "invalid_output" });
    expect(check(output({ shots: [{ ...output().shots[0]!, plannedSeconds: 11 }, ...output().shots.slice(1)] }))).toEqual({ ok: false, code: "invalid_output" });
    expect(check(output({ shots: [{ ...output().shots[0]!, plannedSeconds: 1 }, ...output().shots.slice(1)] }))).toEqual({ ok: false, code: "invalid_output" });
  });

  it("refuses duplicate scene keys and duplicate shot keys", () => {
    expect(check(output({ scenes: [output().scenes[0]!, { ...output().scenes[1]!, key: "S1" }] }))).toEqual({ ok: false, code: "duplicate_key" });
    expect(check(output({ shots: [output().shots[0]!, { ...output().shots[1]!, key: "S1-1" }, output().shots[2]!] }))).toEqual({ ok: false, code: "duplicate_key" });
  });

  it("refuses missing references: an unknown scene, an unknown character and a scene without shots", () => {
    expect(check(output({ shots: [...output().shots.slice(0, 2), { ...output().shots[2]!, sceneKey: "S3" }] }))).toEqual({ ok: false, code: "missing_reference" });
    expect(check(output({ shots: [{ ...output().shots[0]!, characterKeys: ["C3"] }, ...output().shots.slice(1)] }))).toEqual({ ok: false, code: "missing_reference" });
    expect(check(output({ shots: output().shots.slice(0, 2) }))).toEqual({ ok: false, code: "missing_reference" });
    expect(check(output(), input({ characters: [] }))).toEqual({ ok: false, code: "missing_reference" });
  });

  it("refuses shots that are not grouped in scene order", () => {
    const [a, b, c] = output().shots;
    expect(check(output({ shots: [a!, c!, b!] }))).toEqual({ ok: false, code: "invalid_output" });
  });

  it("refuses keys that do not match their scene and position: S1, S2, … and S<scene>-1, S<scene>-2, … with nothing renamed", () => {
    const [a, b, c] = output().shots;
    // A shot keyed for S2 placed under S1, and the reverse.
    expect(check(output({ shots: [a!, { ...b!, key: "S2-1" }, { ...c!, key: "S2-2" }] }))).toEqual({ ok: false, code: "invalid_output" });
    expect(check(output({ shots: [a!, b!, { ...c!, key: "S1-3" }] }))).toEqual({ ok: false, code: "invalid_output" });
    // Wrong, skipped or swapped ordinals inside a scene.
    expect(check(output({ shots: [{ ...a!, key: "S1-2" }, { ...b!, key: "S1-1" }, c!] }))).toEqual({ ok: false, code: "invalid_output" });
    expect(check(output({ shots: [a!, { ...b!, key: "S1-3" }, c!] }))).toEqual({ ok: false, code: "invalid_output" });
    expect(check(output({ shots: [a!, b!, { ...c!, key: "S2-2" }] }))).toEqual({ ok: false, code: "invalid_output" });
    // Scene keys out of order or skipped (shots follow their scenes, so only the scene keys are wrong).
    const [s1, s2] = output().scenes;
    expect(check(output({ scenes: [{ ...s1!, key: "S2" }, { ...s2!, key: "S1" }],
      shots: [{ ...a!, key: "S2-1", sceneKey: "S2" }, { ...b!, key: "S2-2", sceneKey: "S2" }, { ...c!, key: "S1-1", sceneKey: "S1" }] })))
      .toEqual({ ok: false, code: "invalid_output" });
    expect(check(output({ scenes: [s1!, { ...s2!, key: "S3" }], shots: [a!, b!, { ...c!, key: "S3-1", sceneKey: "S3" }] })))
      .toEqual({ ok: false, code: "invalid_output" });
  });

  it("accepts a valid answer of three scenes with one, three and two shots, keys exactly as given", () => {
    const script = [SCRIPT, "场 3 码头 晨", "周野：走吧。"].join("\n");
    const shot = (key: string, sceneKey: string) => ({ key, sceneKey, shotType: "中景", camera: "固定机位", action: "动作", dialogue: [], characterKeys: [], plannedSeconds: 3 });
    const three = output({
      scenes: [...output().scenes, { key: "S3", heading: "码头", timeOfDay: "晨", description: "两人离开。" }],
      shots: [shot("S1-1", "S1"), shot("S2-1", "S2"), shot("S2-2", "S2"), shot("S2-3", "S2"), shot("S3-1", "S3"),
        { ...shot("S3-2", "S3"), dialogue: [{ speaker: "周野", line: "走吧。" }], characterKeys: ["C2"] }],
    });
    expect(check(three, input({ scriptText: script }))).toEqual({ ok: true, output: three });
  });

  it("requires the key of the frozen character who speaks a line; another character's key does not count", () => {
    const [a, b, c] = output().shots;
    // S1-2: 林夏 (C1) speaks. Missing key, or only 周野's key: refused.
    expect(check(output({ shots: [a!, { ...b!, characterKeys: [] }, c!] }))).toEqual({ ok: false, code: "missing_reference" });
    expect(check(output({ shots: [a!, { ...b!, characterKeys: ["C2"] }, c!] }))).toEqual({ ok: false, code: "missing_reference" });
    expect(check(output({ shots: [a!, b!, { ...c!, characterKeys: ["C1"] }] }))).toEqual({ ok: false, code: "missing_reference" });
    // The speaker's key alongside others passes; the spoken name is matched as the dialogue rules match it.
    expect(check(output({ shots: [a!, { ...b!, characterKeys: ["C2", "C1"] }, c!] })).ok).toBe(true);
    expect(check(output({ shots: [a!, { ...b!, dialogue: [{ speaker: "林 夏", line: "这不是我。" }], characterKeys: ["C1"] }, c!] })).ok).toBe(true);
  });

  it("asks nothing of a speaker who is not a frozen character, and takes no guess between characters of one name", () => {
    const [a, b, c] = output().shots;
    // 周野 is not a frozen character here: his line needs no key (and none is invented).
    const onlyLinXia = input({ characters: [input().characters[0]!] });
    expect(check(output({ shots: [a!, b!, { ...c!, characterKeys: [] }] }), onlyLinXia).ok).toBe(true);
    // Two characters named 林夏: the line needs one of them, chosen by the answer; none is refused, either one passes.
    const twins = input({ characters: [input().characters[0]!, { ...input().characters[1]!, name: "林夏" }] });
    const linXiaShots = (keys: string[]) => output({ shots: [{ ...a!, characterKeys: [] }, { ...b!, characterKeys: keys }, { ...c!, characterKeys: [] }] });
    // 周野's line in S2-1 now has no frozen character, so only S1-2 matters.
    expect(check(linXiaShots([]), twins)).toEqual({ ok: false, code: "missing_reference" });
    expect(check(linXiaShots(["C1"]), twins).ok).toBe(true);
    expect(check(linXiaShots(["C2"]), twins).ok).toBe(true);
  });

  it("refuses dialogue or a speaker that is not in the frozen script, ignoring only whitespace and outer quotes", () => {
    const invented = output({ shots: [output().shots[0]!, { ...output().shots[1]!, dialogue: [{ speaker: "林夏", line: "这真的不是我。" }] }, output().shots[2]!] });
    expect(check(invented)).toEqual({ ok: false, code: "dialogue_not_in_script" });
    const stranger = output({ shots: [output().shots[0]!, { ...output().shots[1]!, dialogue: [{ speaker: "路人", line: "这不是我。" }] }, output().shots[2]!] });
    expect(check(stranger)).toEqual({ ok: false, code: "dialogue_not_in_script" });
    const spaced = output({ shots: [output().shots[0]!, { ...output().shots[1]!, dialogue: [{ speaker: "林 夏", line: "「这不是 我。」" }] }, output().shots[2]!] });
    expect(check(spaced).ok).toBe(true);
    // The same answer against another script is refused: lines must come from the frozen source.
    expect(check(output(), input({ scriptText: "场 1 便利店 夜\n林夏盯着监控屏幕。" }))).toEqual({ ok: false, code: "dialogue_not_in_script" });
  });

  it.each([
    { speaker: "林夏", line: "你终于来了。" },
    { speaker: "林夏", line: "周野推开铁门。" },
    { speaker: "铁门", line: "你终于来了。" },
  ])("refuses a mismatched dialogue attribution $speaker: $line even when both substrings occur", (dialogue) => {
    const answer = output();
    answer.shots[1]!.dialogue = [dialogue];
    expect(check(answer)).toEqual({ ok: false, code: "dialogue_not_in_script" });
  });

  it.each([
    "林夏：这不是我。",
    '林夏: "这不是我。"',
    "林夏（低声）：『这不是我。』",
    " 林 夏 ( 低声 ) : “这不是 我。”",
    "林夏：\n“这不是我。”",
  ])("accepts an explicitly attributed line with supported punctuation: %s", (line) => {
    expect(check(output(), input({ scriptText: SCRIPT.replace("林夏：这不是我。", line) })).ok).toBe(true);
  });

  it("accepts explicitly marked narration without requiring a character entry", () => {
    const answer = output();
    answer.shots[1]!.dialogue = [{ speaker: "旁白", line: "夜幕落下。" }];
    expect(check(answer, input({ scriptText: `${SCRIPT}\n旁白：夜幕落下。` })).ok).toBe(true);
  });

  it("does not infer attribution from unmarked prose or a later action line", () => {
    const answer = output();
    answer.shots[1]!.dialogue = [{ speaker: "林夏", line: "周野推开铁门。" }];
    expect(check(answer, input({ scriptText: `${SCRIPT}\n林夏：\n周野推开铁门。` })))
      .toEqual({ ok: false, code: "dialogue_not_in_script" });
  });

  it("refuses unsafe text and a total planned duration outside 5–180 seconds", () => {
    expect(check(output({ scenes: [{ ...output().scenes[0]!, description: "见 https://example.com" }, output().scenes[1]!] }))).toEqual({ ok: false, code: "unsafe_content" });
    const short = output({ scenes: [output().scenes[0]!], shots: [{ ...output().shots[0]!, plannedSeconds: 2 }, { ...output().shots[1]!, plannedSeconds: 2 }] });
    expect(check(short)).toEqual({ ok: false, code: "duration_out_of_range" });
  });
});

describe("stored shot text", () => {
  it("keeps dialogue, camera, action and the composed prompt as separate values", () => {
    const shot = output().shots[1]!;
    expect(breakdownDialogueText(shot)).toBe("林夏：这不是我。");
    expect(breakdownDialogueText(output().shots[0]!)).toBeNull();
    expect(breakdownShotPromptText(output().scenes[0]!, shot)).toBe("便利店（夜）；近景；固定机位；林夏后退半步");
  });

  it("reads only the editor's { text } script shape", () => {
    expect(scriptTextOf({ text: "abc" })).toBe("abc");
    expect(scriptTextOf({ text: "abc", scenes: [] })).toBeNull();
    expect(scriptTextOf("abc")).toBeNull();
    expect(scriptTextOf(null)).toBeNull();
  });

  it("matches lines without whitespace", () => {
    expect(normalizeForMatch(" 林 夏\n：这\t不是我。")).toBe(normalizeForMatch("林夏：这不是我。"));
    expect(normalizeForMatch(" 林 夏\n：这\t不是我。")).not.toMatch(/\s/);
    expect(lineInScript("“你终于来了。”", normalizeForMatch(SCRIPT))).toBe(true);
    expect(lineInScript("", normalizeForMatch(SCRIPT))).toBe(false);
  });
});
