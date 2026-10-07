"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError, StudioClient } from "../lib/studio-client";
import { appendOnce, bindDirectionToProject, premiseBlock, readSelectedDirection } from "../lib/creative-direction-link";
import type { DirectionDraft } from "../lib/creative-taxonomy";
import { IDEA_TEMPLATES, START_SCOPE_NOTE, suggestTitle } from "../lib/beginner-start";
import { LIMITS, draftStorageKey, nextDraft, readDraft, releaseSubmittedDraft, writeDraft } from "../lib/studio-model";
import { BeginnerShell } from "./beginner-shell";

interface ProjectItem {
  id: string;
  title: string;
}

const client = new StudioClient();
/** Same draft slot as the earlier create dialog, so an unfinished create keeps its idempotency key. */
const CREATE_KEY = draftStorageKey("new", "project", null);

/**
 * "你的故事，从一句话开始". Typing, choosing a template or opening the inspiration centre never creates a project:
 * only "确认创建作品" posts { title, premise } with the draft's idempotency key, which survives a failed or unsure reply.
 */
export function BeginnerStart({ active }: { active: "/create" | undefined }) {
  const [idea, setIdea] = useState("");
  const [title, setTitle] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [latest, setLatest] = useState<ProjectItem | null>(null);
  const [direction, setDirection] = useState<DirectionDraft | null>(null);
  const [directionNote, setDirectionNote] = useState<string | null>(null);
  const confirmHeading = useRef<HTMLHeadingElement>(null);
  const creatingRef = useRef(false);
  const ideaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let restored = false;
    try {
      const draft = readDraft(window.sessionStorage, CREATE_KEY);
      const payload = draft?.payload as { title?: unknown; premise?: unknown } | undefined;
      if (payload && typeof payload.premise === "string") {
        setIdea(payload.premise);
        restored = true;
      }
      if (payload && typeof payload.title === "string") setTitle(payload.title);
    } catch {
      // A broken draft slot only means nothing is restored.
    }
    if (restored) setConfirming(true);
    try {
      const selected = readSelectedDirection(window.localStorage);
      if (selected && new URLSearchParams(window.location.search).get("direction") === "1") setDirection(selected);
    } catch {
      setDirection(null);
    }
    let alive = true;
    void client.get<{ items: ProjectItem[] }>("/projects").then((page) => {
      if (alive) setLatest(page.items[0] ?? null);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (confirming) confirmHeading.current?.focus();
  }, [confirming]);

  function remember(nextTitle: string, nextIdea: string) {
    // While a create is in flight the request content is frozen: nothing may change what was submitted.
    if (creatingRef.current) return;
    setTitle(nextTitle);
    setIdea(nextIdea);
    try {
      writeDraft(window.sessionStorage, CREATE_KEY,
        nextDraft(readDraft(window.sessionStorage, CREATE_KEY), { title: nextTitle, premise: nextIdea }, null, () => crypto.randomUUID()));
    } catch {
      // Without session storage the page still works; a retry then cannot reuse the key across a reload.
    }
  }

  function startConfirm() {
    if (idea.trim().length === 0) {
      setError("先写下一句你想拍的故事。");
      ideaRef.current?.focus();
      return;
    }
    setError(null);
    remember(title.trim().length > 0 ? title : suggestTitle(idea), idea);
    setConfirming(true);
  }

  function applyDirection() {
    if (!direction) return;
    const result = appendOnce(idea, premiseBlock(direction), LIMITS.premise);
    if (!result.ok) {
      setDirectionNote("加入后会超过梗概长度上限，原内容没有改动。");
      return;
    }
    if (!result.changed) {
      setDirectionNote("想法里已经有这段创作方向。");
      return;
    }
    remember(title, result.text);
    setDirectionNote("已加入创作方向。确认创建后才会保存。");
  }

  async function create() {
    if (creatingRef.current) return;
    let draft;
    try {
      draft = nextDraft(readDraft(window.sessionStorage, CREATE_KEY), { title, premise: idea }, null, () => crypto.randomUUID());
      writeDraft(window.sessionStorage, CREATE_KEY, draft);
    } catch {
      draft = nextDraft(null, { title, premise: idea }, null, () => crypto.randomUUID());
    }
    creatingRef.current = true;
    setCreating(true);
    setError(null);
    try {
      const created = await client.write<ProjectItem>({ path: "/projects", body: { title, premise: idea }, idempotencyKey: draft.idempotencyKey });
      try {
        // Clear only the snapshot that was submitted; anything newer stays as this tab's draft.
        releaseSubmittedDraft(window.sessionStorage, CREATE_KEY, draft);
        if (direction && idea.includes(premiseBlock(direction))) bindDirectionToProject(window.localStorage, created.body.id, direction);
      } catch {
        // The project is saved; the browser-only extras are optional.
      }
      window.location.assign(`/projects/${created.body.id}/create`);
    } catch (caught) {
      setError(caught instanceof ApiError && caught.status < 500 && caught.status !== 0
        ? `作品没有创建：${caught.detail}。你的内容还在，修改后可以再试。`
        : "没有确认作品是否已创建（网络或服务异常）。内容还在；再次点击会用同一个请求标识，服务器不会重复创建。");
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }

  return (
    <BeginnerShell active={active}>
      <main className="mx-auto max-w-3xl px-4 pb-28 pt-10 sm:pb-12">
        <h1 className="text-3xl font-semibold leading-tight sm:text-4xl">你的故事，从一句话开始</h1>
        <p className="mt-3 text-[17px] text-[#5F5D66]">不用会写剧本，先告诉我你想拍什么。</p>
        {latest ? (
          <p className="mt-4 text-[15px]">
            <a className="underline" href={`/projects/${latest.id}/create`}>继续上次创作：{latest.title}</a>
          </p>
        ) : null}

        <section className="mt-6 rounded-[12px] border border-[#E7E5E0] bg-white p-5 shadow-sm" aria-label="写下想法">
          <label id="idea-label" className="block font-medium" htmlFor="idea">你想拍一个什么样的故事？</label>
          <textarea
            ref={ideaRef}
            id="idea"
            className="mt-2 w-full rounded-[12px] border px-3 py-2 text-[16px]"
            rows={4}
            maxLength={LIMITS.premise}
            placeholder="例如：一个外卖员发现自己每天送餐的那户人家，其实是他失散多年的哥哥。"
            value={idea}
            aria-describedby={error ? "start-error scope-note" : "scope-note"}
            disabled={creating}
            onChange={(event) => { setConfirming(false); remember(title, event.target.value); }}
          />
          <p id="scope-note" className="mt-2 text-sm text-[#5F5D66]">{START_SCOPE_NOTE}</p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button className={confirming ? "rounded-[12px] border border-[#D34846] bg-white px-5 py-2.5 font-medium text-[#B8322F]"
              : "rounded-[12px] bg-[#D34846] px-5 py-2.5 font-medium text-white"} type="button" disabled={creating} onClick={startConfirm}>开始构思</button>
            <a className="text-[15px] underline" href="/categories">还没想法？看看灵感</a>
          </div>
          <div className="mt-5">
            <p className="text-sm text-[#5F5D66]">示例模板（静态示例，点选只会填入输入框，不会创建作品）</p>
            <ul className="mt-2 flex flex-wrap gap-2">
              {IDEA_TEMPLATES.map((template) => (
                <li key={template.id}>
                  <button className="rounded-[12px] border px-3 py-1.5 text-[15px] hover:bg-[#FBE7E4] disabled:opacity-60" type="button"
                    disabled={creating} onClick={() => { setConfirming(false); remember(title, template.idea); }}>
                    示例 · {template.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
          {direction ? (
            <div className="mt-5 rounded-[12px] border p-3">
              <p className="text-sm">灵感中心选好的创作方向（只保存在本浏览器）</p>
              <p className="mt-1 whitespace-pre-line text-sm text-[#5F5D66]">{premiseBlock(direction)}</p>
              <button className="mt-2 rounded-[12px] border px-3 py-1 text-sm" type="button" disabled={creating} onClick={applyDirection}>把创作方向加入想法</button>
              {directionNote ? <p className="mt-1 text-sm" role="status">{directionNote}</p> : null}
            </div>
          ) : null}
        </section>

        {confirming ? (
          <section className="mt-6 rounded-[12px] border-2 border-[#D34846] bg-white p-5" aria-labelledby="confirm-title">
            <h2 id="confirm-title" ref={confirmHeading} tabIndex={-1} className="text-xl font-semibold">确认创建作品</h2>
            <p className="mt-1 text-[15px] text-[#5F5D66]">点「确认创建作品」后才会保存到服务器。之后在「定故事」一步把想法写成完整故事。</p>
            <label className="mt-4 block font-medium" htmlFor="work-title">作品名称</label>
            <input id="work-title" className="mt-1 w-full rounded-[12px] border px-3 py-2" maxLength={LIMITS.title} value={title}
              aria-describedby="title-hint" disabled={creating} onChange={(event) => remember(event.target.value, idea)} />
            <p id="title-hint" className="mt-1 text-sm text-[#5F5D66]">
              建议名称按规则截取自你的想法开头，不是 AI 生成，可以直接修改。
              <button className="ml-2 underline" type="button" disabled={creating} onClick={() => remember(suggestTitle(idea), idea)}>重新按想法截取</button>
            </p>
            <p className="mt-3 font-medium">故事想法</p>
            <p className="mt-1 whitespace-pre-line rounded-[12px] bg-[#F7F6F2] p-3 text-[15px] [overflow-wrap:anywhere]">{idea}</p>
            <div className="fixed inset-x-0 bottom-0 z-10 border-t border-[#E7E5E0] bg-white p-3 sm:static sm:mt-4 sm:border-0 sm:p-0">
              <button className="w-full rounded-[12px] bg-[#D34846] px-5 py-3 font-medium text-white disabled:opacity-60 sm:w-auto" type="button"
                disabled={creating || title.trim().length === 0} onClick={() => void create()}>
                {creating ? "正在创建…" : "确认创建作品"}
              </button>
              {creating ? <p className="mt-2 text-sm text-[#5F5D66]" role="status">正在创建，内容已锁定，完成前不能修改。</p> : null}
            </div>
          </section>
        ) : null}
        {error ? <p id="start-error" className="mt-4 rounded-[12px] border border-[#D34846] bg-[#FBE7E4] p-3 text-[15px]" role="alert">{error}</p> : null}
      </main>
    </BeginnerShell>
  );
}
