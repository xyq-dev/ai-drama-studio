"use client";

import { TITLE_WRITING_PROVIDER_LABELS, type ProjectLibraryScript } from "@ai-drama/contracts";
import { useEffect, useId, useRef, useState } from "react";
import { ApiError, StudioClient } from "../lib/studio-client";
import { loadProjectFacts } from "../lib/beginner-facts";
import { STEPS, STEP_STATE_MARK, STEP_STATE_TEXT, stepsFor, stepStates, type StepKey, type StepState } from "../lib/beginner-steps";
import { useModalKeyboard } from "../lib/modal-keyboard";
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
  script?: ProjectLibraryScript;
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
  return <img src="/design/tailadmin-v2/icon-cover-placeholder.svg" width={22} height={22} alt="" />;
}

function ScriptSource({ script }: { script: ProjectLibraryScript | undefined }) {
  const source = script?.source ?? "unknown";
  const label = source === "ai" ? "AI 生成" : source === "manual" ? "人工创作" : "来源未记录";
  const icon = source === "ai" ? "ai" : source === "manual" ? "manual" : null;
  const providerKey = script?.providerKey;
  const provider = providerKey && Object.hasOwn(TITLE_WRITING_PROVIDER_LABELS, providerKey)
    ? TITLE_WRITING_PROVIDER_LABELS[providerKey as keyof typeof TITLE_WRITING_PROVIDER_LABELS]
    : providerKey;
  return <div className={styles.scriptSource}>
    <span className={styles.sourceBadge} data-source={source}>
      {icon ? <img src={`/design/tailadmin-v2/icon-script-${icon}.svg`} width={15} height={15} alt="" /> : null}
      {label}
    </span>
    {source === "ai" && (provider || script?.model) ? <span className={styles.model} title={script?.model ?? undefined}>{provider || script?.model}</span> : null}
  </div>;
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
  const [desktop, setDesktop] = useState(true);
  const categoryDialog = useRef<HTMLDivElement>(null);
  const categoryInput = useRef<HTMLInputElement>(null);
  const categoryOpener = useRef<HTMLButtonElement>(null);
  const categoryWasOpen = useRef(false);
  const categoryHeadingId = useId();
  const categoryInputId = useId();
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

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia("(min-width: 1024px)");
    const sync = () => setDesktop(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);

  function closeCategory() {
    if (!creatingInFlight.current) setCreatingCategory(false);
  }
  useModalKeyboard(creatingCategory, categoryDialog, closeCategory);
  useEffect(() => {
    if (creatingCategory) {
      categoryWasOpen.current = true;
      categoryInput.current?.focus();
    } else if (categoryWasOpen.current && !categoryBusy) {
      categoryWasOpen.current = false;
      const opener = categoryOpener.current;
      if (opener && !opener.closest("[hidden]")) opener.focus();
      else document.getElementById("main")?.focus();
    }
  }, [creatingCategory, categoryBusy]);

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

  const searchForm = <form className={styles.search} role="search" onSubmit={(event) => { event.preventDefault(); changeQuery({ ...queryRef.current, q: search.trim() }); }}>
    <button type="submit" disabled={bulkBusy} aria-label="搜索"><img src="/design/tailadmin-v2/icon-search.svg" width={19} height={19} alt="" /></button>
    <input disabled={bulkBusy} aria-label="搜索作品" maxLength={200} placeholder="搜索剧本标题、作品名称或故事内容…" value={search} onChange={(event) => setSearch(event.target.value)} />
  </form>;
  const categoryNavigation = <div className={styles.categoryNavigation}>
    <div className={styles.categoryList} role="group" aria-label="按分类筛选作品">
      <button type="button" disabled={bulkBusy} aria-pressed={query.category === "all"} onClick={() => changeQuery({ ...queryRef.current, category: "all" })}><span>全部作品</span><span className={styles.count}>{summary?.allCount ?? "—"}</span></button>
      {categories.map((category) => <button type="button" key={category.id} disabled={bulkBusy} aria-pressed={query.category === category.id} onClick={() => changeQuery({ ...queryRef.current, category: category.id })}><span>{category.name}</span><span className={styles.count}>{category.count}</span></button>)}
      <button type="button" disabled={!summary?.categoriesReady || bulkBusy} aria-pressed={query.category === "uncategorized"} onClick={() => changeQuery({ ...queryRef.current, category: "uncategorized" })}><span>未分类</span><span className={styles.count}>{summary?.unclassifiedCount ?? "—"}</span></button>
    </div>
    <button ref={categoryOpener} className={styles.newCategory} type="button" disabled={!summary?.categoriesReady || bulkBusy} onClick={() => { setCreatingCategory(true); setCategoryError(null); }}><span aria-hidden="true">＋</span>新建分类</button>
    {summary && !summary.categoriesReady ? <p className={styles.sidebarNote}>分类功能尚未启用，作品仍可正常打开。</p> : null}
    <a className={styles.trashLink} href="/studio/trash"><img src="/design/tailadmin-v2/icon-trash.svg" width={20} height={20} alt="" />回收站</a>
  </div>;

  return (
    <BeginnerShell active="/studio" workspaceNavigation={categoryNavigation} headerContent={desktop ? searchForm : undefined}>
      <main className={styles.page}>
        <header className={styles.headingRow}>
          <div><h1 className={styles.heading}>我的作品</h1><p className={styles.intro}>从一个想法，到一部作品。</p></div>
          <div className={styles.headingActions}><a className={styles.primary} href="/create"><span className={styles.plus} aria-hidden="true">+</span>开始创作</a></div>
        </header>
        {!desktop ? <div className={styles.mobileSearch}>{searchForm}</div> : null}
        <div className={styles.workspace}>
          <section className={styles.library} aria-label="作品列表">
            <div className={styles.toolbar}>
              <div className={styles.listHeading}>
                <h2>{selectedCategory}</h2>
                {!desktop ? <select className={styles.mobileCategory} aria-label="作品分类" disabled={bulkBusy} value={query.category} onChange={(event) => changeQuery({ ...queryRef.current, category: event.target.value })}>
                  <option value="all">全部作品</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}<option value="uncategorized" disabled={!summary?.categoriesReady}>未分类</option>
                </select> : null}
                <span>{summary ? `${summary.total} 部作品` : "读取中"}</span>
              </div>
              <div className={styles.toolbarControls}>
                <select disabled={bulkBusy} aria-label="作品排序" className={styles.sort} value={query.sort} onChange={(event) => changeQuery({ ...queryRef.current, sort: event.target.value as LibraryQuery["sort"] })}><option value="updated">最近更新</option><option value="created">最近创建</option></select>
                <button type="button" className={styles.refresh} aria-label="刷新作品列表" disabled={controlsBusy} onClick={() => { setFailedThumbnails(new Set()); void load(null); }}><img src="/design/tailadmin-v2/icon-refresh.svg" width={20} height={20} alt="" /></button>
              </div>
            </div>
            {query.q ? <p className={styles.filterNote}>搜索“{query.q}”<button className={styles.textButton} type="button" onClick={() => { setSearch(""); changeQuery({ ...queryRef.current, q: "" }); }}>清除搜索</button></p> : null}
            {bulkErrors.length ? <div className={styles.notice} role="alert"><p>以下作品未完成，请核对后重试：</p><ul>{bulkErrors.map((message, index) => <li key={index}>{message}</li>)}</ul></div> : null}

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
                const title = item.script?.title || item.title;
                const projectPath = `/projects/${item.id}`;
                const scriptHref = item.script?.destination === "auto" ? `${projectPath}/auto#auto-episodes-title`
                  : item.script?.destination === "script" ? `${projectPath}/script?view=episodes` : null;
                const workMeta = title !== item.title ? item.title : item.writingMode === "series" ? "系列写作" : "短剧创作";
                return <tr key={item.id} data-selected={selected.has(item.id)} data-has-script={Boolean(scriptHref)}>
                  <td className={styles.selectionCell}><SelectionCheckbox checked={selected.has(item.id)} disabled={controlsBusy} label={`选择作品：${title}`} onChange={() => toggleSelection(item.id)} /></td>
                  <td className={styles.workCell}><div className={styles.workIdentity}>
                    <a className={styles.thumbnail} href={`${projectPath}/create`} aria-label={`打开作品：${title}`}>
                      {item.thumbnailUrl && !failedThumbnails.has(item.thumbnailUrl) ? <img className={styles.coverImage} src={item.thumbnailUrl} alt={`${title}封面`} loading="lazy" onError={() => setFailedThumbnails((current) => new Set(current).add(item.thumbnailUrl!))} /> : <span className={styles.thumbnailPlaceholder}><ImageIcon /><span>暂无封面</span></span>}
                    </a>
                    <div className={styles.workText}>
                      <h3><a href={scriptHref ?? `${projectPath}/create`} title={title}>{title}</a></h3>
                      <ScriptSource script={item.script} />
                      <p className={styles.workMeta} title={workMeta}>{workMeta}{item.episodeCount ? ` · ${item.episodeCount} 集` : ""}</p>
                      {!scriptHref ? <a className={styles.scriptLink} href={`${projectPath}/script`}>剧本工作台</a> : null}
                    </div>
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
                  <td className={styles.actions}><div className={styles.actionLinks}>
                    {scriptHref ? <a className={styles.continue} href={scriptHref}>查看剧本</a>
                      : <a className={styles.continue} href={`${projectPath}/create`}>继续创作<span aria-hidden="true">→</span></a>}
                    <a className={styles.advanced} href={projectPath} aria-label="高级编辑" title="高级编辑"><img src="/design/tailadmin-v2/icon-more.svg" width={20} height={20} alt="" /></a>
                  </div></td>
                </tr>;
              })}</tbody>
            </table> : null}

            <div className={styles.pagination}><span>已显示 {items?.length ?? 0} / {summary?.total ?? 0} 部作品</span>{nextCursor ? <button className={styles.secondary} type="button" disabled={controlsBusy} onClick={() => void load(nextCursor)}>{loadingPage ? "正在加载" : "加载更多作品"}</button> : <span>已显示全部作品</span>}</div>
          </section>
          <footer className={styles.bulkFooter} aria-label="作品批量管理" aria-busy={bulkBusy}>
            <div className={styles.bulkControls}>
              <label className={styles.selectAll}><SelectionCheckbox checked={allSelected} mixed={mixedSelection} disabled={controlsBusy || !items?.length} label="全选已显示作品" onChange={toggleAll} /><span>全选已显示</span></label>
              <strong className={styles.selectedCount}>已选 {selectedItems.length} 部</strong>
              <ProjectBulkActions selected={selectedItems} categories={categories} categoriesReady={summary?.categoriesReady ?? false} disabled={controlsBusy || Boolean(error)} onBusyChange={setBulkBusy} onComplete={completeBulk} />
              <button className={styles.cancelSelection} type="button" disabled={controlsBusy || !selectedItems.length} onClick={() => setSelected(new Set())}>取消选择</button>
            </div>
            <p className={styles.bottomHint}>删除后可在回收站恢复。全选仅包含当前已显示的作品。</p>
          </footer>
        </div>
        {creatingCategory ? <div className={styles.overlay}><div ref={categoryDialog} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby={categoryHeadingId} aria-busy={categoryBusy}>
          <h2 id={categoryHeadingId}>新建分类</h2><p className={styles.dialogNote}>按题材或创作计划，整理你的作品。</p>
          <form onSubmit={(event) => { event.preventDefault(); void createCategory(); }}>
            <label className={styles.fieldLabel} htmlFor={categoryInputId}>分类名称</label>
            <input ref={categoryInput} className={styles.categoryInput} id={categoryInputId} value={categoryName} maxLength={40} disabled={categoryBusy} onChange={(event) => setCategoryName(event.target.value)} placeholder="例如：都市情感" />
            {categoryError ? <p className={styles.notice} role="alert">{categoryError}</p> : null}
            <div className={styles.dialogActions}><button className={styles.secondary} type="button" disabled={categoryBusy} onClick={closeCategory}>取消</button><button className={styles.primary} type="submit" disabled={categoryBusy || !categoryName.trim()}>{categoryBusy ? "保存中" : "保存"}</button></div>
          </form>
        </div></div> : null}
      </main>
    </BeginnerShell>
  );
}
