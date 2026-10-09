import {
  EPISODE_DRAFT_SCHEMA,
  EPISODE_OUTLINE_SCHEMA,
  TITLE_CONCEPT_SCHEMA,
  type EpisodeDraftCandidate,
  type EpisodeOutline,
  type TitleConcept,
} from "@ai-drama/contracts";
import type { WritingTransport } from "./text-writing";

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

export function fixtureOutline(): EpisodeOutline {
  return {
    schema: EPISODE_OUTLINE_SCHEMA,
    episodes: [1, 2, 3].map((episodeNo) => ({
      episodeNo: episodeNo as 1 | 2 | 3,
      title: ["改过的监控", "雨夜追踪", "当众说出真相"][episodeNo - 1]!,
      entryState: `第 ${episodeNo} 集开场时林夏的处境。`,
      goal: "林夏要找到改监控的人。",
      action: "她和周岩分头调查。",
      turn: "线索指向林川。",
      result: "林夏知道了更多真相。",
      handoff: `第 ${episodeNo} 集交给下一集的事实。`,
    })),
  };
}

export function fixtureEpisode(episodeNo: 1 | 2 | 3): EpisodeDraftCandidate {
  return {
    schema: EPISODE_DRAFT_SCHEMA,
    episodeNo,
    title: `第 ${episodeNo} 集`,
    screenplay: `场 1 便利店 夜\n林夏盯着监控屏幕。\n林夏：这不是我。\n（第 ${episodeNo} 集）`,
    scenes: [{ heading: "便利店 夜", action: "林夏发现监控被改。", dialogue: "林夏：这不是我。", sound: "冰柜嗡嗡声" }],
    handoffFacts: [`第 ${episodeNo} 集结束时林夏知道林川还活着。`],
  };
}

export type FixtureStep = "concept" | "outline" | "episode:1" | "episode:2" | "episode:3";

/** Which step a prompt belongs to, read from the provider-neutral prompt text. */
export function fixtureStepOf(userPrompt: string): FixtureStep {
  if (userPrompt.includes("只根据剧名完成故事策划")) return "concept";
  if (userPrompt.includes("写分集大纲")) return "outline";
  const match = /写第 (\d) 集完整剧本/.exec(userPrompt);
  if (match?.[1] === "1" || match?.[1] === "2" || match?.[1] === "3") return `episode:${match[1]}` as FixtureStep;
  throw new Error("unrecognized prompt");
}

export interface FixtureExchange {
  step: FixtureStep;
  url: string;
  body: Record<string, unknown>;
  user: string;
}

/**
 * An OpenAI-compatible chat transport (Qwen / DeepSeek wire format) that answers each step with valid JSON unless
 * an override returns a different HTTP answer for that step and attempt.
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
    const answer = custom ?? { status: 200, body: chatAnswer(step === "concept" ? fixtureConcept(title)
      : step === "outline" ? fixtureOutline() : fixtureEpisode(Number(step.slice(-1)) as 1 | 2 | 3)) };
    return {
      status: answer.status,
      headers: { get: (name: string) => name.toLowerCase() === "x-request-id" ? `fixture-${step}-${String(attempt)}` : null },
      body: new TextEncoder().encode(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body)),
    };
  };
}

export function chatAnswer(value: unknown, finish = "stop") {
  return {
    id: "fixture",
    model: "fixture-model",
    choices: [{ message: { role: "assistant", content: typeof value === "string" ? value : JSON.stringify(value) }, finish_reason: finish }],
    usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
  };
}
