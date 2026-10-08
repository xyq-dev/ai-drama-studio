"use client";

import { useEffect, useRef, useState } from "react";
import type { TitleWritingProviderKey } from "@ai-drama/contracts";
import { ApiError, StudioClient } from "../lib/studio-client";
import {
  TitleWritingClient,
  TitleWritingError,
  normalizeOptions,
  optionsUnavailableReason,
  type StartBody,
  type TitleWritingOptionsView,
} from "../lib/title-writing-client";
import styles from "./title-writing.module.css";

const studio = new StudioClient();
const writing = new TitleWritingClient();
const DRAFT_KEY = "title-writing:start";
const TITLE_MAX = 60;
const SECONDS = [60, 90, 120, 180];
const PROVIDERS: readonly TitleWritingProviderKey[] = ["qwen", "openai", "deepseek"];

/**
 * One start whose result is not confirmed yet: the frozen request exactly as sent, and the keys of both writes.
 * While it exists the form shows it and only it can be sent again; a new creation is a separate, explicit choice.
 */
interface PendingStart {
  version: 2;
  request: StartBody & { settings: { episodeSeconds: number; style: string } };
  projectKey: string;
  projectId: string | null;
  runKey: string;
}

function isPendingStart(value: unknown): value is PendingStart {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<PendingStart>;
  const request = draft.request as Partial<PendingStart["request"]> | undefined;
  return draft.version === 2 && typeof draft.projectKey === "string" && typeof draft.runKey === "string"
    && (draft.projectId === null || typeof draft.projectId === "string")
    && !!request && typeof request.title === "string" && !!request.settings
    && typeof request.settings.episodeSeconds === "number" && typeof request.settings.style === "string"
    && (request.providerKey === undefined || PROVIDERS.includes(request.providerKey))
    && (request.model === undefined || typeof request.model === "string");
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

/** Saves and reads back. False means the request identity could not be kept, so no write may be sent. */
function savePendingStart(draft: PendingStart): boolean {
  try {
    const text = JSON.stringify(draft);
    window.sessionStorage.setItem(DRAFT_KEY, text);
    return window.sessionStorage.getItem(DRAFT_KEY) === text;
  } catch {
    return false;
  }
}

function clearPendingStart(): void {
  try {
    window.sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // Nothing to keep: the start was confirmed or explicitly abandoned.
  }
}

const NOT_SAVED = "浏览器没能保存这次请求的标识（会话存储不可用或已满），为避免重复创建作品或重复开始创作，没有发送请求。可以换用普通窗口后再试。";

function startError(caught: unknown): string {
  if (caught instanceof TitleWritingError) {
    const missing = Array.isArray(caught.details?.missing) ? (caught.details.missing as string[]).join("、") : "";
    if (caught.code === "TITLE_WRITING_FORBIDDEN") return "操作者令牌不正确，没有启动任何调用。改正令牌后可以重试上次请求。";
    if (caught.code === "TITLE_WRITING_PROVIDER_UNCONFIGURED") return `所选模型服务没有配置完整${missing ? `（缺少 ${missing}）` : ""}，没有启动任何调用。`;
    if (caught.status > 0 && caught.status < 500) return `${caught.detail} 上次请求没有被受理。`;
  }
  if (caught instanceof ApiError && caught.status > 0 && caught.status < 500) return `作品没有创建：${caught.detail}。上次请求没有被受理。`;
  return "没有确认是否已经启动（网络或服务异常）。剧名和设置已保留。可以先查看进度，或重试上次请求：重试会使用同一个请求标识。";
}

/** "AI 一键创作": the title is the only required creative input. Keys, tokens and budgets stay in their own section. */
export function TitleWritingStart() {
  const [options, setOptions] = useState<TitleWritingOptionsView | null>(null);
  const [optionsLoaded, setOptionsLoaded] = useState(false);
  const [title, setTitle] = useState("");
  const [seconds, setSeconds] = useState(90);
  const [style, setStyle] = useState("");
  const [providerKey, setProviderKey] = useState<TitleWritingProviderKey | "">("");
  const [model, setModel] = useState("");
  const [token, setToken] = useState("");
  const [pending, setPending] = useState<PendingStart | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const pendingRef = useRef<PendingStart | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const tokenRef = useRef<HTMLInputElement>(null);

  function showPending(draft: PendingStart | null) {
    pendingRef.current = draft;
    setPending(draft);
    if (!draft) return;
    setTitle(draft.request.title);
    setSeconds(draft.request.settings.episodeSeconds);
    setStyle(draft.request.settings.style);
    setProviderKey(draft.request.providerKey ?? "");
    setModel(draft.request.model ?? "");
  }

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
      if (normalized?.defaults) setSeconds(normalized.defaults.episodeSeconds);
    }).catch(() => {
      if (alive) setOptions(null);
    }).finally(() => {
      if (alive) setOptionsLoaded(true);
    });
    return () => { alive = false; };
  }, []);

  const unavailable = optionsLoaded ? optionsUnavailableReason(options) : null;
  const readyProviders = options?.providers.filter((item) => item.ready) ?? [];
  const chosen = readyProviders.find((item) => item.providerKey === providerKey) ?? null;
  const locked = busy || pending !== null;

  function chooseProvider(next: TitleWritingProviderKey) {
    setProviderKey(next);
    setModel(readyProviders.find((item) => item.providerKey === next)?.defaultModel ?? "");
  }

  /** Sends the frozen request with its own keys. Every key is saved before the write that uses it. */
  async function send(draft: PendingStart) {
    busyRef.current = true;
    setBusy(true);
    setError(null);
    let current = draft;
    try {
      if (!current.projectId) {
        const created = await studio.write<{ id: string }>({ path: "/projects", body: { title: current.request.title, premise: "" },
          idempotencyKey: current.projectKey });
        current = { ...current, projectId: created.body.id };
        showPending(current);
        if (!savePendingStart(current)) {
          setError(NOT_SAVED);
          return;
        }
      }
      const projectId = current.projectId!;
      try {
        await writing.start(projectId, current.request, { token: token.trim(), idempotencyKey: current.runKey });
      } catch (caught) {
        // Another start of this work is already running: show that one instead of starting a second.
        if (!(caught instanceof TitleWritingError && caught.code === "TITLE_WRITING_RUN_ACTIVE")) throw caught;
      }
      clearPendingStart();
      showPending(null);
      window.location.assign(`/projects/${projectId}/writing`);
    } catch (caught) {
      setError(startError(caught));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function checkReady(): boolean {
    if (!optionsLoaded) return false;
    if (unavailable) {
      setError(unavailable);
      return false;
    }
    if (token.trim().length === 0) {
      setError("请先在「配置与权限」填写操作者令牌。它只用于确认这次调用由你发起，不属于故事内容。");
      tokenRef.current?.focus();
      return false;
    }
    return true;
  }

  async function start() {
    if (busyRef.current) return;
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
    if (!checkReady()) return;
    const draft: PendingStart = {
      version: 2,
      request: {
        title: trimmed,
        ...(chosen ? { providerKey: chosen.providerKey, ...(model || chosen.defaultModel ? { model: model || chosen.defaultModel! } : {}) } : {}),
        settings: { episodeSeconds: seconds, style: style.trim() },
      },
      projectKey: crypto.randomUUID(),
      projectId: null,
      runKey: crypto.randomUUID(),
    };
    if (!savePendingStart(draft)) {
      setError(NOT_SAVED);
      return;
    }
    showPending(draft);
    await send(draft);
  }

  /** Replays the unconfirmed request exactly: same body, same project key, same run key. */
  async function retry() {
    const draft = pendingRef.current;
    if (busyRef.current || !draft || !checkReady()) return;
    await send(draft);
  }

  /** An explicit new creation: the unconfirmed request is abandoned and the form is free again. */
  function abandon() {
    if (busyRef.current) return;
    clearPendingStart();
    showPending(null);
    setError(null);
  }

  return (
    <section className={styles.startCard} aria-labelledby="ai-start-title">
      <h2 id="ai-start-title" className={styles.cardTitle}>AI 一键创作</h2>
      <p className={styles.cardIntro}>只填剧名。AI 会补全题材、人物、梗概、故事走向、分集大纲和每一集剧本，结果存为可修改的草稿。</p>
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
      <details className={styles.more} open={pending !== null || undefined}>
        <summary>更多设置（可不填）</summary>
        <div className={styles.moreGrid}>
          <p className={styles.fixed}>集数：3 集（当前试制范围固定）</p>
          <label className={styles.label} htmlFor="ai-seconds">每集时长</label>
          <select id="ai-seconds" className={styles.input} value={seconds} disabled={locked} onChange={(event) => setSeconds(Number(event.target.value))}>
            {(SECONDS.includes(seconds) ? SECONDS : [...SECONDS, seconds]).map((value) => <option key={value} value={value}>约 {value} 秒</option>)}
          </select>
          <label className={styles.label} htmlFor="ai-style">风格</label>
          <input id="ai-style" className={styles.input} maxLength={40} placeholder="不填则由 AI 根据剧名判断" value={style}
            disabled={locked} onChange={(event) => setStyle(event.target.value)} />
          {pending?.request.providerKey ? (
            <p className={styles.fixed}>
              模型服务：{options?.providers.find((item) => item.providerKey === pending.request.providerKey)?.label ?? pending.request.providerKey}
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
        {options && !unavailable ? (
          <p className={styles.helper}>
            服务端已配置：{readyProviders.map((item) => item.label).join("、")}。每天最多 {options.maxCallsPerDay} 次模型调用，
            每次创作最多 {options.callCapPerRun} 次。费用以服务商账单为准，本页不估算金额。
          </p>
        ) : null}
        <label className={styles.label} htmlFor="ai-token">操作者令牌</label>
        <input ref={tokenRef} id="ai-token" className={styles.input} type="password" autoComplete="off" value={token}
          disabled={busy} onChange={(event) => setToken(event.target.value)} />
        <p className={styles.helper}>只保存在本页内存，用来确认这次可能计费的调用由你发起；不写入浏览器存储，也不进入故事内容。模型密钥只在服务端。</p>
      </section>
    </section>
  );
}
