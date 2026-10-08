"use client";

import { useEffect, useRef, useState } from "react";
import type { TitleWritingProviderKey } from "@ai-drama/contracts";
import { ApiError, StudioClient } from "../lib/studio-client";
import {
  TitleWritingClient,
  TitleWritingError,
  normalizeOptions,
  optionsUnavailableReason,
  type TitleWritingOptionsView,
} from "../lib/title-writing-client";
import styles from "./title-writing.module.css";

const studio = new StudioClient();
const writing = new TitleWritingClient();
const DRAFT_KEY = "title-writing:start";
const TITLE_MAX = 60;

interface StartDraft {
  title: string;
  request: string;
  projectKey: string;
  projectId: string | null;
  runKey: string;
}

function readStartDraft(): StartDraft | null {
  try {
    const raw = window.sessionStorage.getItem(DRAFT_KEY);
    return raw ? JSON.parse(raw) as StartDraft : null;
  } catch {
    return null;
  }
}

function writeStartDraft(draft: StartDraft | null): void {
  try {
    if (draft) window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    else window.sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // Without session storage a retry after a reload cannot reuse the keys; the server still refuses a second active run.
  }
}

/**
 * Keys are reused while the same title and settings are retried, so an unsure reply never creates a second project
 * or a second run. A changed title gets new keys; a changed setting gets a new run key on the same project.
 */
function draftFor(title: string, request: string): StartDraft {
  const previous = readStartDraft();
  if (previous && previous.title === title && previous.request === request) return previous;
  if (previous && previous.title === title) return { ...previous, request, runKey: crypto.randomUUID() };
  return { title, request, projectKey: crypto.randomUUID(), projectId: null, runKey: crypto.randomUUID() };
}

function startError(caught: unknown): string {
  if (caught instanceof TitleWritingError) {
    const missing = Array.isArray(caught.details?.missing) ? (caught.details.missing as string[]).join("、") : "";
    if (caught.code === "TITLE_WRITING_FORBIDDEN") return "操作者令牌不正确，没有启动任何调用。剧名还在，改正后可以再试。";
    if (caught.code === "TITLE_WRITING_PROVIDER_UNCONFIGURED") return `所选模型服务没有配置完整${missing ? `（缺少 ${missing}）` : ""}，没有启动任何调用。`;
    return `${caught.detail} 剧名还在，可以修改后再试。`;
  }
  if (caught instanceof ApiError && caught.status > 0 && caught.status < 500) return `作品没有创建：${caught.detail}。剧名还在，可以修改后再试。`;
  return "没有确认是否已经启动（网络或服务异常）。剧名还在；再次点击会用同一个请求标识，服务器不会重复创建作品或重复开始创作。";
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const tokenRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    const draft = readStartDraft();
    if (draft) setTitle(draft.title);
    void writing.options().then((value) => {
      if (!alive) return;
      const normalized = normalizeOptions(value);
      setOptions(normalized);
      if (normalized?.defaultProvider) {
        setProviderKey(normalized.defaultProvider);
        setModel(normalized.providers.find((item) => item.providerKey === normalized.defaultProvider)?.defaultModel ?? "");
      }
      if (normalized?.defaults) {
        setSeconds(normalized.defaults.episodeSeconds);
      }
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

  function chooseProvider(next: TitleWritingProviderKey) {
    setProviderKey(next);
    setModel(readyProviders.find((item) => item.providerKey === next)?.defaultModel ?? "");
  }

  async function start() {
    if (busyRef.current) return;
    const trimmed = title.trim();
    if (trimmed.length === 0) {
      setError("先写一个剧名。");
      titleRef.current?.focus();
      return;
    }
    if (!optionsLoaded) return;
    if (unavailable) {
      setError(unavailable);
      return;
    }
    if (token.trim().length === 0) {
      setError("请先在「配置与权限」填写操作者令牌。它只用于确认这次调用由你发起，不属于故事内容。");
      tokenRef.current?.focus();
      return;
    }
    const body = {
      title: trimmed,
      ...(chosen ? { providerKey: chosen.providerKey, model: model || chosen.defaultModel || undefined } : {}),
      settings: { episodeSeconds: seconds, style: style.trim() },
    };
    let draft = draftFor(trimmed, JSON.stringify(body));
    writeStartDraft(draft);
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      if (!draft.projectId) {
        const created = await studio.write<{ id: string }>({ path: "/projects", body: { title: trimmed, premise: "" }, idempotencyKey: draft.projectKey });
        draft = { ...draft, projectId: created.body.id };
        writeStartDraft(draft);
      }
      const projectId = draft.projectId!;
      try {
        await writing.start(projectId, body, { token: token.trim(), idempotencyKey: draft.runKey });
      } catch (caught) {
        // Another start of this work is already running: show that one instead of starting a second.
        if (!(caught instanceof TitleWritingError && caught.code === "TITLE_WRITING_RUN_ACTIVE")) throw caught;
      }
      writeStartDraft(null);
      window.location.assign(`/projects/${projectId}/writing`);
    } catch (caught) {
      setError(startError(caught));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <section className={styles.startCard} aria-labelledby="ai-start-title">
      <h2 id="ai-start-title" className={styles.cardTitle}>AI 一键创作</h2>
      <p className={styles.cardIntro}>只填剧名。AI 会补全题材、人物、梗概、故事走向、分集大纲和每一集剧本，结果存为可修改的草稿。</p>
      <label className={styles.label} htmlFor="ai-title">剧名</label>
      <input
        ref={titleRef}
        id="ai-title"
        className={styles.input}
        maxLength={TITLE_MAX}
        placeholder="例如：夜班证词"
        value={title}
        disabled={busy}
        onChange={(event) => setTitle(event.target.value)}
      />
      <details className={styles.more}>
        <summary>更多设置（可不填）</summary>
        <div className={styles.moreGrid}>
          <p className={styles.fixed}>集数：3 集（当前试制范围固定）</p>
          <label className={styles.label} htmlFor="ai-seconds">每集时长</label>
          <select id="ai-seconds" className={styles.input} value={seconds} disabled={busy} onChange={(event) => setSeconds(Number(event.target.value))}>
            {[60, 90, 120, 180].map((value) => <option key={value} value={value}>约 {value} 秒</option>)}
          </select>
          <label className={styles.label} htmlFor="ai-style">风格</label>
          <input id="ai-style" className={styles.input} maxLength={40} placeholder="不填则由 AI 根据剧名判断" value={style}
            disabled={busy} onChange={(event) => setStyle(event.target.value)} />
          {readyProviders.length > 0 ? (
            <>
              <label className={styles.label} htmlFor="ai-provider">模型服务</label>
              <select id="ai-provider" className={styles.input} value={providerKey} disabled={busy}
                onChange={(event) => chooseProvider(event.target.value as TitleWritingProviderKey)}>
                {readyProviders.map((item) => <option key={item.providerKey} value={item.providerKey}>{item.label}</option>)}
              </select>
              <label className={styles.label} htmlFor="ai-model">模型</label>
              <select id="ai-model" className={styles.input} value={model} disabled={busy} onChange={(event) => setModel(event.target.value)}>
                {(chosen?.models ?? []).map((item) => <option key={item} value={item}>{item}</option>)}
              </select>
            </>
          ) : null}
        </div>
      </details>
      <div className={styles.actions}>
        <button className={styles.primary} type="button" disabled={busy || !optionsLoaded} onClick={() => void start()}>
          {busy ? "正在启动…" : "AI 一键创作"}
        </button>
        <a className={styles.textLink} href="#manual-start">改为手动写想法</a>
      </div>
      {busy ? <p className={styles.helper} role="status">正在创建作品并启动创作。剧名已锁定，完成前不能修改。</p> : null}
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
