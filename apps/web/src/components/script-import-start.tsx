"use client";

import { useRef, useState } from "react";
import { StudioClient } from "../lib/studio-client";
import { IMPORTED_SCRIPT_TEXT_LIMIT, storeImportedScript } from "../lib/script-workbench-drafts";
import { LIMITS } from "../lib/studio-model";
import styles from "./creator-entry.module.css";

const client = new StudioClient();
const MAX_FILE_BYTES = 32 * 1024;

export function ScriptImportStart() {
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const request = useRef<{ title: string; text: string; key: string; projectId?: string } | null>(null);
  const readingRef = useRef(false);
  const creatingRef = useRef(false);

  async function readFile(file: File | undefined) {
    if (!file || readingRef.current || busy) return;
    if (!file.name.toLowerCase().endsWith(".txt") || file.size > MAX_FILE_BYTES) {
      setError("请选择 32 KiB 以内的 UTF-8 .txt 文件。");
      return;
    }
    setReading(true);
    readingRef.current = true;
    setError("");
    try {
      const content = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
      if (!content.trim() || content.length > IMPORTED_SCRIPT_TEXT_LIMIT) throw new Error("invalid text");
      setText(content);
      setTitle(current => current || file.name.slice(0, -4).slice(0, LIMITS.title));
    } catch {
      setError("未能读取剧本。请使用 UTF-8 纯文本，正文最多 8000 字符。");
    } finally {
      setReading(false);
      readingRef.current = false;
    }
  }

  async function create() {
    const titleValue = title.trim();
    if (creatingRef.current || readingRef.current || !titleValue || !text.trim() || text.length > IMPORTED_SCRIPT_TEXT_LIMIT) return;
    if (request.current?.title !== titleValue || request.current.text !== text) {
      request.current = { title: titleValue, text, key: crypto.randomUUID() };
    }
    const pending = request.current;
    creatingRef.current = true;
    setBusy(true);
    setError("");
    try {
      // Keep the imported script out of the project's visible premise and preserve its exact text for editing.
      if (!pending.projectId) {
        const created = await client.write<{ id: string }>({
          path: "/projects", body: { title: pending.title, premise: "" }, idempotencyKey: pending.key,
        });
        pending.projectId = created.body.id;
      }
      storeImportedScript(window.sessionStorage, pending.projectId, pending.text);
      window.location.assign(`/projects/${pending.projectId}/script`);
    } catch {
      setError(pending.projectId ? "作品已创建，浏览器暂时无法保留剧本草稿。原文仍在这里，可重试。"
        : "未能确认创建。原文仍在这里，可用同一请求重试。");
    } finally {
      creatingRef.current = false;
      setBusy(false);
    }
  }

  return <details id="script-import" className={styles.formCard}>
    <summary className={styles.fieldLabel}>从已有剧本开始</summary>
    <form className="mt-4 grid gap-3" onSubmit={event => { event.preventDefault(); void create(); }}>
      <label className={styles.fieldLabel}>剧本标题
        <input className={styles.titleInput} value={title} maxLength={LIMITS.title} disabled={busy || reading}
          onChange={event => setTitle(event.target.value)} required />
      </label>
      <label className={styles.fieldLabel}>导入 UTF-8 .txt
        <input className="mt-1 block max-w-full text-sm" type="file" accept=".txt,text/plain" disabled={busy || reading}
          onChange={event => { const file = event.target.files?.[0]; event.target.value = ""; void readFile(file); }} />
      </label>
      <label className={styles.fieldLabel}>剧本正文
        <textarea className={styles.ideaInput} rows={6} maxLength={IMPORTED_SCRIPT_TEXT_LIMIT} value={text} disabled={busy || reading}
          onChange={event => setText(event.target.value)} placeholder="也可以直接粘贴第 1 集的剧本" required />
      </label>
      <p className={styles.scopeNote}>原文先进入当前标签页的第 1 集草稿。确认大纲后可保存正文并提交审稿。</p>
      {error ? <p role="alert" className={styles.notice}>{error}</p> : null}
      <div><button className={styles.primary} type="submit" disabled={busy || reading || !title.trim() || !text.trim()}>
        {busy ? "正在创建…" : reading ? "正在读取…" : "创建并打开剧本工作台"}
      </button></div>
    </form>
  </details>;
}
