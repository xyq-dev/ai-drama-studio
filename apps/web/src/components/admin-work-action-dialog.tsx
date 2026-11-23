"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useModalKeyboard } from "../lib/modal-keyboard";
import { withSession } from "../lib/site-session";
import type { ManagedWork } from "./admin-work-management";
import styles from "./admin-directory.module.css";

export type WorkOperation = { mode: "trash" | "restore"; works: ManagedWork[] };
export type WorkResult = { summary: string; details: { id: string; title: string; message: string }[] };
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type Checked = { id: string; eligible: boolean; version: number | null; message: string | null; title?: string; ownerName?: string };
type Outcome = { id: string; status: "succeeded" | "skipped" | "unknown"; message: string | null };
type Candidate = { id: string; title: string; ownerName: string; version: number | null; message: string | null };

function jsonPost(body: unknown): RequestInit {
  return { method: "POST", credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

export function AdminWorkActionDialog({ operation, fetchImpl, onClose }: {
  operation: WorkOperation; fetchImpl: FetchLike; onClose: (result?: WorkResult) => void;
}) {
  const trash = operation.mode === "trash";
  const [checks, setChecks] = useState<Checked[] | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState("");
  const [saving, setSaving] = useState(false);
  const writing = useRef(false);
  const alive = useRef(true);
  const dialog = useRef<HTMLFormElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const heading = useId();
  const fieldError = useId();
  function close() { if (!writing.current) onClose(); }
  useModalKeyboard(true, dialog, close);
  useEffect(() => { alive.current = true; cancel.current?.focus(); return () => { alive.current = false; }; }, []);

  useEffect(() => {
    if (!trash) return;
    const controller = new AbortController();
    const preview = async () => {
      try {
        const res = await withSession(fetchImpl)("/api/v1/admin/works/trash-preview", {
          ...jsonPost({ ids: operation.works.map(row => row.id) }), signal: controller.signal,
        });
        const body = await res.json() as { items?: Checked[]; error?: { message?: string } };
        if (controller.signal.aborted) return;
        if (!res.ok || !Array.isArray(body.items)) {
          setPreviewError(body.error?.message ?? "无法核对移入范围，请重新核对。");
          return;
        }
        setChecks(body.items);
      } catch {
        if (!controller.signal.aborted) setPreviewError("无法核对移入范围，请重新核对。");
      }
    };
    void preview();
    return () => controller.abort();
  }, [fetchImpl, operation, trash, attempt]);

  const candidates: Candidate[] = operation.works.map(row => {
    if (!trash && "deletedAt" in row) return { ...row, message: null };
    const check = checks?.find(item => item.id === row.id);
    const allowed = check?.eligible === true && Number.isSafeInteger(check.version);
    return { id: row.id, title: check?.title || row.title, ownerName: check?.ownerName || row.ownerName,
      version: allowed ? check.version : null, message: allowed ? null : check?.message || "无法确认当前作品状态。" };
  });
  const available = candidates.filter(item => Number.isSafeInteger(item.version));
  const blocked = candidates.filter(item => !Number.isSafeInteger(item.version));
  const waiting = trash && !checks;
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (writing.current || waiting || !available.length) return;
    if (trash && !reason.trim()) {
      setReasonError("请填写操作原因。");
      field.current?.focus();
      return;
    }
    writing.current = true;
    setSaving(true);
    const payload = { items: available.map(({ id, version }) => ({ id, version })), confirmed: true,
      ...(trash ? { reason: reason.trim() } : {}) };
    let outcomes: Outcome[] = [];
    let commonUnknown = "结果未确认，请刷新全部作品和回收站后核对。";
    try {
      const res = await withSession(fetchImpl)(`/api/v1/admin/works/${operation.mode}`, jsonPost(payload));
      const body = await res.json() as { items?: Outcome[]; error?: { message?: string } };
      if (res.ok && Array.isArray(body.items)) outcomes = body.items;
      else if (res.status === 400 || res.status === 401 || res.status === 403) {
        const message = body.error?.message ?? "本次操作未获准，请核对权限和输入。";
        outcomes = available.map(({ id }) => ({ id, status: "skipped", message }));
      }
    } catch {
      commonUnknown = "未收到操作回执，请刷新全部作品和回收站后核对。";
    }
    if (!alive.current) return;
    let succeeded = 0;
    let skipped = blocked.length;
    let unknown = 0;
    const details = blocked.map(item => ({ id: item.id, title: item.title, message: item.message || "已跳过。" }));
    for (const item of available) {
      const outcome = outcomes.find(entry => entry.id === item.id);
      if (outcome?.status === "succeeded") { succeeded++; continue; }
      if (outcome?.status === "skipped") skipped++; else unknown++;
      details.push({ id: item.id, title: item.title, message: outcome?.message || (outcome?.status === "skipped" ? "已跳过，请重新核对。" : commonUnknown) });
    }
    const counts = [`${trash ? "已移入回收站" : "已恢复"} ${succeeded} 部`];
    if (skipped) counts.push(`跳过 ${skipped} 部`);
    if (unknown) counts.push(`结果待核对 ${unknown} 部`);
    onClose({ summary: counts.join("，"), details });
  }

  return <>
    <div className={styles.backdrop} />
    <form ref={dialog} className={`${styles.dialog} ${styles.workDialog}`} aria-modal="true" role="dialog" aria-labelledby={heading} onSubmit={submit}>
      <div className={styles.dialogHead}><h2 id={heading}>{trash ? "将作品移入回收站？" : "恢复所选作品？"}</h2>
        <button type="button" className={styles.close} aria-label="关闭" disabled={saving} onClick={close}>
          <img src="/design/tailadmin-v2/icon-x.svg" width={18} height={18} alt="" />
        </button>
      </div>
      <p>{trash ? "移入后，创作者将无法打开这些作品。恢复后可继续创作。" : "恢复后，原创作者可在「我的作品」继续编辑。"}</p>
      {previewError ? <div role="alert" className={styles.workState}>{previewError}
        <button type="button" className={styles.secondary} onClick={() => { setPreviewError(""); setAttempt(n => n + 1); }}>重新核对</button>
      </div> : waiting ? <p role="status">正在核对所选作品…</p> : <>
        <section className={styles.workCheck}><h3>{trash ? "可移入" : "可恢复"} · {available.length} 部</h3>
          <ul>{available.map(item => <li key={item.id}><span>{item.title}</span><span>{item.ownerName}</span></li>)}</ul>
        </section>
        {blocked.length > 0 && <section className={`${styles.workCheck} ${styles.workBlocked}`}><h3>将跳过 · {blocked.length} 部</h3>
          <ul>{blocked.map(item => <li key={item.id}><span>{item.title}</span><span>{item.ownerName}</span><small>{item.message}</small></li>)}</ul>
        </section>}
      </>}
      {trash && <label className={styles.field}><span>操作原因</span>
        <textarea ref={field} value={reason} maxLength={300} aria-invalid={Boolean(reasonError)} aria-describedby={reasonError ? fieldError : undefined}
          disabled={saving} onChange={e => { setReason(e.target.value); if (e.target.value.trim()) setReasonError(""); }} />
      </label>}
      {reasonError && <p id={fieldError} className={styles.workInvalid} role="alert">{reasonError}</p>}
      <div className={styles.dialogActions}>
        <button ref={cancel} type="button" className={styles.secondary} disabled={saving} onClick={close}>取消</button>
        <button type="submit" className={trash ? styles.danger : styles.primary} disabled={waiting || saving || !available.length}>
          {saving ? "正在处理…" : waiting ? "等待核对" : `确认${trash ? "移入" : "恢复"} ${available.length} 部`}
        </button>
      </div>
    </form>
  </>;
}
