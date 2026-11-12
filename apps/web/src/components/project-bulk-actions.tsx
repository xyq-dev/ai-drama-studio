"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ApiError, StudioClient } from "../lib/studio-client";
import { useModalKeyboard } from "../lib/modal-keyboard";
import styles from "./my-works.module.css";
import modal from "./recycle-bin.module.css";

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
  const [open, setOpen] = useState(false);
  const [checks, setChecks] = useState<Check[]>([]);
  const [reading, setReading] = useState(false);
  const [writing, setWriting] = useState(false);
  const [completed, setCompleted] = useState(0);
  const [assigning, setAssigning] = useState(false);
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
    setOpen(false);
    setReading(false);
    onBusyChange(false);
  }
  useModalKeyboard(open, dialog, close);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) wasOpen.current = true;
    else if (wasOpen.current && !disabled) { wasOpen.current = false; opener.current?.focus(); }
  }, [open, disabled]);

  async function classify(categoryId: string) {
    if (disabled || inFlight.current || !selected.length || !categoriesReady) return;
    const snapshot = [...selected];
    inFlight.current = true;
    setAssigning(true);
    onBusyChange(true);
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
        } catch (error) { errors.push(`《${work.title}》：${message(error)}`); }
      }
      if (alive.current) await onComplete(succeeded, `归类完成 ${succeeded.length} 部，未确认 ${errors.length} 部。`, errors);
    } finally {
      inFlight.current = false;
      if (alive.current) { setAssigning(false); onBusyChange(false); }
    }
  }

  async function inspect() {
    if (disabled || inFlight.current || !selected.length) return;
    const snapshot = [...selected];
    const current = ++token.current;
    setOpen(true);
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
    if (reading || inFlight.current || !eligible.length) return;
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
        setOpen(false);
      }
    } finally {
      inFlight.current = false;
      if (alive.current) { setWriting(false); onBusyChange(false); }
    }
  }

  return <>
    <select className={styles.bulkCategory} aria-label="归类所选作品" value="placeholder"
      disabled={disabled || !selected.length || !categoriesReady} onChange={(event) => void classify(event.target.value)}>
      <option value="placeholder" disabled>{assigning ? "归类中…" : "归类到"}</option>
      <option value="">未分类</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
    </select>
    <button ref={opener} className={styles.bulkDelete} type="button" disabled={disabled || !selected.length} onClick={() => void inspect()}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7M14 10v7" /></svg>移入回收站
    </button>
    {open ? <div className={modal.overlay}><div ref={dialog} className={modal.dialog} role="dialog" aria-modal="true" aria-labelledby={heading} aria-busy={reading || writing}>
      <h2 id={heading}>将所选作品移入回收站？</h2>
      <p>删除整部作品及其全部集数。已有剧本、场景、分镜、配音和视频将保留，可在回收站恢复。</p>
      {reading ? <p role="status">正在逐项核对删除范围…已核对 {checks.length} 部。</p> : <p>可移入 {eligible.length} 部；跳过 {checks.length - eligible.length} 部。</p>}
      <ul className={styles.deletionChecks}>{checks.map(({ work, preview, error }) => <li key={work.id}>
        <strong>《{preview?.title ?? work.title}》</strong>
        {preview ? <span>全部 {preview.episodeCount} 集 · 场景 {preview.dependencies.scenes} · 分镜 {preview.dependencies.shots} · 配音 {preview.dependencies.speech} · 视频 {preview.dependencies.video}{preview.dependencies.other ? ` · 其他引用 ${preview.dependencies.other}` : ""}</span> : null}
        {error || !preview?.canDelete ? <span className={styles.checkError}>{error || preview?.blockedReason || "暂时不能删除"}</span> : null}
      </li>)}</ul>
      {writing ? <p role="status">正在移入…{completed} / {eligible.length} 部</p> : null}
      <div className={modal.dialogActions}>
        <button ref={cancel} className={modal.button} type="button" disabled={writing} onClick={close}>取消</button>
        <button className={modal.dangerButton} type="button" disabled={reading || writing || !eligible.length} onClick={() => void remove()}>确认移入 {eligible.length} 部</button>
      </div>
    </div></div> : null}
  </>;
}
