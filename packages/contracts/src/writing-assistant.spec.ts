import { describe, expect, it } from "vitest";
import { episodeDraftCandidateSchema, storyPlanCandidateSchema } from "./writing-assistant";

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

const story = {
  schema: "ads.writing.story-plan.v1",
  logline: "手写测试候选，不是模型结果",
  protagonistGoal: "守住班次记录",
  opposition: "店长能改时间",
  coreConflict: "解释会被当成承认",
  relationships: [{ name: "店员", pressure: "不能供出同事" }],
  episodes: [episode(2), episode(1), episode(3)],
};

describe("writing candidate contracts", () => {
  it("accepts a three-episode story plan and rejects duplicates or unknown fields", () => {
    expect(storyPlanCandidateSchema.parse(story).episodes.map((item) => item.episodeNo).sort()).toEqual([1, 2, 3]);
    expect(storyPlanCandidateSchema.safeParse({
      ...story,
      episodes: [episode(1), episode(1), episode(2)],
    }).success).toBe(false);
    expect(storyPlanCandidateSchema.safeParse({ ...story, projectId: "project-1" }).success).toBe(false);
    expect(storyPlanCandidateSchema.safeParse({ ...story, reviewStatus: "APPROVED" }).success).toBe(false);
  });

  it("rejects an over-long screenplay instead of trimming it", () => {
    const draft = {
      schema: "ads.writing.episode-draft.v1",
      episodeNo: 1,
      title: "手写测试候选",
      screenplay: "戏".repeat(12_001),
      scenes: [{ heading: "店内", action: "她按下暂停", dialogue: "", sound: "" }],
      handoffFacts: ["监控停在九点"],
    };
    expect(episodeDraftCandidateSchema.safeParse(draft).success).toBe(false);
    expect(episodeDraftCandidateSchema.safeParse({ ...draft, screenplay: "她按下暂停。", ifMatch: 4 }).success).toBe(false);
  });
});
