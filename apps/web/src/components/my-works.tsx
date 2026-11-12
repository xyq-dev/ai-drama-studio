"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError, StudioClient } from "../lib/studio-client";
import { loadProjectFacts } from "../lib/beginner-facts";
import { STEPS, STEP_STATE_MARK, STEP_STATE_TEXT, stepsFor, stepStates, type StepKey, type StepState } from "../lib/beginner-steps";
import { shouldPoll } from "../lib/studio-model";
import { BeginnerShell } from "./beginner-shell";
import { ProjectBulkActions, SelectionCheckbox } from "./project-bulk-actions";
import styles from "./my-works.module.css";

interface ProjectItem {
  id: string;
  title: string;
  premise: string;
  createdAt: string;
  updatedAt: string;
  episodeCount: number;
  writingMode: "short" | "series";
  categoryId: string | null;
  categoryName: string | null;
  categoryRevision: number;
  thumbnailAssetId: string | null;
  thumbnailUrl: string | null;
}
interface Category { id: string; name: string; count: number }
interface LibraryPage {
  items: ProjectItem[];
  nextCursor: string | null;
  total: number;
  allCount: number;
  unclassifiedCount: number;
  categories: Category[];
  categoriesReady: boolean;
}
interface LibraryQuery { q: string; category: string; sort: "updated" | "created" }
const initialQuery: LibraryQuery = { q: "", category: "all", sort: "updated" };

function queryPath(query: LibraryQuery, cursor: string | null) {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q);
  if (query.category !== "all") params.set("category", query.category);
  if (query.sort !== "updated") params.set("sort", query.sort);
  if (cursor) params.set("cursor", cursor);
  return `/library/projects${params.size ? `?${params}` : ""}`;
}

function ImageIcon() {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="8" cy="9" r="1.5" /><path d="m3 16 5-4 4 4 4-6 5 6" /></svg>;
}
function FolderIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></svg>;
}
function updatedDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "时间未知" : date.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Asia/Shanghai" });
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
function todo(step: StepKey, state: StepState, mode: ProjectItem["writingMode"]): string {
  const title = STEPS.find((item) => item.key === step)?.title ?? "";
  switch (state) {
    case "not_started": return `下一步：${title}`;
    case "needs_input": return `${title}：还需要补充内容`;
    case "needs_confirmation": return `${title}：有内容等你检查确认`;
    case "in_progress": return `${title}：任务处理中`;
    case "needs_attention": return `${title}：有内容需要处理`;
    case "source_updated": return `${title}：上游内容已更新，需要重新确认`;
    case "unknown": return `${title}：部分进度没有读到，暂不能确认`;
    default: return mode === "series" ? "故事和剧本已完成，可以继续编辑" : "五步都已完成，可以查看和下载成片";
  }
}

export function MyWorks() {
  const [items, setItems] = useState<ProjectItem[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingPage, setLoadingPage] = useState(false);
  const pageInFlight = useRef(false);
  const listRequest = useRef(0);
  const listAbort = useRef<AbortController | null>(null);
  const projectMetadata = useRef(new Map<string, ProjectItem>());
  const [query, setQuery] = useState<LibraryQuery>(initialQuery);
  const queryRef = useRef(initialQuery);
  const [search, setSearch] = useState("");
  const [summary, setSummary] = useState<Omit<LibraryPage, "items" | "nextCursor"> | null>(null);
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [categoryName, setCategoryName] = useState("");
  const [categoryBusy, setCategoryBusy] = useState(false);
  const creatingInFlight = useRef(false);
  const categoryRequest = useRef<{ id: string; name: string } | null>(null);
  const [selected, setSelected] = useState(new Set<string>());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkErrors, setBulkErrors] = useState<string[]>([]);
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [categoryNotice, setCategoryNotice] = useState("");
  const [failedThumbnails, setFailedThumbnails] = useState(new Set<string>());
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
        const metadata = projectMetadata.current.get(id);
        if (!metadata) return;
        const states = stepStates({ ...facts, episodeCount: metadata.episodeCount, writingMode: metadata.writingMode });
        const steps = stepsFor(metadata.writingMode);
        const step = steps.find((item) => states[item.key] !== "done")?.key ?? steps[steps.length - 1]!.key;
        const active = facts.runs.some((run) => shouldPoll(run.status, false));
        if (!alive.current || !projectMetadata.current.has(id)) return;
        setProgress((current) => ({ ...current, [id]: { kind: "ready", step, state: states[step], running: active } }));
        // A terminal answer ends the refreshes; a running one schedules the next, within the bound.
        if (active) scheduleRefresh(id);
        else refreshes.current.delete(id);
      }).catch(() => {
        if (!alive.current || !projectMetadata.current.has(id)) return;
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
    if (!projectMetadata.current.has(id) || timers.current.has(id)) return;
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

  async function load(cursor: string | null, nextQuery = queryRef.current) {
    // A filter change supersedes an older page; repeated "load more" clicks share one request.
    if (cursor && pageInFlight.current) return;
    const request = ++listRequest.current;
    listAbort.current?.abort();
    const controller = new AbortController();
    listAbort.current = controller;
    pageInFlight.current = true;
    setLoadingPage(true);
    setError(null);
    try {
      const page = await client.get<LibraryPage>(queryPath(nextQuery, cursor), { signal: controller.signal });
      if (!alive.current || request !== listRequest.current) return;
      if (!cursor) {
        const retained = new Set(page.items.map((item) => item.id));
        for (const [id, timer] of timers.current) if (!retained.has(id)) { clearTimeout(timer); timers.current.delete(id); }
        for (const id of dueWhileHidden.current) if (!retained.has(id)) dueWhileHidden.current.delete(id);
        queue.current = queue.current.filter((queued) => {
          if (retained.has(queued.id)) return true;
          pending.current.delete(queued.id);
          return false;
        });
        projectMetadata.current.clear();
      }
      for (const item of page.items) projectMetadata.current.set(item.id, item);
      setItems((current) => {
        if (!cursor || !current) return page.items;
        const known = new Set(current.map((item) => item.id));
        return [...current, ...page.items.filter((item) => !known.has(item.id))];
      });
      if (!cursor) setSelected((current) => new Set(page.items.filter((item) => current.has(item.id)).map((item) => item.id)));
      setNextCursor(page.nextCursor);
      setSummary(page);
      track(page.items.map((item) => item.id));
    } catch (caught) {
      if (alive.current && request === listRequest.current && !controller.signal.aborted) {
        setError(caught instanceof ApiError ? caught.detail : "作品列表读取失败");
      }
    } finally {
      if (request === listRequest.current) {
        pageInFlight.current = false;
        if (alive.current) setLoadingPage(false);
      }
    }
  }

  function changeQuery(next: LibraryQuery) {
    if (bulkBusy) return;
    setSelected(new Set());
    setBulkErrors([]);
    queryRef.current = next;
    setQuery(next);
    setItems(null);
    setNextCursor(null);
    setCategoryNotice("");
    void load(null, next);
  }

  async function createCategory() {
    const name = categoryName.trim();
    if (!name || creatingInFlight.current || bulkBusy) return;
    creatingInFlight.current = true;
    // Reuse the client identity after a lost response so a retry cannot create another category.
    if (categoryRequest.current?.name !== name) categoryRequest.current = { id: crypto.randomUUID(), name };
    setCategoryBusy(true);
    setCategoryError(null);
    try {
      await client.postJson("/library/categories", categoryRequest.current);
      if (!alive.current) return;
      categoryRequest.current = null;
      setCategoryName("");
      setCreatingCategory(false);
      setCategoryNotice(`已新建分类“${name}”`);
      await load(null);
    } catch (caught) {
      if (alive.current) setCategoryError(caught instanceof ApiError ? caught.detail : "分类保存结果未确认，请重试。");
    } finally {
      creatingInFlight.current = false;
      if (alive.current) setCategoryBusy(false);
    }
  }

  async function completeBulk(_succeeded: string[], notice: string, errors: string[]) {
    setSelected(new Set());
    setCategoryNotice(errors.length ? `${notice} 列表刷新后，请核对未完成作品并重新选择。` : notice);
    setBulkErrors(errors);
    // Refresh counts and server revisions, even when a response was lost.
    await load(null);
  }

  function toggleSelection(id: string) {
    if (bulkBusy || loadingPage) return;
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
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
      listRequest.current += 1;
      listAbort.current?.abort();
      document.removeEventListener("visibilitychange", onVisible);
      for (const timer of scheduled.values()) clearTimeout(timer);
      scheduled.clear();
    };
  }, []);

  const categories = summary?.categories ?? [];
  const selectedCategory = query.category === "all" ? "全部作品" : query.category === "uncategorized" ? "未分类" : categories.find((item) => item.id === query.category)?.name ?? "分类作品";
  const filtered = Boolean(query.q) || query.category !== "all";

  const selectedItems = items?.filter((item) => selected.has(item.id)) ?? [];
  const allSelected = Boolean(items?.length) && selectedItems.length === items?.length;
  const mixedSelection = selectedItems.length > 0 && !allSelected;
  const controlsBusy = bulkBusy || loadingPage || categoryBusy;
  function toggleAll() {
    if (controlsBusy) return;
    setSelected(allSelected ? new Set() : new Set(items?.map((item) => item.id)));
  }

  return (
    <BeginnerShell active="/studio">
      <main className={styles.page}>
        <header className={styles.headingRow}>
          <div>
            <h1 className={styles.heading}>我的作品</h1>
            <p className={styles.intro}>按题材归类，快速找到要继续的故事。</p>
          </div>
          <div className={styles.headingActions}><a className={styles.primary} href="/create"><span className={styles.plus} aria-hidden="true">+</span>开始创作</a></div>
        </header>
        <div className={styles.workspace}>
          <aside className={styles.sidebar} aria-label="作品分类">
            <h2 className={styles.sidebarTitle}><FolderIcon />作品分类</h2>
            <nav className={styles.categoryList} aria-label="按分类筛选作品">
              <button type="button" disabled={bulkBusy} aria-pressed={query.category === "all"} onClick={() => changeQuery({ ...queryRef.current, category: "all" })}><FolderIcon /><span>全部分类</span><span className={styles.count}>{summary?.allCount ?? "—"}</span></button>
              {categories.map((category) => <button type="button" key={category.id} disabled={bulkBusy} aria-pressed={query.category === category.id} onClick={() => changeQuery({ ...queryRef.current, category: category.id })}><FolderIcon /><span>{category.name}</span><span className={styles.count}>{category.count}</span></button>)}
              <button type="button" disabled={!summary?.categoriesReady || bulkBusy} aria-pressed={query.category === "uncategorized"} onClick={() => changeQuery({ ...queryRef.current, category: "uncategorized" })}><FolderIcon /><span>未分类</span><span className={styles.count}>{summary?.unclassifiedCount ?? "—"}</span></button>
            </nav>
            <div className={styles.categoryCreate}>
              {creatingCategory ? <form onSubmit={(event) => { event.preventDefault(); void createCategory(); }}>
                <label htmlFor="new-category-name">分类名称</label>
                <input id="new-category-name" value={categoryName} maxLength={40} autoFocus disabled={categoryBusy || bulkBusy} onChange={(event) => setCategoryName(event.target.value)} placeholder="例如：都市情感" />
                <div className={styles.categoryFormActions}><button className={styles.primary} type="submit" disabled={categoryBusy || bulkBusy || !categoryName.trim()}>{categoryBusy ? "保存中" : "保存"}</button><button className={styles.textButton} type="button" disabled={categoryBusy || bulkBusy} onClick={() => setCreatingCategory(false)}>取消</button></div>
              </form> : <button className={styles.newCategory} type="button" disabled={!summary?.categoriesReady || bulkBusy} onClick={() => { setCreatingCategory(true); setCategoryError(null); }}><span aria-hidden="true">＋</span>新建分类</button>}
              {summary && !summary.categoriesReady ? <p className={styles.sidebarNote} data-unavailable="true">分类功能尚未启用，作品仍可正常打开。</p> : <p className={styles.sidebarNote}>按题材或创作计划，整理你的作品。</p>}
            </div>
            <a className={styles.trashLink} href="/studio/trash"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7" /></svg>回收站</a>
          </aside>
          <section className={styles.library} aria-label="作品列表">
            <div className={styles.toolbar}>
              <div className={styles.listHeading}><h2>{selectedCategory}</h2><span>{summary ? `${summary.total} 部作品` : "读取中"}</span></div>
              <div className={styles.toolbarControls}>
                <form className={styles.search} role="search" onSubmit={(event) => { event.preventDefault(); changeQuery({ ...queryRef.current, q: search.trim() }); }}>
                  <input disabled={bulkBusy} aria-label="搜索作品" maxLength={200} placeholder="搜索作品名称、故事内容" value={search} onChange={(event) => setSearch(event.target.value)} />
                  <button type="submit" disabled={bulkBusy} aria-label="搜索"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg></button>
                </form>
                <select disabled={bulkBusy} aria-label="作品排序" className={styles.sort} value={query.sort} onChange={(event) => changeQuery({ ...queryRef.current, sort: event.target.value as LibraryQuery["sort"] })}><option value="updated">最近更新</option><option value="created">最近创建</option></select>
                <button type="button" className={styles.refresh} aria-label="刷新作品列表" disabled={controlsBusy} onClick={() => { setFailedThumbnails(new Set()); void load(null); }}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M20 10a8 8 0 1 0-1.2 7M20 4v6h-6" /></svg></button>
              </div>
            </div>
            {query.q ? <p className={styles.filterNote}>搜索“{query.q}”<button className={styles.textButton} type="button" onClick={() => { setSearch(""); changeQuery({ ...queryRef.current, q: "" }); }}>清除搜索</button></p> : null}
            {bulkErrors.length ? <div className={styles.notice} role="alert"><p>以下作品未完成，请核对后重试：</p><ul>{bulkErrors.map((message, index) => <li key={index}>{message}</li>)}</ul></div> : null}
            {categoryError ? <p className={styles.notice} role="alert">{categoryError}</p> : null}
            {categoryNotice ? <p className={styles.saveNotice} role="status">{categoryNotice}</p> : null}
            {error ? <div className={styles.notice} role="alert"><p>作品列表读取失败：{error}。不会显示示例作品。</p><button className={styles.secondary} type="button" onClick={() => void load(null)}>重试</button></div> : null}
            {items === null && !error ? <p className={styles.loading} role="status">正在读取作品…</p> : null}
            {items && items.length === 0 && !error ? <div className={styles.empty}>
              <span className={styles.emptyIcon}><ImageIcon /></span>
              <h3>{filtered ? "没有符合条件的作品" : "还没有作品"}</h3>
              <p>{filtered ? "换一个关键词或分类，继续寻找你的故事。" : "从一句话开始，写下你想拍的故事。"}</p>
              {filtered ? <button className={styles.secondary} type="button" onClick={() => { setSearch(""); changeQuery(initialQuery); }}>查看全部作品</button> : <a className={styles.primary} href="/create">开始创作<span aria-hidden="true">→</span></a>}
            </div> : null}
            {items && items.length > 0 ? <table className={styles.table} aria-busy={loadingPage}>
              <thead><tr><th scope="col" className={styles.selectionColumn}><SelectionCheckbox checked={allSelected} mixed={mixedSelection} disabled={controlsBusy} label="选择所有已显示作品" onChange={toggleAll} /></th><th scope="col" className={styles.workColumn}>作品</th><th scope="col" className={styles.categoryColumn}>分类</th><th scope="col" className={styles.stageColumn}>当前阶段</th><th scope="col" className={styles.dateColumn}>更新时间</th><th scope="col" className={styles.actionColumn}>操作</th></tr></thead>
              <tbody>{items.map((item) => {
                const state = progress[item.id];
                const stepTitle = state?.kind === "ready" ? STEPS.find((step) => step.key === state.step) : null;
                return <tr key={item.id} data-selected={selected.has(item.id)}>
                  <td className={styles.selectionCell}><SelectionCheckbox checked={selected.has(item.id)} disabled={controlsBusy} label={`选择作品：${item.title}`} onChange={() => toggleSelection(item.id)} /></td>
                  <td className={styles.workCell}><div className={styles.workIdentity}>
                    <a className={styles.thumbnail} href={`/projects/${item.id}/create`} aria-label={`打开作品：${item.title}`}>
                      {item.thumbnailUrl && !failedThumbnails.has(item.thumbnailUrl) ? <img src={item.thumbnailUrl} alt={`${item.title}封面`} loading="lazy" onError={() => setFailedThumbnails((current) => new Set(current).add(item.thumbnailUrl!))} /> : <span className={styles.thumbnailPlaceholder}><ImageIcon /><span>暂无封面</span></span>}
                    </a>
                    <div className={styles.workText}><h3><a href={`/projects/${item.id}/create`}>{item.title}</a></h3><p className={styles.premise} title={item.premise || "还没有故事想法"}><span className={styles.workMeta}>{item.writingMode === "series" ? "系列写作" : "短剧创作"}{item.episodeCount ? ` · ${item.episodeCount} 集` : ""} · </span>{item.premise || "还没有故事想法"}</p><a className={styles.scriptLink} href={`/projects/${item.id}/script`}>剧本工作台</a></div>
                  </div></td>
                  <td className={styles.categoryCell} data-label="分类"><span className={styles.categoryBadge}>{item.categoryName ?? "未分类"}</span></td>
                  <td className={styles.progressCell}><div aria-live="polite">
                    {!state || state.kind === "loading" ? <p className={styles.progressNote}>正在读取进度…</p> : null}
                    {state?.kind === "failed" ? <p className={styles.progressNote}>进度读取失败。<button className={styles.textButton} type="button" onClick={() => track([item.id])}>重试</button></p> : null}
                    {state?.kind === "ready" && stepTitle ? <>
                      <p className={styles.statusLine} data-state={state.state} title={todo(state.step, state.state, item.writingMode)}><span className={styles.stageTitle}><span className={styles.visuallyHidden}>当前阶段：</span>{`第 ${stepTitle.no} 步 ${stepTitle.title}`}</span><span className={styles.stateText}>{`${STEP_STATE_MARK[state.state]} ${STEP_STATE_TEXT[state.state]}`}</span></p>
                      <p className={["needs_input", "needs_attention", "source_updated", "unknown"].includes(state.state) ? styles.progressNote : styles.visuallyHidden}>{todo(state.step, state.state, item.writingMode)}</p>
                      {state.running && !state.paused ? <p className={styles.progressNote}>有任务正在处理，进度会自动刷新。</p> : null}
                      {state.refreshFailed && !state.paused ? <p className={styles.progressNote}>最新进度暂时没有读到，显示的是上次读到的阶段，稍后会再试。</p> : null}
                      {state.paused ? <p className={styles.progressNote}>任务仍在处理，已暂停自动刷新。<button className={styles.textButton} type="button" onClick={() => refreshNow(item.id)}>刷新进度</button></p> : null}
                    </> : null}
                  </div></td>
                  <td className={styles.dateCell} data-label="更新于"><time dateTime={item.updatedAt} title={item.updatedAt}>{updatedDate(item.updatedAt)}</time></td>
                  <td className={styles.actions}><div className={styles.actionLinks}><a className={styles.continue} href={`/projects/${item.id}/create`}>继续创作<span aria-hidden="true">→</span></a><a className={styles.advanced} href={`/projects/${item.id}`} aria-label="高级编辑" title="高级编辑"><span aria-hidden="true">···</span></a></div></td>
                </tr>;
              })}</tbody>
            </table> : null}

          </section>
          <footer className={styles.bulkFooter} aria-label="作品批量管理" aria-busy={bulkBusy}>
            <div className={styles.bulkControls}>
              <label className={styles.selectAll}><SelectionCheckbox checked={allSelected} mixed={mixedSelection} disabled={controlsBusy || !items?.length} label="全选已显示作品" onChange={toggleAll} /><span>全选已显示</span></label>
              <strong className={styles.selectedCount}>已选 {selectedItems.length} 部</strong>
              <ProjectBulkActions selected={selectedItems} categories={categories} categoriesReady={summary?.categoriesReady ?? false} disabled={controlsBusy || Boolean(error)} onBusyChange={setBulkBusy} onComplete={completeBulk} />
              <button className={styles.cancelSelection} type="button" disabled={controlsBusy || !selectedItems.length} onClick={() => setSelected(new Set())}>取消选择</button>
            </div>
            <div className={styles.pagination}><span>已显示 {items?.length ?? 0} / {summary?.total ?? 0} 部作品</span>{nextCursor ? <button className={styles.secondary} type="button" disabled={controlsBusy} onClick={() => void load(nextCursor)}>{loadingPage ? "正在加载" : "加载更多作品"}</button> : <span>已显示全部作品</span>}</div>
          </footer>
        </div>
        <p className={styles.bottomHint}>删除后可在回收站恢复。全选仅包含当前已显示的作品。</p>
      </main>
    </BeginnerShell>
  );
}
