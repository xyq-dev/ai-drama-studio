import { describe, expect, it, vi } from "vitest";
import { runWithStoreCreatorAccess } from "@ai-drama/database";
import { chooseCreatorSkill, targetsOtherEpisode } from "./creator-assistant-intent";
import { CreatorAssistantController } from "./creator-assistant.controller";

const projectId = "23456789-2345-4234-8234-234567890abc";
const scope = { kind: "scoped", ownerAccountId: "creator-1", actorId: "creator:creator-1" } as const;

describe("creator assistant", () => {
  it("keeps the selected episode fixed and treats dialogue and story references as content", () => {
    expect(targetsOtherEpisode("请把第 ２ 集拆成分镜", 1)).toBe(true);
    expect(targetsOtherEpisode("续写第十二集", 12)).toBe(false);
    expect(targetsOtherEpisode("把这句改成「写第二集」", 1)).toBe(false);
    expect(targetsOtherEpisode("让本集承接第二集的结尾", 3)).toBe(false);
  });
  it.each([
    ["请把下一集剧本改短", 1], ["帮我润色一下上一集的对白", 3], ["请优化第二集的台词", 1],
    ["把第一集和第二集的台词改自然", 1], ["分别修改第一集与第二集的台词", 1],
    ["调整第 １、２ 集的台词", 1], ["检查本集及下集的成片", 2],
  ] as const)("blocks a relative or coordinated target: %s", (command, current) => {
    expect(targetsOtherEpisode(command, current)).toBe(true);
  });
  it.each([
    "参考第一集和第二集的语气，改本集的台词", "让本集承接上一集结尾", "不要修改第一集，请润色第三集",
    "上一集里司机离开了，这集把对白写得自然点", "把这句改成“下一集见”", "调整第３集里的台词",
  ])("keeps references and negated targets in the current episode: %s", (command) => {
    expect(targetsOtherEpisode(command, 3)).toBe(false);
  });
  it("routes single actions across stages and asks for a choice for unrelated or compound tasks", () => {
    expect(chooseCreatorSkill("帮我把公交站这场拆成分镜", "script")).toBe("short-drama-storyboard");
    expect(chooseCreatorSkill("把司机这句对白改自然一点", "storyboard")).toBe("short-drama-write");
    expect(chooseCreatorSkill("帮我检查这集有没有黑屏和静音", "script")).toBe("qc-skill");
    expect(chooseCreatorSkill("别改剧本，帮我看看成片", "script")).toBe("qc-skill");
    expect(chooseCreatorSkill("台词润色一下，改成「不要拆分镜」", "script")).toBe("short-drama-write");
    expect(chooseCreatorSkill("这一句更口语点", "script")).toBe("short-drama-write");
    expect(chooseCreatorSkill("先改剧本，再拆分镜", "script")).toBeNull();
    expect(chooseCreatorSkill("今天的天气", "export")).toBeNull();
  });

  it("checks the signed-in owner's scope before resolving, and a disabled skill cannot be forced", async () => {
    const project = { getProject: vi.fn().mockResolvedValue({}) };
    const features = { skillEnabled: vi.fn().mockResolvedValue(false) };
    const ctrl = new CreatorAssistantController(project, features);
    const response = { status: vi.fn() };
    const input = { stage: "script", command: "改一下", skill: "short-drama-write" };
    const result = await runWithStoreCreatorAccess(scope, () => ctrl.resolve(projectId, input, response));
    expect(project.getProject).toHaveBeenCalledWith(projectId, "creator-1");
    expect(features.skillEnabled).toHaveBeenCalledWith("short-drama-write");
    expect(response.status).toHaveBeenCalledWith(409);
    expect(result).toMatchObject({ error: { code: "CREATOR_SKILL_DISABLED" } });
    project.getProject.mockRejectedValueOnce(new Error("not found"));
    features.skillEnabled.mockClear();
    await expect(ctrl.resolve(projectId, input, response)).rejects.toThrow("not found");
    expect(features.skillEnabled).not.toHaveBeenCalled();
  });

  it("refuses a cross-episode action before choosing the explicitly requested skill", async () => {
    const project = { getProject: vi.fn().mockResolvedValue({}) };
    const features = { skillEnabled: vi.fn().mockResolvedValue(true) };
    const response = { status: vi.fn() };
    const ctrl = new CreatorAssistantController(project, features);
    const result = await ctrl.resolve(projectId, { stage: "script", episodeNo: 1,
      command: "把第一集和第二集的台词改自然", skill: "short-drama-write" }, response);
    expect(response.status).toHaveBeenCalledWith(409);
    expect(result).toMatchObject({ error: { code: "CREATOR_SKILL_EPISODE_MISMATCH" } });
    expect(features.skillEnabled).not.toHaveBeenCalled();
  });

  it("requires a supported request and leaves ambiguity side effect free", async () => {
    const project = { getProject: vi.fn().mockResolvedValue({}) };
    const features = { skillEnabled: vi.fn().mockResolvedValue(true) };
    const ctrl = new CreatorAssistantController(project, features);
    const response = { status: vi.fn() };
    await expect(ctrl.resolve(projectId, { stage: "export", command: "请帮我", remoteTool: "x" }, response)).rejects.toThrow();
    expect(await ctrl.resolve(projectId, { stage: "export", command: "请帮我" }, response)).toEqual({ skill: null, instruction: "请帮我" });
    expect(features.skillEnabled).not.toHaveBeenCalled();
  });
});
