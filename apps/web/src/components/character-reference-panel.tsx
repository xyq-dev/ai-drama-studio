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
}

interface ReferenceListing {
  characterId: string;
  currentRevisionId: string | null;
  selection: { assetId: string; sourceCharacterRevisionId: string; usable: boolean } | null;
  items: ReferenceAsset[];
}

const client = new StudioClient();

const REVIEW_TEXT: Record<string, string> = { DRAFT: "待审核", APPROVED: "已通过", REJECTED: "已退回" };
const STATUS_TEXT: Record<string, string> = { ACTIVE: "可用", STALE: "已失效 STALE", SUPERSEDED: "已被取代", FAILED: "失败", DELETED: "已删除" };

/**
 * Character reference images: generate (does not require an approved character), review on exact bytes and select
 * the one video generation uses under the strict gate. Everything here needs the reference storage draft; without it
 * the server answers 503 and the panel says so instead of offering actions.
 */
export function CharacterReferencePanel(props: { characterId: string; currentRevisionId: string }) {
  const [listing, setListing] = useState<ReferenceListing | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rejectNotes, setRejectNotes] = useState<Record<string, string>>({});
  const keys = useRef<Record<string, string>>({});
  const request = useRef(0);

  const load = useCallback(async () => {
    const id = ++request.current;
    try {
      const next = await client.get<ReferenceListing>(`/characters/${props.characterId}/reference-images`);
      if (id !== request.current) return;
      setListing(next);
      setUnavailable(false);
      setError(null);
    } catch (caught) {
      if (id !== request.current) return;
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
    setListing(null);
    setNote(null);
    void load();
  }, [load, props.currentRevisionId]);

  async function write(action: string, path: string, body: unknown, success: string) {
    const key = keys.current[action] ?? crypto.randomUUID();
    keys.current[action] = key;
    setBusy(true);
    setError(null);
    try {
      await client.write({ path, body, idempotencyKey: key });
      delete keys.current[action];
      setNote(success);
      await load();
    } catch (caught) {
      if (caught instanceof ApiError && (caught.code === "REFERENCE_SELECTION_CONFLICT" || caught.code === "REVIEW_CONFLICT")) {
        delete keys.current[action];
        await load();
        setError(`${caught.code}：${caught.detail}。已重新读取最新状态。`);
      } else {
        setError(caught instanceof ApiError ? `${caught.code}：${caught.detail}。再次操作会复用同一幂等键。` : "操作没有完成，再次操作会复用同一幂等键。");
      }
    } finally {
      setBusy(false);
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
  return (
    <section className="min-w-0 rounded-lg bg-white p-4 [overflow-wrap:anywhere]" aria-label="角色参考图">
      <h2 className="font-medium">角色参考图</h2>
      <p className="mt-2 text-sm">生成参考图只要求来源剧本已审核、角色当前版本非 STALE，不要求角色先审核。严格视频门要求角色和选定参考图都已审核且属于当前版本。图片是 Mock 固定测试图，不是模型生成结果。</p>
      <button className="mt-2 rounded border px-3 py-1 text-sm disabled:opacity-50" type="button" disabled={busy}
        onClick={() => void write(`generate:${props.currentRevisionId}`, `/character-revisions/${props.currentRevisionId}/reference-images/generate`, {},
          "已受理参考图生成。这不是生成成功，结果以列表为准。")}>为当前版本生成参考图</button>
      <button className="ml-2 mt-2 text-sm underline" type="button" onClick={() => void load()}>刷新列表</button>
      {note ? <p className="mt-2 text-sm" role="status">{note}</p> : null}
      {error ? <p className="mt-2 text-sm" role="alert">{error}</p> : null}
      {listing?.selection ? (
        <p className="mt-2 text-sm">当前选定：{listing.selection.assetId.slice(0, 8)} · {listing.selection.usable ? "可用于视频" : "不可用于视频（已失效、未通过或不是当前版本）"}</p>
      ) : listing ? <p className="mt-2 text-sm">尚未选定参考图</p> : null}
      {listing && listing.items.length === 0 ? <p className="mt-2 text-sm">还没有参考图</p> : null}
      <ul className="mt-3 grid gap-3 sm:grid-cols-2">
        {listing?.items.map((item) => {
          const current = item.characterRevisionId === listing.currentRevisionId;
          const selectable = current && item.status === "ACTIVE" && item.reviewStatus === "APPROVED" && item.id !== selectedId;
          return (
            <li key={item.id} className="min-w-0 rounded border p-2 text-sm">
              <img className="h-24 w-24 rounded border object-contain [image-rendering:pixelated]" src={`/api/v1/assets/${item.id}/content`} alt={`参考图 ${item.id.slice(0, 8)}`} />
              <p className="mt-1">{item.id.slice(0, 8)}{item.id === selectedId ? " · 当前选定" : ""}</p>
              <p>{STATUS_TEXT[item.status] ?? item.status} · {REVIEW_TEXT[item.reviewStatus] ?? item.reviewStatus}{current ? "" : " · 来自旧版本"}</p>
              {item.reviewNote ? <p>备注：{item.reviewNote}</p> : null}
              {item.status === "ACTIVE" && current && item.reviewStatus !== "APPROVED" ? (
                <button className="mt-1 mr-2 underline disabled:opacity-50" type="button" disabled={busy}
                  onClick={() => void write(`review:${item.id}:${item.rowVersion}:APPROVED`, `/character-reference-images/${item.id}/review`,
                    { decision: "APPROVED", expectedRowVersion: item.rowVersion, contentHash: item.checksumSha256 }, "参考图已通过")}>通过</button>
              ) : null}
              {item.reviewStatus !== "REJECTED" ? (
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
