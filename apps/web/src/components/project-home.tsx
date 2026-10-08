"use client";

import { useEffect, useRef, useState } from "react";
import { useModalKeyboard } from "../lib/modal-keyboard";
import { ApiError, StudioClient } from "../lib/studio-client";
import { appendOnce, bindDirectionToProject, premiseBlock, readSelectedDirection } from "../lib/creative-direction-link";
import type { DirectionDraft } from "../lib/creative-taxonomy";
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
  const [listError, setListError] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [premise, setPremise] = useState("");
  const [creating, setCreating] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [direction, setDirection] = useState<DirectionDraft | null>(null);
  const [directionNote, setDirectionNote] = useState<string | null>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLFormElement>(null);

  async function load(cursor: string | null, append: boolean) {
    setLoading(true);
    setListError(null);
    try {
      const path = cursor ? `/projects?cursor=${encodeURIComponent(cursor)}` : "/projects";
      const body = await client.get<{ items: ProjectItem[]; nextCursor: string | null }>(path);
      setPage((current) => applyPage(current, { scope: "projects", items: body.items, nextCursor: body.nextCursor, append }));
    } catch (caught) {
      setListError(caught instanceof ApiError ? caught.detail : "项目列表加载失败");
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
    let selected: DirectionDraft | null;
    try {
      selected = readSelectedDirection(window.localStorage);
    } catch {
      selected = null;
    }
    setDirection(selected);
    // Only a flag travels in the URL; the direction itself stays in this browser's storage.
    if (selected && new URLSearchParams(window.location.search).get("direction") === "1") setComposerOpen(true);
    void load(null, false);
  }, []);

  function closeComposer() {
    setComposerOpen(false);
    openerRef.current?.focus();
  }

  useModalKeyboard(composerOpen, dialogRef, closeComposer);

  useEffect(() => {
    if (!composerOpen) return;
    titleRef.current?.focus();
  }, [composerOpen]);

  function remember(nextTitle: string, nextPremise: string) {
    setTitle(nextTitle);
    setPremise(nextPremise);
    const draft = nextDraft(readDraft(window.sessionStorage, CREATE_KEY), { title: nextTitle, premise: nextPremise }, null, () => crypto.randomUUID());
    writeDraft(window.sessionStorage, CREATE_KEY, draft);
  }

  function applyDirection() {
    if (!direction) return;
    const result = appendOnce(premise, premiseBlock(direction), LIMITS.premise);
    if (!result.ok) {
      setDirectionNote("加入后会超过梗概长度上限，原梗概没有改动。可以先精简梗概。");
      return;
    }
    if (!result.changed) {
      setDirectionNote("梗概里已经有这段创作方向，没有重复加入。");
      return;
    }
    remember(title, result.text);
    setDirectionNote("已把创作方向加入梗概，原有内容保留。提交后才会保存到作品。");
  }

  async function createProject() {
    const draft = nextDraft(readDraft(window.sessionStorage, CREATE_KEY), { title, premise }, null, () => crypto.randomUUID());
    writeDraft(window.sessionStorage, CREATE_KEY, draft);
    setCreating(true);
    setCreateError(null);
    try {
      const created = await client.write<ProjectItem>({
        path: "/projects",
        body: { title, premise },
        idempotencyKey: draft.idempotencyKey,
      });
      clearDraft(window.sessionStorage, CREATE_KEY);
      // Bind the direction to the real project id only when it was carried into this premise.
      if (direction && premise.includes(premiseBlock(direction))) {
        try {
          bindDirectionToProject(window.localStorage, created.body.id, direction);
        } catch {
          // The project is saved; the browser-only direction link is optional.
        }
      }
      window.location.assign(`/projects/${created.body.id}`);
    } catch (caught) {
      setCreateError(caught instanceof ApiError ? `${caught.code}：${caught.detail}` : "创建失败，草稿仍保留，再次提交会复用同一幂等键");
    } finally {
      setCreating(false);
    }
  }

  return (
    <main className="creator-page secondary-page">
      <header className="creator-page-heading secondary-page-heading">
        <div>
          <p className="secondary-eyebrow">创作中心</p>
          <h1>你的作品</h1>
        </div>
        <button
          ref={openerRef}
          className="ui-button ui-button-primary"
          type="button"
          aria-haspopup="dialog"
          aria-expanded={composerOpen}
          onClick={() => setComposerOpen(true)}
        >
          新建作品
        </button>
      </header>
      {composerOpen ? (
        <div className="secondary-modal-backdrop" role="presentation">
          <form
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-work-title"
            className="secondary-modal space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void createProject();
            }}
          >
            <h2 id="create-work-title" className="font-medium">新建作品</h2>
            <p className="text-sm secondary-muted">只保存标题和故事梗概。当前试制范围仍是固定三集，这里不能选择集数或时长。</p>
            <label className="block text-sm" htmlFor="project-title">标题</label>
            <input
              ref={titleRef}
              id="project-title"
              className="secondary-field"
              maxLength={LIMITS.title}
              value={title}
              onChange={(event) => remember(event.target.value, premise)}
              required
            />
            <label className="block text-sm" htmlFor="project-premise">故事梗概</label>
            <textarea
              id="project-premise"
              className="secondary-field"
              maxLength={LIMITS.premise}
              rows={4}
              value={premise}
              onChange={(event) => remember(title, event.target.value)}
            />
            {direction ? (
              <div className="ui-notice">
                <p className="text-sm">分类中心的创作方向（只保存在本浏览器，不会跨设备同步）</p>
                <p className="mt-1 whitespace-pre-line text-sm secondary-muted">{premiseBlock(direction)}</p>
                <button className="ui-button ui-button-secondary mt-2" type="button" onClick={applyDirection}>把创作方向加入梗概</button>
                {directionNote ? <p className="mt-1 text-sm" role="status">{directionNote}</p> : null}
              </div>
            ) : null}
            {createError ? (
              <div className="ui-notice secondary-error" role="alert">
                <p className="text-sm [overflow-wrap:anywhere]">{createError}</p>
                <p className="mt-2 text-sm secondary-muted">草稿仍保留。可以改标题或梗概后再提交，同一内容会复用原来的幂等键。</p>
              </div>
            ) : null}
            <div className="secondary-actions">
              <button className="ui-button ui-button-primary" type="submit" disabled={creating || title.trim().length === 0}>
                {creating ? "创建中" : "创建项目"}
              </button>
              <button className="ui-button ui-button-secondary" type="button" onClick={closeComposer}>关闭</button>
            </div>
          </form>
        </div>
      ) : null}
      {listError ? (
        <div className="ui-notice secondary-error mt-4" role="alert">
          <p className="text-sm">{page === null ? `连接状态：读取失败。${listError}` : listError}</p>
          {page === null ? <p className="mt-2 text-sm secondary-muted">接口暂不可用时不会改用示例项目。</p> : null}
          <div className="secondary-actions">
            <button className="ui-button ui-button-secondary" type="button" onClick={() => void load(null, false)}>重试</button>
            <a className="ui-button ui-button-secondary" href="/preview">查看界面预览</a>
          </div>
        </div>
      ) : null}
      <section className="ui-card secondary-project-list" aria-busy={loading}>
        <h2 className="font-medium">继续创作</h2>
        {loading && page === null ? <p className="mt-3 text-sm">正在加载项目</p> : null}
        {!loading && page && page.items.length === 0 ? <p className="mt-3 text-sm">还没有项目。可以用「新建作品」写下标题和梗概。</p> : null}
        <ul className="secondary-project-items">
          {page?.items.map((project) => (
            <li key={project.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="font-medium [overflow-wrap:anywhere]">{project.title}</p>
                <p className="text-sm secondary-muted">{project.premise || "无梗概"}</p>
                <p className="text-sm secondary-muted">状态 {project.status} · 版本 {project.version}</p>
              </div>
              <a className="ui-button ui-button-secondary" href={`/projects/${project.id}`}>继续创作</a>
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
