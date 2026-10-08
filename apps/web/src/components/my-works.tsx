"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError, StudioClient } from "../lib/studio-client";
import { loadProjectFacts } from "../lib/beginner-facts";
import { STEPS, STEP_STATE_MARK, STEP_STATE_TEXT, currentStep, stepStates, type StepKey, type StepState } from "../lib/beginner-steps";
import { shouldPoll } from "../lib/studio-model";
import { BeginnerShell } from "./beginner-shell";
import { CreatorCover } from "./creator-cover";
import styles from "./creator-entry.module.css";

interface ProjectItem {
  id: string;
  title: string;
  premise: string;
}

type Progress =
  | { kind: "loading" }
  | { kind: "failed" }
  | {
    kind: "ready";
    step: StepKey;
    state: StepState;
    /** A workflow of this project was still running when its facts were read. */
    running: boolean;
    /** The latest background reread failed; the shown stage is the last one read. */
    refreshFailed?: boolean;
    /** Automatic rereads used up while still running; the card waits for the user. */
    paused?: boolean;
  };

const client = new StudioClient();
/** At most this many projects read their progress at the same time. */
const CONCURRENCY = 2;
/** A card with a running workflow is read again after this delay, at most MAX_REFRESHES times in a row. */
export const REFRESH_MS = 5000;
export const MAX_REFRESHES = 24;

/** One sentence per state: what the user has to do next on that step. */
function todo(step: StepKey, state: StepState): string {
  const title = STEPS.find((item) => item.key === step)?.title ?? "";
  switch (state) {
    case "not_started": return `下一步：${title}`;
    case "needs_input": return `${title}：还需要补充内容`;
    case "needs_confirmation": return `${title}：有内容等你检查确认`;
    case "in_progress": return `${title}：任务处理中`;
    case "needs_attention": return `${title}：有内容需要处理`;
    case "source_updated": return `${title}：上游内容已更新，需要重新确认`;
    case "unknown": return `${title}：部分进度没有读到，暂不能确认`;
    default: return "五步都已完成，可以查看和下载成片";
  }
}

export function MyWorks() {
  const [items, setItems] = useState<ProjectItem[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingPage, setLoadingPage] = useState(false);
  const pageInFlight = useRef(false);
  const [progress, setProgress] = useState<Record<string, Progress>>({});
  const queue = useRef<Array<{ id: string; background: boolean }>>([]);
  const running = useRef(0);
  const alive = useRef(true);
  /** Projects queued or being read: a project is never read twice at once. */
  const pending = useRef(new Set<string>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const refreshes = useRef(new Map<string, number>());
  /** Rereads that fell due while the page was hidden; read when it is visible again. */
  const dueWhileHidden = useRef(new Set<string>());

  /**
   * Starts queued reads up to the concurrency limit. A hidden page starts no background reread, including one already
   * queued when the page was hidden: it stays queued (and pending) until the page is visible again. Reads already
   * started finish normally. Nothing starts after unmount.
   */
  function pump() {
    while (alive.current && running.current < CONCURRENCY) {
      const hidden = document.visibilityState === "hidden";
      const index = queue.current.findIndex((item) => !hidden || !item.background);
      if (index < 0) return;
      const { id, background } = queue.current.splice(index, 1)[0]!;
      running.current += 1;
      void loadProjectFacts(client, id).then((facts) => {
        const states = stepStates(facts);
        const step = currentStep(states);
        const active = facts.runs.some((run) => shouldPoll(run.status, false));
        if (!alive.current) return;
        setProgress((current) => ({ ...current, [id]: { kind: "ready", step, state: states[step], running: active } }));
        // A terminal answer ends the refreshes; a running one schedules the next, within the bound.
        if (active) scheduleRefresh(id);
        else refreshes.current.delete(id);
      }).catch(() => {
        if (!alive.current) return;
        setProgress((current) => {
          const shown = current[id];
          // A failed background reread keeps the last stage read and says it may be out of date.
          return { ...current, [id]: background && shown?.kind === "ready" ? { ...shown, refreshFailed: true } : { kind: "failed" } };
        });
        if (background) scheduleRefresh(id);
      }).finally(() => {
        running.current -= 1;
        pending.current.delete(id);
        if (alive.current) pump();
      });
    }
  }

  function enqueue(id: string, background: boolean) {
    if (pending.current.has(id)) return;
    pending.current.add(id);
    queue.current.push({ id, background });
    pump();
  }

  function scheduleRefresh(id: string) {
    if (timers.current.has(id)) return;
    const used = refreshes.current.get(id) ?? 0;
    if (used >= MAX_REFRESHES) {
      setProgress((current) => {
        const shown = current[id];
        return shown?.kind === "ready" ? { ...current, [id]: { ...shown, paused: true } } : current;
      });
      return;
    }
    refreshes.current.set(id, used + 1);
    timers.current.set(id, setTimeout(() => {
      timers.current.delete(id);
      if (!alive.current) return;
      if (document.visibilityState === "hidden") {
        dueWhileHidden.current.add(id);
        return;
      }
      enqueue(id, true);
    }, REFRESH_MS));
  }

  function track(ids: string[]) {
    setProgress((current) => ({ ...current, ...Object.fromEntries(ids.map((id) => [id, { kind: "loading" } as Progress])) }));
    for (const id of ids) {
      refreshes.current.delete(id);
      enqueue(id, false);
    }
  }

  /** The user asked again: a fresh set of automatic rereads, keeping the shown stage meanwhile. */
  function refreshNow(id: string) {
    refreshes.current.delete(id);
    setProgress((current) => {
      const shown = current[id];
      return shown?.kind === "ready" ? { ...current, [id]: { ...shown, paused: false } } : current;
    });
    enqueue(id, true);
  }

  async function load(cursor: string | null) {
    // One page request at a time: a second click on 加载更多 must not append the same page twice.
    if (pageInFlight.current) return;
    pageInFlight.current = true;
    setLoadingPage(true);
    setError(null);
    try {
      const page = await client.get<{ items: ProjectItem[]; nextCursor: string | null }>(
        cursor ? `/projects?cursor=${encodeURIComponent(cursor)}` : "/projects");
      if (!alive.current) return;
      setItems((current) => {
        if (!cursor || !current) return page.items;
        const known = new Set(current.map((item) => item.id));
        return [...current, ...page.items.filter((item) => !known.has(item.id))];
      });
      setNextCursor(page.nextCursor);
      track(page.items.map((item) => item.id));
    } catch (caught) {
      if (alive.current) setError(caught instanceof ApiError ? caught.detail : "作品列表读取失败");
    } finally {
      pageInFlight.current = false;
      if (alive.current) setLoadingPage(false);
    }
  }

  useEffect(() => {
    alive.current = true;
    void load(null);
    // Back on the page: read the cards whose reread fell due while it was hidden.
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const due = [...dueWhileHidden.current];
      dueWhileHidden.current.clear();
      for (const id of due) enqueue(id, true);
      // Rereads queued before the page was hidden.
      pump();
    };
    document.addEventListener("visibilitychange", onVisible);
    const scheduled = timers.current;
    return () => {
      alive.current = false;
      document.removeEventListener("visibilitychange", onVisible);
      for (const timer of scheduled.values()) clearTimeout(timer);
      scheduled.clear();
    };
  }, []);

  return (
    <BeginnerShell active="/studio">
      <main className={styles.page}>
        <header className={styles.headingRow}>
          <div>
            <p className={styles.eyebrow}>你的创作空间</p>
            <h1 className={styles.heading}>我的作品</h1>
            <p className={styles.intro}>进度按服务器上的真实内容、审核和任务状态读取。</p>
          </div>
          <a className={styles.primary} href="/create"><span className={styles.plus} aria-hidden="true">+</span>开始创作</a>
        </header>
        {error ? (
          <div className={styles.notice} role="alert">
            <p>作品列表读取失败：{error}。不会显示示例作品。</p>
            <button className={styles.secondary} type="button" onClick={() => void load(null)}>重试</button>
          </div>
        ) : null}
        {items === null && !error ? <p className={styles.loading} role="status">正在读取作品</p> : null}
        {items && items.length === 0 ? (
          <div className={styles.empty}>
            <span className={styles.emptyIcon} aria-hidden="true">
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M7 3h10a2 2 0 0 1 2 2v15l-7-3-7 3V5a2 2 0 0 1 2-2Z" /><path d="M9 8h6M9 12h4" /></svg>
            </span>
            <p className="font-medium">还没有作品</p>
            <p className="mt-1 text-[15px] text-[#5F5D66]">从一句话开始，写下你想拍的故事。</p>
            <a className={styles.primary} href="/create">开始创作<span aria-hidden="true">→</span></a>
          </div>
        ) : null}
        <ul className={styles.worksGrid}>
          {items?.map((item, index) => {
            const state = progress[item.id];
            const stepTitle = state?.kind === "ready" ? STEPS.find((step) => step.key === state.step) : null;
            return (
              <li key={item.id} className={styles.workCard}>
                {/* No real cover asset is listed for a project, so the card uses a text cover. */}
                <CreatorCover title={item.title} />
                <div className={styles.workBody}>
                  {index === 0 ? <p className={styles.workEyebrow}>接着把这个故事讲下去</p> : null}
                  <h2 className={styles.workTitle}>{item.title}</h2>
                  <p className={styles.workPremise}>{item.premise || "还没有故事想法"}</p>
                  <div className={styles.workProgress} aria-live="polite">
                    {!state || state.kind === "loading" ? <p>正在读取进度…</p> : null}
                    {state?.kind === "failed" ? (
                      <p>进度读取失败。<button className="underline" type="button" onClick={() => track([item.id])}>重试</button></p>
                    ) : null}
                    {state?.kind === "ready" && stepTitle ? (
                      <>
                        <p className={styles.statusLine} data-state={state.state}>{`当前阶段：第 ${stepTitle.no} 步 ${stepTitle.title} · ${STEP_STATE_MARK[state.state]} ${STEP_STATE_TEXT[state.state]}`}</p>
                        <p className={styles.todo}>{todo(state.step, state.state)}</p>
                        {state.running && !state.paused ? <p className={styles.progressNote}>有任务正在处理，进度会自动刷新。</p> : null}
                        {state.refreshFailed && !state.paused ? <p className={styles.progressNote}>最新进度暂时没有读到，显示的是上次读到的阶段，稍后会再试。</p> : null}
                        {state.paused ? (
                          <p>任务仍在处理，已暂停自动刷新。<button className="underline" type="button" onClick={() => refreshNow(item.id)}>刷新进度</button></p>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                  <div className={styles.workActions}>
                    <a className={styles.primary} href={`/projects/${item.id}/create`}>继续创作<span aria-hidden="true">→</span></a>
                    <a className={styles.textLink} href={`/projects/${item.id}`}>高级编辑</a>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
        {nextCursor ? <button className={`${styles.secondary} ${styles.loadMore}`} type="button" disabled={loadingPage} onClick={() => void load(nextCursor)}>{loadingPage ? "正在加载" : "加载更多作品"}</button> : null}
      </main>
    </BeginnerShell>
  );
}
