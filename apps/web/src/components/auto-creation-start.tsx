"use client";

import { useEffect, useRef, useState } from "react";
import {
  AUTO_CREATION_RESEND_ALLOWANCE,
  autoCreationHardCap,
  autoCreationNormalCalls,
  autoCreationRevisionsPerRound,
  autoCreationWorstCalls,
  type TitleWritingProviderKey,
} from "@ai-drama/contracts";
import { ApiError, StudioClient } from "../lib/studio-client";
import { suggestTitle } from "../lib/beginner-start";
import { TitleWritingError, TitleWritingUnconfirmedError, isEntityId, providerTarget, tokenRequired } from "../lib/title-writing-client";
import {
  AutoCreationClient,
  autoOptionsUnavailable,
  normalizeAutoOptions,
  type AutoCreationOptionsView,
  type AutoStartBody,
} from "../lib/auto-creation-client";
import styles from "./title-writing.module.css";
import autoStyles from "./auto-creation.module.css";

const studio = new StudioClient();
const auto = new AutoCreationClient();
const DRAFT_KEY = "auto-creation:start";
const EPISODE_COUNTS = [1, 2, 3, 4, 5, 6];
const SECONDS = [{ value: 60, label: "约 1 分钟" }, { value: 90, label: "约 1.5 分钟" }];

/** One start whose result is not confirmed: the frozen request and the keys of both writes. */
interface PendingAutoStart {
  version: 1;
  title: string;
  request: AutoStartBody;
  projectKey: string;
  projectId: string | null;
  runKey: string;
}

function readPending(): PendingAutoStart | null {
  try {
    const raw = window.sessionStorage.getItem(DRAFT_KEY);
    const parsed = raw ? JSON.parse(raw) as Partial<PendingAutoStart> : null;
    if (!parsed || parsed.version !== 1 || typeof parsed.projectKey !== "string" || typeof parsed.runKey !== "string"
      || typeof parsed.title !== "string" || !parsed.request || typeof parsed.request.episodeCount !== "number") return null;
    return parsed as PendingAutoStart;
  } catch {
    return null;
  }
}

/** Saved and read back before the write that uses it; false means no request may be sent. */
function savePending(draft: PendingAutoStart, slot: "empty" | "own"): boolean {
  try {
    const stored = readPending();
    if (slot === "empty" ? stored !== null : !stored || stored.projectKey !== draft.projectKey || stored.runKey !== draft.runKey) return false;
    const text = JSON.stringify(draft);
    window.sessionStorage.setItem(DRAFT_KEY, text);
    return window.sessionStorage.getItem(DRAFT_KEY) === text;
  } catch {
    return false;
  }
}

function clearPending(draft: PendingAutoStart): void {
  try {
    const stored = readPending();
    if (stored && stored.projectKey === draft.projectKey && stored.runKey === draft.runKey) window.sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // Nothing to keep.
  }
}

/** An optional whole number: empty is "not set"; anything else must be an integer within the range, or it is invalid. */
function wholeNumber(value: string, min: number, max: number): { kind: "empty" } | { kind: "ok"; value: number } | { kind: "invalid" } {
  const trimmed = value.trim();
  if (trimmed === "") return { kind: "empty" };
  if (!/^\d+$/u.test(trimmed)) return { kind: "invalid" };
  const parsed = Number(trimmed);
  return parsed >= min && parsed <= max ? { kind: "ok", value: parsed } : { kind: "invalid" };
}

const valueOr = <T,>(parsed: ReturnType<typeof wholeNumber>, fallback: T): number | T => parsed.kind === "ok" ? parsed.value : fallback;

/** Every setting the card shows, in the form's own terms; built from the form, or from a frozen request. */
interface ShownSettings {
  idea: string;
  episodeCount: number;
  seconds: number;
  genre: string;
  audience: string;
  maxCharacters: string;
  maxLocations: string;
  forbidden: string;
  ending: string;
  rounds: number;
  budget: string;
  materialTitle: string;
  materialText: string;
  materialRights: boolean;
  providerKey: string;
}

/** The frozen request as the card shows it: what a retry replays, never the current form or the current server defaults. */
function frozenSettings(request: AutoStartBody): ShownSettings {
  // Read from browser storage: a missing part shows as empty instead of breaking the card (and its way to give up).
  const constraints: Partial<AutoStartBody["constraints"]> = request.constraints ?? {};
  const material = request.materials?.[0];
  return {
    idea: request.idea ?? "", episodeCount: request.episodeCount, seconds: request.episodeSeconds,
    genre: constraints.genre ?? "", audience: constraints.audience ?? "",
    maxCharacters: typeof constraints.maxCharacters === "number" ? String(constraints.maxCharacters) : "",
    maxLocations: typeof constraints.maxLocations === "number" ? String(constraints.maxLocations) : "",
    forbidden: constraints.forbiddenThemes?.join("，") ?? "", ending: constraints.endingRequirement ?? "",
    rounds: request.revisionRounds, budget: String(request.callBudget),
    materialTitle: material?.title ?? "", materialText: material?.text ?? "", materialRights: material !== undefined,
    providerKey: request.providerKey ?? "",
  };
}

function startError(caught: unknown, projectCreated: boolean): string {
  const work = projectCreated ? "作品已经创建。" : "";
  if (caught instanceof TitleWritingError) {
    if (caught.code === "AUTO_CREATION_DAILY_QUOTA_LOW") {
      return `${work}最近 24 小时还剩 ${String(caught.details?.remainingCalls ?? "?")} 次调用，这次创作正常需要 ${String(caught.details?.requiredCalls ?? "?")} 次。没有创建任务，也没有发出调用。`;
    }
    if (caught.status > 0 && caught.status < 500) return `${work}${caught.detail} 没有创建新任务。`;
  }
  if (caught instanceof ApiError && caught.status > 0 && caught.status < 500) return `作品没有创建：${caught.detail}`;
  return "没有确认是否已经启动（网络或服务异常）。设置已保留，重试会使用同一个请求标识，不会重复创建或重复收费。";
}

/**
 * "AI 自动创作": an optional one-line idea, the size and the budget, then one click. Everything else is optional and
 * left to the AI when empty. The page shows the real provider, the research method and the call counts first.
 */
export function AutoCreationStart() {
  const [options, setOptions] = useState<AutoCreationOptionsView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [idea, setIdea] = useState("");
  const [episodeCount, setEpisodeCount] = useState(1);
  const [seconds, setSeconds] = useState(60);
  const [genre, setGenre] = useState("");
  const [audience, setAudience] = useState("");
  const [maxCharacters, setMaxCharacters] = useState("");
  const [maxLocations, setMaxLocations] = useState("");
  const [forbidden, setForbidden] = useState("");
  const [ending, setEnding] = useState("");
  const [rounds, setRounds] = useState(2);
  const [budget, setBudget] = useState("");
  const [materialTitle, setMaterialTitle] = useState("");
  const [materialText, setMaterialText] = useState("");
  const [materialRights, setMaterialRights] = useState(false);
  const [providerKey, setProviderKey] = useState("");
  const [providerExplicit, setProviderExplicit] = useState(false);
  const [token, setToken] = useState("");
  const [pending, setPending] = useState<PendingAutoStart | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const operation = useRef<object | null>(null);

  useEffect(() => {
    let alive = true;
    setPending(readPending());
    void auto.options().then((value) => {
      if (!alive) return;
      const normalized = normalizeAutoOptions(value);
      setOptions(normalized);
      if (normalized?.defaultProvider) setProviderKey(normalized.defaultProvider);
      if (normalized) {
        setEpisodeCount(normalized.episodePlan.defaultEpisodes);
        setSeconds(normalized.episodePlan.defaultSeconds);
      }
    }).catch(() => { if (alive) setOptions(null); }).finally(() => { if (alive) setLoaded(true); });
    return () => { alive = false; operation.current = null; };
  }, []);

  const unavailable = loaded ? autoOptionsUnavailable(options) : null;
  const target = options ? providerTarget(options.providers, providerKey, providerExplicit) : { kind: "none" as const };
  const chosen = target.kind === "ready" ? target.option : null;
  const readyProviders = options?.providers.filter((item) => item.ready) ?? [];
  const needsToken = tokenRequired(options);
  // While a start is pending, the card shows the request a retry replays; loaded options and defaults never change it.
  const frozen = pending?.request ?? null;
  const shown: ShownSettings = frozen ? frozenSettings(frozen) : {
    idea, episodeCount, seconds, genre, audience, maxCharacters, maxLocations, forbidden, ending, rounds, budget,
    materialTitle, materialText, materialRights, providerKey,
  };
  const frozenProvider = frozen?.providerKey ? options?.providers.find((item) => item.providerKey === frozen.providerKey) ?? null : null;
  const providerChanged = frozen?.providerKey && options
    ? !frozenProvider?.ready || (frozen.model !== undefined && !(frozenProvider.models ?? []).includes(frozen.model)) : false;
  const normal = autoCreationNormalCalls(shown.episodeCount);
  const worst = autoCreationWorstCalls(shown.episodeCount, shown.rounds);
  const hardCap = autoCreationHardCap(shown.episodeCount, shown.rounds);
  const budgetParsed = wholeNumber(budget, 1, 60);
  const budgetValue = frozen ? frozen.callBudget : valueOr(budgetParsed, hardCap);
  const charactersParsed = wholeNumber(maxCharacters, 1, 8);
  const locationsParsed = wholeNumber(maxLocations, 1, 6);
  // Every number is checked before anything is created: an invalid value is never treated as "not set".
  // A frozen request was checked when it was made and is replayed as it is, so only the form is checked here.
  const budgetProblem = frozen ? null : budgetParsed.kind === "invalid" ? "调用预算必须是整数。"
    : budgetValue < normal ? `调用预算至少要 ${String(normal)} 次（正常流程所需）。`
      : budgetValue > hardCap ? `调用预算最多 ${String(hardCap)} 次。` : null;
  const forbiddenThemes = forbidden.split(/[,，、]/u).map((item) => item.trim()).filter(Boolean);
  // A hard constraint is never dropped: more than five themes, or a theme over 20 characters, is refused instead.
  const constraintProblem = frozen ? null : charactersParsed.kind === "invalid" ? "出场人物最多人数必须是 1–8 的整数，或留空由 AI 决定。"
    : locationsParsed.kind === "invalid" ? "地点最多个数必须是 1–6 的整数，或留空由 AI 决定。"
      : forbiddenThemes.length > 5 ? `禁止的题材或元素最多 5 项（现在 ${String(forbiddenThemes.length)} 项），请合并或删减后再开始。`
        : forbiddenThemes.some((item) => item.length > 20) ? "每项禁止的题材或元素最多 20 字。" : null;
  const providerText = frozen
    ? frozen.providerKey ? `${frozenProvider?.label ?? frozen.providerKey} · ${frozen.model ?? ""}` : "原请求没有指定模型服务"
    : chosen ? `${chosen.label} · ${chosen.defaultModel ?? ""}` : target.kind === "blocked" ? target.reason : "未选择";
  // The provider select shows the request's own provider even when it is no longer among the ready ones.
  const strayProvider = frozen ? !readyProviders.some((item) => item.providerKey === shown.providerKey) : target.kind === "blocked";
  const locked = busy || pending !== null;

  async function send(draft: PendingAutoStart) {
    const mine = {};
    operation.current = mine;
    const live = () => operation.current === mine;
    setBusy(true);
    setError(null);
    let current = draft;
    try {
      if (!current.projectId) {
        const created = await studio.write<unknown>({ path: "/projects", idempotencyKey: current.projectKey,
          body: { title: current.title, premise: current.request.idea, episodeCount: current.request.episodeCount, targetEpisodeSeconds: current.request.episodeSeconds } });
        if (!live()) return;
        const id = created.body && typeof created.body === "object" ? (created.body as { id?: unknown }).id : undefined;
        if (!isEntityId(id)) throw new TitleWritingUnconfirmedError(created.status);
        const next = { ...current, projectId: id };
        if (!savePending(next, "own")) {
          setError("浏览器没能保存这次请求的标识，为避免重复创建，没有继续。");
          return;
        }
        current = next;
        setPending(next);
      }
      await auto.start(current.projectId!, current.request, { token: needsToken ? token.trim() : "", idempotencyKey: current.runKey });
      if (!live()) return;
      clearPending(current);
      window.location.assign(`/projects/${current.projectId!}/auto`);
    } catch (caught) {
      if (live()) setError(startError(caught, current.projectId !== null));
    } finally {
      if (live()) {
        operation.current = null;
        setBusy(false);
      }
    }
  }

  async function start() {
    if (operation.current || !loaded) return;
    if (pending) {
      await send(pending);
      return;
    }
    if (unavailable) return setError(unavailable);
    if (target.kind === "blocked") return setError(target.reason);
    if (budgetProblem) return setError(budgetProblem);
    if (constraintProblem) return setError(constraintProblem);
    if (needsToken && token.trim().length === 0) return setError("请先填写操作者令牌。");
    if (materialText.trim().length > 0 && !materialRights) return setError("请确认你拥有这份资料的使用权限，或清空资料。");
    const request: AutoStartBody = {
      idea: idea.trim(),
      constraints: {
        genre: genre.trim(), audience: audience.trim(), maxCharacters: valueOr(charactersParsed, null), maxLocations: valueOr(locationsParsed, null),
        forbiddenThemes, endingRequirement: ending.trim(),
      },
      materials: materialText.trim().length > 0
        ? [{ title: materialTitle.trim() || "我的资料", kind: "notes", text: materialText, rightsConfirmed: true }] : [],
      episodeCount, episodeSeconds: seconds, revisionRounds: rounds, callBudget: budgetValue,
      ...(chosen ? { providerKey: chosen.providerKey, ...(chosen.defaultModel ? { model: chosen.defaultModel } : {}) } : {}),
    };
    const draft: PendingAutoStart = {
      version: 1,
      title: (idea.trim() ? suggestTitle(idea) : "") || `AI 自动创作 ${new Date().toLocaleDateString("zh-CN")}`,
      request, projectKey: crypto.randomUUID(), projectId: null, runKey: crypto.randomUUID(),
    };
    if (!savePending(draft, "empty")) return setError("浏览器没能保存这次请求的标识（会话存储不可用），为避免重复创建或重复收费，没有发送。");
    setPending(draft);
    await send(draft);
  }

  function abandon() {
    if (operation.current || !pending) return;
    clearPending(pending);
    setPending(null);
    setError(null);
  }

  const research = options?.research;
  return (
    <section className={styles.startCard} aria-labelledby="auto-start-title" data-testid="auto-creation-start">
      <h2 id="auto-start-title" className={styles.cardTitle}>AI 自动创作</h2>
      <p className={styles.cardIntro}>
        可以只写一句想法，也可以什么都不填。AI 会自动完成资料研究、选题比较与选择、故事与结局、人物地点、分集大纲、逐集剧本、质量检查和有限修改，
        最后保存为可下载的剧本包和作品草稿。过程中不需要逐步确认。
      </p>
      {pending && !busy ? (
        <div className={styles.notice} role="status">
          <p>上次的启动请求还没有确认结果。重试会原样重放，使用同一个请求标识，不会重复创建或收费。</p>
          <p className={styles.actions}>
            {pending.projectId ? <a className={styles.secondary} href={`/projects/${pending.projectId}/auto`}>查看进度</a> : null}
            <button className={styles.textLink} type="button" onClick={abandon}>放弃上次请求，重新填写</button>
          </p>
        </div>
      ) : null}
      <label className={styles.label} htmlFor="auto-idea">一句话想法（可不填）</label>
      <input id="auto-idea" className={styles.input} maxLength={300} placeholder="不填则由 AI 根据资料自主策划" value={shown.idea}
        disabled={locked} onChange={(event) => setIdea(event.target.value)} />
      <div className={styles.planGrid}>
        <div>
          <label className={styles.label} htmlFor="auto-episodes">集数</label>
          <select id="auto-episodes" className={styles.input} value={shown.episodeCount} disabled={locked}
            onChange={(event) => setEpisodeCount(Number(event.target.value))}>
            {EPISODE_COUNTS.map((value) => <option key={value} value={value}>{value} 集</option>)}
          </select>
        </div>
        <div>
          <label className={styles.label} htmlFor="auto-seconds">每集时长</label>
          <select id="auto-seconds" className={styles.input} value={shown.seconds} disabled={locked}
            onChange={(event) => setSeconds(Number(event.target.value))}>
            {SECONDS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </div>
      </div>
      <details className={styles.more}>
        <summary>高级设置（可不填，留空由 AI 决定；填写的内容是必须遵守的硬约束）</summary>
        <div className={styles.moreGrid}>
          <label className={styles.label} htmlFor="auto-genre">题材</label>
          <input id="auto-genre" className={styles.input} maxLength={20} value={shown.genre} disabled={locked} onChange={(event) => setGenre(event.target.value)} />
          <label className={styles.label} htmlFor="auto-audience">目标观众</label>
          <input id="auto-audience" className={styles.input} maxLength={40} value={shown.audience} disabled={locked} onChange={(event) => setAudience(event.target.value)} />
          <label className={styles.label} htmlFor="auto-characters">出场人物最多（人）</label>
          <input id="auto-characters" className={styles.input} inputMode="numeric" value={shown.maxCharacters} disabled={locked} onChange={(event) => setMaxCharacters(event.target.value)} />
          <label className={styles.label} htmlFor="auto-locations">地点最多（个）</label>
          <input id="auto-locations" className={styles.input} inputMode="numeric" value={shown.maxLocations} disabled={locked} onChange={(event) => setMaxLocations(event.target.value)} />
          <label className={styles.label} htmlFor="auto-forbidden">禁止的题材或元素（用逗号分隔）</label>
          <input id="auto-forbidden" className={styles.input} maxLength={110} value={shown.forbidden} disabled={locked} onChange={(event) => setForbidden(event.target.value)} />
          <label className={styles.label} htmlFor="auto-ending">结局要求</label>
          <input id="auto-ending" className={styles.input} maxLength={100} value={shown.ending} disabled={locked} onChange={(event) => setEnding(event.target.value)} />
          <label className={styles.label} htmlFor="auto-rounds">最多修改轮次</label>
          <select id="auto-rounds" className={styles.input} value={shown.rounds} disabled={locked} onChange={(event) => setRounds(Number(event.target.value))}>
            {[0, 1, 2].map((value) => <option key={value} value={value}>{value} 轮</option>)}
          </select>
          <label className={styles.label} htmlFor="auto-budget">调用预算（次，默认 {hardCap}）</label>
          <input id="auto-budget" className={styles.input} inputMode="numeric" placeholder={String(hardCap)} value={shown.budget} disabled={locked} onChange={(event) => setBudget(event.target.value)} />
          <label className={styles.label} htmlFor="auto-material-title">我的参考资料（剧本、字幕或笔记文字，可不填）</label>
          <input id="auto-material-title" className={styles.input} maxLength={60} placeholder="资料名称" value={shown.materialTitle} disabled={locked} onChange={(event) => setMaterialTitle(event.target.value)} />
          <textarea className={styles.input} aria-label="资料文字" rows={3} maxLength={6000} value={shown.materialText} disabled={locked} onChange={(event) => setMaterialText(event.target.value)} />
          <label className={styles.check}>
            <input type="checkbox" checked={shown.materialRights} disabled={locked} onChange={(event) => setMaterialRights(event.target.checked)} />
            我拥有这份资料的使用权限。AI 只分析结构和需求，不复制台词、人物组合或具体情节。
          </label>
          {readyProviders.length > 1 || (strayProvider && readyProviders.length > 0) ? (
            <>
              <label className={styles.label} htmlFor="auto-provider">模型服务</label>
              <select id="auto-provider" className={styles.input} value={shown.providerKey} disabled={locked}
                onChange={(event) => { setProviderKey(event.target.value as TitleWritingProviderKey); setProviderExplicit(true); }}>
                {strayProvider ? <option value={shown.providerKey} disabled>{options?.providers.find((item) => item.providerKey === shown.providerKey)?.label ?? shown.providerKey}{shown.providerKey ? "（暂不可用）" : "原请求未指定"}</option> : null}
                {readyProviders.map((item) => <option key={item.providerKey} value={item.providerKey}>{item.label}</option>)}
              </select>
            </>
          ) : null}
        </div>
      </details>

      <section className={styles.config} aria-labelledby="auto-plan-title" data-testid="auto-plan">
        <h3 id="auto-plan-title" className={styles.configTitle}>开始前请确认</h3>
        {!loaded ? <p className={styles.helper} role="status">正在读取服务端配置…</p> : null}
        {unavailable ? <p className={styles.warning} role="status">{unavailable}</p> : null}
        {options && !unavailable ? (
          <ul className={autoStyles.list}>
            <li data-testid="auto-provider-target">模型：{providerText}（所有阶段使用同一个模型，不会自动改用其他服务）</li>
            {providerChanged ? (
              <li data-testid="auto-provider-changed">服务端当前配置已变化：原请求的模型服务或模型现在不可用。重试仍原样发送原请求，由服务端决定是否接受，不会改用其他服务或模型。</li>
            ) : null}
            <li data-testid="auto-calls">调用次数：正常 {normal} 次；含最多 {shown.rounds} 轮修改（每轮最多改 {autoCreationRevisionsPerRound(shown.episodeCount)} 集并复查）最坏 {worst} 次；
              包括你确认的续跑重发（{AUTO_CREATION_RESEND_ALLOWANCE} 次）在内，本次预算上限 {budgetValue} 次，不会超出。</li>
            <li>每次输出上限 {options.maxOutputTokensPerCall} tokens，输入不超过约 {options.maxPromptChars} 字。费用以服务商账单为准，本页不估算金额（费用未知）。</li>
            <li>管理员限额：最近 24 小时最多 {options.maxCallsPerDay} 次调用（与其他 AI 创作共用），同时最多 {options.maxActiveRuns} 个创作任务。</li>
            <li data-testid="auto-research-mode">研究方式：内置资料快照 {research?.builtInSources} 条（其中可读的市场资料 {research?.readableMarketSources} 条）
              {research?.fetchEnabled ? `，并读取公开页面（${research.allowedHosts.join("、")}）` : "；服务端未开启公开页面读取"}；没有视频画面分析能力，只分析文字。
              {research?.expectedMode === "limited" ? "预计为「资料有限策划模式」：受众判断是待验证假设，不是实时市场验证。" : null}</li>
            <li>每集时长是写作目标，不代表成片长度。完成后保存为「AI 自动生成草稿」，机器质量检查不等于人工审核，也不会自动发布。</li>
            <li>本功能只交付剧本包和生产准备包；当前没有接入真实图片、语音、视频服务，不会生成成片。</li>
          </ul>
        ) : null}
        {budgetProblem ? <p className={styles.warning} role="status">{budgetProblem}</p> : null}
        {constraintProblem ? <p className={styles.warning} role="status">{constraintProblem}</p> : null}
        {needsToken && options && !unavailable ? (
          <>
            <label className={styles.label} htmlFor="auto-token">AI 自动创作的操作者令牌</label>
            <input id="auto-token" className={styles.input} type="password" autoComplete="off" value={token} disabled={busy} onChange={(event) => setToken(event.target.value)} />
          </>
        ) : null}
      </section>
      <div className={styles.actions}>
        <button className={styles.primary} type="button" disabled={busy || !loaded || (pending === null && unavailable !== null)} onClick={() => void start()}>
          {busy ? "正在启动…" : pending ? "重试上次请求" : "AI 自动创作"}
        </button>
      </div>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
    </section>
  );
}
