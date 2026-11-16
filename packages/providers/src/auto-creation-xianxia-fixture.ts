import {
  AUTO_CREATION_BIBLE_SCHEMA,
  AUTO_CREATION_DIRECTIONS_SCHEMA,
  AUTO_CREATION_EPISODE_SCHEMA,
  AUTO_CREATION_OUTLINE_SCHEMA,
  type AutoBible,
  type AutoDirections,
  type AutoEpisode,
  type AutoOutline,
} from "@ai-drama/contracts";

const TITLE = "留灯还水";
const PREMISE = "守灯弟子沈禾发现宗门扣住山下的水，必须以放弃内门名额为代价重开水脉。";
const ENDING = "水流回山下，沈禾还了宗门的名牌，与许婆回外院守灯。";
const MARKER = "井壁深处传来三声空响";

export const AUTO_XIANXIA_STORY_PROSE = [
  `外院收灯前，沈禾提着铜灯去查看废井，${MARKER}。许婆把一只空陶碗递给他，说山下的水缸也响成了这样。沈禾摸到井沿一块松动的旧砖，拨开灰土，认出压在里面的旧引水符。那道平时朝着村口的朱纹，今晚却逆着水声亮了起来。`,
  "沈禾提灯下到水脉边，照见干渠另一侧藏着一股活水。陆监事赶来按住封签，只说这股水得先温养内门的灵田。只要沈禾装作没见过，内门名牌明早便能送来。沈禾把许婆的空碗放进渠里，碗底连一点湿气也没沾上。他转身去找刻在符背的旧誓，终于知道渠道不是枯了，而是被引到了别处。",
  "旧誓写着，守灯人交还名牌，便有权翻转引水符，代宗门把这笔欠下的水还给山下。沈禾当着陆监事的面解下名牌，将名字朝上放在封签旁。他的手被湿冷的石头冻得发僵，仍把符一点点按回原来的朱纹。先是陶碗里浮起泥屑，接着水冲开了淤塞的渠口。许婆端起满碗，沈禾没有去捡那块名牌，只提灯与她一同走回外院。",
];

export function fixtureAutoXianxiaDirections(): AutoDirections {
  const base = { protagonist: "守灯弟子沈禾", goal: "重开水脉", obstacle: "陆监事封住旧渠", stakes: "山下断水，沈禾可能失去入内门的资格",
    coreEmotion: "以舍换得", differentiation: "把修行资格和还水的选择绑在一张旧引水符上", difficultyNote: "灯、渠口和陶碗可拍",
    audienceFit: "舍弃入门资格换回山下泉水的抉择值得试读，待验证 H1", evidenceIds: ["H1"] };
  return { schema: AUTO_CREATION_DIRECTIONS_SCHEMA, candidates: [
    { ...base, id: "D1", title: TITLE, logline: PREMISE, productionDifficulty: "low",
      ratings: { audienceFit: 5, conflictStrength: 5, originality: 4, feasibility: 5, constraintFit: 5 } },
    { ...base, id: "D2", title: "守镜人", logline: "试炼弟子为守住故乡的倒影，主动打破用来争夺师门排名的古镜。",
      protagonist: "试炼弟子纪明", goal: "守住故乡倒影", obstacle: "古镜不容弟子带走", stakes: "故乡会从宗册上消失", productionDifficulty: "medium",
      ratings: { audienceFit: 3, conflictStrength: 3, originality: 4, feasibility: 3, constraintFit: 4 } },
  ] };
}

export function fixtureAutoXianxiaBible(): AutoBible {
  return {
    schema: AUTO_CREATION_BIBLE_SCHEMA, title: TITLE, logline: PREMISE,
    synopsis: "模型替身样例：沈禾发现外门灵井的水被截给内门灵田。他遵循旧誓，交还名牌翻转引水符，换来山下重新得水。",
    story: {
      protagonistId: "C1", desire: "取得内门名额后让同门承认自己", weakness: "习惯把禁令当成理所当然",
      goal: "让山下重新得水", stakes: "山下人无水可用，自己要放弃内门名额", obstacles: ["陆监事扣下封签", "沈禾不敢舍弃名额"],
      keyChoices: [{ choice: "当着陆监事交还名牌、翻转旧引水符", consequence: "山下水渠重新得水，沈禾留在外院" }],
      twist: { reveal: "井水被私自改道，旧誓允许守灯人将它引回山下", setups: ["井壁有朝反方向发亮的朱纹", "许婆带来干透的陶碗"] },
      payoffs: ["沈禾主动说出自己要放弃名额，践行守灯人的旧誓"], ending: ENDING,
      causalChain: ["陆监事让水脉改道", "沈禾循井声发现旧引水符", "沈禾归还名牌翻转旧符", "山下重新得水"],
    },
    characters: [
      { id: "C1", name: "沈禾", identity: "外院守灯弟子", goal: "让山下得水", weakness: "敬畏宗门禁令", motivation: "不愿辜负山下人", voice: "先沉默再直说", presence: "on_screen" },
      { id: "C2", name: "陆监事", identity: "管内门灵田的监事", goal: "把水留给内门", weakness: "只看门内功绩", motivation: "保住灵田收成", voice: "语气短促", presence: "on_screen" },
      { id: "C3", name: "许婆", identity: "山下村民", goal: "给村民找水", weakness: "力有未逮", motivation: "水缸见底", voice: "用家常器物说话", presence: "on_screen" },
    ],
    relationships: [{ from: "C1", to: "C2", relation: "守灯弟子和宗门上司", change: "从服从禁令到当面行使旧誓" }],
    locations: [
      { id: "L1", name: "宗门外院", intExt: "EXT", timeOfDay: "夜", layout: "废井与铜灯并排", productionNotes: "用灯光照出旧砖" },
      { id: "L2", name: "地下水脉", intExt: "INT", timeOfDay: "夜", layout: "封签刻在两条反向水渠交界", productionNotes: "可拍碗底干湿变化" },
    ],
    props: [{ id: "P1", name: "旧引水符", ownerId: "C1", purpose: "切换活水流向", change: "由逆向亮转为顺向亮" }],
  };
}

const BEATS = [
  { locationId: "L1", characterIds: ["C1", "C3"], action: `模型替身样例：${MARKER}。沈禾把铜灯移到井沿，许婆递来干碗。`, line: "山下的水缸也响成了这样。", characterId: "C3", fact: "许婆的碗是干的，沈禾听见了废井里的空响。" },
  { locationId: "L1", characterIds: ["C1"], action: "沈禾抽出松动的旧砖，朝着村口的朱纹逆着水声发亮。", line: "水为什么往回走？", characterId: "C1", fact: "井沿下藏着朝反方向亮的旧引水符。" },
  { locationId: "L2", characterIds: ["C1", "C2"], action: "沈禾把干碗放在村渠里，陆监事以袖遮住通往内门的活水。", line: "你想要进内门，就别管这个渠。", characterId: "C2", fact: "陆监事把活水截给了内门灵田。" },
  { locationId: "L2", characterIds: ["C1"], action: "沈禾把旧符翻面，举灯照见守灯人可以还水的旧誓。", line: "交还名牌，就能翻符。", characterId: "C1", fact: "只有交还名牌的守灯人有权翻转旧引水符。" },
  { locationId: "L2", characterIds: ["C1", "C2"], action: "沈禾把名牌放回封签旁，按住旧符翻回正面。", line: "我的名字在这儿，水要回山下。", characterId: "C1", fact: "沈禾当着陆监事交还名牌，翻转旧引水符。" },
  { locationId: "L1", characterIds: ["C1", "C3"], action: "水从废井旁的渠口涌出，许婆举起满碗，沈禾提灯和她并肩离开。", line: "等水先把下面的缸续上。", characterId: "C1", fact: ENDING },
] as const;

function episodeBeats(episodeNo: number, count: number) {
  const boundary = (episode: number) => Math.floor(episode * BEATS.length / count);
  return BEATS.slice(boundary(episodeNo - 1), boundary(episodeNo));
}

export function fixtureAutoXianxiaOutline(count: number): AutoOutline {
  return { schema: AUTO_CREATION_OUTLINE_SCHEMA, episodes: Array.from({ length: count }, (_, index) => {
    const episodeNo = index + 1;
    const beats = episodeBeats(episodeNo, count);
    return { episodeNo, title: count === 1 ? TITLE : `${TITLE}（${String(episodeNo)}）`, opening: beats[0]!.action,
      goal: "让水流回山下", obstacle: "宗门的内门规则和水道封签", action: beats.map(beat => beat.action).join("").slice(0, 150),
      turn: beats.at(-1)!.action, result: beats.at(-1)!.fact, newInformation: beats[0]!.fact,
      emotionShift: episodeNo === count ? "舍弃之后的平静" : "困惑转为下定决心", handoff: beats.at(-1)!.fact,
      characterIds: [...new Set(beats.flatMap(beat => [...beat.characterIds]))], locationIds: [...new Set(beats.map(beat => beat.locationId))] };
  }), resolution: ENDING };
}

export function fixtureAutoXianxiaEpisode(episodeNo: number, count: number, seconds: number): AutoEpisode {
  const beats = episodeBeats(episodeNo, count);
  const grouped: Array<Array<(typeof beats)[number]>> = [];
  for (const beat of beats) {
    const previous = grouped.at(-1);
    if (previous?.[0]?.locationId === beat.locationId) previous.push(beat);
    else grouped.push([beat]);
  }
  const perScene = Math.round(seconds / grouped.length);
  const shots = Math.ceil(perScene / 15);
  return { schema: AUTO_CREATION_EPISODE_SCHEMA, episodeNo, title: TITLE,
    scenes: grouped.map((scene, index) => ({ sceneNo: index + 1, locationId: scene[0]!.locationId, timeOfDay: "夜",
      characterIds: [...new Set(scene.flatMap(beat => [...beat.characterIds]))], action: scene.map(beat => beat.action).join(""),
      dialogue: scene.map(beat => ({ characterId: beat.characterId, line: beat.line, delivery: "" })), sound: "", assetNeeds: [],
      shots: Array.from({ length: shots }, (_, shotIndex) => ({ shotNo: shotIndex + 1, framing: "中景", description: scene[0]!.action,
        seconds: Math.min(15, perScene - shotIndex * 15) })) })),
    handoffFacts: [beats.at(-1)!.fact] };
}
