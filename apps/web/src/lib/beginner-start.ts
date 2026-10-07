/** Pure helpers for the beginner start page. Nothing here calls a model or the server. */

/**
 * A title suggestion by rule: the first clause of the idea, at most 12 characters. It is offered for the user to
 * accept or edit, and the page says it was cut from their own words, not generated.
 */
export function suggestTitle(idea: string): string {
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

export const START_SCOPE_NOTE = "当前是试制范围：每部作品固定三集、竖屏 9:16。素材是演示素材，不是真实 AI 拍摄。";
