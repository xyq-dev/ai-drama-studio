"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ApiError, StudioClient } from "../lib/studio-client";
import { useModalKeyboard } from "../lib/modal-keyboard";
import { BeginnerShell } from "./beginner-shell";
import styles from "./recycle-bin.module.css";

interface Dependencies {
  scenes: number;
  shots: number;
  speech: number;
  video: number;
  other: number;
  total: number;
}

interface ProjectDeletionPreview {
  kind: "project";
  projectId: string;
  title: string;
  version: number;
  episodeCount: number;
  dependencies: Dependencies;
  canDelete: boolean;
  blockedReason: string | null;
}

interface TrashItem {
  kind: "project" | "script";
  id: string;
  projectId: string;
  title: string;
  episodeId?: string;
  episodeNo?: number;
  revisionNo?: number;
  version: number;
  deletedAt: string;
}

const client = new StudioClient();

function errorText(caught: unknown, fallback: string) {
  if (!(caught instanceof ApiError)) return fallback;
  return caught.status === 409 || caught.status === 412
    ? `${caught.detail} 请刷新核对最新版本后再操作。`
    : caught.detail;
}

function deletedDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "时间未知" : date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
}

/** Reads a fresh impact preview before the user can confirm moving a whole work to trash. */
export function ProjectTrashButton({ projectId, title, onDeleted }: {
  projectId: string;
  title: string;
  onDeleted: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<ProjectDeletionPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const inFlight = useRef(false);
  const alive = useRef(true);
  const readToken = useRef(0);
  const writeRequest = useRef<{ version: number; key: string } | null>(null);
  const headingId = useId();

  function close() {
    if (inFlight.current) return;
    readToken.current += 1;
    setOpen(false);
    opener.current?.focus();
  }
  useModalKeyboard(open, dialog, close);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; readToken.current += 1; };
  }, []);
  useEffect(() => { if (open) cancel.current?.focus(); }, [open]);

  async function readPreview() {
    const token = ++readToken.current;
    setLoading(true);
    setPreview(null);
    setError(null);
    setNeedsRefresh(false);
    try {
      const result = await client.get<ProjectDeletionPreview>(`/projects/${projectId}/script-workbench/deletion-preview`);
      if (alive.current && readToken.current === token) setPreview(result);
    } catch (caught) {
      if (alive.current && readToken.current === token) setError(errorText(caught, "删除范围读取失败，请重试。"));
    } finally {
      if (alive.current && readToken.current === token) setLoading(false);
    }
  }

  async function remove() {
    if (!preview?.canDelete || needsRefresh || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    if (writeRequest.current?.version !== preview.version) {
      writeRequest.current = { version: preview.version, key: crypto.randomUUID() };
    }
    try {
      await client.write({ path: `/projects/${projectId}/script-workbench/trash`,
        body: { expectedVersion: preview.version }, ifMatch: preview.version,
        idempotencyKey: writeRequest.current.key });
      if (!alive.current) return;
      setOpen(false);
      await onDeleted();
    } catch (caught) {
      if (!alive.current) return;
      setError(errorText(caught, "删除结果尚未确认，请重试核对。重复操作不会重复删除。"));
      if (caught instanceof ApiError && (caught.status === 409 || caught.status === 412)) setNeedsRefresh(true);
    } finally {
      inFlight.current = false;
      if (alive.current) setBusy(false);
    }
  }

  return <>
    <button ref={opener} type="button" className={styles.deleteIcon} aria-label={`删除作品：${title}`} title="移入回收站"
      onClick={() => { setOpen(true); void readPreview(); }}>
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7" /></svg>
    </button>
    {open ? <div className={styles.overlay}>
      <div ref={dialog} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby={headingId} aria-busy={loading || busy}>
        <h2 id={headingId}>删除整部作品？</h2>
        {loading ? <p role="status">正在核对作品和涉及的集数…</p> : null}
        {preview ? <>
          <dl className={styles.details}><dt>作品</dt><dd>《{preview.title}》</dd><dt>涉及范围</dt><dd>全部 {preview.episodeCount} 集 · 作品版本 {preview.version}</dd></dl>
          <p>作品将从「我的作品」移入回收站，可恢复后继续创作。</p>
          {preview.dependencies.total > 0 ? <><p>该作品已有以下制作内容：</p><ul className={styles.dependencies}>
            <li>场景：{preview.dependencies.scenes}</li><li>分镜：{preview.dependencies.shots}</li>
            <li>配音：{preview.dependencies.speech}</li><li>视频：{preview.dependencies.video}</li>
            {preview.dependencies.other > 0 ? <li>其他引用：{preview.dependencies.other}</li> : null}
          </ul><p className={styles.restoreHint}>移入回收站会保留这些内容与版本引用。</p></> : null}
          {!preview.canDelete ? <p className={styles.error} role="alert">{preview.blockedReason || "当前作品暂时不能删除，请先处理进行中的任务。"}</p> : null}
        </> : null}
        {error ? <div className={styles.error} role="alert"><p>{error}</p>{!busy && (!preview || needsRefresh) ? <button className={styles.button} type="button" onClick={() => void readPreview()}>重新核对</button> : null}</div> : null}
        <div className={styles.dialogActions}>
          <button ref={cancel} className={styles.button} type="button" disabled={busy} onClick={close}>取消</button>
          <button className={styles.dangerButton} type="button" disabled={busy || loading || !preview?.canDelete || needsRefresh} onClick={() => void remove()}>{busy ? "正在移入…" : "移入回收站"}</button>
        </div>
      </div>
    </div> : null}
  </>;
}

export function RecycleBin() {
  const [items, setItems] = useState<TrashItem[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [restoredHistory, setRestoredHistory] = useState<string | null>(null);
  const alive = useRef(true);
  const readToken = useRef(0);
  const loadingNow = useRef(false);
  const restoringNow = useRef(false);
  const pending = useRef(new Map<string, { key: string; version: number }>());
  const controller = useRef<AbortController | null>(null);

  async function load(cursor: string | null = null) {
    if (cursor && loadingNow.current) return;
    loadingNow.current = true;
    const token = ++readToken.current;
    controller.current?.abort();
    const requestController = new AbortController();
    controller.current = requestController;
    setLoading(true);
    setError(null);
    try {
      const result = await client.get<{ items: TrashItem[]; nextCursor: string | null }>(`/script-workbench/trash${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, { signal: requestController.signal });
      if (alive.current && readToken.current === token) {
        setItems((current) => {
          if (!cursor || !current) return result.items;
          const seen = new Set(current.map((item) => `${item.kind}:${item.id}`));
          return [...current, ...result.items.filter((item) => !seen.has(`${item.kind}:${item.id}`))];
        });
        setNextCursor(result.nextCursor);
      }
    } catch (caught) {
      if (alive.current && readToken.current === token && !requestController.signal.aborted) setError(errorText(caught, "回收站读取失败，请重试。"));
    } finally {
      if (readToken.current === token) {
        loadingNow.current = false;
        if (alive.current) setLoading(false);
      }
    }
  }

  async function restore(item: TrashItem) {
    if (restoringNow.current) return;
    if (item.kind === "script" && !item.episodeId) {
      setError("稿件信息不完整，请刷新回收站后重试。");
      return;
    }
    restoringNow.current = true;
    setRestoring(item.id);
    setError(null);
    setNotice("");
    setRestoredHistory(null);
    const key = `${item.kind}:${item.id}`;
    let request = pending.current.get(key);
    if (request?.version !== item.version) {
      request = { key: crypto.randomUUID(), version: item.version };
      pending.current.set(key, request);
    }
    const path = item.kind === "project"
      ? `/projects/${item.projectId}/script-workbench/restore`
      : `/projects/${item.projectId}/episodes/${item.episodeId}/scripts/${item.id}/restore`;
    try {
      await client.write({ path, body: { expectedVersion: item.version }, ifMatch: item.version, idempotencyKey: request.key });
      if (!alive.current) return;
      pending.current.delete(key);
      setRestoredHistory(item.kind === "script" ? `/projects/${item.projectId}/script?history=${item.episodeId}` : null);
      setItems((current) => current?.filter((entry) => entry.kind !== item.kind || entry.id !== item.id) ?? null);
      setNotice(item.kind === "project" ? `已恢复《${item.title}》，可在「我的作品」继续创作。`
        : `已恢复《${item.title}》第 ${item.episodeNo} 集 v${item.revisionNo}，请在版本记录中查看；未自动定稿或开启制作。`);
      // Restoring a revision changes its episode version; restoring a work can reveal separately deleted drafts.
      // Read again so the remaining restore buttons never carry the previous aggregate version.
      await load();
    } catch (caught) {
      if (alive.current) setError(errorText(caught, "恢复结果尚未确认，请重试或刷新核对。"));
    } finally {
      restoringNow.current = false;
      if (alive.current) setRestoring(null);
    }
  }

  useEffect(() => {
    alive.current = true;
    void load();
    return () => { alive.current = false; readToken.current += 1; controller.current?.abort(); };
  }, []);

  return <BeginnerShell active="/studio"><main className={styles.page}>
    <header className={styles.heading}><div><h1>回收站</h1><p>找回删除的作品和稿件。稿件恢复到版本记录，定稿和制作仍需你确认。</p></div><a className={styles.button} href="/studio">返回我的作品</a></header>
    {notice ? <div className={styles.notice}><p role="status">{notice}</p>{restoredHistory ? <a className={styles.button} href={restoredHistory}>查看本集版本记录</a> : null}</div> : null}
    {error ? <div className={styles.error} role="alert"><p>{error}</p><button className={styles.button} type="button" disabled={loading || restoring !== null} onClick={() => void load()}>刷新回收站</button></div> : null}
    <section className={styles.panel} aria-label="已删除的作品和稿件" aria-busy={loading}>
      <div className={styles.toolbar}><h2>{items ? `${items.length} 项可恢复内容` : "已删除内容"}</h2><button className={styles.button} type="button" disabled={loading || restoring !== null} onClick={() => void load()}>{loading ? "读取中…" : "刷新"}</button></div>
      {items === null && !error ? <p className={styles.empty} role="status">正在读取回收站…</p> : null}
      {items?.length === 0 && !error ? <div className={styles.empty}><h3>回收站是空的</h3><p>删除的作品与稿件会出现在这里。</p><a className={styles.button} href="/studio">去我的作品</a></div> : null}
      {items && items.length > 0 ? <ul className={styles.list}>{items.map((item) => <li key={`${item.kind}:${item.id}`} className={styles.item}>
        <div className={styles.identity}><h3><span className={styles.kind}>{item.kind === "project" ? "整部作品" : "稿件版本"}</span>《{item.title}》{item.kind === "script" ? ` · 第 ${item.episodeNo} 集 v${item.revisionNo}` : ""}</h3>
          <p>删除于 <time dateTime={item.deletedAt}>{deletedDate(item.deletedAt)}</time></p>
          {item.kind === "script" ? <p>恢复后到版本记录查看，不自动替换当前稿件。</p> : null}
        </div><button className={styles.button} type="button" disabled={restoring !== null} aria-label={`恢复${item.kind === "project" ? "作品" : `第 ${item.episodeNo} 集 v${item.revisionNo}`}：${item.title}`} onClick={() => void restore(item)}>{restoring === item.id ? "正在恢复…" : "恢复"}</button>
      </li>)}</ul> : null}
      {nextCursor ? <div className={styles.more}><button className={styles.button} type="button" disabled={loading || restoring !== null} onClick={() => void load(nextCursor)}>{loading ? "读取中…" : "加载更多已删除内容"}</button></div> : null}
    </section>
  </main></BeginnerShell>;
}
