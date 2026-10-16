"use client";

import { useEffect, useRef, useState } from "react";
import {
  TITLE_WRITING_PROVIDER_LABELS, TITLE_WRITING_STORED_PROVIDER_KEYS, titleWritingCallCap, titleWritingRequiredCalls,
  type TitleWritingProviderKey, type TitleWritingStoredProviderKey,
} from "@ai-drama/contracts";
import { ApiError, StudioClient } from "../lib/studio-client";
import {
  TitleWritingClient,
  TitleWritingError,
  TitleWritingUnconfirmedError,
  isEntityId,
  normalizeOptions,
  optionsUnavailableReason,
  tokenRequired,
  type StartBody,
  type TitleWritingOptionsView,
} from "../lib/title-writing-client";
import { EpisodeWritingGuidance } from "./episode-writing-guidance";
import styles from "./title-writing.module.css";

const studio = new StudioClient();
const writing = new TitleWritingClient();
const DRAFT_KEY = "title-writing:start";
const TITLE_MAX = 60;
/** A new work's episode plan: the server freezes exactly these into the work and its writing run. */
const EPISODE_COUNTS = [1, 2, 3, 4, 5, 6];
const SECONDS: ReadonlyArray<{ value: number; label: string }> = [{ value: 60, label: "约 1 分钟" }, { value: 90, label: "约 1.5 分钟" }];
/**
 * A stored start may name a retired provider: it stays readable and can still be replayed (the server answers from the
 * run it created, or refuses without creating anything); it is never dropped as damaged.
 */
const STORED_PROVIDERS: readonly string[] = TITLE_WRITING_STORED_PROVIDER_KEYS;

/**
 * One start whose result is not confirmed yet: the frozen request exactly as sent, and the keys of both writes.
 * While it exists the form shows it and only it can be sent again; a new creation is a separate, explicit choice.
 * version 2 is a record saved by the earlier page (no plan: three episodes, 30–180 seconds); it is replayed exactly as
 * it was saved, so its work and run keep their original identity. version 3 carries the new work's episode plan.
 */
interface PendingStartV2 {
  version: 2;
  request: StartBody & { settings: { episodeSeconds: number; style: string } };
  projectKey: string;
  projectId: string | null;
  runKey: string;
}

interface PendingStartV3 {
  version: 3;
  plan: { episodeCount: number; targetEpisodeSeconds: number };
  request: StartBody & { settings: { episodeCount: number; episodeSeconds: number; style: string } };
  projectKey: string;
  projectId: string | null;
  runKey: string;
}

type PendingStart = PendingStartV2 | PendingStartV3;

function isPendingStart(value: unknown): value is PendingStart {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<PendingStartV3> & { version?: unknown };
  const request = draft.request as Partial<PendingStartV3["request"]> | undefined;
  const common = typeof draft.projectKey === "string" && typeof draft.runKey === "string"
    && (draft.projectId === null || typeof draft.projectId === "string")
    && !!request && typeof request.title === "string" && !!request.settings
    && typeof request.settings.episodeSeconds === "number" && typeof request.settings.style === "string"
    && (request.providerKey === undefined || STORED_PROVIDERS.includes(request.providerKey))
    && (request.model === undefined || typeof request.model === "string");
  if (!common) return false;
  if ((value as { version?: unknown }).version === 2) return true;
  const plan = draft.plan;
  return draft.version === 3 && !!plan && EPISODE_COUNTS.includes(plan.episodeCount)
    && SECONDS.some((item) => item.value === plan.targetEpisodeSeconds)
    && request.settings!.episodeCount === plan.episodeCount && request.settings!.episodeSeconds === plan.targetEpisodeSeconds;
}

function readPendingStart(): PendingStart | null {
  try {
    const raw = window.sessionStorage.getItem(DRAFT_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : null;
    return isPendingStart(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** One start is one pair of keys: its record may only be replaced or removed by that same start. */
function sameStart(a: PendingStart, b: PendingStart): boolean {
  return a.projectKey === b.projectKey && a.runKey === b.runKey;
}

/**
 * Saves and reads back. A new start may only take an empty slot; a known start may only update its own record. False
 * means the request identity could not be kept (or belongs to another start), so no write may be sent.
 */
function savePendingStart(draft: PendingStart, slot: "empty" | "own"): boolean {
  try {
    const stored = readPendingStart();
    if (slot === "empty" ? stored !== null : stored === null || !sameStart(stored, draft)) return false;
    const text = JSON.stringify(draft);
    window.sessionStorage.setItem(DRAFT_KEY, text);
    return window.sessionStorage.getItem(DRAFT_KEY) === text;
  } catch {
    return false;
  }
}

/** Removes the record of this start only; a newer start's record stays. */
function clearPendingStart(draft: PendingStart): void {
  try {
    const stored = readPendingStart();
    if (stored && sameStart(stored, draft)) window.sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // Nothing to keep: the start was confirmed or explicitly abandoned.
  }
}

const NOT_SAVED = "浏览器没能保存这次请求的标识（会话存储不可用或已满），为避免重复创建作品或重复开始创作，没有发送请求。可以换用普通窗口后再试。";

/** Normal requests and the hard cap of a run of n episodes, as the server counts them (contracts). */
function callsFor(episodeCount: number): { required: number; cap: number } {
  return { required: titleWritingRequiredCalls(episodeCount), cap: titleWritingCallCap(episodeCount) };
}

/**
 * Creating the work and its writing run are separate writes. A refusal of this attempt does not settle an earlier
 * lost receipt: only the quota refusal (after the server's idempotency lookup) proves no new run or call this time.
 */
function startError(caught: unknown, projectCreated: boolean): string {
  const work = projectCreated ? "作品已经创建，可以在作品列表里找到。" : "";
  const previous = "此前未确认的请求可能已经执行，请先查看进度；重试仍会使用原请求标识。";
  if (caught instanceof TitleWritingError) {
    const missing = Array.isArray(caught.details?.missing) ? (caught.details.missing as string[]).join("、") : "";
    if (caught.code === "TITLE_WRITING_FORBIDDEN") return `${work}操作者令牌不正确，本次请求没有被受理。${previous}改正令牌后可以重试上次请求。`;
    if (caught.code === "TITLE_WRITING_OTHER_TASK_ACTIVE") {
      return `${work}这部作品正在进行剧本拆解，标题创作暂时不能开始。本次请求没有创建任务，也没有发出模型调用。等拆解结束后，可以重试上次请求（使用同一个请求标识）。`;
    }
    if (caught.code === "TITLE_WRITING_PROVIDER_UNCONFIGURED") return `${work}所选模型服务没有配置完整${missing ? `（缺少 ${missing}）` : ""}，本次请求没有被受理。${previous}`;
    if (caught.code === "TITLE_WRITING_PROVIDER_RETIRED") {
      // Refused only after the server found no run for this request identity: nothing was created or sent, now or before.
      return `${work}上次请求选择的模型服务（${String(caught.details?.label ?? caught.details?.providerKey ?? "")}）已经退役。服务端没有找到这次请求创建的任务，也没有发出模型调用。可以放弃上次请求，改用 OpenAI 或 Claude 重新开始。`;
    }
    if (caught.code === "TITLE_WRITING_PROVIDER_STORAGE_UNAVAILABLE") {
      return `${work}所选模型服务的数据库迁移还没有执行，本次请求没有创建任务，也没有发出模型调用。可以改用其他已就绪的模型服务。`;
    }
    if (caught.code === "TITLE_WRITING_DAILY_QUOTA_LOW") {
      const required = Number(caught.details?.requiredCalls);
      const remaining = Number(caught.details?.remainingCalls);
      const counts = Number.isFinite(required) && Number.isFinite(remaining) ? `最近 24 小时还剩 ${String(remaining)} 次调用，这次创作正常需要 ${String(required)} 次。` : "";
      return `${work}${counts}额度不够，本次请求未创建新任务，也未发出模型调用。可以以后再试，或放弃上次请求改选更少的集数。`;
    }
    if (caught.status > 0 && caught.status < 500) return `${work}${caught.detail} 本次请求没有被受理。${previous}`;
  }
  if (caught instanceof ApiError && caught.status > 0 && caught.status < 500) {
    return `本次创建作品请求没有被受理：${caught.detail}。此前未确认的请求可能已经执行，请先查看作品列表；重试仍会使用原请求标识。`;
  }
  return "没有确认是否已经启动（网络或服务异常）。剧名和设置已保留。可以先查看进度，或重试上次请求：重试会使用同一个请求标识。";
}

/** "AI 一键创作": the title is the only required creative input. Keys, tokens and budgets stay in their own section. */
export function TitleWritingStart() {
  const [options, setOptions] = useState<TitleWritingOptionsView | null>(null);
  const [optionsLoaded, setOptionsLoaded] = useState(false);
  const [title, setTitle] = useState("");
  const [episodeCount, setEpisodeCount] = useState(3);
  const [seconds, setSeconds] = useState(90);
  const [style, setStyle] = useState("");
  // A replayed start may still carry a retired provider; the picker only ever offers ready active providers.
  const [providerKey, setProviderKey] = useState<TitleWritingStoredProviderKey | "">("");
  const [model, setModel] = useState("");
  const [token, setToken] = useState("");
  const [pending, setPending] = useState<PendingStart | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The send in progress on this mounted page. Leaving the page or starting another send replaces it, and an answer
  // that arrives for a replaced send changes nothing: no state, no storage, no navigation.
  const operation = useRef<object | null>(null);
  const pendingRef = useRef<PendingStart | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const tokenRef = useRef<HTMLInputElement>(null);

  function showPending(draft: PendingStart | null) {
    pendingRef.current = draft;
    setPending(draft);
    if (!draft) return;
    setTitle(draft.request.title);
    setEpisodeCount(draft.version === 3 ? draft.plan.episodeCount : 3);
    setSeconds(draft.request.settings.episodeSeconds);
    setStyle(draft.request.settings.style);
    setProviderKey(draft.request.providerKey ?? "");
    setModel(draft.request.model ?? "");
  }

  useEffect(() => () => {
    // Leaving does not cancel anything on the server; the saved identity stays so the request can be replayed.
    operation.current = null;
  }, []);

  useEffect(() => {
    let alive = true;
    showPending(readPendingStart());
    void writing.options().then((value) => {
      if (!alive) return;
      const normalized = normalizeOptions(value);
      setOptions(normalized);
      // Defaults fill an empty form only; they never change a restored, unconfirmed request.
      if (pendingRef.current) return;
      if (normalized?.defaultProvider) {
        setProviderKey(normalized.defaultProvider);
        setModel(normalized.providers.find((item) => item.providerKey === normalized.defaultProvider)?.defaultModel ?? "");
      }
      if (normalized?.episodePlan) {
        setEpisodeCount(normalized.episodePlan.defaultEpisodes);
        setSeconds(normalized.episodePlan.defaultSeconds);
      }
    }).catch(() => {
      if (alive) setOptions(null);
    }).finally(() => {
      if (alive) setOptionsLoaded(true);
    });
    return () => { alive = false; };
  }, []);

  const unavailable = optionsLoaded ? optionsUnavailableReason(options) : null;
  // A new work needs the episode plan storage; a restored request from the earlier page has no plan and does not.
  const planUnavailable = optionsLoaded && options && !unavailable && options.episodePlanReady !== true
    ? "集数和时长设置还没有在服务器上就绪（数据库迁移尚未执行），暂时不能用 AI 一键创作新作品。可以先手动创作。" : null;
  const readyProviders = options?.providers.filter((item) => item.ready) ?? [];
  // With the site login on, the signed-in administrator authorizes the call; no token field is shown or sent.
  const needsToken = tokenRequired(options);
  const chosen = readyProviders.find((item) => item.providerKey === providerKey) ?? null;
  const locked = busy || pending !== null;

  function chooseProvider(next: TitleWritingProviderKey) {
    setProviderKey(next);
    setModel(readyProviders.find((item) => item.providerKey === next)?.defaultModel ?? "");
  }

  /**
   * Sends the frozen request with its own keys. Every key is saved before the write that uses it. Only a receipt that
   * proves the result (a project id, then a run of that project) confirms the start; anything else keeps the keys.
   */
  async function send(draft: PendingStart) {
    const mine = {};
    operation.current = mine;
    const live = () => operation.current === mine;
    setBusy(true);
    setError(null);
    let current = draft;
    try {
      if (!current.projectId) {
        // The work carries the plan; a record from the earlier page creates the work exactly as it would have then.
        const body = current.version === 3 ? { title: current.request.title, premise: "", ...current.plan } : { title: current.request.title, premise: "" };
        const created = await studio.write<unknown>({ path: "/projects", body, idempotencyKey: current.projectKey });
        if (!live()) return;
        const id = created.body && typeof created.body === "object" ? (created.body as { id?: unknown }).id : undefined;
        if (!isEntityId(id)) throw new TitleWritingUnconfirmedError(created.status);
        const next = { ...current, projectId: id };
        if (!savePendingStart(next, "own")) {
          setError(NOT_SAVED);
          return;
        }
        current = next;
        showPending(current);
      }
      const projectId = current.projectId!;
      try {
        await writing.start(projectId, current.request, { token: needsToken ? token.trim() : "", idempotencyKey: current.runKey });
      } catch (caught) {
        // Another start of this work is already running: show that one instead of starting a second.
        if (!(caught instanceof TitleWritingError && caught.code === "TITLE_WRITING_RUN_ACTIVE")) throw caught;
      }
      if (!live()) return;
      clearPendingStart(current);
      showPending(null);
      window.location.assign(`/projects/${projectId}/writing`);
    } catch (caught) {
      if (live()) setError(startError(caught, current.projectId !== null));
    } finally {
      if (live()) {
        operation.current = null;
        setBusy(false);
      }
    }
  }

  function checkReady(draft: PendingStart | null): boolean {
    if (!optionsLoaded) return false;
    if (unavailable) {
      setError(unavailable);
      return false;
    }
    if (planUnavailable && draft?.version !== 2) {
      setError(planUnavailable);
      return false;
    }
    if (needsToken && token.trim().length === 0) {
      setError("请先在「配置与权限」填写操作者令牌。它只用于确认这次调用由你发起，不属于故事内容。");
      tokenRef.current?.focus();
      return false;
    }
    return true;
  }

  async function start() {
    if (operation.current) return;
    if (pendingRef.current) {
      await retry();
      return;
    }
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      setError("先写一个剧名。");
      titleRef.current?.focus();
      return;
    }
    if (!checkReady(null)) return;
    const draft: PendingStart = {
      version: 3,
      plan: { episodeCount, targetEpisodeSeconds: seconds },
      request: {
        title: trimmed,
        ...(chosen ? { providerKey: chosen.providerKey, ...(model || chosen.defaultModel ? { model: model || chosen.defaultModel! } : {}) } : {}),
        settings: { episodeCount, episodeSeconds: seconds, style: style.trim() },
      },
      projectKey: crypto.randomUUID(),
      projectId: null,
      runKey: crypto.randomUUID(),
    };
    if (!savePendingStart(draft, "empty")) {
      setError(NOT_SAVED);
      return;
    }
    showPending(draft);
    await send(draft);
  }

  /** Replays the unconfirmed request exactly: same body, same project key, same run key. */
  async function retry() {
    const draft = pendingRef.current;
    if (operation.current || !draft || !checkReady(draft)) return;
    await send(draft);
  }

  /** An explicit new creation: the unconfirmed request is abandoned and the form is free again. */
  function abandon() {
    const draft = pendingRef.current;
    if (operation.current || !draft) return;
    clearPendingStart(draft);
    showPending(null);
    setError(null);
  }

  return (
    <section className={styles.startCard} aria-labelledby="ai-start-title">
      <h2 id="ai-start-title" className={styles.cardTitle}>AI 一键创作</h2>
      <p className={styles.cardIntro}>只填剧名，选好集数和每集时长。AI 会补全题材、人物、梗概、故事走向、分集大纲和每一集剧本，结果存为可修改的草稿。</p>
      {pending && !busy ? (
        <div className={styles.notice} role="status">
          <p>上次的启动请求还没有确认结果。下面是当时提交的剧名和设置，重试会原样重放它，使用同一个请求标识。</p>
          <p className={styles.actions}>
            {pending.projectId ? <a className={styles.secondary} href={`/projects/${pending.projectId}/writing`}>查看进度</a> : null}
            <button className={styles.textLink} type="button" onClick={abandon}>放弃上次请求，重新填写</button>
          </p>
        </div>
      ) : null}
      <label className={styles.label} htmlFor="ai-title">剧名</label>
      <input
        ref={titleRef}
        id="ai-title"
        className={styles.input}
        maxLength={TITLE_MAX}
        placeholder="例如：夜班证词"
        value={title}
        disabled={locked}
        onChange={(event) => setTitle(event.target.value)}
      />
      {pending?.version === 2 ? (
        <p className={styles.fixed}>集数：3 集 · 每集约 {pending.request.settings.episodeSeconds} 秒（上次请求来自旧版页面，按原样重放）</p>
      ) : (
        <div className={styles.planGrid}>
          <div>
            <label className={styles.label} htmlFor="ai-episodes">集数</label>
            <select id="ai-episodes" className={styles.input} value={episodeCount} disabled={locked} onChange={(event) => setEpisodeCount(Number(event.target.value))}>
              {EPISODE_COUNTS.map((value) => <option key={value} value={value}>{value} 集</option>)}
            </select>
          </div>
          <div>
            <label className={styles.label} htmlFor="ai-seconds">每集时长</label>
            <select id="ai-seconds" className={styles.input} value={seconds} disabled={locked} onChange={(event) => setSeconds(Number(event.target.value))}>
              {SECONDS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </div>
        </div>
      )}
      {pending?.version !== 2 ? (
        <p className={styles.helper}>
          正常需要 {callsFor(episodeCount).required} 次模型调用，这次创作最多 {callsFor(episodeCount).cap} 次（上限，不会自动重试）。
          每集时长是写作目标，用来控制剧本篇幅，不代表成片已经达到这个长度。作品创建后集数不能再改。
        </p>
      ) : null}
      <details className={styles.more} open={pending !== null || undefined}>
        <summary>更多设置（可不填）</summary>
        <div className={styles.moreGrid}>
          <label className={styles.label} htmlFor="ai-style">风格</label>
          <input id="ai-style" className={styles.input} maxLength={40} placeholder="不填则由 AI 根据剧名判断" value={style}
            disabled={locked} onChange={(event) => setStyle(event.target.value)} />
          {pending?.request.providerKey ? (
            <p className={styles.fixed}>
              模型服务：{options?.providers.find((item) => item.providerKey === pending.request.providerKey)?.label
                ?? TITLE_WRITING_PROVIDER_LABELS[pending.request.providerKey as TitleWritingStoredProviderKey] ?? pending.request.providerKey}
              {" · "}{pending.request.model ?? "默认模型"}（上次提交的选择）
            </p>
          ) : readyProviders.length > 0 ? (
            <>
              <label className={styles.label} htmlFor="ai-provider">模型服务</label>
              <select id="ai-provider" className={styles.input} value={providerKey} disabled={locked}
                onChange={(event) => chooseProvider(event.target.value as TitleWritingProviderKey)}>
                {readyProviders.map((item) => <option key={item.providerKey} value={item.providerKey}>{item.label}</option>)}
              </select>
              <label className={styles.label} htmlFor="ai-model">模型</label>
              <select id="ai-model" className={styles.input} value={model} disabled={locked} onChange={(event) => setModel(event.target.value)}>
                {(chosen?.models ?? []).map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </>
          ) : null}
        </div>
      </details>
      <EpisodeWritingGuidance />
      <div className={styles.actions}>
        <button className={styles.primary} type="button" disabled={busy || !optionsLoaded} onClick={() => void start()}>
          {busy ? "正在启动…" : pending ? "重试上次请求" : "AI 一键创作"}
        </button>
        <a className={styles.textLink} href="#manual-start">改为手动写想法</a>
      </div>
      {busy ? <p className={styles.helper} role="status">正在创建作品并启动创作。剧名和设置已锁定，完成前不能修改。</p> : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}

      <section className={styles.config} aria-labelledby="ai-config-title">
        <h3 id="ai-config-title" className={styles.configTitle}>配置与权限</h3>
        {!optionsLoaded ? <p className={styles.helper} role="status">正在读取服务端配置…</p> : null}
        {unavailable ? <p className={styles.warning} role="status">{unavailable}</p> : null}
        {planUnavailable ? <p className={styles.warning} role="status">{planUnavailable}</p> : null}
        {options && !unavailable ? (
          <p className={styles.helper}>
            服务端已配置：{readyProviders.map((item) => item.label).join("、")}。最近 24 小时最多 {options.maxCallsPerDay} 次模型调用；
            开始前剩余次数少于正常需要的次数时，不会创建任务。费用以服务商账单为准，本页不估算金额。
          </p>
        ) : null}
        {needsToken ? (
          <>
            <label className={styles.label} htmlFor="ai-token">操作者令牌</label>
            <input ref={tokenRef} id="ai-token" className={styles.input} type="password" autoComplete="off" value={token}
              disabled={busy} onChange={(event) => setToken(event.target.value)} />
            <p className={styles.helper}>只保存在本页内存，用来确认这次可能计费的调用由你发起；不写入浏览器存储，也不进入故事内容。模型密钥只在服务端。</p>
          </>
        ) : (
          <p className={styles.helper}>调用权限由当前管理员登录确认，不需要填写操作者令牌。模型密钥只在服务端。</p>
        )}
      </section>
    </section>
  );
}
