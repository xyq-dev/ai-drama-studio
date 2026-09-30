"use client";

import { useEffect, useState } from "react";
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
    <main className="mx-auto max-w-3xl px-4 py-8 text-neutral-900">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">项目</h1>
        <a className="text-sm underline" href="/status">服务状态</a>
      </header>
      <form
        className="mt-6 space-y-3 rounded-lg bg-white p-4 shadow-sm"
        onSubmit={(event) => {
          event.preventDefault();
          void createProject();
        }}
      >
        <h2 className="font-medium">创建项目</h2>
        <label className="block text-sm" htmlFor="project-title">标题</label>
        <input
          id="project-title"
          className="w-full rounded border border-neutral-300 px-3 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-700"
          maxLength={LIMITS.title}
          value={title}
          onChange={(event) => remember(event.target.value, premise)}
          required
        />
        <label className="block text-sm" htmlFor="project-premise">梗概</label>
        <textarea
          id="project-premise"
          className="w-full rounded border border-neutral-300 px-3 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-red-700"
          maxLength={LIMITS.premise}
          rows={4}
          value={premise}
          onChange={(event) => remember(title, event.target.value)}
        />
        <button className="rounded bg-red-700 px-4 py-2 text-white disabled:opacity-50" type="submit" disabled={creating || title.trim().length === 0}>
          {creating ? "创建中" : "创建项目"}
        </button>
      </form>
      {error ? <p className="mt-4 text-sm" role="alert">{error}</p> : null}
      <section className="mt-6 rounded-lg bg-white p-4 shadow-sm" aria-busy={loading}>
        <h2 className="font-medium">继续创作</h2>
        {loading && page === null ? <p className="mt-3 text-sm">正在加载项目</p> : null}
        {page && page.items.length === 0 ? <p className="mt-3 text-sm">还没有项目</p> : null}
        <ul className="mt-3 divide-y divide-neutral-200">
          {page?.items.map((project) => (
            <li key={project.id} className="flex items-center justify-between gap-3 py-3">
              <div>
                <p className="font-medium">{project.title}</p>
                <p className="text-sm text-neutral-600">{project.premise || "无梗概"} · {project.status} · 版本 {project.version}</p>
              </div>
              <a className="rounded border border-neutral-300 px-3 py-1 text-sm" href={`/projects/${project.id}`}>继续创作</a>
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
