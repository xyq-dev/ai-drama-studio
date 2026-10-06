// Editorial starting points for this product, not an external platform's official taxonomy.
export const CATEGORIES = [
  { id: "ROMANCE", name: "爱情情感", description: "以亲密关系和情感选择为主线，让人物在相遇、失去与重逢中发生改变。", prompt: "两个人最想靠近彼此的时候，什么让他们不得不分开？", recommended: ["relation-0", "relation-1", "mechanism-6", "tone-3"] },
  { id: "RISE_GROWTH", name: "逆袭成长", description: "从低谷出发，用具体的目标、代价与行动，呈现人物一步步完成自我突破。", prompt: "一个不被看好的人，要付出什么代价才能赢得第一次机会？", recommended: ["mechanism-2", "mechanism-14", "character-3", "tone-1"] },
  { id: "FAMILY", name: "家庭伦理", description: "围绕家庭责任、代际关系与日常选择，讲述有温度也有冲突的亲情故事。", prompt: "一家人共同保守的秘密，会在怎样的一次团聚中被揭开？", recommended: ["relation-4", "relation-8", "character-9", "tone-5"] },
  { id: "URBAN_REALITY", name: "都市现实", description: "在工作、生活和社会关系中寻找戏剧冲突，关注普通人的处境与改变。", prompt: "生活即将失去平衡时，主人公会坚持哪一件看似不值得的事？", recommended: ["background-0", "background-6", "character-8", "tone-5"] },
  { id: "SUSPENSE_CRIME", name: "悬疑罪案", description: "以谜题和线索推动情节，在有限信息中构建动机、误导与最终揭晓。", prompt: "所有人都相信的证据，为什么只有主人公觉得不对劲？", recommended: ["mechanism-12", "niche-6", "mechanism-8", "tone-2"] },
  { id: "COMEDY", name: "喜剧轻喜", description: "让人物的欲望与现实错位，通过性格碰撞、情境升级和反差制造幽默。", prompt: "一个想尽快解决的小麻烦，怎样被越帮越忙的朋友变成大事件？", recommended: ["relation-2", "mechanism-5", "mechanism-9", "tone-4"] },
  { id: "XUANHUAN", name: "玄幻修仙", description: "在有明确规则的修行世界中，讲述力量、信念和代价之间的抉择。", prompt: "获得突破的唯一办法，为什么恰好违背了主人公的承诺？", recommended: ["background-10", "relation-6", "mechanism-14", "tone-1"] },
  { id: "FANTASY", name: "奇幻脑洞", description: "用一个不寻常的设定打开故事，再让人物面对真实而具体的情感难题。", prompt: "如果每天都能交换一种人生，主人公最舍不得失去的是什么？", recommended: ["background-11", "mechanism-9", "character-11", "tone-3"] },
  { id: "SCI_FI", name: "科幻未来", description: "从科技变化提出问题，探索未来社会、人类关系与个人选择的可能性。", prompt: "一项本为解决孤独的技术，为什么让主人公更难相信身边的人？", recommended: ["background-3", "mechanism-11", "character-11", "tone-2"] },
  { id: "ACTION_ADVENTURE", name: "动作冒险", description: "以任务、危险和时限组织情节，让外部行动与人物内在变化相互推动。", prompt: "最后一次撤离之前，主人公为什么决定返回最危险的地方？", recommended: ["mechanism-13", "niche-7", "relation-9", "tone-1"] },
  { id: "HISTORICAL_INTRIGUE", name: "历史权谋", description: "在时代与权力关系中建立人物处境，用选择、博弈和后果展开故事。", prompt: "一封送错的密信，会迫使谁在忠诚与家人之间作出选择？", recommended: ["background-1", "mechanism-8", "relation-7", "character-10"] },
  { id: "YOUTH_CAMPUS", name: "青春校园", description: "记录成长中的友谊、理想与第一次抉择，让小事件承载真实的青春情绪。", prompt: "毕业前最后一个约定，会让哪两个渐行渐远的朋友重新并肩？", recommended: ["background-4", "relation-5", "relation-3", "tone-0"] },
] as const;

export const TAG_GROUPS = [
  { id: "background", name: "背景标签", description: "时代、地域、场景等", color: "pink", icon: "globe", tags: ["现代都市", "古代架空", "民国年代", "未来世界", "校园生活", "乡村小镇", "职场商圈", "豪门世家", "江湖武林", "末日废土", "仙侠世界", "异域空间"] },
  { id: "mechanism", name: "剧情机制", description: "主线、冲突、反转等", color: "orange", icon: "script", tags: ["重生", "穿越", "逆袭", "复仇", "身份反转", "误会解开", "先婚后爱", "契约关系", "真假身份", "命运互换", "系统任务", "循环时空", "探案解谜", "追逐逃生", "成长觉醒", "守护救赎"] },
  { id: "character", name: "人物设定", description: "主角、配角、人设等", color: "blue", icon: "person", tags: ["强女主", "成长型主角", "双强主角", "草根小人物", "隐藏高手", "冷面精英", "反派主角", "天才少年", "职场新人", "单亲父母", "群像人物", "非人主角"] },
  { id: "relation", name: "关系情感", description: "人物关系、情感类型等", color: "purple", icon: "heart", tags: ["甜宠爱情", "破镜重圆", "欢喜冤家", "暗恋成真", "亲情羁绊", "友情陪伴", "师徒传承", "宿敌对决", "家庭和解", "并肩成长"] },
  { id: "niche", name: "细分题材", description: "更具体的题材方向", color: "green", icon: "grid", tags: ["商战博弈", "医疗救援", "竞技体育", "美食经营", "文化传承", "乡村创业", "刑侦推理", "密室求生"] },
  { id: "tone", name: "情绪风格", description: "情绪基调、叙事风格等", color: "violet", icon: "smile", tags: ["轻松治愈", "高燃热血", "紧张悬疑", "浪漫唯美", "荒诞幽默", "现实质感"] },
] as const;

export const TAGS = TAG_GROUPS.flatMap((group) => group.tags.map((name, index) => ({ id: `${group.id}-${index}`, name, groupId: group.id, groupName: group.name })));
export const DIRECTION_STORAGE_KEY = "ads-creative-direction:v1";
export type Category = typeof CATEGORIES[number];
export type DirectionDraft = { version: 1; categoryId: string | null; tagIds: string[] };
export const EMPTY_DIRECTION: DirectionDraft = { version: 1, categoryId: null, tagIds: [] };

export function parseDirectionDraft(raw: string): DirectionDraft | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const draft = value as Record<string, unknown>;
    if (draft.version !== 1 || (draft.categoryId !== null && !CATEGORIES.some((item) => item.id === draft.categoryId))) return null;
    if (!Array.isArray(draft.tagIds) || draft.tagIds.length > TAGS.length || !draft.tagIds.every((id) => typeof id === "string" && TAGS.some((tag) => tag.id === id))) return null;
    return { version: 1, categoryId: draft.categoryId as string | null, tagIds: [...new Set(draft.tagIds as string[])] };
  } catch { return null; }
}

export function matchesSearch(query: string, ...values: string[]): boolean {
  const words = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  const text = values.join(" ").toLocaleLowerCase();
  return words.every((word) => text.includes(word));
}

export function formatCreativeDirection(draft: DirectionDraft): string {
  const category = CATEGORIES.find((item) => item.id === draft.categoryId);
  const groups = TAG_GROUPS.map((group) => {
    const names = TAGS.filter((tag) => tag.groupId === group.id && draft.tagIds.includes(tag.id)).map((tag) => tag.name);
    return names.length ? `${group.name}：${names.join("、")}` : null;
  }).filter(Boolean);
  return [`创作方向：${category?.name ?? "尚未选择题材"}`, ...groups, "请围绕以上方向完善人物、核心冲突与故事梗概。"].join("\n");
}
