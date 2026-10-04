"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError, StudioClient } from "../lib/studio-client";
import {
  LIMITS,
  applyPage,
  clearDraft,
  draftStorageKey,
  nextDraft,
  readDraft,
  writeDraft,
  type PageState,
} from "../lib/studio-model";

interface ProjectItem {
  id: string;
  title: string;
  premise: string;
  version: number;
  status: string;
}

const client = new StudioClient();
const CREATE_KEY = draftStorageKey("new", "project", null);

export function ProjectHome() {
  const [page, setPage] = useState<PageState<ProjectItem> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [premise, setPremise] = useState("");
  const [creating, setCreating] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const openerRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  async function load(cursor: string | null, append: boolean) {
    setLoading(true);
    setError(null);
    try {
      const path = cursor ? `/projects?cursor=${encodeURIComponent(cursor)}` : "/projects";
      const body = await client.get<{ items: ProjectItem[]; nextCursor: string | null }>(path);
      setPage((current) => applyPage(current, { scope: "projects", items: body.items, nextCursor: body.nextCursor, append }));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.detail : "项目列表加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const draft = readDraft(window.sessionStorage, CREATE_KEY);
    const payload = draft?.payload;
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const record = payload as { title?: unknown; premise?: unknown };
      if (typeof record.title === "string") setTitle(record.title);
      if (typeof record.premise === "string") setPremise(record.premise);
    }
    void load(null, false);
  }, []);

  useEffect(() => {
    if (!composerOpen) return;
    titleRef.current?.focus();
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") closeComposer();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [composerOpen]);

  function closeComposer() {
    setComposerOpen(false);
    openerRef.current?.focus();
  }

  function remember(nextTitle: string, nextPremise: string) {
    setTitle(nextTitle);
    setPremise(nextPremise);
    const draft = nextDraft(readDraft(window.sessionStorage, CREATE_KEY), { title: nextTitle, premise: nextPremise }, null, () => crypto.randomUUID());
    writeDraft(window.sessionStorage, CREATE_KEY, draft);
  }

  async function createProject() {
    const draft = nextDraft(readDraft(window.sessionStorage, CREATE_KEY), { title, premise }, null, () => crypto.randomUUID());
    writeDraft(window.sessionStorage, CREATE_KEY, draft);
    setCreating(true);
    setError(null);
    try {
      const created = await client.write<ProjectItem>({
        path: "/projects",
        body: { title, premise },
        idempotencyKey: draft.idempotencyKey,
      });
      clearDraft(window.sessionStorage, CREATE_KEY);
      window.location.assign(`/projects/${created.body.id}`);
    } catch (caught) {
      setError(caught instanceof ApiError ? `${caught.code}：${caught.detail}` : "创建失败，草稿仍保留，再次提交会复用同一幂等键");
    } finally {
      setCreating(false);
    }
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 text-[#F4F6FA]">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-[#AAB3C5]">创作中心</p>
          <h1 className="text-2xl font-semibold">你的作品</h1>
        </div>
        <button
          ref={openerRef}
          className="rounded bg-[#9B8CFF] px-4 py-2 text-[#0B0E14]"
          type="button"
          aria-haspopup="dialog"
          aria-expanded={composerOpen}
          onClick={() => setComposerOpen(true)}
        >
          新建作品
        </button>
      </header>
      {composerOpen ? (
        <div className="fixed inset-0 z-30 flex items-end justify-center bg-black/60 p-4 sm:items-center" role="presentation">
          <form
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-work-title"
            className="w-full max-w-lg space-y-3 rounded-lg border border-[#283140] bg-[#141A23] p-4"
            onSubmit={(event) => {
              event.preventDefault();
              void createProject();
            }}
          >
            <h2 id="create-work-title" className="font-medium">新建作品</h2>
            <p className="text-sm text-[#AAB3C5]">只保存标题和故事梗概。当前试制范围仍是固定三集，这里不能选择集数或时长。</p>
            <label className="block text-sm" htmlFor="project-title">标题</label>
            <input
              ref={titleRef}
              id="project-title"
              className="w-full rounded border border-[#283140] bg-[#0B0E14] px-3 py-2 text-[#F4F6FA]"
              maxLength={LIMITS.title}
              value={title}
              onChange={(event) => remember(event.target.value, premise)}
              required
            />
            <label className="block text-sm" htmlFor="project-premise">故事梗概</label>
            <textarea
              id="project-premise"
              className="w-full rounded border border-[#283140] bg-[#0B0E14] px-3 py-2 text-[#F4F6FA]"
              maxLength={LIMITS.premise}
              rows={4}
              value={premise}
              onChange={(event) => remember(title, event.target.value)}
            />
            <div className="flex gap-2">
              <button className="rounded bg-[#9B8CFF] px-4 py-2 text-[#0B0E14] disabled:opacity-50" type="submit" disabled={creating || title.trim().length === 0}>
                {creating ? "创建中" : "创建项目"}
              </button>
              <button className="rounded border border-[#283140] px-4 py-2" type="button" onClick={closeComposer}>关闭</button>
            </div>
          </form>
        </div>
      ) : null}
      {error ? (
        <div className="mt-4 rounded-lg border border-[#283140] bg-[#141A23] p-4" role="alert">
          <p className="text-sm">{page === null ? `连接状态：读取失败。${error}` : error}</p>
          {page === null ? <p className="mt-2 text-sm text-[#AAB3C5]">接口暂不可用时不会改用示例项目。</p> : null}
          <div className="mt-3 flex gap-3">
            <button className="rounded border border-[#283140] px-3 py-1 text-sm" type="button" onClick={() => void load(null, false)}>重试</button>
            <a className="rounded border border-[#283140] px-3 py-1 text-sm" href="/preview">查看界面预览</a>
          </div>
        </div>
      ) : null}
      <section className="mt-6 rounded-lg border border-[#283140] bg-[#141A23] p-4" aria-busy={loading}>
        <h2 className="font-medium">继续创作</h2>
        {loading && page === null ? <p className="mt-3 text-sm">正在加载项目</p> : null}
        {!loading && page && page.items.length === 0 ? <p className="mt-3 text-sm">还没有项目。可以用「新建作品」写下标题和梗概。</p> : null}
        <ul className="mt-3 divide-y divide-[#283140]">
          {page?.items.map((project) => (
            <li key={project.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="font-medium">{project.title}</p>
                <p className="text-sm text-[#AAB3C5]">{project.premise || "无梗概"}</p>
                <p className="text-sm text-[#AAB3C5]">状态 {project.status} · 版本 {project.version}</p>
              </div>
              <a className="rounded border border-[#283140] px-3 py-1 text-sm" href={`/projects/${project.id}`}>继续创作</a>
            </li>
          ))}
        </ul>
        {page?.nextCursor ? (
          <button className="mt-3 text-sm underline" type="button" onClick={() => void load(page.nextCursor, true)}>加载更多</button>
        ) : null}
      </section>
    </main>
  );
}
