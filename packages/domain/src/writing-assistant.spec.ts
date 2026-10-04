import { describe, expect, it } from "vitest";
import { DomainError } from "./errors";
import {
  WRITING_IMPORT_MAX_BYTES,
  WRITING_PROMPT_VERSION,
  buildEpisodeDraftInstruction,
  buildStoryPlanInstruction,
  canAdopt,
  formatEpisodeDraft,
  formatStoryPlan,
  freezeWritingContext,
  parseWritingImport,
  type EpisodeDraftCandidate,
  type StoryPlanCandidate,
  type WritingTargetSnapshot,
} from "./writing-assistant";

function episode(episodeNo: 1 | 2 | 3) {
  return {
    episodeNo,
    entryState: `进入${episodeNo}`,
    goal: `目标${episodeNo}`,
    action: `行动${episodeNo}`,
    turn: `转折${episodeNo}`,
    result: `结果${episodeNo}`,
    handoff: `交接${episodeNo}`,
  };
}

/** Handwritten fixture. This is not a model result. */
const storyPlan: StoryPlanCandidate = {
  schema: "ads.writing.story-plan.v1",
  logline: "手写测试候选，不是模型结果",
  protagonistGoal: "守住班次记录",
  opposition: "店长能改时间",
  coreConflict: "解释会被当成承认",
  relationships: [{ name: "店员", pressure: "不能供出同事" }],
  episodes: [episode(1), episode(2), episode(3)],
};

/** Handwritten fixture. This is not a model result. */
function episodeDraft(episodeNo: 1 | 2 | 3): EpisodeDraftCandidate {
  return {
    schema: "ads.writing.episode-draft.v1",
    episodeNo,
    title: "夜班",
    screenplay: "店员把记录按在柜台上。\n店长：你自己看时间。",
    scenes: [{ heading: "店内", action: "她没有松手", dialogue: "店长：你自己看时间。", sound: "[SFX] 冰柜嗡鸣" }],
    handoffFacts: ["记录仍被按在柜台上"],
  };
}

const storyRequest = {
  premise: "夜班便利店",
  genre: "悬疑",
  audience: "成人",
  characters: "店员，店长",
  mustKeep: "班次记录是真的",
  mustNotChange: "不改结局的记录归属",
  currentText: "原来的故事",
};

const target: WritingTargetSnapshot = {
  projectId: "project-1",
  entityKey: "story",
  mode: "story",
  episodeNo: null,
  sourceRevisionId: "story-1",
  ifMatch: 3,
  draftFingerprint: "draft-a",
  currentText: "原来的故事",
  loaded: true,
};

describe("writing instructions", () => {
  it("repeats the same story instruction, including the template version", () => {
    const first = buildStoryPlanInstruction(storyRequest);
    expect(buildStoryPlanInstruction(storyRequest)).toBe(first);
    expect(first).toContain(WRITING_PROMPT_VERSION);
    expect(first).toContain("模式：故事策划");
    expect(first).toContain("不强制每一集使用相同的反转");
    expect(first).not.toContain("局部修改保留没有点名的段落");
  });

  it("uses episode rules for the selected episode", () => {
    const instruction = buildEpisodeDraftInstruction({
      episodeNo: 2,
      premise: "夜班便利店",
      confirmedStory: "第一集结束时记录还在",
      currentText: "第二集原文",
      revisionRequest: "只改开场",
      mustKeep: "记录还在",
      mustKeepDialogue: "你自己看时间",
      mustKeepEnding: "她没有交出记录",
    });
    expect(instruction).toContain(WRITING_PROMPT_VERSION);
    expect(instruction).toContain("模式：单集写作");
    expect(instruction).toContain("当前集：第 2 集");
    expect(instruction).toContain("对白承担人物行动");
    expect(instruction).toContain("局部修改保留没有点名的段落");
    expect(instruction).toContain("不是平台审核结论");
  });
});

describe("writing import", () => {
  it("rejects illegal JSON, unknown fields, the wrong episode, unsafe text, and oversized files", () => {
    const storyBytes = new TextEncoder().encode(JSON.stringify(storyPlan));
    expect(parseWritingImport(storyBytes, { mode: "story", episodeNo: null }).mode).toBe("story");
    expect(() => parseWritingImport(new TextEncoder().encode("{"), { mode: "story", episodeNo: null })).toThrowError(
      expect.objectContaining({ code: "WRITING_INVALID_JSON" }),
    );
    expect(() => parseWritingImport(new TextEncoder().encode(JSON.stringify({ ...storyPlan, projectId: "x" })), { mode: "story", episodeNo: null })).toThrowError(
      expect.objectContaining({ code: "WRITING_INVALID_CANDIDATE" }),
    );
    expect(() => parseWritingImport(new TextEncoder().encode(JSON.stringify(episodeDraft(2))), { mode: "episode", episodeNo: 1 })).toThrowError(
      expect.objectContaining({ code: "WRITING_EPISODE_MISMATCH" }),
    );
    expect(() => parseWritingImport(new TextEncoder().encode(JSON.stringify({ ...storyPlan, logline: "看 <b>这里</b>" })), { mode: "story", episodeNo: null })).toThrowError(
      expect.objectContaining({ code: "WRITING_UNSAFE_CONTENT" }),
    );
    expect(() => parseWritingImport(new Uint8Array(WRITING_IMPORT_MAX_BYTES + 1), { mode: "story", episodeNo: null })).toThrowError(
      expect.objectContaining({ code: "WRITING_TOO_LARGE" }),
    );
  });

  it("formats a story plan and refuses an episode draft that would exceed the editor", () => {
    const text = formatStoryPlan(storyPlan);
    expect(text).toContain("一句话故事");
    expect(text).toContain("第 1 集");
    expect(text).toContain("第 3 集");
    expect(formatStoryPlan(storyPlan)).toBe(text);
    const huge = episodeDraft(1);
    huge.screenplay = "戏".repeat(12_000);
    huge.scenes = Array.from({ length: 12 }, () => ({
      heading: "场".repeat(20),
      action: "动".repeat(400),
      dialogue: "白".repeat(400),
      sound: "声".repeat(120),
    }));
    huge.handoffFacts = Array.from({ length: 8 }, () => "事".repeat(200));
    expect(() => formatEpisodeDraft(huge)).toThrowError(expect.objectContaining({ code: "WRITING_TOO_LARGE" }));
    try {
      formatEpisodeDraft(huge);
    } catch (caught) {
      expect(caught).toBeInstanceOf(DomainError);
      expect((caught as DomainError).message).toContain("没有截断");
    }
  });
});

describe("adoption guard", () => {
  it("keeps the frozen If-Match and blocks a changed draft", () => {
    const frozen = freezeWritingContext(target, "input-a");
    expect(frozen.ifMatch).toBe(3);
    expect(canAdopt(frozen, target, "input-a")).toEqual({ ok: true });
    const moved = canAdopt(frozen, { ...target, ifMatch: 9 }, "input-a");
    expect(moved.ok).toBe(false);
    if (!moved.ok) expect(moved.differences.join(" ")).toContain("If-Match");
    const edited = canAdopt(frozen, { ...target, draftFingerprint: "draft-b" }, "input-a");
    expect(edited.ok).toBe(false);
    expect(frozen.ifMatch).toBe(3);
  });
});
