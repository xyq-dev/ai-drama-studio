"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError, StudioClient } from "../lib/studio-client";

interface ListedAsset {
  id: string;
  kind: string;
  mimeType: string;
  status: string;
  reviewStatus: string;
  sourceShotRevisionId: string | null;
  durationMs: number | null;
}

interface PreflightAsset {
  assetId: string;
  checksumSha256: string;
  kind: string;
  mimeType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  durationMs: number;
}

interface PreflightResponse {
  manifest: {
    plan: { width: number; height: number; frameRate: number; container: string; durationMs: number };
    sources: Array<{ role: "video" | "audio" | "music" | "subtitle"; asset: PreflightAsset | null }>;
  };
  inputHash: string;
}

const EMPTY_SELECTION = { video: "", audio: "", music: "", subtitle: "" };
const ROLE_LABEL = { video: "视频", audio: "配音", music: "音乐", subtitle: "字幕" } as const;
const SLOT_RULES = {
  video: { kind: "VIDEO", mimeType: "video/mp4" },
  audio: { kind: "AUDIO", mimeType: "audio/wav" },
  music: { kind: "MUSIC", mimeType: "audio/wav" },
  subtitle: { kind: "SUBTITLE", mimeType: "text/vtt" },
} as const;

export function ComposePreflight(props: { revisionId: string; refreshEpoch: number; client?: StudioClient }) {
  const fallback = useRef<StudioClient | null>(null);
  if (!fallback.current) fallback.current = new StudioClient();
  const client = props.client ?? fallback.current;
  const epoch = useRef(0);
  const listToken = useRef(0);
  const [boundRevision, setBoundRevision] = useState(props.revisionId);
  const [assets, setAssets] = useState<ListedAsset[]>([]);
  const [selection, setSelection] = useState(EMPTY_SELECTION);
  const [result, setResult] = useState<PreflightResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (boundRevision !== props.revisionId) {
    epoch.current += 1;
    setBoundRevision(props.revisionId);
    setAssets([]);
    setSelection(EMPTY_SELECTION);
    setResult(null);
    setError(null);
    setBusy(false);
  }

  useEffect(() => {
    const token = ++listToken.current;
    const revisionId = props.revisionId;
    let cancelled = false;
    void client.get<{ items: ListedAsset[] }>(`/shot-revisions/${revisionId}/assets`).then((page) => {
      if (cancelled || token !== listToken.current) return;
      const items = page.items.filter((asset) => asset.sourceShotRevisionId === revisionId);
      setAssets(items);
      setSelection((current) => {
        const next = {
          video: keep(current.video, items, revisionId, "video"),
          audio: keep(current.audio, items, revisionId, "audio"),
          music: keep(current.music, items, revisionId, "music"),
          subtitle: keep(current.subtitle, items, revisionId, "subtitle"),
        };
        if (next.video !== current.video || next.audio !== current.audio || next.music !== current.music || next.subtitle !== current.subtitle) {
          epoch.current += 1;
          setResult(null);
          setError(null);
          setBusy(false);
        }
        return next;
      });
    }, () => {
      if (cancelled || token !== listToken.current) return;
      setError("媒体列表刷新失败");
    });
    return () => {
      cancelled = true;
    };
  }, [client, props.refreshEpoch, props.revisionId]);

  function choose(slot: keyof typeof EMPTY_SELECTION, value: string) {
    epoch.current += 1;
    setResult(null);
    setError(null);
    setBusy(false);
    setSelection((current) => ({ ...current, [slot]: value }));
  }

  async function submit() {
    const token = ++epoch.current;
    const revisionId = props.revisionId;
    const body = {
      videoAssetId: selection.video,
      audioAssetId: selection.audio || null,
      musicAssetId: selection.music || null,
      subtitleAssetId: selection.subtitle || null,
    };
    setResult(null);
    setError(null);
    setBusy(true);
    try {
      const payload = await client.postJson<PreflightResponse>(`/shot-revisions/${revisionId}/compose-preflight`, body);
      if (token !== epoch.current || revisionId !== props.revisionId) return;
      setResult(payload);
      setError(null);
    } catch (caught) {
      if (token !== epoch.current || revisionId !== props.revisionId) return;
      setResult(null);
      setError(caught instanceof ApiError ? caught.detail : "预检失败");
    } finally {
      if (token === epoch.current) setBusy(false);
    }
  }

  const videos = usable(assets, props.revisionId, "video");
  return (
    <section className="mt-6 min-w-0 rounded border p-3" aria-label="Mock 单镜合成预检">
      <h3 className="font-medium">Mock 单镜合成预检</h3>
      <label className="mt-3 block text-sm" htmlFor="compose-video">合成视频</label>
      <select id="compose-video" className="mt-1 w-full rounded border px-2 py-1" value={selection.video} onChange={(event) => choose("video", event.target.value)}>
        <option value="">请选择视频</option>
        {videos.map((asset) => <option key={asset.id} value={asset.id}>{asset.id}</option>)}
      </select>
      <OptionalSelect id="compose-audio" label="合成配音" value={selection.audio} assets={usable(assets, props.revisionId, "audio")} onChange={(value) => choose("audio", value)} />
      <OptionalSelect id="compose-music" label="合成音乐" value={selection.music} assets={usable(assets, props.revisionId, "music")} onChange={(value) => choose("music", value)} />
      <OptionalSelect id="compose-subtitle" label="合成字幕" value={selection.subtitle} assets={usable(assets, props.revisionId, "subtitle")} onChange={(value) => choose("subtitle", value)} />
      <button className="mt-3 rounded border px-3 py-2 disabled:opacity-50" type="button" disabled={!selection.video || busy} onClick={() => void submit()}>
        {busy ? "正在预检" : "预检合成输入"}
      </button>
      {error ? <p className="mt-2 text-sm" role="alert">{error}</p> : null}
      {result ? (
        <div className="mt-3 text-sm">
          <p>合成尚未执行</p>
          <p>计划尺寸 {result.manifest.plan.width}×{result.manifest.plan.height} · {result.manifest.plan.frameRate}fps · {result.manifest.plan.container.toUpperCase()}</p>
          <p>计划时长 {result.manifest.plan.durationMs} ms</p>
          <ul className="mt-2 space-y-1">
            {result.manifest.sources.map((slot) => (
              <li key={slot.role}>{ROLE_LABEL[slot.role]} {slot.asset ? slot.asset.assetId : "未选择"}</li>
            ))}
          </ul>
          <details className="mt-2">
            <summary>预检摘要</summary>
            <p className="break-all">{result.inputHash}</p>
          </details>
        </div>
      ) : null}
    </section>
  );
}

function OptionalSelect(props: {
  id: string;
  label: string;
  value: string;
  assets: ListedAsset[];
  onChange: (value: string) => void;
}) {
  return (
    <>
      <label className="mt-3 block text-sm" htmlFor={props.id}>{props.label}</label>
      <select id={props.id} className="mt-1 w-full rounded border px-2 py-1" value={props.value} onChange={(event) => props.onChange(event.target.value)}>
        <option value="">未选择</option>
        {props.assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.id}</option>)}
      </select>
    </>
  );
}

function usable(assets: readonly ListedAsset[], revisionId: string, role: keyof typeof SLOT_RULES): ListedAsset[] {
  const rule = SLOT_RULES[role];
  return assets.filter((asset) => asset.sourceShotRevisionId === revisionId
    && asset.status === "ACTIVE"
    && asset.reviewStatus === "DRAFT"
    && asset.kind === rule.kind
    && asset.mimeType === rule.mimeType);
}

function keep(selected: string, assets: readonly ListedAsset[], revisionId: string, role: keyof typeof SLOT_RULES): string {
  if (!selected) return "";
  return usable(assets, revisionId, role).some((asset) => asset.id === selected) ? selected : "";
}
