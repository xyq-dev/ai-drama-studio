"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError, StudioClient } from "../lib/studio-client";
import { loadProjectFacts } from "../lib/beginner-facts";
import { STEPS, STEP_STATE_MARK, STEP_STATE_TEXT, currentStep, stepStates, type StepKey, type StepState } from "../lib/beginner-steps";
import { BeginnerShell } from "./beginner-shell";

interface ProjectItem {
  id: string;
  title: string;
  premise: string;
}

type Progress = { kind: "loading" } | { kind: "failed" } | { kind: "ready"; step: StepKey; state: StepState };

const client = new StudioClient();
/** At most this many projects read their progress at the same time. */
const CONCURRENCY = 2;

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
    default: return "五步都已完成，可以查看和下载成片";
  }
}

export function MyWorks() {
  const [items, setItems] = useState<ProjectItem[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, Progress>>({});
  const queue = useRef<string[]>([]);
  const running = useRef(0);
  const alive = useRef(true);

  function pump() {
    while (running.current < CONCURRENCY && queue.current.length > 0) {
      const id = queue.current.shift()!;
      running.current += 1;
      void loadProjectFacts(client, id).then((facts) => {
        const states = stepStates(facts);
        const step = currentStep(states);
        if (alive.current) setProgress((current) => ({ ...current, [id]: { kind: "ready", step, state: states[step] } }));
      }).catch(() => {
        if (alive.current) setProgress((current) => ({ ...current, [id]: { kind: "failed" } }));
      }).finally(() => {
        running.current -= 1;
        if (alive.current) pump();
      });
    }
  }

  function track(ids: string[]) {
    setProgress((current) => ({ ...current, ...Object.fromEntries(ids.map((id) => [id, { kind: "loading" } as Progress])) }));
    queue.current.push(...ids);
    pump();
  }

  async function load(cursor: string | null) {
    setError(null);
    try {
      const page = await client.get<{ items: ProjectItem[]; nextCursor: string | null }>(
        cursor ? `/projects?cursor=${encodeURIComponent(cursor)}` : "/projects");
      if (!alive.current) return;
      setItems((current) => (cursor && current ? [...current, ...page.items] : page.items));
      setNextCursor(page.nextCursor);
      track(page.items.map((item) => item.id));
    } catch (caught) {
      if (alive.current) setError(caught instanceof ApiError ? caught.detail : "作品列表读取失败");
    }
  }

  useEffect(() => {
    alive.current = true;
    void load(null);
    return () => { alive.current = false; };
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
        {nextCursor ? <button className="mt-6 rounded-[12px] border px-4 py-2" type="button" onClick={() => void load(nextCursor)}>加载更多作品</button> : null}
      </main>
    </BeginnerShell>
  );
}
