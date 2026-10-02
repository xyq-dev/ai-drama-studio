"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError, StudioClient } from "../lib/studio-client";

interface Candidate {
  assetId: string;
  shotId: string;
  shotRevisionId: string;
  sceneId: string;
  sceneOrdinal: number;
  sceneHeading: string;
  shotOrdinal: number;
  durationMs: number;
  reviewStatus: string;
}

interface CandidatePage {
  items: Candidate[];
  nextCursor: string | null;
}

interface PreflightSegment {
  position: number;
  assetId: string;
  startMs: number;
  endMs: number;
  durationMs: number;
}

interface PreflightResponse {
  verification: string;
  diskContentChecked: boolean;
  decoded: boolean;
  executed: boolean;
  statusNote: string;
  durationNotice: string | null;
  inputHash: string;
  manifest: {
    plan: { durationMs: number; width: number; height: number; frameRate: number; container: string };
    segments: PreflightSegment[];
  };
}

export function EpisodeComposePreflight(props: {
  projectId: string;
  episodeId: string | null;
  episodeNo: number;
  client?: StudioClient;
}) {
  const fallback = useRef<StudioClient | null>(null);
  if (!fallback.current) fallback.current = new StudioClient();
  const client = props.client ?? fallback.current;
  const identity = `${props.projectId}:${props.episodeId ?? ""}`;
  const selections = useRef(new Map<string, Candidate[]>());
  const epoch = useRef(0);
  const listToken = useRef(0);
  const [bound, setBound] = useState(identity);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<Candidate[]>([]);
  const [result, setResult] = useState<PreflightResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  if (bound !== identity) {
    selections.current.set(bound, selected);
    epoch.current += 1;
    setBound(identity);
    setSelected(selections.current.get(identity) ?? []);
    setCandidates([]);
    setNextCursor(null);
    setResult(null);
    setError(null);
    setBusy(false);
    setLoading(false);
  }

  useEffect(() => {
    if (!props.episodeId) return;
    const token = ++listToken.current;
    const episodeId = props.episodeId;
    const projectId = props.projectId;
    setLoading(true);
    setError(null);
    void client.get<CandidatePage>(`/projects/${projectId}/episodes/${episodeId}/compose-candidates?limit=100`).then((page) => {
      if (token !== listToken.current) return;
      setCandidates(page.items);
      setNextCursor(page.nextCursor);
      setLoading(false);
    }).catch((caught: unknown) => {
      if (token !== listToken.current) return;
      setError(caught instanceof ApiError ? caught.detail : "候选成片加载失败");
      setLoading(false);
    });
  }, [client, props.episodeId, props.projectId, bound]);

  function remember(next: Candidate[]) {
    selections.current.set(identity, next);
    setSelected(next);
    setResult(null);
    epoch.current += 1;
  }

  function add(candidate: Candidate) {
    if (selected.some((item) => item.assetId === candidate.assetId || item.shotId === candidate.shotId)) return;
    remember([...selected, candidate]);
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= selected.length) return;
    const next = selected.slice();
    const current = next[index];
    const neighbor = next[target];
    if (!current || !neighbor) return;
    next[index] = neighbor;
    next[target] = current;
    remember(next);
  }

  function remove(assetId: string) {
    remember(selected.filter((item) => item.assetId !== assetId));
  }

  async function reload() {
    if (!props.episodeId) return;
    const token = ++listToken.current;
    const episodeId = props.episodeId;
    setLoading(true);
    setError(null);
    try {
      const page = await client.get<CandidatePage>(`/projects/${props.projectId}/episodes/${episodeId}/compose-candidates?limit=100`);
      if (token !== listToken.current) return;
      setCandidates(page.items);
      setNextCursor(page.nextCursor);
    } catch (caught: unknown) {
      if (token !== listToken.current) return;
      setError(caught instanceof ApiError ? caught.detail : "候选成片加载失败");
    } finally {
      if (token === listToken.current) setLoading(false);
    }
  }

  async function more() {
    if (!props.episodeId || !nextCursor) return;
    const token = ++listToken.current;
    const cursor = nextCursor;
    try {
      const page = await client.get<CandidatePage>(
        `/projects/${props.projectId}/episodes/${props.episodeId}/compose-candidates?limit=100&cursor=${encodeURIComponent(cursor)}`,
      );
      if (token !== listToken.current) return;
      setCandidates((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (caught: unknown) {
      if (token !== listToken.current) return;
      setError(caught instanceof ApiError ? caught.detail : "候选成片加载失败");
    }
  }

  async function preflight() {
    if (!props.episodeId || selected.length < 2) return;
    const requestEpoch = ++epoch.current;
    const requestIdentity = identity;
    const ids = selected.map((item) => item.assetId);
    setResult(null);
    setError(null);
    setBusy(true);
    try {
      const body = await client.postJson<PreflightResponse>(
        `/projects/${props.projectId}/episodes/${props.episodeId}/compose-preflight`,
        { compositeAssetIds: ids },
      );
      if (requestEpoch !== epoch.current || requestIdentity !== `${props.projectId}:${props.episodeId ?? ""}`) return;
      setResult(body);
    } catch (caught: unknown) {
      if (requestEpoch !== epoch.current || requestIdentity !== `${props.projectId}:${props.episodeId ?? ""}`) return;
      setResult(null);
      setError(caught instanceof ApiError ? caught.detail : "多镜预检失败");
    } finally {
      if (requestEpoch === epoch.current) setBusy(false);
    }
  }

  const totalMs = selected.reduce((sum, item) => sum + item.durationMs, 0);
  let localCursor = 0;

  return (
    <section className="min-w-0 max-w-full rounded-lg bg-white p-4" aria-label="多镜编排">
      <h2 className="text-lg font-medium">多镜编排</h2>
      <p className="mt-2 text-sm text-neutral-700">第 {props.episodeNo} 集。选择本集已批准的单镜成片并调整顺序。这里只做预检，不合成新成片。</p>
      {!props.episodeId ? <p className="mt-3 text-sm">这一集还不存在</p> : null}
      {error ? <p className="mt-3 text-sm" role="alert">{error}</p> : null}
      {error ? <button className="mt-2 rounded border px-3 py-1 text-sm" type="button" onClick={() => void reload()}>重新查询</button> : null}
      <div className="mt-4 min-w-0">
        <h3 className="font-medium">可用成片</h3>
        {loading ? <p className="mt-2 text-sm">正在加载候选成片</p> : null}
        <ul className="mt-2 space-y-2">
          {candidates.map((candidate) => (
            <li key={candidate.assetId} className="min-w-0 rounded border p-2 text-sm" data-asset-id={candidate.assetId}>
              <p className="break-words">{`场景 ${candidate.sceneOrdinal} ${candidate.sceneHeading}`}</p>
              <p className="break-words">{`镜头 ${candidate.shotOrdinal} · ${candidate.durationMs} ms · ${candidate.reviewStatus}`}</p>
              <p className="break-all text-neutral-600">{candidate.assetId}</p>
              <button className="mt-2 rounded border px-3 py-1" type="button" onClick={() => add(candidate)}>加入</button>
            </li>
          ))}
        </ul>
        {nextCursor ? <button className="mt-2 rounded border px-3 py-1 text-sm" type="button" onClick={() => void more()}>加载更多</button> : null}
      </div>
      <div className="mt-4 min-w-0">
        <h3 className="font-medium">已选顺序</h3>
        <ol className="mt-2 space-y-2">
          {selected.map((item, index) => {
            const startMs = localCursor;
            localCursor += item.durationMs;
            return (
              <li key={item.assetId} className="min-w-0 rounded border p-2 text-sm" data-selected-asset-id={item.assetId}>
                <p className="break-words">{`第 ${index + 1} 段 · 场景 ${item.sceneOrdinal} ${item.sceneHeading} · 镜头 ${item.shotOrdinal}`}</p>
                <p>{`${startMs}–${localCursor} ms · ${item.durationMs} ms`}</p>
                <p className="break-all text-neutral-600">{item.assetId}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button className="rounded border px-3 py-1" type="button" onClick={() => move(index, -1)}>上移</button>
                  <button className="rounded border px-3 py-1" type="button" onClick={() => move(index, 1)}>下移</button>
                  <button className="rounded border px-3 py-1" type="button" onClick={() => remove(item.assetId)}>移除</button>
                </div>
              </li>
            );
          })}
        </ol>
        <p className="mt-2 text-sm">总时长 {totalMs} ms</p>
        {!result && selected.length > 0 && totalMs < 60_000 ? <p className="text-sm">尚未达到 V1 的 60–90 秒目标</p> : null}
        <button className="mt-3 rounded bg-neutral-900 px-3 py-2 text-sm text-white disabled:bg-neutral-400" type="button" disabled={selected.length < 2 || busy} onClick={() => void preflight()}>预检编排</button>
      </div>
      {result ? (
        <div className="mt-4 min-w-0 text-sm">
          <p>{result.statusNote}</p>
          <p>元数据预检，未校验磁盘内容，未完成解码。</p>
          {result.durationNotice ? <p>{result.durationNotice}</p> : null}
          <p className="break-all">inputHash {result.inputHash}</p>
          <ul className="mt-2 space-y-1">
            {result.manifest.segments.map((segment) => (
              <li key={segment.assetId} className="break-all">{segment.position}. {segment.assetId} {segment.startMs}–{segment.endMs} ms</li>
            ))}
          </ul>
          <p>拼接 {result.manifest.plan.width}×{result.manifest.plan.height} · {result.manifest.plan.frameRate} fps · {result.manifest.plan.container} · 总时长 {result.manifest.plan.durationMs} ms</p>
        </div>
      ) : null}
    </section>
  );
}
