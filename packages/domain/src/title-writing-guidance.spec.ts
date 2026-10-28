import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EPISODE_DRAFT_SCHEMA,
  EPISODE_OUTLINE_SCHEMA,
  EPISODE_OUTLINE_SCHEMA_V2,
  TITLE_CONCEPT_SCHEMA,
  TITLE_WRITING_INPUT_SCHEMA,
  TITLE_WRITING_INPUT_SCHEMA_V2,
  TITLE_WRITING_PROMPT_VERSION,
  TITLE_WRITING_PROMPT_VERSION_V2,
  TITLE_WRITING_PROMPT_VERSION_V3,
  TITLE_WRITING_PROMPT_VERSION_V4,
  titleWritingJsonSchemas,
  type TitleWritingFrozenInput,
} from "@ai-drama/contracts";
import { buildTitleWritingPrompt, formatTitleEpisode, validateTitleWritingOutput } from "./title-writing";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
type V2Prompt = typeof TITLE_WRITING_PROMPT_VERSION_V2 | typeof TITLE_WRITING_PROMPT_VERSION_V3 | typeof TITLE_WRITING_PROMPT_VERSION_V4;
const input = (promptVersion: V2Prompt, episodeCount = 3): TitleWritingFrozenInput => ({
  schema: TITLE_WRITING_INPUT_SCHEMA_V2, promptVersion, title: "夜班证词", settings: { episodeCount, episodeSeconds: 90, style: "" },
  providerKey: "qwen", model: "q-1" });
const concept = { schema: TITLE_CONCEPT_SCHEMA, genre: "g", logline: "l", synopsis: "s", protagonistGoal: "p", opposition: "o",
  coreConflict: "c", direction: "d", characters: [{ name: "甲", role: "r", profile: "p" }, { name: "乙", role: "r", profile: "p" }],
  relationships: [{ name: "甲与乙", pressure: "x" }] } as const;
const outline = (count: number) => ({ schema: EPISODE_OUTLINE_SCHEMA_V2, episodes: Array.from({ length: count }, (_, index) => ({
  episodeNo: index + 1, title: "t", entryState: "e", goal: "g", action: "a", turn: "t", result: "r", handoff: "h" })) });
const episode = (episodeNo: number) => ({ schema: EPISODE_DRAFT_SCHEMA, episodeNo, title: "t", screenplay: "s",
  scenes: [{ heading: "h", action: "a", dialogue: "", sound: "" }], handoffFacts: ["f"] });
const prompts = (frozen: TitleWritingFrozenInput) => [
  buildTitleWritingPrompt("concept", frozen, {}),
  buildTitleWritingPrompt("outline", frozen, { concept }),
  buildTitleWritingPrompt("episode:1", frozen, { concept, outline: outline(3), episodes: [] }),
  buildTitleWritingPrompt("episode:3", frozen, { concept, outline: outline(3), episodes: [episode(1), episode(2)] as never[] }),
];

describe("stored v2 runs keep their exact prompts", () => {
  // Computed from origin/main 70abefb9c0da055c75b216164483aebcbeb34e0d before prompt v3 existed: a stored run frozen
  // with ads.title-writing.prompt.v2 that is resumed after this change sends byte-identical prompts.
  it("builds the v2 prompts byte for byte as before", () => {
    expect(sha(JSON.stringify(prompts(input(TITLE_WRITING_PROMPT_VERSION_V2))))).toBe("6198cd81c3b0e19cbcc00b690baa02a354a3f9708364a108806f817b3756b44c");
    for (const prompt of prompts(input(TITLE_WRITING_PROMPT_VERSION_V2))) expect(prompt.user).not.toContain(TITLE_WRITING_PROMPT_VERSION_V3);
  });
});

describe("prompt v3 adds the writing requirements inside the existing structure", () => {
  it("names the version and asks each step for its answers in existing fields", () => {
    const [conceptPrompt, outlinePrompt, firstEpisode, lastEpisode] = prompts(input(TITLE_WRITING_PROMPT_VERSION_V3)).map((prompt) => prompt.user);
    for (const text of [conceptPrompt, outlinePrompt, firstEpisode, lastEpisode]) expect(text).toContain(TITLE_WRITING_PROMPT_VERSION_V3);
    expect(conceptPrompt).toContain("整部期待");
    for (const field of ["entryState：", "goal：", "action：", "turn：", "result：", "handoff："]) expect(outlinePrompt).toContain(field);
    expect(outlinePrompt).toContain("不新增字段");
    expect(firstEpisode).toContain("不凭空新增解围人物或决定性证据");
    expect(lastEpisode).toContain("不改变人物身份、关系和大纲中的结局走向");
    // There is no step where a person confirms the outline: the prompt names the outline this run saved, nothing more.
    expect(firstEpisode).toContain("本集按本次创作保存的分集大纲执行");
    for (const text of [conceptPrompt, outlinePrompt, firstEpisode, lastEpisode]) expect(text).not.toMatch(/已确认|确认的(计划|大纲)/);
  });

  it("keeps every v2 line in the same order: v3 only inserts lines", () => {
    const v2 = prompts(input(TITLE_WRITING_PROMPT_VERSION_V2));
    const v3 = prompts(input(TITLE_WRITING_PROMPT_VERSION_V3));
    v2.forEach((prompt, index) => {
      const guided = v3[index]!;
      expect(guided.system).toBe(prompt.system);
      expect(guided.schemaKind).toBe(prompt.schemaKind);
      const lines = guided.user.split("\n");
      const kept = lines.filter((line) => prompt.user.split("\n").includes(line));
      expect(kept.join("\n")).toBe(prompt.user);
    });
  });

  it("expects the same output structure and provider schemas as prompt v2", () => {
    expect(titleWritingJsonSchemas(input(TITLE_WRITING_PROMPT_VERSION_V3))).toEqual(titleWritingJsonSchemas(input(TITLE_WRITING_PROMPT_VERSION_V2)));
    const v3 = input(TITLE_WRITING_PROMPT_VERSION_V3);
    expect(validateTitleWritingOutput("concept", JSON.stringify(concept), v3).ok).toBe(true);
    expect(validateTitleWritingOutput("outline", JSON.stringify(outline(3)), v3).ok).toBe(true);
    expect(validateTitleWritingOutput("episode:2", JSON.stringify(episode(2)), v3).ok).toBe(true);
    expect(validateTitleWritingOutput("outline", JSON.stringify({ ...outline(3), extra: "x" }), v3).ok).toBe(false);
  });
});

/** Every step of a run of `count` episodes, each episode with all earlier episodes as context. */
const everyStep = (frozen: TitleWritingFrozenInput, count: number, outlineSchema: string) => [
  buildTitleWritingPrompt("concept", frozen, {}),
  buildTitleWritingPrompt("outline", frozen, { concept }),
  ...Array.from({ length: count }, (_, index) => buildTitleWritingPrompt(`episode:${String(index + 1)}` as "episode:1", frozen, {
    concept, outline: { schema: outlineSchema, episodes: outline(count).episodes } as never,
    episodes: Array.from({ length: index }, (__, earlier) => ({ ...episode(earlier + 1), handoffFacts: [`f${String(earlier + 1)}`] })) as never[] })),
];

/**
 * sha256 of JSON.stringify(everyStep(...)) computed at 66b2bb9d91e1c2ad2efbaeb4d28420ee82d4dfea, before prompt v4
 * existed. Never regenerate these: a stored v1, v2 or v3 run must keep sending these exact prompts.
 */
const BEFORE_V4: Record<string, string> = {
  "v1": "2e26603f8040c3a1d5ea0aa93aa4b779d66bb2a54bf91f09d4a68290f1812597",
  "v2:1:60": "bbb6e7481afceae18e463d17ccd9149c2409289a14413c7ad8499c722c18dec6",
  "v2:1:90": "b862fad14f285bd19f2476112ed51f3d11f1600058b41e928ebe1ab0424b3d40",
  "v2:2:60": "c8e38d79d56cf0519fe5ceb60fc939a995522b0ac196dc2b5f992a57e622393f",
  "v2:2:90": "623af94070ca0f58f5e08003bdbc57ea2bd896c33933dfccdd45c27db669faf3",
  "v2:3:60": "f9860462d984b42499f23ce4f1650a49d1f98a52297eb1bfb59bf52ece701f83",
  "v2:3:90": "de76e8d396da420b953270d9b87f15798afcce32a3675e57a3a2692f23f643d2",
  "v2:4:60": "6248ff61012ed240d6bce7e8d8d2f785bdf67bab10db0dc94100998270c198d9",
  "v2:4:90": "69a787850e6166b3750a15316208c2377983482fca8d8712fd3076d5dd7dcad1",
  "v2:5:60": "13994fe379375036cedf0d0ac7d605ba8c5e33c7cb2358b77dd742c81638afb3",
  "v2:5:90": "ae6440ce74342345e49e0e4043a4de6c10fb05809bf75ecd6f44c94b63c8c735",
  "v2:6:60": "542e50bbbaf4ada29619d5a165368fd7e48cbfe858c89d04763539a5d08dea51",
  "v2:6:90": "70945b688319ae5e5a43a240dfce904ccf74382337c7315f12cf90dee2812d29",
  "v3:1:60": "cd8ce00c98abac80a974c97f1636e6afd44d38b2d9c19ee7f40a5187bfa94b9c",
  "v3:1:90": "91eea818492fd3384bca58bf858314607fd75fd49f7415cfb28bb672a0c796ec",
  "v3:2:60": "80ea7bd4b968823423fc2a741f1ccfe86f0054e7464d4e4a9da04a589a5c4bb1",
  "v3:2:90": "38f392c4c7a2c5c386efc65f2f844ec7fe155d2ff0fcd26adc8375d3b5b562f6",
  "v3:3:60": "516839bae9051d75bcaa4f5774dc58196b86848507fde1c1557ae67fd7488f92",
  "v3:3:90": "7dff9f94f2f875fb25548612e87bc1e2f5248b3a20e26d2bde592b1fa16cda33",
  "v3:4:60": "a34d1d2e7ffd2ee8144d7d9d47b9fc50a99ad386970eb1d540aa1e2aeaf12060",
  "v3:4:90": "7d34c6e3ddd63d48f99ac4f212e865fc19560236b8e0429885b9db5d40022fbb",
  "v3:5:60": "57f3e0c083a982f82b431850f30c2cdd08617bb76b22b17fa6689fe8650fa905",
  "v3:5:90": "fd74f8982972306470b36852024c457d3f5a5530ab08d3b65ebbb27935b53318",
  "v3:6:60": "b642322b2fd6c4eff8df8d980ef2c09f2480851a731c7b2906b9c901207adda8",
  "v3:6:90": "9be796088f741ffc1ae861024f958c673cb5c5a3ef3200d1296b05edbb8f27bf",
};

describe("stored v1, v2 and v3 runs keep their exact prompts after prompt v4", () => {
  it("builds every step of every episode count and duration byte for byte as before", () => {
    const v1: TitleWritingFrozenInput = { schema: TITLE_WRITING_INPUT_SCHEMA, promptVersion: TITLE_WRITING_PROMPT_VERSION, title: "夜班证词",
      settings: { episodeCount: 3, episodeSeconds: 90, style: "悬疑" }, providerKey: "qwen", model: "q-1" };
    expect(sha(JSON.stringify(everyStep(v1, 3, EPISODE_OUTLINE_SCHEMA)))).toBe(BEFORE_V4.v1);
    let checked = 1;
    for (const [label, version] of [["v2", TITLE_WRITING_PROMPT_VERSION_V2], ["v3", TITLE_WRITING_PROMPT_VERSION_V3]] as const) {
      for (let count = 1; count <= 6; count += 1) {
        for (const seconds of [60, 90]) {
          const key = `${label}:${String(count)}:${String(seconds)}`;
          const frozen: TitleWritingFrozenInput = { schema: TITLE_WRITING_INPUT_SCHEMA_V2, promptVersion: version, title: "夜班证词",
            settings: { episodeCount: count, episodeSeconds: seconds, style: seconds === 60 ? "" : "悬疑" }, providerKey: "qwen", model: "q-1" };
          const built = everyStep(frozen, count, EPISODE_OUTLINE_SCHEMA_V2);
          expect(sha(JSON.stringify(built)), key).toBe(BEFORE_V4[key]);
          for (const prompt of built) expect(prompt.user).not.toContain(TITLE_WRITING_PROMPT_VERSION_V4);
          checked += 1;
        }
      }
    }
    expect(checked).toBe(Object.keys(BEFORE_V4).length);
  });
});

describe("prompt v4 words the episode ending by position", () => {
  const episodePrompts = (count: number) => everyStep(input(TITLE_WRITING_PROMPT_VERSION_V4, count), count, EPISODE_OUTLINE_SCHEMA_V2)
    .slice(2).map((prompt) => prompt.user);
  const ENDING_QUESTION = "handoffFacts 包括本集结尾留下的、与主线相关的问题，以及下一集必须承接的事实。";
  const CLOSURE = "本集是全剧结局：收束主线冲突，回应故事策划里观众对整部剧的期待；不为后续剧情新留悬念或未解决的问题。";
  const ENDING_FACTS = "handoffFacts 记录结局事实：主线冲突如何收束、整部期待如何得到回应、主要人物的最终处境。";
  const FINAL_FIELDS = "handoffFacts[1-8]（本集结局事实：主线如何收束、整部期待如何回应）";

  const expectClosure = (text: string) => {
    expect(text).toContain(CLOSURE);
    expect(text).toContain(ENDING_FACTS);
    expect(text).toContain(FINAL_FIELDS);
    // Nothing in a final episode asks for a question or facts left to a next episode.
    expect(text).not.toContain("结尾留下的");
    expect(text).not.toContain("下一集必须");
  };
  const expectHandoff = (text: string) => {
    expect(text).toContain(ENDING_QUESTION);
    expect(text).toContain("handoffFacts[1-8]（下一集必须继承的事实）");
    expect(text).not.toContain(CLOSURE);
    expect(text).not.toContain(ENDING_FACTS);
    expect(text).not.toContain("本集结局事实");
  };

  it("a one-episode run closes the story in its only episode", () => {
    const [only] = episodePrompts(1);
    expect(only).toContain("这是全剧唯一的一集，要在本集内讲完核心冲突。");
    expectClosure(only!);
  });

  it("the last episode closes the story and every earlier episode keeps its ending question and handoff", () => {
    for (let count = 2; count <= 6; count += 1) {
      const texts = episodePrompts(count);
      texts.slice(0, -1).forEach((text) => expectHandoff(text));
      expect(texts.at(-1)).toContain(`这是最后一集（第 ${String(count)} 集），要收束核心冲突。`);
      expectClosure(texts.at(-1)!);
    }
  });

  it("keeps every other v3 line under the v4 heading; only ending field wording changes", () => {
    const relabel = (text: string) => text.replaceAll(TITLE_WRITING_PROMPT_VERSION_V3, TITLE_WRITING_PROMPT_VERSION_V4);
    const v3Handoff = "台词表达人物意图，不重复解释已经演出来的信息。handoffFacts 包括本集结尾留下的问题。";
    const v3Fields = "字段：title、screenplay、scenes[1-12]{heading,action,dialogue,sound}、handoffFacts[1-8]（下一集必须继承的事实）。没有对白或声音时填空字符串。";
    for (const count of [1, 3]) {
      const v3 = everyStep(input(TITLE_WRITING_PROMPT_VERSION_V3, count), count, EPISODE_OUTLINE_SCHEMA_V2);
      const v4 = everyStep(input(TITLE_WRITING_PROMPT_VERSION_V4, count), count, EPISODE_OUTLINE_SCHEMA_V2);
      // Concept stays unchanged; outline field wording distinguishes final closure from handoff.
      expect(v4[0]).toEqual({ ...v3[0], user: relabel(v3[0]!.user) });
      const oldOutlineFields = "每项字段：episodeNo、title、entryState（进入状态）、goal、action、turn（转折）、result、handoff（交给下一集的事实）。相邻集的 handoff 与下一集的 entryState 要能接上。";
      const newOutlineFields = "每项字段：episodeNo、title、entryState（进入状态）、goal、action、turn（转折）、result、handoff（本集结尾事实：非最后一集记录交给下一集的事实，最后一集记录主线如何收束；单集也是最后一集）。仅非最后一集的 handoff 与下一集的 entryState 要能接上。";
      expect(v4[1]).toEqual({ ...v3[1], user: relabel(v3[1]!.user).replace(oldOutlineFields, newOutlineFields) });
      expect(v4[1]!.user).not.toContain("handoff（交给下一集的事实）");
      expect(v4[1]!.user).toContain("最后一集写清主线问题如何收束");
      v4.slice(2).forEach((prompt, index) => {
        const final = index === count - 1;
        const kept = relabel(v3[index + 2]!.user).split("\n").filter((line) => line !== v3Handoff && (!final || line !== v3Fields));
        const lines = prompt.user.split("\n");
        // Every remaining v3 line is still there, in the same order.
        expect(lines.filter((line) => kept.includes(line))).toEqual(kept);
        expect(lines).not.toContain(v3Handoff);
        expect({ system: prompt.system, schemaKind: prompt.schemaKind }).toEqual({ system: v3[index + 2]!.system, schemaKind: "episode" });
      });
    }
  });

  it("expects the same output structure, provider schemas and validation as prompt v2 and v3", () => {
    for (const count of [1, 3, 6]) {
      expect(titleWritingJsonSchemas(input(TITLE_WRITING_PROMPT_VERSION_V4, count))).toEqual(titleWritingJsonSchemas(input(TITLE_WRITING_PROMPT_VERSION_V3, count)));
      expect(titleWritingJsonSchemas(input(TITLE_WRITING_PROMPT_VERSION_V4, count))).toEqual(titleWritingJsonSchemas(input(TITLE_WRITING_PROMPT_VERSION_V2, count)));
    }
    const v4 = input(TITLE_WRITING_PROMPT_VERSION_V4, 1);
    // A final answer still needs at least one handoffFacts item: the field stays required, only its wording changed.
    expect(validateTitleWritingOutput("episode:1", JSON.stringify(episode(1)), v4).ok).toBe(true);
    expect(validateTitleWritingOutput("episode:1", JSON.stringify({ ...episode(1), handoffFacts: [] }), v4).ok).toBe(false);
    expect(validateTitleWritingOutput("outline", JSON.stringify(outline(1)), v4).ok).toBe(true);
  });
});


describe("episode formatting respects frozen prompt semantics", () => {
  const oldText = (n: number) => `第 ${n} 集 t\n\ns\n\n场景\nh\n动作：a\n对白：无\n声音：无\n\n下一集需要继承的事实\n- f`;

  it.each([TITLE_WRITING_PROMPT_VERSION_V2, TITLE_WRITING_PROMPT_VERSION_V3])("keeps %s text byte-identical for every position", (version) => {
    for (let count = 1; count <= 6; count++) {
      for (let n = 1; n <= count; n++) expect(formatTitleEpisode(episode(n), input(version, count))).toBe(oldText(n));
    }
  });

  it("keeps v1 text byte-identical", () => {
    const frozen: TitleWritingFrozenInput = { ...input(TITLE_WRITING_PROMPT_VERSION_V2),
      schema: TITLE_WRITING_INPUT_SCHEMA, promptVersion: TITLE_WRITING_PROMPT_VERSION,
      settings: { episodeCount: 3, episodeSeconds: 90, style: "" } };
    for (const n of [1, 2, 3]) expect(formatTitleEpisode(episode(n), frozen)).toBe(oldText(n));
  });

  it("labels only v4 finales as closure without rewriting the creator's content", () => {
    for (let count = 1; count <= 6; count++) {
      for (let n = 1; n <= count; n++) {
        const draft = { ...episode(n), screenplay: "原文提到下一集需要继承的事实", handoffFacts: ["下一集需要继承的事实是原文"] };
        const text = formatTitleEpisode(draft, input(TITLE_WRITING_PROMPT_VERSION_V4, count));
        expect(text).toContain(n === count ? "\n本集结局事实\n- " : "\n下一集需要继承的事实\n- ");
        expect(text).toContain(draft.screenplay);
        expect(text).toContain(`- ${draft.handoffFacts[0]}`);
      }
    }
  });
});
