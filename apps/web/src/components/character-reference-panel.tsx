"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, StudioClient } from "../lib/studio-client";

interface ReferenceAsset {
  id: string;
  characterRevisionId: string;
  checksumSha256: string;
  status: string;
  reviewStatus: string;
  reviewNote: string | null;
  rowVersion: number;
  createdAt: string;
  /** The selection endpoint's own rule, decided by the server. */
  selectable?: boolean;
}

interface ReferenceListing {
  characterId: string;
  currentRevisionId: string | null;
  selection: { assetId: string; sourceCharacterRevisionId: string; usable: boolean; asset?: ReferenceAsset | null } | null;
  /** The strict video gate's answer for the current revision; absent only from an older server. */
  videoReadiness?: { usable: boolean; blockers: string[] };
  items: ReferenceAsset[];
  hasMore?: boolean;
}

interface JobView {
  id: string;
  state: string;
  errorCode: string | null;
  errorMessage: string | null;
}

const client = new StudioClient();

const REVIEW_TEXT: Record<string, string> = { DRAFT: "待审核", APPROVED: "已通过", REJECTED: "已退回" };
const STATUS_TEXT: Record<string, string> = { ACTIVE: "可用", STALE: "已失效 STALE", SUPERSEDED: "已被取代", FAILED: "失败", DELETED: "已删除" };
const JOB_TEXT: Record<string, string> = { QUEUED: "排队中", RUNNING: "生成中", RETRY_WAIT: "等待重试", SUCCEEDED: "已成功",
  FAILED: "失败", CANCELED: "已取消" };
const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELED"]);
const POLL_MS = 1500;

function pageHidden(): boolean {
  return document.visibilityState === "hidden";
}

/** One sentence per reason the strict video gate would refuse; the server decides which apply. */
const BLOCKER_TEXT: Record<string, string> = {
  CHARACTER_REVISION_MISSING: "角色还没有当前版本",
  CHARACTER_REVISION_NOT_CURRENT: "选定参考图所需的角色版本不是当前版本",
  CHARACTER_REVISION_STALE: "角色当前版本已失效 STALE",
  CHARACTER_REVISION_NOT_APPROVED: "角色当前版本尚未审核通过",
  REFERENCE_NOT_SELECTED: "尚未选定参考图",
  REFERENCE_SELECTION_OTHER_REVISION: "选定记录来自角色的旧版本",
  REFERENCE_UNAVAILABLE: "选定的参考图在本角色下已读取不到",
  REFERENCE_NOT_ACTIVE: "选定的参考图已不是可用状态",
  REFERENCE_NOT_APPROVED: "选定的参考图尚未审核通过",
  REFERENCE_REVIEW_HASH_MISMATCH: "选定参考图的审核内容与当前字节不一致",
  REFERENCE_OTHER_REVISION: "选定的参考图由角色旧版本生成",
};

/**
 * Character reference images: generate (does not require an approved character), review on exact bytes and select
 * the one video generation uses under the strict gate. Everything here needs the reference storage draft; without it
 * the server answers 503 and the panel says so instead of offering actions.
 *
 * A generation answers 202 (accepted, not done); the panel then follows that job through the job endpoint, one
 * read at a time, pausing while the page is hidden, and re-reads the list when it succeeds. A change of project,
 * character or revision, or unmounting, makes every in-flight answer for the old one stale.
 */
export function CharacterReferencePanel(props: { projectId: string; characterId: string; currentRevisionId: string }) {
  const [listing, setListing] = useState<ReferenceListing | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rejectNotes, setRejectNotes] = useState<Record<string, string>>({});
  /** The accepted generation job and the scope it was accepted in. */
  const [job, setJob] = useState<(JobView & { owner: number }) | null>(null);
  const keys = useRef<Record<string, string>>({});
  const request = useRef(0);
  /** Bumped on every change of project, character or revision and on unmount. */
  const scope = useRef(0);

  const load = useCallback(async () => {
    const owner = scope.current;
    const id = ++request.current;
    try {
      const next = await client.get<ReferenceListing>(`/characters/${props.characterId}/reference-images`);
      if (id !== request.current || owner !== scope.current) return;
      setListing(next);
      setUnavailable(false);
      setError(null);
    } catch (caught) {
      if (id !== request.current || owner !== scope.current) return;
      setListing(null);
      if (caught instanceof ApiError && caught.code === "CHARACTER_REFERENCE_STORAGE_UNAVAILABLE") {
        setUnavailable(true);
        setError(null);
      } else {
        setError(caught instanceof ApiError ? `${caught.code}：${caught.detail}` : "参考图列表加载失败");
      }
    }
  }, [props.characterId]);

  useEffect(() => {
    scope.current += 1;
    setListing(null);
    setNote(null);
    setError(null);
    setBusy(false);
    setJob(null);
    void load();
    return () => {
      scope.current += 1;
    };
  }, [load, props.projectId, props.currentRevisionId]);

  // Follows the accepted generation job: serial reads, stop at a terminal state, pause while hidden.
  const jobId = job?.id ?? null;
  const jobOwner = job?.owner ?? null;
  useEffect(() => {
    // A job accepted for an earlier project, character or revision is never followed here.
    if (!jobId || jobOwner !== scope.current) return;
    const owner = jobOwner;
    let stopped = false;
    let reading = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const current = () => !stopped && owner === scope.current;
    const read = async () => {
      timer = undefined;
      if (!current() || reading || pageHidden()) return;
      reading = true;
      try {
        const next = await client.get<JobView>(`/generation-jobs/${jobId}`);
        if (!current()) return;
        setJob({ id: next.id, state: next.state, errorCode: next.errorCode, errorMessage: next.errorMessage, owner });
        if (TERMINAL.has(next.state)) {
          stopped = true;
          if (next.state === "SUCCEEDED") {
            setNote("参考图生成成功，列表已重新读取。");
            await load();
          } else {
            setNote(`参考图生成${next.state === "FAILED" ? "失败" : "已取消"}${next.errorCode ? `（${next.errorCode}）` : ""}，没有新增参考图。`);
          }
          return;
        }
      } catch {
        if (!current()) return;
        setNote("任务状态暂时读取不到，稍后自动再读。");
      } finally {
        reading = false;
      }
      if (current() && !pageHidden()) timer = setTimeout(() => void read(), POLL_MS);
    };
    const onVisibility = () => {
      if (pageHidden()) {
        if (timer) clearTimeout(timer);
        timer = undefined;
        return;
      }
      if (!timer && !reading) void read();
    };
    void read();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [jobId, jobOwner, load]);

  async function write(action: string, path: string, body: unknown, success: string, generation = false) {
    const owner = scope.current;
    const key = keys.current[action] ?? crypto.randomUUID();
    keys.current[action] = key;
    setBusy(true);
    setError(null);
    try {
      const result = await client.write<{ jobId?: string }>({ path, body, idempotencyKey: key });
      delete keys.current[action];
      if (owner !== scope.current) return;
      setNote(success);
      if (generation && typeof result.body?.jobId === "string") {
        setJob({ id: result.body.jobId, state: "QUEUED", errorCode: null, errorMessage: null, owner });
      } else {
        await load();
      }
    } catch (caught) {
      if (owner !== scope.current) return;
      if (caught instanceof ApiError && (caught.code === "REFERENCE_SELECTION_CONFLICT" || caught.code === "REVIEW_CONFLICT")) {
        delete keys.current[action];
        await load();
        if (owner !== scope.current) return;
        setError(`${caught.code}：${caught.detail}。已重新读取最新状态。`);
      } else {
        setError(caught instanceof ApiError ? `${caught.code}：${caught.detail}。再次操作会复用同一幂等键。` : "操作没有完成，再次操作会复用同一幂等键。");
      }
    } finally {
      if (owner === scope.current) setBusy(false);
    }
  }

  if (unavailable) {
    return (
      <section className="rounded-lg bg-white p-4" aria-label="角色参考图">
        <h2 className="font-medium">角色参考图</h2>
        <p className="mt-2 text-sm">参考图存储尚未启用：服务端需要执行参考图数据库草案后才能生成、审核和选择。当前不会改用普通图片代替。</p>
      </section>
    );
  }

  const selectedId = listing?.selection?.assetId ?? null;
  const selectedAsset = listing?.selection?.asset ?? listing?.items.find((item) => item.id === selectedId) ?? null;
  const readiness = listing?.videoReadiness ?? null;
  const usable = readiness ? readiness.usable : listing?.selection?.usable === true;
  const jobRunning = job !== null && !TERMINAL.has(job.state);
  return (
    <section className="min-w-0 rounded-lg bg-white p-4 [overflow-wrap:anywhere]" aria-label="角色参考图">
      <h2 className="font-medium">角色参考图</h2>
      <p className="mt-2 text-sm">生成参考图只要求来源剧本已审核、角色当前版本非 STALE，不要求角色先审核。严格视频门要求角色和选定参考图都已审核且属于当前版本。图片是 Mock 固定测试图，不是模型生成结果。</p>
      <button className="mt-2 rounded border px-3 py-1 text-sm disabled:opacity-50" type="button" disabled={busy || jobRunning}
        onClick={() => void write(`generate:${props.currentRevisionId}`, `/character-revisions/${props.currentRevisionId}/reference-images/generate`, {},
          "已受理参考图生成（202）。这不是生成成功，正在跟踪任务。", true)}>为当前版本生成参考图</button>
      <button className="ml-2 mt-2 text-sm underline" type="button" onClick={() => void load()}>刷新列表</button>
      {job ? <p className="mt-2 text-sm">参考图任务 {job.id.slice(0, 8)} · {JOB_TEXT[job.state] ?? job.state}{job.errorCode ? ` · ${job.errorCode}` : ""}</p> : null}
      {note ? <p className="mt-2 text-sm" role="status">{note}</p> : null}
      {error ? <p className="mt-2 text-sm" role="alert">{error}</p> : null}
      {listing?.selection ? (
        <p className="mt-2 text-sm">当前选定：{listing.selection.assetId.slice(0, 8)}
          {selectedAsset ? `（${STATUS_TEXT[selectedAsset.status] ?? selectedAsset.status} · ${REVIEW_TEXT[selectedAsset.reviewStatus] ?? selectedAsset.reviewStatus}）` : ""}
          {" · "}{usable ? "可用于视频" : "暂不可用于视频"}</p>
      ) : listing ? <p className="mt-2 text-sm">尚未选定参考图</p> : null}
      {listing && !usable && readiness && readiness.blockers.length > 0 ? (
        <ul className="mt-1 list-disc pl-5 text-sm" aria-label="不可用于视频的原因">
          {readiness.blockers.map((blocker) => <li key={blocker}>{BLOCKER_TEXT[blocker] ?? blocker}</li>)}
        </ul>
      ) : null}
      {listing && listing.items.length === 0 ? <p className="mt-2 text-sm">还没有参考图</p> : null}
      {listing?.hasMore ? <p className="mt-2 text-sm">只显示最近 {listing.items.length} 张；当前选定项不在其中时仍按其记录显示状态。</p> : null}
      <ul className="mt-3 grid gap-3 sm:grid-cols-2">
        {listing?.items.map((item) => {
          const current = item.characterRevisionId === listing.currentRevisionId;
          const selectable = item.selectable === true && item.id !== selectedId;
          return (
            <li key={item.id} className="min-w-0 rounded border p-2 text-sm">
              <img className="h-24 w-24 rounded border object-contain [image-rendering:pixelated]" src={`/api/v1/assets/${item.id}/content`} alt={`参考图 ${item.id.slice(0, 8)}`} />
              <p className="mt-1">{item.id.slice(0, 8)}{item.id === selectedId ? " · 当前选定" : ""}</p>
              <p>{STATUS_TEXT[item.status] ?? item.status} · {REVIEW_TEXT[item.reviewStatus] ?? item.reviewStatus}{current ? "" : " · 来自旧版本"}</p>
              {item.reviewNote ? <p>备注：{item.reviewNote}</p> : null}
              {item.status === "ACTIVE" && current && item.reviewStatus === "DRAFT" ? (
                <button className="mt-1 mr-2 underline disabled:opacity-50" type="button" disabled={busy}
                  onClick={() => void write(`review:${item.id}:${item.rowVersion}:APPROVED`, `/character-reference-images/${item.id}/review`,
                    { decision: "APPROVED", expectedRowVersion: item.rowVersion, contentHash: item.checksumSha256 }, "参考图已通过")}>通过</button>
              ) : null}
              {item.status === "ACTIVE" && item.reviewStatus === "DRAFT" ? (
                <span className="mt-1 inline-flex flex-wrap items-center gap-1">
                  <input className="w-32 rounded border px-1" aria-label={`退回原因 ${item.id.slice(0, 8)}`} value={rejectNotes[item.id] ?? ""}
                    onChange={(event) => setRejectNotes({ ...rejectNotes, [item.id]: event.target.value })} />
                  <button className="underline disabled:opacity-50" type="button" disabled={busy || !(rejectNotes[item.id] ?? "").trim()}
                    onClick={() => void write(`review:${item.id}:${item.rowVersion}:REJECTED`, `/character-reference-images/${item.id}/review`,
                      { decision: "REJECTED", expectedRowVersion: item.rowVersion, contentHash: item.checksumSha256, note: rejectNotes[item.id] },
                      "参考图已退回")}>退回</button>
                </span>
              ) : null}
              <button className="mt-1 block underline disabled:opacity-50" type="button" disabled={busy || !selectable}
                onClick={() => void write(`select:${item.id}:${selectedId ?? "none"}`, `/characters/${props.characterId}/reference-selection`,
                  { assetId: item.id, expectedSelectedAssetId: selectedId }, "已选定参考图")}>
                {item.id === selectedId ? "已选定" : selectable ? "选为视频参考" : "不可选定（需通过且属于当前版本）"}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
