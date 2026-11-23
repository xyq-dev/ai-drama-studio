"use client";

import { useEffect, useRef, useState } from "react";
import { formatShanghai } from "../lib/admin-directory-date";
import { withSession } from "../lib/site-session";
import { SelectionCheckbox } from "./project-bulk-actions";
import { AdminWorkActionDialog, type WorkOperation, type WorkResult } from "./admin-work-action-dialog";
import styles from "./admin-directory.module.css";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
interface WorkIdentity { id: string; title: string; ownerName: string }
export interface WorkItem extends WorkIdentity {
  updatedAt: string; productionLabel: string; ownerLegacy: boolean;
  episodeProgress: string; recentTask: string; reviewHref: string;
}
export interface TrashedWork extends WorkIdentity {
  deletedAt: string; deletedBy: string | null; reason: string | null; version: number;
}
export type ManagedWork = WorkItem | TrashedWork;
type Tab = "active" | "trash";
type Page = {
  items: ManagedWork[]; total: number; nextCursor: string | null;
  owners?: Array<{ id: string; name: string }>; canManageWorks?: boolean;
};
const WORK_STATUS = [["all", "全部状态"], ["draft", "草稿"], ["script_review", "剧本待审"], ["storyboard", "分镜中"], ["producing", "制作中"], ["finished", "已完结"], ["unknown", "未知"]];

export function worksCsv(works: WorkItem[]) {
  function field(value: string) {
    // Quoting alone does not stop spreadsheet programs from evaluating formulas.
    // Include Unicode format/control characters that a spreadsheet may ignore before the formula.
    const leading = value.replace(/^[\s\p{Cc}\p{Cf}]+/u, "");
    const safe = /^[=+@\-＝＋＠－]/u.test(leading) || /^[\t\n\r]/u.test(value) ? "'" + value : value;
    return '"' + safe.replaceAll('"', '""') + '"';
  }
  return "\uFEFF" + [["作品名称", "创作者", "制作状态", "更新时间（北京时间）"],
    ...works.map(work => [work.title, work.ownerName, work.productionLabel, formatShanghai(work.updatedAt, "full")])]
    .map(row => row.map(field).join(",")).join("\r\n") + "\r\n";
}

function downloadWorks(works: WorkItem[]) {
  const url = URL.createObjectURL(new Blob([worksCsv(works)], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "作品清单.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function AdminWorkManagement({ wide, fetchImpl, onWork }: {
  wide: boolean; fetchImpl: FetchLike; onWork: (work: WorkItem) => void;
}) {
  const [tab, setTab] = useState<Tab>("active");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [owner, setOwner] = useState("all");
  const [history, setHistory] = useState<string[]>([]);
  const [epoch, setEpoch] = useState(0);
  const [canManage, setCanManage] = useState(false);
  const [owners, setOwners] = useState<Page["owners"]>([]);
  const [loaded, setLoaded] = useState<{ key: string; page: Page } | null>(null);
  const [failed, setFailed] = useState("");
  const [selected, setSelected] = useState(new Set<string>());
  const [operation, setOperation] = useState<WorkOperation | null>(null);
  const [report, setReport] = useState<WorkResult | null>(null);
  const [exportError, setExportError] = useState("");
  const opener = useRef<HTMLElement | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const params = new URLSearchParams();
  if (q.trim()) params.set("q", q.trim());
  if (tab === "active" && status !== "all") params.set("status", status);
  if (tab === "active" && owner !== "all") params.set("owner", owner);
  const cursor = history.at(-1);
  if (cursor) params.set("cursor", cursor);
  const path = "/api/v1/admin/works" + (tab === "trash" ? "/trash" : "") + (params.size ? "?" + params : "");
  const key = path + "|" + epoch;
  const page = loaded?.key === key ? loaded.page : null;

  useEffect(() => {
    const controller = new AbortController();
    const read = async () => {
      try {
        const res = await withSession(fetchImpl)(path, {
          headers: { Accept: "application/json" }, credentials: "same-origin", cache: "no-store", signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (res.status === 401 || res.status === 403) {
          setCanManage(false);
          setLoaded(null);
          setOperation(null);
          setSelected(new Set());
          setReport(null);
        }
        if (!res.ok) throw new Error();
        const body = await res.json() as Page;
        if (controller.signal.aborted) return;
        if (!Array.isArray(body.items)) throw new Error();
        if (tab === "active") {
          setCanManage(body.canManageWorks === true);
          setOwners(body.owners ?? []);
        }
        setFailed("");
        setLoaded({ key, page: body });
      } catch {
        if (!controller.signal.aborted) setFailed(key);
      }
    };
    void read();
    return () => controller.abort();
  }, [fetchImpl, path, key, tab]);

  function resetFilter() {
    setHistory([]);
    setSelected(new Set());
    setReport(null);
    setExportError("");
  }
  function switchTab(next: Tab) {
    if (next === tab) return;
    resetFilter();
    setQ(""); setStatus("all"); setOwner("all"); setTab(next);
  }
  function turnPage(next: string[]) {
    setHistory(next); setSelected(new Set()); setReport(null); setExportError("");
  }
  function toggle(id: string) {
    setSelected(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  const rows = page?.items ?? [];
  const chosen = rows.filter(row => selected.has(row.id));
  const all = rows.length > 0 && chosen.length === rows.length;
  function toggleAll() { setSelected(new Set(all ? [] : rows.map(row => row.id))); }
  function openAction(mode: WorkOperation["mode"], works: ManagedWork[], trigger: HTMLElement) {
    if (!canManage || !works.length) return;
    opener.current = trigger;
    setOperation({ mode, works });
  }
  function closeAction(result?: WorkResult) {
    setOperation(null);
    if (result) {
      setReport(result); setSelected(new Set()); setHistory([]); setEpoch(n => n + 1);
    }
    requestAnimationFrame(() => {
      const previous = opener.current;
      if (!result && previous?.isConnected && !previous.closest("details:not([open])")) previous.focus();
      else search.current?.focus();
    });
  }
  function exportRows(works: WorkItem[]) {
    try { downloadWorks(works); setExportError(""); }
    catch { setExportError("清单导出失败，请重试。"); }
  }
  function check(row: ManagedWork) {
    return <SelectionCheckbox label={`选择《${row.title}》`} checked={selected.has(row.id)} onChange={() => toggle(row.id)} />;
  }
  function selectAll() {
    return <SelectionCheckbox label="全选当前页" checked={all} mixed={chosen.length > 0 && !all}
      disabled={!rows.length} onChange={toggleAll} />;
  }
  function actions(row: ManagedWork) {
    if ("deletedAt" in row) return canManage ? <button type="button" className={styles.linkish}
      onClick={e => openAction("restore", [row], e.currentTarget)}>恢复作品</button> : null;
    return <div className={styles.workRowActions}>
      <button type="button" className={styles.linkish} onClick={() => onWork(row)}>查看详情</button>
      {canManage && <details className={styles.workMenu} onBlur={e => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) e.currentTarget.open = false;
      }} onKeyDown={e => {
        if (e.key === "Escape") { e.currentTarget.open = false; e.currentTarget.querySelector("summary")?.focus(); }
      }}>
        <summary aria-label={`《${row.title}》更多操作`}>···</summary>
        <div>
          <button type="button" onClick={e => { e.currentTarget.closest("details")!.open = false; exportRows([row]); }}>导出清单</button>
          <button type="button" onClick={e => {
            const menu = e.currentTarget.closest("details")!;
            menu.open = false;
            openAction("trash", [row], menu.querySelector("summary")!);
          }}>移入回收站</button>
        </div>
      </details>}
    </div>;
  }

  return <>
    <div className={styles.workTabs} aria-label="作品列表视图">
      <button type="button" aria-pressed={tab === "active"} onClick={() => switchTab("active")}>全部作品</button>
      {(canManage || tab === "trash") && <button type="button" aria-pressed={tab === "trash"} onClick={() => switchTab("trash")}>回收站</button>}
    </div>
    <section className={`${styles.panel} ${styles.worksPanel}`} aria-label={tab === "active" ? "作品列表" : "已移入回收站的作品"}>
      <form role="search" className={styles.workFilters} onSubmit={e => e.preventDefault()}>
        <label className={styles.search}>
          <img src="/design/tailadmin-v2/icon-search.svg" width={18} height={18} alt="" />
          <input ref={search} aria-label="搜索作品或创作者" placeholder="搜索作品或创作者" maxLength={200} value={q}
            onChange={e => { resetFilter(); setQ(e.target.value); }} />
        </label>
        {tab === "active" && <div className={styles.filters}>
          <select aria-label="制作状态" className={styles.select} value={status} onChange={e => { resetFilter(); setStatus(e.target.value); }}>
            {WORK_STATUS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <select aria-label="所属创作者" className={styles.select} value={owner} onChange={e => { resetFilter(); setOwner(e.target.value); }}>
            <option value="all">全部创作者</option>
            {owners?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            <option value="legacy">历史作品</option>
          </select>
        </div>}
      </form>
      {report && <div className={styles.workReport} role="status"><strong>{report.summary}</strong>
        {report.details.length > 0 && <ul>{report.details.map(line => <li key={line.id}>《{line.title}》 {line.message}</li>)}</ul>}
      </div>}
      {exportError && <p role="alert">{exportError}</p>}
      {canManage && chosen.length > 0 && <div className={styles.workBulk}>
        <strong>已选 {chosen.length} 部</strong>
        {tab === "active" && <button type="button" className={styles.secondary} onClick={() => exportRows(chosen as WorkItem[])}>导出清单</button>}
        <button type="button" className={tab === "active" ? styles.workDanger : styles.secondary}
          onClick={e => openAction(tab === "active" ? "trash" : "restore", chosen, e.currentTarget)}>
          {tab === "active" ? "移入回收站" : "恢复作品"}
        </button>
        <button type="button" className={styles.linkish} onClick={() => setSelected(new Set())}>取消选择</button>
      </div>}
      {!page && (failed === key ? <div className={styles.workState} role="alert">
        <h2>{tab === "active" ? "作品列表加载失败" : "回收站加载失败"}</h2>
        <button type="button" className={styles.secondary} onClick={() => setEpoch(n => n + 1)}>重新加载</button>
      </div> : <div className={styles.workState} role="status"><h2>{tab === "active" ? "正在加载作品列表" : "正在读取回收站"}</h2></div>)}
      {page && !rows.length && <div className={styles.workState}><h2>{q || owner !== "all" || status !== "all" ? "没有符合当前筛选的作品" : tab === "active" ? "还没有作品" : "回收站是空的"}</h2></div>}
      {rows.length > 0 && (wide ? <table className={styles.table}>
        <thead><tr>{canManage && <th scope="col" title="全选当前页">{selectAll()}</th>}<th scope="col">作品名称</th><th scope="col">所属创作者</th>
          {tab === "active" ? <><th scope="col">制作状态</th><th scope="col">最近更新</th></> : <><th scope="col">移入时间</th><th scope="col">操作人</th><th scope="col">操作原因</th></>}
          <th scope="col">操作</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.id} data-selected={selected.has(row.id)}>
          {canManage && <td>{check(row)}</td>}<td>{row.title}</td><td>{row.ownerName}</td>
          {"deletedAt" in row ? <><td>{formatShanghai(row.deletedAt, "full")}</td><td>{row.deletedBy ?? "未记录"}</td><td>{row.reason ?? "未记录"}</td></>
            : <><td>{row.productionLabel}</td><td>{formatShanghai(row.updatedAt, "full")}</td></>}
          <td>{actions(row)}</td></tr>)}</tbody>
      </table> : <div className={styles.cards}>
        {canManage && <label className={styles.workSelectAll}>{selectAll()}全选当前页</label>}
        {rows.map(row => <article className={styles.card} key={row.id}>
          <div className={styles.cardHead}><strong>{row.title}</strong>{canManage && check(row)}</div>
          <small>创作者 · {row.ownerName}</small>
          {"deletedAt" in row ? <><small>移入时间 · {formatShanghai(row.deletedAt, "full")}</small><small>操作人 · {row.deletedBy ?? "未记录"}</small><small>操作原因 · {row.reason ?? "未记录"}</small></>
            : <small>{row.productionLabel} · {formatShanghai(row.updatedAt, "full")}</small>}
          {actions(row)}
        </article>)}
      </div>)}
      {page && <footer className={styles.workPager}><span>当前显示 {rows.length} 部，共 {page.total} 部</span>
        {history.length > 0 && <button type="button" className={styles.secondary} onClick={() => turnPage(history.slice(0, -1))}>上一页</button>}
        {page.nextCursor && <button type="button" className={styles.secondary} onClick={() => turnPage([...history, page.nextCursor!])}>下一页</button>}
      </footer>}
    </section>
    {operation && canManage && <AdminWorkActionDialog operation={operation} fetchImpl={fetchImpl} onClose={closeAction} />}
  </>;
}
