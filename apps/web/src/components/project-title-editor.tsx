"use client";

import { useRef, useState, type FormEvent } from "react";
import type { ProjectRecord } from "../lib/project-base";
import { ApiError, StudioClient } from "../lib/studio-client";
import { LIMITS } from "../lib/studio-model";

const client = new StudioClient();

export function ProjectTitleEditor({ project, reload }: { project: ProjectRecord; reload: () => Promise<void> }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [version, setVersion] = useState(project.version);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const saving = useRef(false);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (saving.current || draft === null) return;
    const title = draft.trim();
    if (!title) return setMessage("请输入作品名");
    saving.current = true;
    setBusy(true);
    setMessage("");
    try {
      await client.write({
        method: "PATCH", path: `/projects/${project.id}`, body: { title },
        ifMatch: version, idempotencyKey: crypto.randomUUID(),
      });
      setDraft(null);
      try { await reload(); } catch { setMessage("作品名已保存，请刷新查看。"); }
    } catch (error) {
      if (error instanceof ApiError && error.code === "REVISION_CONFLICT") {
        try {
          const current = await client.get<ProjectRecord>(`/projects/${project.id}`);
          setVersion(current.version);
          setMessage(`当前作品名为「${current.title}」，请确认后再保存。`);
        } catch { setMessage("读取最新作品名失败，请稍后再试。"); }
      } else {
        setMessage("作品名保存失败，请稍后再试。");
      }
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="mt-1 text-sm">
      {draft === null ? (
        <button className="underline" type="button" onClick={() => {
          setDraft(project.title); setVersion(project.version); setMessage("");
        }}>修改作品名</button>
      ) : (
        <form className="flex flex-wrap items-center gap-2" onSubmit={save}>
          <label htmlFor="creator-project-title">作品名</label>
          <input className="min-w-0 max-w-full rounded-lg border px-2 py-1.5" id="creator-project-title"
            maxLength={LIMITS.title} value={draft} disabled={busy}
            onChange={event => { setDraft(event.target.value); setMessage(""); }} />
          <button className="rounded-lg border bg-white px-3 py-1.5" disabled={busy} type="submit">{busy ? "保存中…" : "保存作品名"}</button>
          <button className="underline" disabled={busy} type="button" onClick={() => { setDraft(null); setMessage(""); }}>取消</button>
        </form>
      )}
      {message && <p role="status">{message}</p>}
    </div>
  );
}
