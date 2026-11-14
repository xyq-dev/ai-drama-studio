"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  TITLE_WRITING_PROVIDER_LABELS,
  type ScriptWorkbenchScript,
  type ShortSequelAiHistoryPage,
  type ShortSequelAiTaskView,
  type ShortSequelAiView,
} from "@ai-drama/contracts";
import { shortSequelPath } from "../lib/short-sequel-client";
import { ApiError, StudioClient } from "../lib/studio-client";
import styles from "./script-workbench.module.css";

const client = new StudioClient();
const status: Record<ShortSequelAiTaskView["state"], string> = {
  reserved: "等待生成",
  submitted: "生成中",
  completed: "草稿已生成",
  rejected: "生成未完成",
  unknown: "模型调用结果未确认",
};

export function ShortSequelDraftPreview({ script, title }: { script: ScriptWorkbenchScript; title: string }) {
  return (
    <details>
      <summary>{title}</summary>
      <p>{script.title}</p>
      <p>{script.previousHandoff}</p>
      {script.scenes.map((scene) => (
        <section key={scene.id}>
          <h4>{scene.heading}</h4>
          {scene.beats.map((beat) => <p key={beat.id}>{[beat.characterId, beat.text].filter(Boolean).join(" · ")}</p>)}
        </section>
      ))}
      <p>{script.endingHandoff}</p>
    </details>
  );
}

export function ShortSequelAi({ projectId, episodeNo, hasBody, hasUnsaved, onAdopt, source, hasPlan }: {
  projectId: string;
  episodeNo: number;
  hasBody: boolean;
  hasUnsaved: boolean;
  source: string;
  hasPlan: boolean;
  onAdopt: (task: ShortSequelAiTaskView) => void;
}) {
  const path = `${shortSequelPath(projectId, episodeNo)}/ai`;
  const [view, setView] = useState<ShortSequelAiView | null>(null);
  const [direction, setDirection] = useState("");
  const [token, setToken] = useState("");
  const [confirmedAttemptId, setConfirmedAttemptId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<ShortSequelAiHistoryPage | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const inFlight = useRef(false);
  const reading = useRef<{ signal?: AbortSignal } | null>(null);
  const historyRequest = useRef<AbortController | null>(null);
  const pending = useRef<{ path: string; body: unknown; key: string } | null>(null);
  const task = view?.task ?? null;
  const bodyExists = hasBody || view?.hasBody;
  const pendingCall = task?.state === "reserved" || task?.state === "submitted";
  const needsConfirmation = task?.state === "unknown";
  const confirmed = needsConfirmation && confirmedAttemptId === task.attemptId;
  const nextHistoryCursor = history ? history.nextCursor : view?.nextCursor;
  const shownHistory = new Map<string, ShortSequelAiTaskView>();
  for (const item of [...(view?.previousTasks ?? []), ...(history?.items ?? [])]) {
    if (item.script && item.taskId !== task?.taskId && !shownHistory.has(item.taskId)) shownHistory.set(item.taskId, item);
  }
  const [opened, setOpened] = useState(false);

  const read = useCallback(async (signal?: AbortSignal) => {
    if (reading.current && !reading.current.signal?.aborted) return;
    const request = { signal };
    reading.current = request;
    try {
      const latest = await client.get<ShortSequelAiView>(path, { signal });
      if (!signal?.aborted) setView(latest);
    } catch (caught) {
      if (!signal?.aborted) setError(caught instanceof ApiError ? caught.detail : "暂时无法读取续写任务。");
    } finally {
      if (reading.current === request) reading.current = null;
    }
  }, [path]);

  useEffect(() => {
    historyRequest.current?.abort();
    historyRequest.current = null;
    setHistory(null);
    setHistoryBusy(false);
    if (!opened) return;
    const abort = new AbortController();
    void read(abort.signal);
    return () => abort.abort();
  }, [opened, read, source]);

  useEffect(() => () => historyRequest.current?.abort(), []);

  useEffect(() => {
    if (!pendingCall) return;
    const abort = new AbortController();
    const timer = window.setInterval(() => { void read(abort.signal); }, 2_000);
    return () => {
      abort.abort();
      window.clearInterval(timer);
    };
  }, [pendingCall, read]);

  async function run(resume: boolean) {
    if (inFlight.current || (needsConfirmation && !confirmed)) return;
    const target = resume && task ? `${path}/${task.taskId}/resume` : path;
    const body = resume && task
      ? { attemptId: task.attemptId, confirmUncertain: needsConfirmation }
      : { direction: direction.trim(), ...(needsConfirmation && task ? { confirmUncertainAttemptId: task.attemptId } : {}) };
    const sameRequest = pending.current?.path === target && JSON.stringify(pending.current.body) === JSON.stringify(body);
    const key = sameRequest ? pending.current!.key : crypto.randomUUID();
    pending.current = { path: target, body, key };
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const { body: next } = await client.write<ShortSequelAiView>({
        path: target, body, idempotencyKey: key, operatorToken: token.trim(),
      });
      if (!next.task || next.task.episodeNo !== episodeNo || (resume && next.task.taskId !== task?.taskId)) {
        throw new Error("续写请求未确认");
      }
      pending.current = null;
      setConfirmedAttemptId(null);
      setView((current) => ({ ...current, ...next }));
      await read();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.detail : "未确认续写请求，刷新任务状态后可以重试。");
      await read();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  async function loadHistory() {
    if (!nextHistoryCursor || historyRequest.current) return;
    const abort = new AbortController();
    historyRequest.current = abort;
    setHistoryBusy(true);
    setError("");
    try {
      const page = await client.get<ShortSequelAiHistoryPage>(`${path}/history?cursor=${encodeURIComponent(nextHistoryCursor)}`, { signal: abort.signal });
      if (!abort.signal.aborted) setHistory(current => ({ items: [...(current?.items ?? []), ...page.items], nextCursor: page.nextCursor }));
    } catch (caught) {
      if (!abort.signal.aborted) setError(caught instanceof ApiError ? caught.detail : "暂时无法读取更早的续写草稿。");
    } finally {
      if (historyRequest.current === abort) {
        historyRequest.current = null;
        setHistoryBusy(false);
      }
    }
  }

  return (
    <details className={styles.notice} onToggle={(event) => setOpened(event.currentTarget.open)}>
      <summary>AI 续写</summary>
      {opened && !view && !error ? <p role="status">正在读取续写任务…</p> : null}
      {view && !view.enabled ? <p>AI 续写当前不可用。</p> : null}
      {bodyExists ? <p>这一集已有正文。可在编辑器中修订正文。</p> : null}
      {task ? (
        <>
          <p role="status">{status[task.state]}{task.stale ? " · 来源版本已过期" : ""}</p>
          <p className={styles.muted}>{TITLE_WRITING_PROVIDER_LABELS[task.providerKey] ?? task.providerKey} · {task.model} · 费用 {task.billing}</p>
          {task.usage.status === "present" && task.usage.totalTokens !== null ? <p className={styles.muted}>用量 {task.usage.totalTokens} tokens</p> : null}
          {task.errorCode ? <p className={styles.muted}>{task.errorCode}</p> : null}
          {task.script ? (
            <>
              <ShortSequelDraftPreview script={task.script} title={task.stale ? "查看过期 AI 草稿" : "查看 AI 草稿"} />
              {!task.stale && !bodyExists ? <button className={styles.subtle} type="button"
                disabled={busy || hasUnsaved} onClick={() => onAdopt(task)}>载入编辑器</button> : null}
              {!task.stale && !bodyExists && hasUnsaved ? <p>当前有未保存的编辑稿，AI 草稿在这里保留。</p> : null}
            </>
          ) : null}
        </>
      ) : null}
      {[...shownHistory.values()].map((previous) => (
        <ShortSequelDraftPreview key={previous.taskId} script={previous.script!} title={previous.stale ? "查看过期 AI 草稿" : "查看历史 AI 草稿"} />
      ))}
      {nextHistoryCursor ? <button className={styles.subtle} type="button" disabled={historyBusy}
        onClick={() => void loadHistory()}>加载更早的 AI 草稿</button> : null}
      {view?.enabled && !bodyExists && !pendingCall ? (
        <>
          {!hasPlan ? <p>可以先生成草稿。在确认新版设定前载入编辑器，确认后再核对和保存。</p> : null}
          <label className={styles.field}>
            剧情方向（可选）
            <textarea value={direction} rows={2} maxLength={1000} onChange={(event) => setDirection(event.target.value)} />
          </label>
          {view.operatorTokenRequired ? (
            <label className={styles.field}>
              操作者令牌
              <input type="password" value={token} onChange={(event) => setToken(event.target.value)} />
            </label>
          ) : null}
          {needsConfirmation ? (
            <label>
              <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmedAttemptId(event.target.checked ? task.attemptId : null)} />
              上次调用结果未确认，继续可能重复计费。
            </label>
          ) : null}
          <div className={styles.actions}>
            {task?.canResume ? <button className={styles.button} type="button"
              disabled={busy || (needsConfirmation && !confirmed) || (view.operatorTokenRequired && !token.trim())}
              onClick={() => void run(true)}>继续第 {episodeNo} 集 AI 任务</button> : null}
            <button className={styles.button} type="button"
              disabled={busy || (needsConfirmation && !confirmed) || (view.operatorTokenRequired && !token.trim())}
              onClick={() => void run(false)}>{task ? "重新生成本集草稿" : "生成本集草稿"}</button>
          </div>
        </>
      ) : null}
      {error ? <p className={styles.warning} role="alert">{error}</p> : null}
      {error && !view ? <button className={styles.subtle} type="button" onClick={() => { setError(""); void read(); }}>重新读取</button> : null}
    </details>
  );
}
