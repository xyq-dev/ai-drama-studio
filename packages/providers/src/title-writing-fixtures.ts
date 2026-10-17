import {
  STORY_PLAN_SCHEMA,
  EPISODE_DRAFT_SCHEMA,
  EPISODE_OUTLINE_SCHEMA,
  EPISODE_OUTLINE_SCHEMA_V2,
  TITLE_CONCEPT_SCHEMA,
  type EpisodeDraftCandidate,
  type EpisodeOutline,
  type StoryPlanCandidate,
  type TitleConcept,
  type TitleWritingStepKey,
} from "@ai-drama/contracts";
import { fixtureBreakdownFromPrompt, isBreakdownPrompt } from "./script-breakdown-fixtures";
import { ANTHROPIC_MESSAGES_URL, DEEPSEEK_CHAT_COMPLETIONS_URL, type WritingTransport } from "./text-writing";

/**
 * Controllable provider double for tests and the local acceptance run. It is never wired into the API runtime:
 * the runtime only builds the real fetch transport, so a missing configuration cannot fall back to these answers.
 */
export function fixtureConcept(title: string): TitleConcept {
  return {
    schema: TITLE_CONCEPT_SCHEMA,
    genre: "都市悬疑",
    logline: `《${title}》：夜班店员林夏发现自己被写进一桩失踪案的证词。`,
    synopsis: "林夏在便利店夜班发现监控被改，所有线索都指向她。她和刑警周岩一起追查，发现改监控的人是她失踪多年的哥哥林川。",
    protagonistGoal: "林夏要在三天内证明自己清白。",
    opposition: "幕后的人掌握她的排班和钥匙。",
    coreConflict: "她必须在保护哥哥和说出真相之间做选择。",
    direction: "第一集被指认，第二集追到哥哥，第三集当众说出真相。",
    characters: [
      { name: "林夏", role: "主角，夜班店员", profile: "谨慎、倔强，习惯一个人扛事。" },
      { name: "周岩", role: "刑警", profile: "表面冷淡，暗中相信林夏。" },
      { name: "林川", role: "林夏的哥哥", profile: "失踪五年，为躲债改名。" },
    ],
    relationships: [
      { name: "林夏与林川", pressure: "兄妹情和真相互相拉扯。" },
      { name: "林夏与周岩", pressure: "互相怀疑又不得不合作。" },
    ],
  };
}

const OUTLINE_TITLES = ["改过的监控", "雨夜追踪", "当众说出真相", "旧账本", "天台对峙", "清晨的证词"];

/** The v1 outline (three episodes), or with count the v2 outline of exactly that many episodes. */
export function fixtureOutline(count?: number): EpisodeOutline {
  return {
    schema: count === undefined ? EPISODE_OUTLINE_SCHEMA : EPISODE_OUTLINE_SCHEMA_V2,
    episodes: Array.from({ length: count ?? 3 }, (_, index) => index + 1).map((episodeNo) => ({
      episodeNo,
      title: OUTLINE_TITLES[episodeNo - 1]!,
      entryState: `第 ${episodeNo} 集开场时林夏的处境。`,
      goal: "林夏要找到改监控的人。",
      action: "她和周岩分头调查。",
      turn: "线索指向林川。",
      result: "林夏知道了更多真相。",
      handoff: `第 ${episodeNo} 集交给下一集的事实。`,
    })),
  };
}

export function fixtureEpisode(episodeNo: number): EpisodeDraftCandidate {
  return {
    schema: EPISODE_DRAFT_SCHEMA,
    episodeNo: episodeNo as EpisodeDraftCandidate["episodeNo"],
    title: `第 ${episodeNo} 集`,
    screenplay: `场 1 便利店 夜\n林夏盯着监控屏幕。\n林夏：这不是我。\n（第 ${episodeNo} 集）`,
    scenes: [{ heading: "便利店 夜", action: "林夏发现监控被改。", dialogue: "林夏：这不是我。", sound: "冰柜嗡嗡声" }],
    handoffFacts: [`第 ${episodeNo} 集结束时林夏知道林川还活着。`],
  };
}

export type FixtureStep = TitleWritingStepKey;

/** Which step a prompt belongs to, read from the provider-neutral prompt text (v1 or v2). */
export function fixtureStepOf(userPrompt: string): FixtureStep {
  if (isBreakdownPrompt(userPrompt)) return "breakdown";
  if (userPrompt.includes("只根据剧名完成故事策划")) return "concept";
  if (userPrompt.includes("写分集大纲")) return "outline";
  const match = /写第 ([1-6]) 集(?:（共 [1-6] 集）)?完整剧本/.exec(userPrompt);
  if (match?.[1]) return `episode:${match[1]}` as FixtureStep;
  throw new Error("unrecognized prompt");
}

/** The episode count a v2 outline prompt asks for, or undefined for a v1 prompt. */
export function fixtureOutlineCountOf(userPrompt: string): number | undefined {
  if (!userPrompt.includes(EPISODE_OUTLINE_SCHEMA_V2)) return undefined;
  const match = /episodes 正好 ([1-6]) 项/.exec(userPrompt);
  return match?.[1] ? Number(match[1]) : undefined;
}

export interface FixtureExchange {
  step: FixtureStep;
  url: string;
  body: Record<string, unknown>;
  user: string;
}

/**
 * A transport that speaks the protocol of the endpoint it is called for: the OpenAI Responses API, the Claude
 * Messages API or the DeepSeek Chat Completions API. It answers each step with valid JSON unless an override returns a different HTTP answer for that step
 * and attempt. An override body may be built with providerAnswer() for the endpoint's own wire format.
 */
export function fixtureChatTransport(title: string, options: {
  seen?: FixtureExchange[];
  override?: (step: FixtureStep, attempt: number) => { status: number; body: unknown } | "hang" | "throw" | undefined;
} = {}): WritingTransport {
  const attempts = new Map<FixtureStep, number>();
  return async (request) => {
    const body = JSON.parse(request.body) as Record<string, unknown>;
    const messages = body.messages as Array<{ role: string; content: string }> | undefined;
    const user = messages?.find((message) => message.role === "user")?.content ?? String(body.input ?? "");
    const step = fixtureStepOf(user);
    const attempt = (attempts.get(step) ?? 0) + 1;
    attempts.set(step, attempt);
    options.seen?.push({ step, url: request.url, body, user });
    const custom = options.override?.(step, attempt);
    if (custom === "throw") throw new TypeError("fetch failed");
    if (custom === "hang") {
      return new Promise((_, reject) => {
        request.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }
    const answer = custom ?? { status: 200, body: providerAnswer(request.url, step === "concept" ? fixtureConcept(title)
      : step === "outline" ? fixtureOutline(fixtureOutlineCountOf(user))
        : step === "breakdown" ? fixtureBreakdownFromPrompt(user) : fixtureEpisode(Number(step.slice(-1)))) };
    // DeepSeek documents no request id header: its id comes from the body.
    const requestIdHeader = request.url === ANTHROPIC_MESSAGES_URL ? "request-id" : request.url === DEEPSEEK_CHAT_COMPLETIONS_URL ? null : "x-request-id";
    return {
      status: answer.status,
      headers: { get: (name: string) => requestIdHeader !== null && name.toLowerCase() === requestIdHeader ? `fixture-${step}-${String(attempt)}` : null },
      body: new TextEncoder().encode(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body)),
    };
  };
}

/** A completed OpenAI Responses answer carrying the value as its only output text. */
export function responsesAnswer(value: unknown, options: { status?: "completed" | "incomplete"; reason?: string } = {}) {
  return {
    id: "resp_fixture",
    model: "fixture-model",
    status: options.status ?? "completed",
    ...(options.status === "incomplete" ? { incomplete_details: { reason: options.reason ?? "max_output_tokens" } } : {}),
    output: [{ type: "message", content: [{ type: "output_text", text: typeof value === "string" ? value : JSON.stringify(value) }] }],
    usage: { input_tokens: 100, output_tokens: 200, total_tokens: 300 },
  };
}

/** A Claude Messages answer: an omitted thinking block, then the value as the only text block. */
export function messagesAnswer(value: unknown, stopReason = "end_turn") {
  return {
    id: "msg_fixture",
    type: "message",
    role: "assistant",
    model: "fixture-model",
    content: [
      { type: "thinking", thinking: "", signature: "fixture-signature" },
      { type: "text", text: typeof value === "string" ? value : JSON.stringify(value) },
    ],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 80, cache_creation_input_tokens: 0, cache_read_input_tokens: 20, output_tokens: 200 },
  };
}

/** A DeepSeek Chat Completions answer: the value as the only choice's content (no reasoning, thinking is off). */
export function chatCompletionsAnswer(value: unknown, finishReason = "stop") {
  return {
    id: "ds_fixture",
    object: "chat.completion",
    model: "fixture-model",
    choices: [{ index: 0, finish_reason: finishReason,
      message: { role: "assistant", content: typeof value === "string" ? value : JSON.stringify(value) } }],
    usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 20, prompt_cache_miss_tokens: 80, completion_tokens: 200, total_tokens: 300 },
  };
}

/** The answer in the wire format of the endpoint a request was sent to. */
export function providerAnswer(url: string, value: unknown) {
  if (url === DEEPSEEK_CHAT_COMPLETIONS_URL) return chatCompletionsAnswer(value);
  return url === ANTHROPIC_MESSAGES_URL ? messagesAnswer(value) : responsesAnswer(value);
}

/** A story plan candidate of the model double. Every text says it is the double's sample, not a model's writing. */
export function fixtureStoryPlan(tag = "模型替身样例"): StoryPlanCandidate {
  return {
    schema: STORY_PLAN_SCHEMA,
    logline: `${tag}：夜班店员守住一份被改过的记录`,
    protagonistGoal: "守住班次记录",
    opposition: "店长能改时间",
    coreConflict: "解释会被当成承认",
    relationships: [{ name: "店员与店长", pressure: "店员不能供出同事" }],
    episodes: ([1, 2, 3] as const).map((episodeNo) => ({
      episodeNo, entryState: `${tag}·进入${episodeNo}`, goal: `目标${episodeNo}`, action: `行动${episodeNo}`, turn: `转折${episodeNo}`,
      result: `结果${episodeNo}`, handoff: `交接${episodeNo}`,
    })),
  };
}

/**
 * The online candidate the double answers for a prompt: the story plan for 模式：故事策划, otherwise the draft of the
 * episode the prompt asks for (episodeNo 必须是 N).
 */
export function fixtureCandidateFromPrompt(userPrompt: string): StoryPlanCandidate | EpisodeDraftCandidate {
  if (userPrompt.includes("模式：故事策划")) return fixtureStoryPlan();
  const episodeNo = Number(/episodeNo 必须是 (\d)/.exec(userPrompt)?.[1] ?? "1");
  return fixtureEpisode(episodeNo);
}

/** Breakdown answers for the same stubbed acceptances. */
export { breakdownPromptParts, fixtureBreakdown, fixtureBreakdownFromPrompt } from "./script-breakdown-fixtures";
