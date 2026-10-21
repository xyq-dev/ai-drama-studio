import {
  AUTO_RESEARCH_SERVER_KEYS,
  AUTO_REVIEW_DIMENSION_LABELS,
  autoErrorParts,
  autoStageEpisodeNo,
  autoStageRound,
  autoRunSettledForGood,
  currentUncertainCallIds,
  type AutoCreationOptionsView,
  type AutoCreationRunView,
  type AutoCreationStageView,
} from "@ai-drama/contracts";
import { withSession } from "./site-session";
import { TitleWritingError, TitleWritingUnconfirmedError, isEntityId, operatorHeader } from "./title-writing-client";

export type { AutoCreationOptionsView, AutoCreationRunView };
export { AUTO_REVIEW_DIMENSION_LABELS };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface AutoStartBody {
  idea: string;
  constraints: {
    genre: string;
    audience: string;
    maxCharacters: number | null;
    maxLocations: number | null;
    forbiddenThemes: string[];
    endingRequirement: string;
  };
  materials: Array<{ title: string; kind: "script" | "subtitles" | "notes"; text: string; rightsConfirmed: true }>;
  episodeCount: number;
  episodeSeconds: number;
  revisionRounds: number;
  callBudget: number;
  providerKey?: string;
  model?: string;
}

/** The run in a start receipt, only when it names a run of exactly this work. */
export function autoStartReceiptRun(body: unknown, projectId: string): AutoCreationRunView | null {
  const run = body && typeof body === "object" ? (body as { run?: unknown }).run : null;
  if (!run || typeof run !== "object") return null;
  const view = run as Partial<AutoCreationRunView>;
  return isEntityId(view.runId) && view.projectId === projectId ? run as AutoCreationRunView : null;
}

/** Browser side of automatic creation: start, read, stop, resume, place scripts. Keys never reach the page. */
export class AutoCreationClient {
  constructor(private readonly fetchImpl?: FetchLike, private readonly prefix = "/api/v1") {}

  private async call<T>(path: string, init: RequestInit): Promise<{ status: number; body: T }> {
    const response = await withSession(this.fetchImpl ?? globalThis.fetch.bind(globalThis))(`${this.prefix}${path}`, init);
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text.length === 0 ? null : JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const error = parsed && typeof parsed === "object" && "error" in parsed
        ? (parsed as { error?: { code?: string; message?: string; details?: Record<string, unknown> } }).error : undefined;
      throw new TitleWritingError(response.status, error?.code ?? "REQUEST_FAILED", error?.message ?? `HTTP ${String(response.status)}`, error?.details ?? null);
    }
    return { status: response.status, body: parsed as T };
  }

  async options(): Promise<AutoCreationOptionsView> {
    return (await this.call<AutoCreationOptionsView>("/writing/auto-runs/options", { method: "GET", headers: { Accept: "application/json" } })).body;
  }

  async start(projectId: string, body: AutoStartBody, options: { token: string; idempotencyKey: string }): Promise<AutoCreationRunView> {
    const result = await this.call<unknown>(`/projects/${projectId}/auto-runs`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "Idempotency-Key": options.idempotencyKey, ...operatorHeader(options.token) },
      body: JSON.stringify(body),
    });
    const run = autoStartReceiptRun(result.body, projectId);
    if (!run) throw new TitleWritingUnconfirmedError(result.status);
    return run;
  }

  async latest(projectId: string, signal?: AbortSignal): Promise<AutoCreationRunView | null> {
    return (await this.call<{ run: AutoCreationRunView | null }>(`/projects/${projectId}/auto-runs/latest`,
      { method: "GET", headers: { Accept: "application/json" }, ...(signal ? { signal } : {}) })).body.run;
  }

  async cancel(projectId: string, runId: string): Promise<AutoCreationRunView> {
    return (await this.call<{ run: AutoCreationRunView }>(`/projects/${projectId}/auto-runs/${runId}/cancel`, { method: "POST", headers: { Accept: "application/json" } })).body.run;
  }

  async resume(projectId: string, runId: string, options: { confirmUncertainCallIds: readonly string[]; token: string; idempotencyKey: string }): Promise<AutoCreationRunView> {
    const result = await this.call<unknown>(`/projects/${projectId}/auto-runs/${runId}/resume`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", ...operatorHeader(options.token), "Idempotency-Key": options.idempotencyKey },
      body: JSON.stringify({ confirmUncertainCallIds: options.confirmUncertainCallIds }),
    });
    // Only a receipt naming this run confirms the resume; anything else leaves it unconfirmed.
    const run = autoStartReceiptRun(result.body, projectId);
    if (!run || run.runId !== runId) throw new TitleWritingUnconfirmedError(result.status);
    return run;
  }

  async placeScripts(projectId: string, runId: string, acceptStoryChanged: boolean): Promise<AutoCreationRunView> {
    return (await this.call<{ run: AutoCreationRunView }>(`/projects/${projectId}/auto-runs/${runId}/scripts`, {
      method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify({ acceptStoryChanged }),
    })).body.run;
  }

  packageUrl(projectId: string, runId: string, format: "markdown" | "json"): string {
    return `${this.prefix}/projects/${projectId}/auto-runs/${runId}/package?format=${format}`;
  }
}

export function normalizeAutoOptions(value: unknown): AutoCreationOptionsView | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<AutoCreationOptionsView>;
  if (typeof record.code !== "string" || !Array.isArray(record.providers) || typeof record.enabled !== "boolean" || !record.research) return null;
  return record as AutoCreationOptionsView;
}

export function autoOptionsUnavailable(options: AutoCreationOptionsView | null): string | null {
  if (!options) return "没能读取 AI 自动创作的服务端配置。可以稍后重试，或使用下面的其他创作方式。";
  if (options.code === "AUTO_CREATION_READY") return options.episodePlanReady ? null : "集数和时长设置还没有在服务器上就绪（数据库迁移尚未执行）。";
  if (options.code === "AUTO_CREATION_DISABLED") return "AI 自动创作没有在服务端开启（需要 TITLE_WRITING_ENABLED 和 AUTO_CREATION_ENABLED）。原有创作方式不受影响。";
  if (options.code === "AUTO_CREATION_FORBIDDEN") return "服务端还没有可用的调用授权（未启用站点登录，也没有设置操作者令牌）。";
  if (options.code === "AUTO_CREATION_STORAGE_UNAVAILABLE") return "AI 自动创作的数据库迁移 20261019000100_auto_creation 尚未执行（需由服务器部署流程单独授权执行）。";
  if (options.code === "AUTO_CREATION_PROVIDER_UNCONFIGURED") return "还没有可用的模型服务（DeepSeek、Claude 或 OpenAI 都未配置完整）。";
  return "AI 自动创作暂不可用。";
}

const STAGE_LABELS: Record<string, string> = {
  sources: "整理资料来源",
  research: "研究与受众分析",
  directions: "原创选题与自动选择",
  bible: "故事、结局、人物与地点",
  outline: "分集大纲",
};

export function autoStageLabel(stageKey: string): string {
  if (STAGE_LABELS[stageKey]) return STAGE_LABELS[stageKey]!;
  const episodeNo = autoStageEpisodeNo(stageKey);
  const round = autoStageRound(stageKey);
  if (stageKey.startsWith("episode:")) return `第 ${String(episodeNo)} 集剧本`;
  if (stageKey.startsWith("review:")) return `第 ${String(round)} 轮质量检查`;
  if (stageKey.startsWith("revise:")) return `第 ${String(round)} 轮修改：第 ${String(episodeNo)} 集`;
  return stageKey;
}

const STATE_TEXT: Record<string, string> = {
  pending: "未开始", reserved: "正在进行", submitted: "正在进行", completed: "已完成", rejected: "没有通过", unknown: "结果不确定", canceled: "已取消",
};

export function autoStageStateText(state: string): string {
  return STATE_TEXT[state] ?? state;
}

/** What the run is doing now, from stored stage states only (no percentage, no timer). */
export function autoHeadline(run: AutoCreationRunView): string {
  if (run.state === "completed") return run.quality === "passed" ? "剧本包已完成（机器质量检查通过）" : "剧本包已完成（待完善）";
  if (run.state === "partial") return "部分完成，已停止";
  if (run.state === "needs_attention") return "需要处理，已停止";
  if (run.state === "canceled") return "已取消";
  if (run.state === "failed") return "没有完成";
  if (run.cancelRequested) return "正在停止";
  const next = run.stages.find((stage) => stage.state !== "completed");
  return next ? `正在进行：${autoStageLabel(next.stageKey)}` : "正在保存结果";
}

const ERRORS: Record<string, string> = {
  unsourced_number: "回答里有一个数字没有通过真实性检查，已拒收，后续阶段没有发送。这不说明模型一定编造了数据，也可能是写法让程序无法确认它是创作设定；下面写明了位置和判断类别。",
  unsourced_claim: "研究结论把没有来源的判断标成了有来源，已拒收。",
  unknown_source: "研究结论引用了不存在的资料编号，已拒收。",
  unread_source: "研究结论引用了没有读到正文的资料，已拒收。",
  evidence_not_in_source: "研究结论的引文在资料中找不到，已拒收。",
  constraint_violation: "结果违反了冻结的硬约束（集数、每集时长、人物数、地点数或禁止题材），已拒收，没有保存。",
  dangling_reference: "结果引用了设定中不存在的人物、地点或编号，已拒收。",
  duplicate_id: "结果里有重复的编号，已拒收。",
  duplicate_direction: "几个选题方向实质相同，已拒收。",
  episode_mismatch: "集号不对，已拒收。",
  invalid_output: "模型返回的内容格式不符合要求，没有保存，也不会自动重发修格式。",
  unsafe_content: "模型返回的内容含有网址、网页代码或保留字段，没有保存。",
  too_large: "模型返回的内容超过长度上限，没有保存。",
  truncated: "模型的回答被截断，没有保存。",
  refusal: "模型拒绝了这一步。",
  auth: "模型服务认证失败（密钥无效或过期）。",
  quota: "模型账户余额或额度不足。",
  rate_limited: "模型服务限流。",
  bad_request: "模型服务认为请求参数无效。",
  timeout: "等待模型超时。模型可能已经处理并产生费用（结果未知），不会自动重发。",
  disconnected: "连接中断。结果未知，可能已产生费用，不会自动重发。",
  server_error: "模型服务出错。结果未知，可能已产生费用，不会自动重发。",
  executor_lost: "服务重启时这一步已经发出，结果未知，不会自动重发。",
  provider_unconfigured: "这次创作冻结的模型服务现在不可用，没有发出请求，也不会改用其他模型服务。",
  legacy_provider_run: "这是 DeepSeek 退役前的旧任务，不会再发出请求。",
  prompt_too_large: "这一步的输入超过了输入长度上限，没有发送；按已保存的成果再次继续也只会停在这里。剧本包仍可查看和下载。",
  research_fetch_unavailable: "这次创作开始时选择了读取公开页面，但服务端现在关闭了页面读取：没有整理资料，也没有发出调用，参考网址保留在任务里。恢复页面读取后可以继续。",
  research_sources_missing: "下一步是研究，但这次创作没有有效的已保存资料快照，无法确定研究契约：没有发出调用，也不会默认按有市场资料处理。",
  story_conflict: "作品里已经有故事（可能是你写的），没有覆盖。剧本包仍可查看和下载。",
  story_too_large: "整理后的故事超过保存上限，没有保存，再次继续也只会得到同样的结果。剧本包仍可查看和下载；分集剧本不会写入作品。",
  revision_rounds_exhausted: "已用完允许的修改轮次，仍有问题未解决，标记为「待完善」。",
  revision_budget_exhausted: "剩余调用预算不够完成一整轮修改，没有开始修改，标记为「待完善」。",
  unrevisable_issues: "剩余问题出在故事设定或大纲上，定向修改单集无法解决，标记为「待完善」。",
  AUTO_CREATION_DAILY_CAP: "最近 24 小时的调用次数已达管理员上限，在发送前停止，已完成的内容保留。",
  AUTO_CREATION_RUN_CAP: "这次创作的调用预算已用完，在发送前停止。",
  canceled_before_send: "停止请求先到达，这一步没有发出。",
};

/** Rules an answer broke: the model answered, the answer was checked and refused. Never a key or account problem. */
const OUTPUT_CHECK_CODES = new Set(["unsourced_number", "unsourced_claim", "unknown_source", "unread_source", "evidence_not_in_source",
  "constraint_violation", "dangling_reference", "duplicate_id", "duplicate_direction", "episode_mismatch", "invalid_output", "unsafe_content", "too_large"]);

const CATEGORY_TEXT: Record<string, string> = {
  digits: "阿拉伯数字", percent: "百分比或成数", rank: "排名名次", chinese_numeral: "中文数字", fullwidth_digits: "全角数字",
  // Every strict stage: the answer carries a field its contract does not allow.
  unrecognized_keys: "模型回答包含契约不允许的额外字段",
};

/** What the check took the number for (checks v3). */
const SEMANTIC_TEXT: Record<string, string> = {
  market_statistic: "判断为市场或受众统计，需要可读资料来源",
  result_claim: "判断为写成了已经得到的调查或观众结论，而不是待验证的假设或计划",
  frozen_conflict: "判断为创作数量，但与冻结的集数、时长或人物、地点上限冲突",
  unclassified: "无法确认是创作设定还是统计（如日期、资料条数），按无来源数字处理",
  unsourced: "所引资料的摘录正文里没有这个数字",
  limited_contract: "本次是 AI 创作策划（市场证据不可用），这个字段由服务端写入，模型回答不能包含，空值也不行",
};

const RULE_TEXT: Record<string, string> = {
  proportion: "比例或成数", magnitude: "数量级或倍数", ranking: "排名", audience_count: "观众或用户人数", audience_age: "受众年龄或年龄段",
  rate_or_average: "平均值或每天、每周的频次", viewing_duration: "观看时长", viewing_count: "观看集数", long_observation: "过长的观察期",
  market_clause: "与观众或市场写在同一句", measured_result: "写成已测得的结果", unmarked_audience_judgement: "观众判断没有写明待验证或计划",
  cast_over_limit: "人物数超过上限", locations_over_limit: "地点数超过上限", episode_count: "集数与冻结值不同", over_length: "时长超过每集目标",
  date_or_range: "日期或数值范围", no_role: "没有对应的创作或计划含义", count_out_of_range: "数量超出合理的创作范围",
  not_in_cited_excerpt: "引用资料中找不到",
  forbidden_field: "资料有限契约不允许的字段",
};

/** A stored code (rule; since checks v2 the field and the kind of token; since v3 what it was taken for and the sub-rule) as the page says it. */
export function autoErrorText(stored: string | null): string | null {
  if (stored === null) return null;
  const { code, field, category, semantic, rule } = autoErrorParts(stored);
  const base = ERRORS[code] ?? `出现了未识别的问题（${code}）。`;
  if (!field && !category) return base;
  // research v3: only a key the server keeps for itself is explained as the server's record.
  const serverKey = category === "unrecognized_keys" && (AUTO_RESEARCH_SERVER_KEYS as readonly string[]).includes(field ?? "");
  const kind = category ? `（${CATEGORY_TEXT[category] ?? category}${serverKey ? "；用户设定与资料局限由服务端记录，模型不能填写" : ""}）` : "";
  const meaning = semantic ? `；${SEMANTIC_TEXT[semantic] ?? semantic}${rule ? `：${RULE_TEXT[rule] ?? rule}` : ""}` : "";
  return `${base}位置：${field ?? "未知字段"}${kind}${meaning}。`;
}

/** True when the model's answer was refused by the checks (not a key, quota or network problem). */
export function autoOutputRefused(stored: string | null): boolean {
  return stored !== null && OUTPUT_CHECK_CODES.has(autoErrorParts(stored).code);
}

export function autoUncertainIds(run: AutoCreationRunView): string[] {
  return currentUncertainCallIds(
    run.stages.map((stage) => ({ stepKey: stage.stageKey as never, state: stage.state, attemptNo: stage.attemptNo })),
    run.calls.map((call) => ({ callId: call.callId, stepKey: call.stageKey as never, attemptNo: call.attemptNo, state: call.state })),
  );
}

/**
 * One resume whose answer never arrived: its key and the exact confirmations it sent are one identity. A retry sends
 * both unchanged; a new identity is made only after the server answered or definitely refused. No credential is kept.
 */
export interface PendingAutoResume {
  version: 1;
  projectId: string;
  runId: string;
  key: string;
  confirmUncertainCallIds: string[];
}

const RESUME_STORAGE_PREFIX = "auto-creation:resume:";

function resumeStorageKey(projectId: string, runId: string): string {
  return `${RESUME_STORAGE_PREFIX}${projectId}:${runId}`;
}

export function readPendingResume(projectId: string, runId: string): PendingAutoResume | null {
  try {
    const raw = window.sessionStorage.getItem(resumeStorageKey(projectId, runId));
    const parsed = raw ? JSON.parse(raw) as Partial<PendingAutoResume> : null;
    if (!parsed || parsed.version !== 1 || parsed.projectId !== projectId || parsed.runId !== runId || typeof parsed.key !== "string"
      || !Array.isArray(parsed.confirmUncertainCallIds) || !parsed.confirmUncertainCallIds.every((id) => typeof id === "string")) return null;
    return parsed as PendingAutoResume;
  } catch {
    return null;
  }
}

/** Written and read back before the request that uses it; false means only this page remembers it. */
export function savePendingResume(pending: PendingAutoResume): boolean {
  try {
    const text = JSON.stringify(pending);
    window.sessionStorage.setItem(resumeStorageKey(pending.projectId, pending.runId), text);
    return window.sessionStorage.getItem(resumeStorageKey(pending.projectId, pending.runId)) === text;
  } catch {
    return false;
  }
}

export function clearPendingResume(pending: PendingAutoResume): void {
  try {
    if (readPendingResume(pending.projectId, pending.runId)?.key === pending.key) window.sessionStorage.removeItem(resumeStorageKey(pending.projectId, pending.runId));
  } catch {
    // Nothing to keep.
  }
}

/**
 * True when the server answered with a refusal it explains, so it did not apply this resume (a resume the server
 * accepted is answered with the run on every replay). A lost answer, a gateway error or an unexplained failure is not.
 */
export function autoResumeRefused(error: unknown): boolean {
  return error instanceof TitleWritingError && error.code !== "REQUEST_FAILED" && (error.status < 500 || error.code.startsWith("AUTO_CREATION_"));
}

export function autoCanResume(run: AutoCreationRunView): boolean {
  if (run.state === "running" || run.state === "completed") return false;
  if (run.storySave === "conflict" && run.stages.every((stage) => stage.state === "completed")) return false;
  // Final stops (a story too large to save): a resume would only stop the same way; the package stays downloadable.
  if (autoRunSettledForGood(run, run.stages)) return false;
  // The server found the next request cannot be built (or a frozen page read is off): a resume would be refused.
  return (run.resumeBlock ?? null) === null;
}

export function stageOf(run: AutoCreationRunView, stageKey: string): AutoCreationStageView | undefined {
  return run.stages.find((stage) => stage.stageKey === stageKey);
}
