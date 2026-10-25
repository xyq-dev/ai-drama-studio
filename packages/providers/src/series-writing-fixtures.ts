import {
  SERIES_ARC_SCHEMA,
  SERIES_BATCH_REVIEW_DIMENSIONS,
  SERIES_BATCH_REVIEW_SCHEMA,
  SERIES_EPISODE_SCHEMA,
  SERIES_FINAL_REVIEW_DIMENSIONS,
  SERIES_FINAL_REVIEW_SCHEMA,
  SERIES_OUTLINE_SCHEMA,
  SERIES_PLAN_REVIEW_DIMENSIONS,
  SERIES_PLAN_REVIEW_SCHEMA,
  SERIES_SETTING_SCHEMA,
  seriesOutlineRange,
  type SeriesArc,
  type SeriesEpisode,
  type SeriesOutline,
  type SeriesOutlineEpisode,
  type SeriesSetting,
} from "@ai-drama/contracts";
import { autoFixtureAnswer, autoFixtureStageOf, type AutoFixturePlan } from "./auto-creation-fixtures";
import { ANTHROPIC_MESSAGES_URL, DEEPSEEK_CHAT_COMPLETIONS_URL, type WritingTransport } from "./text-writing";

/**
 * Controllable model double for series writing (tests and stubbed acceptances only; the runtime never wires it). Every
 * text is the double's synthetic sample. The world is fixed: three people, a key that changes hands across batches, a
 * secret revealed in the middle, foreshadowing planted in one batch and paid in the next, one conflict open until the end.
 */

export function seriesFixtureStageOf(user: string): string {
  const stage = /^阶段：(\S+)$/mu.exec(user)?.[1];
  if (stage) return stage;
  const borrowed = autoFixtureStageOf(user);
  if (borrowed === "research" || borrowed === "directions") return borrowed;
  throw new Error("unrecognised series prompt");
}

export function seriesFixtureEpisodeCount(user: string): number {
  return Number(/全剧共 (\d+) 集/u.exec(user)?.[1] ?? /集数：(\d+) 集/u.exec(user)?.[1] ?? "1");
}

export function seriesFixtureSeconds(user: string): number {
  return Number(/每集计划篇幅约 (\d+) 秒/u.exec(user)?.[1] ?? "60");
}

/** The episode where the secret is revealed: the middle of the series (episode 2 at least, when there is one). */
export function fixtureRevealEpisode(n: number): number | null {
  return n >= 2 ? Math.max(2, Math.ceil(n / 2)) : null;
}

export function fixtureSeriesSetting(n: number): SeriesSetting {
  return {
    schema: SERIES_SETTING_SCHEMA,
    title: "模型替身样例：关门之后",
    logline: "替身样例：店员林小满追查一把钥匙，发现店主老周隐瞒店铺将被转卖。",
    synopsis: "替身样例：深夜便利店里，林小满与店主老周因一把钥匙起了误会。她一步步追查，得知老周隐瞒了店铺转卖的消息，最终两人联手保住小店。",
    core: {
      protagonistId: "C1", desire: "保住这份能养活家人的工作", weakness: "遇事先怀疑别人", goal: "查清钥匙去向并保住小店",
      coreConflict: "林小满与隐瞒真相的老周互相猜疑", keyChoices: [{ choice: "林小满选择相信老周", consequence: "两人联手阻止转卖" }],
      failureCost: "小店关门，林小满失去工作", ending: "林小满和老周保住小店，钥匙回到柜台抽屉。",
      majorTurns: [{ episodeNo: fixtureRevealEpisode(n) ?? 1, turn: "老周说出转卖真相" }, { episodeNo: n, turn: "两人联手保住小店" }],
    },
    characters: [
      { id: "C1", name: "林小满", identity: "便利店夜班店员", goal: "保住工作", weakness: "多疑", arc: "从怀疑到信任", voice: "直接、急", initialWhereabouts: "便利店柜台" },
      { id: "C2", name: "老周", identity: "便利店店主", goal: "体面地交出小店", weakness: "爱面子", arc: "从隐瞒到坦白", voice: "慢、少话", initialWhereabouts: "便利店门口" },
      { id: "C3", name: "阿芸", identity: "林小满的妹妹", goal: "帮姐姐", weakness: "冲动", arc: "从添乱到帮忙", voice: "快、俏皮", initialWhereabouts: "家中" },
    ],
    relationships: [
      { from: "C1", to: "C2", relation: "雇员与店主", arc: "从猜疑到联手" },
      { from: "C1", to: "C3", relation: "姐妹", arc: "从争吵到互相支持" },
    ],
    secrets: [{ id: "S1", holderId: "C2", content: "小店下月将被转卖", knownBy: [], revealEpisode: fixtureRevealEpisode(n) }],
    locations: [
      { id: "L1", name: "便利店", intExt: "INT", description: "狭长店面，门口一盏灯" },
      { id: "L2", name: "公交站", intExt: "EXT", description: "店外雨棚下的站牌" },
      { id: "L3", name: "旧仓库", intExt: "INT", description: "堆满纸箱的后仓" },
    ],
    props: [
      { id: "P1", name: "店门钥匙", initialHolderId: "C2", purpose: "开关店门" },
      { id: "P2", name: "旧账本", initialHolderId: "C3", purpose: "记录转卖线索" },
    ],
  };
}

export function fixtureSeriesArc(n: number): SeriesArc {
  const a = Math.max(1, Math.floor(n / 3));
  const b = Math.max(a + 1, Math.floor((2 * n) / 3));
  const phases = n >= 3
    ? [{ from: 1, to: a }, { from: a + 1, to: b }, { from: b + 1, to: n }]
    : [{ from: 1, to: n }];
  const foreshadowing: SeriesArc["foreshadowing"] = [];
  if (n >= 2) foreshadowing.push({ id: "FS1", content: "柜台抽屉的划痕", plantEpisode: 1, payoffEpisode: n, dependsOn: [] });
  if (n >= 5) foreshadowing.push({ id: "FS2", content: "老周口袋里的合同", plantEpisode: 3, payoffEpisode: 5, dependsOn: [] });
  if (n >= 7) foreshadowing.push({ id: "FS3", content: "仓库角落的旧招牌", plantEpisode: 4, payoffEpisode: n - 1, dependsOn: ["FS2"] });
  return {
    schema: SERIES_ARC_SCHEMA,
    phases: phases.map((item, index) => ({ phaseNo: index + 1, title: ["误会", "真相", "联手"][index] ?? "收束", episodeFrom: item.from, episodeTo: item.to,
      goal: ["找钥匙", "查真相", "保小店"][index] ?? "收束", turningPoint: ["钥匙易手", "秘密揭开", "联手反击"][index] ?? "结局" })),
    foreshadowing,
    finale: { episodeNo: n, resolution: "两人保住小店，钥匙回到柜台抽屉。" },
  };
}

/** Who is on screen in episode k: the two leads, the sister when the key or the ledger passes through her hands. */
export function fixtureCast(n: number, k: number): string[] {
  return k === 4 || (k % 5 === 0 && k !== n) ? ["C1", "C2", "C3"] : ["C1", "C2"];
}

export function fixtureSeriesOutlineEpisode(n: number, k: number): SeriesOutlineEpisode {
  const arc = fixtureSeriesArc(n);
  return {
    episodeNo: k, title: `第${String(k)}夜`, goal: "林小满找钥匙", obstacle: "老周不肯开口", choice: "林小满追问", turn: k === fixtureRevealEpisode(n) ? "老周说出转卖" : "线索出现",
    result: "关系推进", endState: k === n ? "小店保住" : "疑问未解", nextHook: k === n ? "日常继续" : "下一夜再查",
    characterIds: fixtureCast(n, k), locationIds: ["L1"],
    plants: arc.foreshadowing.filter((item) => item.plantEpisode === k).map((item) => item.id),
    payoffs: arc.foreshadowing.filter((item) => item.payoffEpisode === k).map((item) => item.id),
    isFinale: k === n,
  };
}

export function fixtureSeriesOutline(n: number, chunkNo: number): SeriesOutline {
  const { first, last } = seriesOutlineRange(n, chunkNo);
  return { schema: SERIES_OUTLINE_SCHEMA, chunkNo, episodes: Array.from({ length: last - first + 1 }, (_, index) => fixtureSeriesOutlineEpisode(n, first + index)) };
}

export interface SeriesFixturePlan {
  /** Episode where the key is handed to someone who is not on screen while its holder is absent (a contradiction). */
  propContradiction?: number;
  /** Episode that pays off a foreshadowing never planted. */
  payoffBeforePlant?: number;
  /** Episode written as the series finale although it is not the last one (refused). */
  earlyFinale?: number;
  /** Episodes whose continuity.secrets are replaced (moving or dropping the planned reveal). */
  secrets?: Record<number, SeriesEpisode["continuity"]["secrets"]>;
  /** Episodes whose continuity.conflicts are replaced (resolving, reopening or opening another conflict). */
  conflicts?: Record<number, SeriesEpisode["continuity"]["conflicts"]>;
  /** Batch reviews returning a verified high issue on their first episode. */
  blockingBatchReviews?: number[];
  /** A plan review returning a verified high issue. */
  blockingPlanReview?: boolean;
  /** Episodes whose JSON is padded past the episode budget (refused, never cut). */
  oversizedEpisodes?: number[];
  /** Tag in every episode's action (to tell rewritten versions apart). */
  tag?: string;
  /** The borrowed research and directions stages' plan (automatic creation's double). */
  auto?: AutoFixturePlan;
}

/** Holder of the key after episode k: C2 until episode 2, C1 until episode 4, then C3 (handed over on screen). */
function keyHolderAfter(k: number): string {
  return k >= 4 ? "C3" : k >= 2 ? "C1" : "C2";
}

export function fixtureSeriesEpisode(n: number, k: number, seconds: number, plan: SeriesFixturePlan = {}): SeriesEpisode {
  const arc = fixtureSeriesArc(n);
  const cast = fixtureCast(n, k);
  const tag = plan.tag ?? "替身样例";
  const continuity: SeriesEpisode["continuity"] = {
    characters: [{ id: "C1", whereabouts: k % 2 === 0 ? "公交站" : "便利店柜台", knows: k >= (fixtureRevealEpisode(n) ?? n + 1) ? ["小店将被转卖"] : ["钥匙不见了"], unaware: [] }],
    relationships: k === n ? [{ from: "C1", to: "C2", state: "联手" }] : [],
    props: [],
    conflicts: n === 1 ? [] : k === 1 ? [{ id: "K1", content: "钥匙归属之争", status: "open" }] : k === n ? [{ id: "K1", content: "钥匙归属之争", status: "resolved" }] : [],
    secrets: k === fixtureRevealEpisode(n) ? [{ id: "S1", revealedTo: ["C1"] }] : [],
    foreshadowing: [
      ...arc.foreshadowing.filter((item) => item.plantEpisode === k).map((item) => ({ id: item.id, action: "plant" as const })),
      ...arc.foreshadowing.filter((item) => item.payoffEpisode === k).map((item) => ({ id: item.id, action: "payoff" as const })),
    ],
  };
  if (k === 2 || (k === 4 && n >= 4)) continuity.props.push({ id: "P1", holderId: keyHolderAfter(k), state: "易手" });
  if (plan.propContradiction === k) continuity.props = [{ id: "P2", holderId: "C1", state: "被拿走" }, ...continuity.props.filter((item) => item.id !== "P2")];
  if (plan.secrets?.[k]) continuity.secrets = plan.secrets[k];
  if (plan.conflicts?.[k]) continuity.conflicts = plan.conflicts[k];
  if (plan.payoffBeforePlant === k) continuity.foreshadowing.push({ id: n >= 7 ? "FS3" : "FS1", action: "payoff" });
  const half = Math.round(seconds / 2);
  const castNow = plan.propContradiction === k ? ["C1", "C2"] : cast;
  const episode: SeriesEpisode = {
    schema: SERIES_EPISODE_SCHEMA, episodeNo: k, title: `第${String(k)}夜`, plannedSeconds: seconds,
    summary: `${tag}：第${String(k)}夜，林小满追查钥匙，${k === fixtureRevealEpisode(n) ? "老周说出转卖" : "线索推进"}。`,
    scenes: [
      { sceneNo: 1, locationId: "L1", timeOfDay: "夜", characterIds: castNow, action: `${tag}：林小满在柜台前翻找钥匙，老周站在门口。`,
        dialogue: [{ characterId: "C1", line: "钥匙呢？", delivery: "急" }, { characterId: "C2", line: "明天再说。", delivery: "低声" }],
        sound: "雨声", keyVisual: "柜台抽屉半开", seconds: half },
      { sceneNo: 2, locationId: "L1", timeOfDay: "夜", characterIds: castNow, action: `${tag}：两人对视，${k === n ? "老周把钥匙放回抽屉。" : "门口的灯闪了一下。"}`,
        dialogue: [{ characterId: "C1", line: k === n ? "我们一起守住它。" : "我会查清楚。", delivery: "" }],
        sound: "", keyVisual: k === n ? "钥匙回到抽屉" : "门灯闪烁", seconds: seconds - half },
    ],
    handoffFacts: [`第${String(k)}夜结束：钥匙在${keyHolderAfter(k)}手里。`],
    continuity,
    ending: k === n || plan.earlyFinale === k ? "finale" : "continue",
  };
  if (plan.oversizedEpisodes?.includes(k)) {
    // Every field at its own limit: the episode as a whole is past its budget (refused whole, never cut).
    const scene = { ...episode.scenes[0]!, action: "填".repeat(200), dialogue: Array.from({ length: 8 }, () => ({ characterId: "C1", line: "填".repeat(60), delivery: "" })) };
    episode.scenes = Array.from({ length: 4 }, (_, index) => ({ ...scene, sceneNo: index + 1, seconds: 15 }));
  }
  return episode;
}

type Review = { schema: string; verdict: "pass" | "revise"; dimensions: Array<{ key: string; assessment: string; internalScore: number }>; issues: Array<Record<string, string>> };

function review(schema: string, dimensions: readonly string[], issues: Review["issues"]): Review {
  return { schema, verdict: issues.some((item) => item.severity === "high") ? "revise" : "pass",
    dimensions: dimensions.map((key) => ({ key, assessment: "替身样例：符合标准。", internalScore: 4 })), issues };
}

export function seriesFixtureAnswer(user: string, plan: SeriesFixturePlan = {}): unknown {
  const stage = seriesFixtureStageOf(user);
  if (stage === "research" || stage === "directions") return autoFixtureAnswer(user, plan.auto);
  const n = seriesFixtureEpisodeCount(user);
  if (stage === "setting") return fixtureSeriesSetting(n);
  if (stage === "arc") return fixtureSeriesArc(n);
  if (stage.startsWith("outline:")) return fixtureSeriesOutline(n, Number(stage.split(":")[1]));
  if (stage.startsWith("episode:")) return fixtureSeriesEpisode(n, Number(stage.split(":")[1]), seriesFixtureSeconds(user), plan);
  if (stage === "plan_review") {
    return review(SERIES_PLAN_REVIEW_SCHEMA, SERIES_PLAN_REVIEW_DIMENSIONS, plan.blockingPlanReview
      ? [{ id: "R1", dimension: "ending", severity: "high", target: "arc", evidence: "两人保住小店", problem: "替身样例：结局兑现不足。", suggestion: "补足结局。" }] : []);
  }
  if (stage.startsWith("batch_review:")) {
    const batchNo = Number(stage.split(":")[1]);
    const first = (batchNo - 1) * 3 + 1;
    return review(SERIES_BATCH_REVIEW_SCHEMA, SERIES_BATCH_REVIEW_DIMENSIONS, plan.blockingBatchReviews?.includes(batchNo)
      ? [{ id: "R1", dimension: "knowledge", severity: "high", target: `episode:${String(first)}`, evidence: "钥匙呢？", problem: "替身样例：人物知道了不该知道的信息。", suggestion: "改写这句台词。" }] : []);
  }
  if (stage === "final_review") return review(SERIES_FINAL_REVIEW_SCHEMA, SERIES_FINAL_REVIEW_DIMENSIONS, []);
  throw new Error(`no series fixture for ${stage}`);
}

function wire(url: string, value: unknown): unknown {
  const textValue = JSON.stringify(value);
  if (url === DEEPSEEK_CHAT_COMPLETIONS_URL) {
    return { id: "ds_series_fixture", object: "chat.completion", model: "fixture-model",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: textValue } }],
      usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100, completion_tokens: 200, total_tokens: 300 } };
  }
  if (url === ANTHROPIC_MESSAGES_URL) {
    return { id: "msg_series_fixture", type: "message", role: "assistant", model: "fixture-model",
      content: [{ type: "text", text: textValue }], stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 200 } };
  }
  return { id: "resp_series_fixture", model: "fixture-model", status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text: textValue }] }],
    usage: { input_tokens: 100, output_tokens: 200, total_tokens: 300 } };
}

export interface SeriesFixtureExchange {
  stage: string;
  url: string;
  user: string;
  system: string;
  body: Record<string, unknown>;
}

/** A transport speaking each endpoint's own wire format, answering every series stage. */
export function seriesFixtureTransport(options: {
  plan?: SeriesFixturePlan | (() => SeriesFixturePlan);
  seen?: SeriesFixtureExchange[];
  override?: (stage: string, attempt: number) => { status: number; body: unknown } | "hang" | "throw" | undefined;
} = {}): WritingTransport {
  const attempts = new Map<string, number>();
  return async (request) => {
    const body = JSON.parse(request.body) as Record<string, unknown>;
    const messages = body.messages as Array<{ role: string; content: unknown }> | undefined;
    const contentText = (value: unknown): string => typeof value === "string" ? value
      : Array.isArray(value) ? value.map((part) => (part as { text?: string }).text ?? "").join("") : "";
    const user = contentText(messages?.find((message) => message.role === "user")?.content) || String(body.input ?? "");
    const system = contentText(messages?.find((message) => message.role === "system")?.content) || String(body.instructions ?? body.system ?? "");
    const stage = seriesFixtureStageOf(user);
    const attempt = (attempts.get(stage) ?? 0) + 1;
    attempts.set(stage, attempt);
    options.seen?.push({ stage, url: request.url, user, system, body });
    const custom = options.override?.(stage, attempt);
    if (custom === "throw") throw new TypeError("fetch failed");
    if (custom === "hang") {
      return new Promise((_, reject) => {
        request.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    const plan = typeof options.plan === "function" ? options.plan() : options.plan;
    const answer = custom ?? { status: 200, body: wire(request.url, seriesFixtureAnswer(user, plan)) };
    return {
      status: answer.status,
      headers: { get: (name: string) => name.toLowerCase() === "x-request-id" ? `series-fixture-${stage}-${String(attempt)}` : null },
      body: new TextEncoder().encode(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body)),
    };
  };
}
