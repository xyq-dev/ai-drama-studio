"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { Aggregate } from "../lib/project-base";
import { useModalKeyboard } from "../lib/modal-keyboard";
import { HoverMediaPreview } from "./hover-media-preview";
import { StoryboardImageBatch } from "./storyboard-image-batch";
import styles from "./storyboard-rows.module.css";

export interface StoryboardShot extends Aggregate {
  storyboard?: {
    ordinal: number;
    shotType: string;
    camera: string;
    action: string;
    dialogue: string | null;
    durationHint: string | null;
    plannedDurationMs: number | null;
    promptText: string;
    sourceScene: string;
    location: string | null;
    characters: Array<{ id: string; name: string; assetId: string | null }>;
    candidates: Array<{ id: string; kind: "IMAGE" | "VIDEO"; storageProvider: "s3" | "mock-object-store"; status: string }>;
    selectedAssetId: string | null;
  };
}

const REVIEW: Record<string, string> = { DRAFT: "草稿", IN_REVIEW: "审核中", IN_REVIEW_PENDING: "待审核", APPROVED: "已审核", REJECTED: "已退回" };
const normalize = (value: string) => value.trim().toLocaleLowerCase();

export function StoryboardRows({ projectId, items, currentId, loading, hasMore, onMore, onOpen, onArchive, onDispatched, createForm }: {
  projectId: string;
  items: readonly StoryboardShot[];
  currentId: string | null;
  loading: boolean;
  hasMore: boolean;
  onMore: () => Promise<void>;
  onOpen: (id: string | null) => void;
  onArchive: (shot: StoryboardShot, key: string) => Promise<void>;
  onDispatched: () => void;
  createForm?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [grid, setGrid] = useState(4);
  const [newOpen, setNewOpen] = useState(false);
  const [paging, setPaging] = useState(false);
  const [pageError, setPageError] = useState(false);
  const [selection, setSelection] = useState(new Set<string>());
  const [archive, setArchive] = useState<{ shot: StoryboardShot; key: string } | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const modal = useRef<HTMLDivElement>(null);
  const archiveCancel = useRef<HTMLButtonElement>(null);
  const archiveOpener = useRef<HTMLElement | null>(null);
  const title = useId();
  const confirmTitle = useId();
  const match = normalize(query);
  const filtered = items.filter(shot => {
    const info = shot.storyboard;
    const searchable = [info?.ordinal, info?.shotType, info?.camera, info?.action, info?.dialogue, info?.promptText, info?.location,
      info?.sourceScene, ...(info?.characters.map(item => item.name) ?? [])].join(" ");
    return (filter === "all" || (filter === "STALE" ? shot.currentRevision?.freshnessStatus === "STALE"
      : shot.currentRevision?.freshnessStatus !== "STALE" && shot.currentRevision?.reviewStatus === filter))
      && (!match || normalize(searchable).includes(match));
  });
  const visible = currentId ? items.filter(shot => shot.entityId === currentId) : filtered;
  const selectedShots = filtered.flatMap(shot => canBatch(shot) && selection.has(shot.currentRevisionId)
    ? [{ shotRevisionId: shot.currentRevisionId, label: shotLabel(shot), promptText: shot.storyboard.promptText }] : []);

  function closeArchive() {
    if (!archiving) { setArchive(null); setArchiveError(null); }
  }
  useModalKeyboard(Boolean(archive), modal, closeArchive);
  useEffect(() => {
    if (!archive) return;
    archiveCancel.current?.focus();
    const opener = archiveOpener.current;
    return () => { if (opener?.isConnected) opener.focus(); };
  }, [archive]);

  async function more() {
    if (paging) return;
    setPaging(true);
    setPageError(false);
    try { await onMore(); }
    catch { setPageError(true); }
    finally { setPaging(false); }
  }

  async function confirmArchive() {
    if (!archive || archiving) return;
    setArchiving(true);
    setArchiveError(null);
    try { await onArchive(archive.shot, archive.key); setArchive(null); }
    catch (error) { setArchiveError(error instanceof Error ? error.message : "删除未确认，请重新核对后重试。"); }
    finally { setArchiving(false); }
  }

  return <section className={styles.workbench} aria-labelledby={title}>
    <div className={styles.header}>
      <div><h2 id={title}>分镜工作台</h2><p>已加载 {items.length} 个分镜</p></div>
      <div className={styles.actions}>
        {createForm ? <button className={styles.primary} type="button" aria-expanded={newOpen} onClick={() => setNewOpen(!newOpen)}>
          {newOpen ? "收起新建表单" : "新增分镜"}</button> : null}
        <div className={styles.view} aria-label="分镜视图">
          <button type="button" aria-pressed={!currentId} onClick={() => onOpen(null)}>列表</button>
          <button type="button" aria-pressed={Boolean(currentId)} disabled={!currentId && !items.length}
            onClick={() => { if (!currentId && items[0]) onOpen(items[0].entityId); }}>单镜</button>
        </div>
      </div>
    </div>
    {newOpen && createForm ? <div className={styles.create}>{createForm}</div> : null}
    {!currentId ? <div className={styles.toolbar}>
      <input type="search" aria-label="筛选已加载分镜" placeholder="筛选已加载分镜" value={query}
        onChange={event => { setQuery(event.target.value); setSelection(new Set()); }} />
      <select aria-label="审核状态" value={filter} onChange={event => { setFilter(event.target.value); setSelection(new Set()); }}>
        <option value="all">全部审核状态</option><option value="DRAFT">草稿</option><option value="APPROVED">已审核</option>
        <option value="REJECTED">已退回</option><option value="STALE">已失效</option>
      </select>
      <select aria-label="候选画面布局" value={grid} onChange={event => setGrid(Number(event.target.value))}>
        <option value="4">四宫格</option><option value="9">九宫格</option>
      </select>
    </div> : <div className={styles.toolbar}>
      <label>切换单镜 <select value={currentId} onChange={event => onOpen(event.target.value)}>
        {!visible.length ? <option value={currentId}>当前分镜</option> : null}
        {items.map(shot => <option key={shot.entityId} value={shot.entityId}>{`镜头 ${shot.storyboard?.ordinal ?? shot.entityId.slice(0, 8)}`}</option>)}
      </select></label>
      {items.filter(shot => !shot.storyboard && shot.entityId !== currentId).map(shot => <button key={shot.entityId}
        className={styles.link} type="button" onClick={() => onOpen(shot.entityId)}>镜头 {shot.entityId.slice(0, 8)}</button>)}
    </div>}
    {loading && items.length === 0 ? <p className={styles.state} role="status">正在读取分镜…</p> : null}
    {!loading && visible.length === 0 ? <p className={styles.state} role="status">
      {currentId ? "该分镜不在已加载列表中。" : items.length ? "已加载的分镜没有符合筛选的结果。" : "还没有镜头。"}
    </p> : null}
    <ul className={styles.list}>
      {visible.map(shot => <li key={shot.entityId}>
        <ShotRow shot={shot} grid={grid} active={currentId === shot.entityId}
          select={!currentId && canBatch(shot) ? {
            checked: selection.has(shot.currentRevisionId), toggle: () => setSelection(previous => {
              const next = new Set(previous);
              if (next.has(shot.currentRevisionId)) next.delete(shot.currentRevisionId);
              else next.add(shot.currentRevisionId);
              return next;
            }),
          } : undefined}
          open={() => onOpen(shot.entityId)} archive={opener => {
            archiveOpener.current = opener;
            setArchive({ shot, key: crypto.randomUUID() });
          }} />
      </li>)}
    </ul>
    {!currentId && items.length > 0 ? <div className={styles.batch}>
      <span>已选 {selectedShots.length} 个分镜</span>
      <div className={styles.actions}>
        {selectedShots.length ? <button type="button" onClick={() => setSelection(new Set())}>取消选择</button> : null}
        <StoryboardImageBatch projectId={projectId} shots={selectedShots} onDispatched={onDispatched} />
      </div>
    </div> : null}
    {hasMore && (!currentId || visible.length === 0) ? <button className={styles.more} type="button" disabled={paging} onClick={() => void more()}>
      {paging ? "正在读取…" : "加载更多镜头"}</button> : null}
    {pageError ? <p className={styles.state} role="alert">分镜加载失败，请重试。</p> : null}
    {archive ? <div className={styles.scrim} onClick={event => { if (event.target === event.currentTarget) closeArchive(); }}>
      <div ref={modal} className={styles.confirm} role="dialog" aria-modal="true" aria-labelledby={confirmTitle}>
        <h3 id={confirmTitle}>删除{archive.shot.storyboard ? `镜头 ${archive.shot.storyboard.ordinal}` : "分镜"}？</h3>
        <p>分镜将从当前列表移除，相关素材会失效，历史版本仍可查阅。</p>
        {archiveError ? <p className={styles.error} role="alert">{archiveError}</p> : null}
        <div className={styles.actions}><button ref={archiveCancel} type="button" disabled={archiving} onClick={closeArchive}>取消</button>
          <button className={styles.primary} type="button" disabled={archiving} onClick={() => void confirmArchive()}>
            {archiving ? "删除中…" : "删除分镜"}</button></div>
      </div>
    </div> : null}
  </section>;
}

function shotLabel(shot: StoryboardShot) {
  return `镜头 ${shot.storyboard?.ordinal ?? shot.entityId.slice(0, 8)}`;
}

function canBatch(shot: StoryboardShot): shot is StoryboardShot & { currentRevisionId: string; storyboard: NonNullable<StoryboardShot["storyboard"]> } {
  return Boolean(shot.storyboard?.promptText.trim() && shot.currentRevisionId && shot.currentRevisionId === shot.approvedRevisionId
    && shot.currentRevision?.reviewStatus === "APPROVED" && shot.currentRevision.freshnessStatus === "CURRENT");
}

function ShotRow({ shot, grid, active, select, open, archive }: {
  shot: StoryboardShot; grid: number; active: boolean; open: () => void; archive: (opener: HTMLElement) => void;
  select?: { checked: boolean; toggle: () => void };
}) {
  const info = shot.storyboard;
  const label = shotLabel(shot);
  const status = shot.currentRevision?.freshnessStatus === "STALE" ? "已失效"
    : REVIEW[shot.currentRevision?.reviewStatus ?? ""] ?? "待确认";
  const duration = info?.plannedDurationMs ? `计划 ${info.plannedDurationMs / 1000} 秒` : info?.durationHint;
  return <article className={styles.shot} data-checked={select?.checked ?? false}>
    <header className={styles.shotHeader}>
      <div>{select ? <input type="checkbox" aria-label={`选择${label}`} checked={select.checked} onChange={select.toggle} /> : null}
        <h3>{label}{info?.shotType ? <span> · {info.shotType}</span> : null}</h3>
        {duration ? <span className={styles.badge}>{duration}</span> : null}
        <span className={styles.badge} data-status={status}>{status}</span></div>
      <div className={styles.actions}>
        {!active ? <button type="button" onClick={open}>{info ? "打开单镜" : `打开${label}`}</button> : null}
        <button type="button" className={styles.danger} onClick={event => archive(event.currentTarget)}
          aria-label={info ? `删除镜头 ${info.ordinal}` : `删除分镜 ${shot.entityId.slice(0, 8)}`}>删除</button>
      </div>
    </header>
    {info ? <div className={styles.columns}>
      <section><h4>候选画面</h4>
        <div className={styles.media} data-grid={grid}>
          {info.candidates.slice(0, grid).map((asset, index) => <div key={asset.id} className={styles.candidate} data-selected={asset.id === info.selectedAssetId}>
            <HoverMediaPreview kind={asset.kind === "VIDEO" ? "video" : "image"}
              label={`${label} · 候选 ${index + 1} · ${asset.kind === "VIDEO" ? "视频" : "图片"}`}
              src={`/api/v1/${asset.storageProvider === "s3" ? "real-media/" : ""}assets/${asset.id}/content`} />
            {asset.id === info.selectedAssetId ? <span>已选用</span> : asset.status !== "ACTIVE" ? <span>历史</span> : null}
          </div>)}
        </div>
        {info.candidates.length === 0 ? <p className={styles.empty}>暂无候选画面</p> : null}
      </section>
      <section><h4>人物与参考</h4>
        <ul className={styles.cast}>{info.characters.map(character => <li key={character.id}>
          {character.assetId ? <HoverMediaPreview kind="image" src={`/api/v1/assets/${character.assetId}/content`} label={`${character.name}参考图`} />
            : <span className={styles.initial} aria-hidden="true">{Array.from(character.name)[0] ?? "人"}</span>}
          <span>{character.name}</span>
        </li>)}</ul>
        {info.characters.length === 0 ? <p className={styles.empty}>未绑定人物</p> : null}
        {info.location ? <p className={styles.location}>{info.location}</p> : null}
      </section>
      <section><h4>镜头提示词</h4><p className={styles.prompt}>{info.promptText || "暂无提示词"}</p>
        {!active ? <button type="button" className={styles.link} onClick={open}>查看或编辑提示词</button> : null}
      </section>
      <section><h4>场景、动作与对白</h4>
        <p className={styles.location}>{info.sourceScene || "未指定场景"}</p>
        {info.camera ? <p className={styles.copy}>{info.camera}</p> : null}
        {info.action ? <p className={styles.copy}>{info.action}</p> : null}
        {info.dialogue ? <blockquote className={styles.copy}>{info.dialogue}</blockquote> : null}
      </section>
    </div> : null}
  </article>;
}
