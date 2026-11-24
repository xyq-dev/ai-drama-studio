import { LIMITS } from "./studio-model";
import { TITLE_WRITING_DEFAULT_EPISODE_COUNT, TITLE_WRITING_MAX_EPISODES } from "@ai-drama/contracts";

/** Pure helpers for the beginner start page. Nothing here calls a model or the server. */

/** Prefer an explicit Chinese book title, otherwise suggest a short opening clause. */
export function suggestTitle(idea: string): string {
  const named = Array.from(idea.matchAll(/《([^《》\n]+)》/gu), (match) => match[1]!.trim()).find(Boolean);
  if (named) return named.slice(0, LIMITS.title).replace(/[\uD800-\uDBFF]$/u, "");
  const first = idea.trim().split(/[。！？!?\n，,；;：:、]/u)[0]?.trim() ?? "";
  const characters = Array.from(first);
  return characters.length <= 12 ? first : `${characters.slice(0, 12).join("")}…`;
}

/** Static examples. They are labelled as templates on the page and only fill the input; nothing is created. */
export const IDEA_TEMPLATES: ReadonlyArray<{ id: string; label: string; idea: string }> = [
  { id: "night-shift", label: "都市悬疑", idea: "夜班便利店店员发现班次记录被人改过，所有证据都指向她自己。" },
  { id: "return-home", label: "家庭情感", idea: "在外打拼十年的女儿回到老家，发现母亲一直瞒着她卖掉了老房子。" },
  { id: "rival-chef", label: "职场逆袭", idea: "被赶出后厨的年轻厨师，在对面开了一家只卖一道菜的小店。" },
];

export const START_SCOPE_NOTE = "短篇作品可选 1–6 集，竖屏 9:16。素材是演示素材，不是真实 AI 拍摄。";

export const SHORT_EPISODE_COUNTS = Array.from({ length: TITLE_WRITING_MAX_EPISODES }, (_, index) => index + 1);

/** Keep the legacy three-episode request shape so an unfinished create can replay its original key. */
export function manualProjectInput(title: string, premise: string, episodeCount: number) {
  return episodeCount === TITLE_WRITING_DEFAULT_EPISODE_COUNT
    ? { title, premise }
    : { title, premise, episodeCount, targetEpisodeSeconds: 60 };
}
