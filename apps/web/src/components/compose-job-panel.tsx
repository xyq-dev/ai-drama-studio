"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError, StudioClient } from "../lib/studio-client";

interface ComposeAsset {
  id: string;
  kind: string;
  status: string;
  reviewStatus: string;
  rowVersion: number;
  checksumSha256: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  sourceShotRevisionId: string | null;
  sourceGenerationJobId: string | null;
}

interface JobView {
  id: string;
  state: string;
  errorCode: string | null;
  errorMessage: string | null;
}

export function ComposeJobPanel(props: {
  revisionId: string;
  eligible: boolean;
  body: { videoAssetId: string; audioAssetId: string | null; musicAssetId: string | null; subtitleAssetId: string | null; expectedInputHash: string } | null;
  client: StudioClient;
}) {
  const epoch = useRef(0);
  const submitEpoch = useRef(0);
  const [boundRevision, setBoundRevision] = useState(props.revisionId);
  const [job, setJob] = useState<JobView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [assets, setAssets] = useState<ComposeAsset[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  if (boundRevision !== props.revisionId) {
    epoch.current += 1;
    submitEpoch.current += 1;
    setBoundRevision(props.revisionId);
    setJob(null);
    setNotice(null);
    setError(null);
    setAssets([]);
    setBusy(false);
  }

  useEffect(() => {
    const token = epoch.current;
    const revisionId = props.revisionId;
    let timer = 0;
    let stopped = false;
    const loadAssets = () => {
      void props.client.get<{ items: ComposeAsset[] }>(`/shot-revisions/${revisionId}/assets`).then((page) => {
        if (stopped || token !== epoch.current || revisionId !== props.revisionId) return;
        setAssets(page.items.filter((item) => item.kind === "COMPOSITE" && item.sourceShotRevisionId === revisionId));
      }, () => undefined);
    };
    const tick = () => {
      if (document.hidden) return;
      loadAssets();
      if (!job) return;
      void props.client.get<JobView>(`/generation-jobs/${job.id}`).then((next) => {
        if (stopped || token !== epoch.current || revisionId !== props.revisionId) return;
        setJob(next);
        if (next.state === "SUCCEEDED" || next.state === "FAILED" || next.state === "CANCELED") loadAssets();
      }, () => undefined);
    };
    tick();
    timer = window.setInterval(tick, 1000);
    const onVisible = () => { if (!document.hidden) tick(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [props.client, props.revisionId, job?.id]);

  async function start() {
    if (!props.body) return;
    const request = ++submitEpoch.current;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await props.client.write<{ id?: string; jobId?: string; state?: string }>({
        path: `/shot-revisions/${props.revisionId}/compose`,
        body: props.body,
        idempotencyKey: crypto.randomUUID(),
      });
      if (request !== submitEpoch.current) return;
      const id = result.body.id ?? result.body.jobId;
      if (!id) throw new ApiError(result.status, "COMPOSE_RESPONSE_INVALID", "合成响应没有任务编号");
      setJob({ id, state: result.body.state ?? "QUEUED", errorCode: null, errorMessage: null });
      setNotice("合成任务已受理");
    } catch (caught) {
      if (request !== submitEpoch.current) return;
      setError(caught instanceof ApiError ? caught.detail : "合成提交失败");
    } finally {
      if (request === submitEpoch.current) setBusy(false);
    }
  }

  async function cancel() {
    if (!job) return;
    const token = epoch.current;
    try {
      await props.client.write({ path: `/generation-jobs/${job.id}/cancel`, body: {}, idempotencyKey: crypto.randomUUID() });
      if (token !== epoch.current) return;
      const next = await props.client.get<JobView>(`/generation-jobs/${job.id}`);
      if (token !== epoch.current) return;
      setJob(next);
    } catch (caught) {
      if (token !== epoch.current) return;
      setError(caught instanceof ApiError ? caught.detail : "取消失败");
    }
  }

  async function review(asset: ComposeAsset, decision: "APPROVE" | "REJECT") {
    const token = epoch.current;
    try {
      const result = await props.client.write<{ reviewStatus: string; rowVersion: number }>({
        path: `/assets/${asset.id}/review`,
        body: { decision, note, contentHash: asset.checksumSha256 },
        idempotencyKey: crypto.randomUUID(),
        ifMatch: asset.rowVersion,
      });
      if (token !== epoch.current) return;
      setAssets((current) => current.map((item) => item.id === asset.id ? { ...item, reviewStatus: result.body.reviewStatus, rowVersion: result.body.rowVersion } : item));
      setError(null);
    } catch (caught) {
      if (token !== epoch.current) return;
      if (caught instanceof ApiError && caught.status === 409) {
        setError("请重读后重新确认");
        const page = await props.client.get<{ items: ComposeAsset[] }>(`/shot-revisions/${props.revisionId}/assets`).catch(() => null);
        if (page && token === epoch.current) {
          setAssets(page.items.filter((item) => item.kind === "COMPOSITE" && item.sourceShotRevisionId === props.revisionId));
        }
        return;
      }
      setError(caught instanceof ApiError ? caught.detail : "审核失败");
    }
  }

  return (
    <div className="mt-3 min-w-0">
      <button className="rounded border px-3 py-2 disabled:opacity-50" type="button" disabled={!props.eligible || busy} onClick={() => void start()}>
        开始合成
      </button>
      {notice ? <p className="mt-2 text-sm">{notice}</p> : null}
      {error ? <p className="mt-2 text-sm" role="alert">{error}</p> : null}
      {job ? (
        <div className="mt-2 text-sm" data-compose-job={job.id}>
          <p>合成任务 {job.state}</p>
          {job.errorMessage ? <p>{job.errorMessage}</p> : null}
          {job.state === "QUEUED" || job.state === "RUNNING" ? <button className="mt-1 rounded border px-2 py-1" type="button" onClick={() => void cancel()}>取消合成</button> : null}
        </div>
      ) : null}
      <ul className="mt-3 space-y-2">
        {assets.map((asset) => {
          const current = asset.status === "ACTIVE";
          return (
            <li key={asset.id} className="rounded border p-2 text-sm" data-composite-id={asset.id}>
              <p>本地合成 · Mock 来源</p>
              <p>{asset.width ?? "—"}×{asset.height ?? "—"} · {asset.durationMs ?? "—"} ms</p>
              <p>任务 {asset.sourceGenerationJobId}</p>
              <p>审核 {asset.reviewStatus}{current ? " · 当前有效" : " · 历史成片"}</p>
              <video className="mt-2 aspect-[9/16] w-full bg-black" controls src={`/api/v1/assets/${asset.id}/content`} />
              {current && asset.reviewStatus === "DRAFT" ? (
                <div className="mt-2">
                  <label className="block" htmlFor={`compose-note-${asset.id}`}>退回说明</label>
                  <input id={`compose-note-${asset.id}`} className="mt-1 w-full rounded border px-2 py-1" value={note} onChange={(event) => setNote(event.target.value)} />
                  <button className="mt-2 rounded border px-2 py-1" type="button" onClick={() => void review(asset, "APPROVE")}>批准成片</button>
                  <button className="ml-2 rounded border px-2 py-1" type="button" onClick={() => void review(asset, "REJECT")}>退回</button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
