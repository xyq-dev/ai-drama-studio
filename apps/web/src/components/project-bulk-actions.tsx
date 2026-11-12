"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ApiError, StudioClient } from "../lib/studio-client";
import { useModalKeyboard } from "../lib/modal-keyboard";
import styles from "./my-works.module.css";

interface SelectedWork { id: string; title: string; categoryId: string | null; categoryRevision: number }
interface Preview {
  projectId: string; title: string; version: number; episodeCount: number;
  canDelete: boolean; blockedReason: string | null;
  dependencies: { scenes: number; shots: number; speech: number; video: number; other: number; total: number };
}
interface Check { work: SelectedWork; preview?: Preview; error?: string }
const client = new StudioClient();
const message = (error: unknown) => error instanceof ApiError ? error.detail : "结果未确认，请刷新作品列表及回收站核对后再操作。";

export function SelectionCheckbox({ checked, mixed = false, disabled, label, onChange }: {
  checked: boolean; mixed?: boolean; disabled?: boolean; label: string; onChange: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (input.current) input.current.indeterminate = mixed; }, [mixed]);
  return <input ref={input} className={styles.checkbox} type="checkbox" checked={checked}
    aria-checked={mixed ? "mixed" : checked} disabled={disabled} aria-label={label} onChange={onChange} />;
}

/** Uses the existing version-checked single-work endpoints; results are reported per work. */
export function ProjectBulkActions({ selected, categories, categoriesReady, disabled, onBusyChange, onComplete }: {
  selected: SelectedWork[]; categories: Array<{ id: string; name: string }>; categoriesReady: boolean;
  disabled: boolean; onBusyChange: (busy: boolean) => void;
  onComplete: (succeeded: string[], notice: string, errors: string[]) => Promise<void>;
}) {
  const [mode, setMode] = useState<"category" | "delete" | null>(null);
  const open = mode !== null;
  const [snapshot, setSnapshot] = useState<SelectedWork[]>([]);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [checks, setChecks] = useState<Check[]>([]);
  const [reading, setReading] = useState(false);
  const [writing, setWriting] = useState(false);
  const [completed, setCompleted] = useState(0);
  const alive = useRef(true);
  const inFlight = useRef(false);
  const token = useRef(0);
  const dialog = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const heading = useId();
  useEffect(() => { alive.current = true; return () => { alive.current = false; token.current += 1; }; }, []);
  useEffect(() => { if (open) cancel.current?.focus(); }, [open]);

  function close() {
    if (inFlight.current) return;
    token.current += 1;
    setMode(null);
    setReading(false);
    onBusyChange(false);
  }
  useModalKeyboard(open, dialog, close);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) wasOpen.current = true;
    else if (wasOpen.current && !writing) {
      wasOpen.current = false;
      const trigger = opener.current;
      if (trigger && !trigger.disabled && !trigger.closest("[hidden], [inert]")) trigger.focus();
      else document.getElementById("main")?.focus();
    }
  }, [open, writing, disabled]);

  function openCategory(button: HTMLButtonElement) {
    if (disabled || open || inFlight.current || !selected.length || !categoriesReady) return;
    opener.current = button;
    setSnapshot(selected.map((work) => ({ ...work })));
    setCategoryId(null);
    setCompleted(0);
    setMode("category");
    onBusyChange(true);
  }

  async function classify() {
    // `disabled` includes our own onBusyChange(true). The frozen dialog owns its
    // confirmation state; checking that parent flag here would deadlock it.
    if (mode !== "category" || inFlight.current || !snapshot.length || categoryId === null) return;
    inFlight.current = true;
    setWriting(true);
    const succeeded: string[] = [];
    const errors: string[] = [];
    try {
      for (const work of snapshot) {
        if (!alive.current) break;
        try {
          await client.postJson(`/library/projects/${work.id}/category`, {
            categoryId: categoryId || null, expectedRevision: work.categoryRevision,
          });
          succeeded.push(work.id);
        } catch (error) {
          // Do not retry an uncertain response: report it for the user to verify.
          errors.push(`《${work.title}》：${message(error)}`);
        }
        if (alive.current) setCompleted((count) => count + 1);
      }
      if (alive.current) {
        await onComplete(succeeded, `归类完成 ${succeeded.length} 部，未确认 ${errors.length} 部。`, errors);
        setMode(null);
      }
    } finally {
      inFlight.current = false;
      if (alive.current) { setWriting(false); onBusyChange(false); }
    }
  }

  async function inspect(button: HTMLButtonElement) {
    if (disabled || open || inFlight.current || !selected.length) return;
    opener.current = button;
    const snapshot = selected.map((work) => ({ ...work }));
    const current = ++token.current;
    setMode("delete");
    setReading(true);
    setChecks([]);
    setCompleted(0);
    onBusyChange(true);
    for (const work of snapshot) {
      if (!alive.current || token.current !== current) return;
      let check: Check;
      try {
        const preview = await client.get<Preview>(`/projects/${work.id}/script-workbench/deletion-preview`);
        check = { work, preview };
      } catch (error) { check = { work, error: message(error) }; }
      if (!alive.current || token.current !== current) return;
      setChecks((items) => [...items, check]);
    }
    if (alive.current && token.current === current) setReading(false);
  }

  const eligible = checks.filter((check) => check.preview?.canDelete);
  async function remove() {
    if (mode !== "delete" || reading || inFlight.current || !eligible.length) return;
    inFlight.current = true;
    setWriting(true);
    const succeeded: string[] = [];
    const errors = checks.filter((check) => !check.preview?.canDelete).map((check) =>
      `《${check.work.title}》：${check.error || check.preview?.blockedReason || "当前无法删除"}`);
    try {
      for (const check of eligible) {
        if (!alive.current) break;
        const preview = check.preview!;
        try {
          await client.write({ path: `/projects/${check.work.id}/script-workbench/trash`,
            body: { expectedVersion: preview.version }, ifMatch: preview.version, idempotencyKey: crypto.randomUUID() });
          succeeded.push(check.work.id);
        } catch (error) {
          // The endpoint does not replay idempotency keys. Never automatically retry an uncertain write.
          errors.push(`《${check.work.title}》：${message(error)}`);
        }
        if (alive.current) setCompleted((count) => count + 1);
      }
      if (alive.current) {
        await onComplete(succeeded, `已移入回收站 ${succeeded.length} 部，未完成 ${errors.length} 部。`, errors);
        setMode(null);
      }
    } finally {
      inFlight.current = false;
      if (alive.current) { setWriting(false); onBusyChange(false); }
    }
  }

  return <>
    <button className={styles.bulkCategory} type="button" aria-label="归类所选作品"
      disabled={disabled || open || !selected.length || !categoriesReady} onClick={(event) => openCategory(event.currentTarget)}>
      归类到 <img src="/design/tailadmin-v2/icon-chevron.svg" width={16} height={16} alt="" />
    </button>
    <button className={styles.bulkDelete} type="button" disabled={disabled || open || !selected.length} onClick={(event) => void inspect(event.currentTarget)}>
      移入回收站
    </button>
    {open ? <div className={styles.overlay}><div ref={dialog} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby={heading} aria-busy={reading || writing}>
      {mode === "category" ? <>
        <h2 id={heading}>归类所选作品</h2>
        <p className={styles.dialogNote}>将已选的 {snapshot.length} 部作品归入同一分类。确认后生效。</p>
        <div className={styles.categoryOptions} role="radiogroup" aria-label="目标分类">
          {[{ id: "", name: "未分类" }, ...categories].map((category) => <label key={category.id} className={styles.categoryOption}>
            <input type="radio" name={`${heading}-category`} value={category.id} checked={categoryId === category.id}
              disabled={writing} onChange={() => setCategoryId(category.id)} />
            <span>{category.name}</span>
          </label>)}
        </div>
        {writing ? <p role="status">正在归类…{completed} / {snapshot.length} 部</p> : null}
        <div className={styles.dialogActions}>
          <button ref={cancel} className={styles.secondary} type="button" disabled={writing} onClick={close}>取消</button>
          <button className={styles.primary} type="button" disabled={writing || categoryId === null} onClick={() => void classify()}>确认归类</button>
        </div>
      </> : <>
        <h2 id={heading}>将所选作品移入回收站？</h2>
        <p className={styles.dialogNote}>删除整部作品及其全部集数。已有剧本、场景、分镜、配音和视频将保留，可在回收站恢复。</p>
        {reading ? <p role="status">正在逐项核对删除范围…已核对 {checks.length} 部。</p> : <p>可移入 {eligible.length} 部；跳过 {checks.length - eligible.length} 部。</p>}
        <ul className={styles.deletionChecks}>{checks.map(({ work, preview, error }) => <li key={work.id}>
          <strong>《{preview?.title ?? work.title}》</strong>
          {preview ? <span>全部 {preview.episodeCount} 集 · 场景 {preview.dependencies.scenes} · 分镜 {preview.dependencies.shots} · 配音 {preview.dependencies.speech} · 视频 {preview.dependencies.video}{preview.dependencies.other ? ` · 其他引用 ${preview.dependencies.other}` : ""}</span> : null}
          {error || !preview?.canDelete ? <span className={styles.checkError}>{error || preview?.blockedReason || "暂时不能删除"}</span> : null}
        </li>)}</ul>
        {writing ? <p role="status">正在移入…{completed} / {eligible.length} 部</p> : null}
        <div className={styles.dialogActions}>
          <button ref={cancel} className={styles.secondary} type="button" disabled={writing} onClick={close}>取消</button>
          <button className={styles.dangerButton} type="button" disabled={reading || writing || !eligible.length} onClick={() => void remove()}>确认移入 {eligible.length} 部</button>
        </div>
      </>}
    </div></div> : null}
  </>;
}
