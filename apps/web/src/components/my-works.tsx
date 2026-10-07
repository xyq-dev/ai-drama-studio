"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError, StudioClient } from "../lib/studio-client";
import { loadProjectFacts } from "../lib/beginner-facts";
import { STEPS, STEP_STATE_MARK, STEP_STATE_TEXT, currentStep, stepStates, type StepKey, type StepState } from "../lib/beginner-steps";
import { shouldPoll } from "../lib/studio-model";
import { BeginnerShell } from "./beginner-shell";

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

  function pump() {
    while (running.current < CONCURRENCY && queue.current.length > 0) {
      const { id, background } = queue.current.shift()!;
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
      <main className="mx-auto max-w-6xl px-4 py-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold">我的作品</h1>
            <p className="mt-1 text-[15px] text-[#5F5D66]">进度按服务器上的真实内容、审核和任务状态读取。</p>
          </div>
          <a className="rounded-[12px] bg-[#D34846] px-5 py-2.5 font-medium text-white" href="/create">开始创作</a>
        </div>
        {error ? (
          <div className="mt-6 rounded-[12px] border border-[#D34846] bg-white p-4" role="alert">
            <p>作品列表读取失败：{error}。不会显示示例作品。</p>
            <button className="mt-2 rounded-[12px] border px-3 py-1" type="button" onClick={() => void load(null)}>重试</button>
          </div>
        ) : null}
        {items === null && !error ? <p className="mt-6" role="status">正在读取作品</p> : null}
        {items && items.length === 0 ? (
          <div className="mt-6 rounded-[12px] border border-[#E7E5E0] bg-white p-6">
            <p className="font-medium">还没有作品</p>
            <p className="mt-1 text-[15px] text-[#5F5D66]">从一句话开始，写下你想拍的故事。</p>
            <a className="mt-3 inline-block rounded-[12px] bg-[#D34846] px-4 py-2 text-white" href="/create">开始创作</a>
          </div>
        ) : null}
        <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items?.map((item) => {
            const state = progress[item.id];
            const stepTitle = state?.kind === "ready" ? STEPS.find((step) => step.key === state.step) : null;
            return (
              <li key={item.id} className="flex min-w-0 flex-col rounded-[12px] border border-[#E7E5E0] bg-white p-4 shadow-sm">
                {/* No real cover asset is listed for a project, so the card uses a text cover. */}
                <div className="flex aspect-[16/7] items-center justify-center rounded-[10px] bg-[#FBE7E4] text-3xl font-semibold text-[#B8322F]" aria-hidden="true">
                  {Array.from(item.title.trim())[0] ?? "作"}
                </div>
                <h2 className="mt-3 text-lg font-semibold [overflow-wrap:anywhere]">{item.title}</h2>
                <p className="mt-1 line-clamp-2 text-[15px] text-[#5F5D66] [overflow-wrap:anywhere]">{item.premise || "还没有故事想法"}</p>
                <div className="mt-3 text-[15px]" aria-live="polite">
                  {!state || state.kind === "loading" ? <p>正在读取进度…</p> : null}
                  {state?.kind === "failed" ? (
                    <p>进度读取失败。<button className="underline" type="button" onClick={() => track([item.id])}>重试</button></p>
                  ) : null}
                  {state?.kind === "ready" && stepTitle ? (
                    <>
                      <p>{`当前阶段：第 ${stepTitle.no} 步 ${stepTitle.title} · ${STEP_STATE_MARK[state.state]} ${STEP_STATE_TEXT[state.state]}`}</p>
                      <p className="text-[#5F5D66]">{todo(state.step, state.state)}</p>
                      {state.running && !state.paused ? <p className="text-[#5F5D66]">有任务正在处理，进度会自动刷新。</p> : null}
                      {state.refreshFailed && !state.paused ? <p>最新进度暂时没有读到，显示的是上次读到的阶段，稍后会再试。</p> : null}
                      {state.paused ? (
                        <p>任务仍在处理，已暂停自动刷新。<button className="underline" type="button" onClick={() => refreshNow(item.id)}>刷新进度</button></p>
                      ) : null}
                    </>
                  ) : null}
                </div>
                <div className="mt-auto flex flex-wrap items-center gap-3 pt-4">
                  <a className="rounded-[12px] bg-[#D34846] px-4 py-2 font-medium text-white" href={`/projects/${item.id}/create`}>继续创作</a>
                  <a className="text-sm text-[#5F5D66] underline" href={`/projects/${item.id}`}>高级编辑</a>
                </div>
              </li>
            );
          })}
        </ul>
        {nextCursor ? <button className="mt-6 rounded-[12px] border px-4 py-2 disabled:opacity-60" type="button" disabled={loadingPage} onClick={() => void load(nextCursor)}>{loadingPage ? "正在加载" : "加载更多作品"}</button> : null}
      </main>
    </BeginnerShell>
  );
}
