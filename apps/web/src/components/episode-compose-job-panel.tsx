import { useEffect, useRef, useState } from "react";
import type { StudioClient } from "../lib/studio-client";
import { ApiError } from "../lib/studio-client";

export interface EpisodeComposeBody {
  compositeAssetIds: string[];
  expectedInputHash: string;
}

export interface EpisodeComposeJobPanelProps {
  client: StudioClient;
  projectId: string;
  episodeId: string;
  body: EpisodeComposeBody | null;
  onReviewed?: () => void;
}

interface JobView {
  id: string;
  state: string;
  errorMessage: string | null;
}

interface CompositeItem {
  assetId: string;
  status: "ACTIVE" | "STALE";
  reviewStatus: "DRAFT" | "APPROVED" | "REJECTED";
  checksumSha256: string;
  rowVersion: number;
  durationMs: number | null;
  segments: Array<{ position: number; assetId: string; shotId: string; startMs: number; endMs: number }>;
}

interface CompositePage {
  items: CompositeItem[];
  nextCursor: string | null;
}

interface HeldSubmit {
  identity: string;
  body: EpisodeComposeBody;
  idempotencyKey: string;
  unresolved: boolean;
}

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELED"]);

export function EpisodeComposeJobPanel(props: EpisodeComposeJobPanelProps) {
  const identity = `${props.projectId}:${props.episodeId}`;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<JobView | null>(null);
  const [items, setItems] = useState<CompositeItem[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [held, setHeld] = useState<HeldSubmit | null>(null);
  const [reload, setReload] = useState(0);
  const epoch = useRef(0);
  const listEpoch = useRef(0);
  const reading = useRef(false);
  const hidden = useRef(typeof document !== "undefined" && document.visibilityState === "hidden");

  function reset(nextEpoch: number) {
    epoch.current = nextEpoch;
    setBusy(false);
    setError(null);
    setJob(null);
    setItems([]);
    setListError(null);
    setHeld(null);
  }

  useEffect(() => {
    const token = epoch.current + 1;
    reset(token);
  }, [identity]);

  useEffect(() => {
    const token = listEpoch.current + 1;
    listEpoch.current = token;
    let timer = 0;
    let stopped = false;
    const read = async () => {
      if (stopped || hidden.current || listEpoch.current !== token) return;
      if (reading.current) {
        timer = window.setTimeout(() => void read(), 50);
        return;
      }
      reading.current = true;
      try {
        const page = await props.client.get<CompositePage>(
          `/projects/${props.projectId}/episodes/${props.episodeId}/composites?limit=10`,
        );
        if (stopped || listEpoch.current !== token) return;
        setItems(page.items);
        setListError(null);
      } catch (caught) {
        if (stopped || listEpoch.current !== token) return;
        setListError(caught instanceof ApiError ? caught.detail : "集级成片暂时无法读取");
      } finally {
        reading.current = false;
        if (!stopped && listEpoch.current === token && !hidden.current) {
          timer = window.setTimeout(() => void read(), 2000);
        }
      }
    };
    const onVisibility = () => {
      hidden.current = document.visibilityState === "hidden";
      if (!hidden.current && !stopped && listEpoch.current === token) {
        window.clearTimeout(timer);
        void read();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    void read();
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearTimeout(timer);
    };
  }, [identity, props.client, props.episodeId, props.projectId, reload]);

  useEffect(() => {
    if (!job || TERMINAL.has(job.state)) return;
    const token = epoch.current;
    const jobId = job.id;
    let timer = 0;
    let active = false;
    let stopped = false;
    const read = async () => {
      if (stopped || hidden.current || active || epoch.current !== token) return;
      active = true;
      try {
        const next = await props.client.get<JobView>(`/generation-jobs/${jobId}`);
        if (stopped || epoch.current !== token || jobId !== next.id) return;
        setJob(next);
        if (!TERMINAL.has(next.state) && epoch.current === token && !hidden.current && !stopped) {
          timer = window.setTimeout(() => void read(), 1500);
        }
      } catch (caught) {
        if (stopped || epoch.current !== token) return;
        setError(caught instanceof ApiError ? caught.detail : "任务暂时无法读取");
        if (epoch.current === token && !hidden.current && !stopped) timer = window.setTimeout(() => void read(), 1500);
      } finally {
        active = false;
      }
    };
    const onVisible = () => {
      hidden.current = document.visibilityState === "hidden";
      if (!hidden.current && !stopped) {
        window.clearTimeout(timer);
        void read();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    void read();
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.clearTimeout(timer);
    };
  }, [job?.id, job?.state, props.client]);

  async function start() {
    const current = held?.identity === identity && held.unresolved ? held : null;
    const body = current?.body ?? props.body;
    if (!body) return;
    const token = epoch.current;
    const idempotencyKey = current?.idempotencyKey ?? crypto.randomUUID();
    const request: HeldSubmit = { identity, body, idempotencyKey, unresolved: true };
    setHeld(request);
    setBusy(true);
    setError(null);
    try {
      const result = await props.client.write<{ id?: string; jobId?: string; state?: string }>({
        path: `/projects/${props.projectId}/episodes/${props.episodeId}/compose`,
        body,
        idempotencyKey,
      });
      if (epoch.current !== token) return;
      const jobId = result.body.id ?? result.body.jobId;
      if (result.status !== 202 || !jobId) {
        setError("合成请求没有返回有效任务编号，将使用同一请求重试");
        return;
      }
      setHeld({ ...request, unresolved: false });
      setJob({ id: jobId, state: result.body.state ?? "QUEUED", errorMessage: null });
    } catch (caught) {
      if (epoch.current !== token) return;
      const retryable = caught instanceof ApiError && (caught.status === 503 || caught.status === 0);
      const network = !(caught instanceof ApiError);
      if (!retryable && !network) setHeld({ ...request, unresolved: false });
      setError(caught instanceof ApiError ? caught.detail : "网络异常，将使用同一请求重试");
    } finally {
      if (epoch.current === token) setBusy(false);
    }
  }

  async function cancel() {
    if (!job) return;
    const token = epoch.current;
    const jobId = job.id;
    try {
      await props.client.write({
        path: `/generation-jobs/${jobId}/cancel`,
        body: {},
        idempotencyKey: crypto.randomUUID(),
      });
      if (epoch.current !== token) return;
      const next = await props.client.get<JobView>(`/generation-jobs/${jobId}`);
      if (epoch.current !== token || next.id !== jobId) return;
      setJob(next);
    } catch (caught) {
      if (epoch.current !== token) return;
      setError(caught instanceof ApiError ? caught.detail : "取消没有完成");
    }
  }

  async function review(item: CompositeItem, action: "APPROVE" | "REJECT") {
    const token = epoch.current;
    try {
      await props.client.write({
        path: `/assets/${item.assetId}/review`,
        body: { decision: action, note: "", contentHash: item.checksumSha256 },
        idempotencyKey: crypto.randomUUID(),
        ifMatch: item.rowVersion,
      });
      if (epoch.current !== token) return;
      props.onReviewed?.();
    } catch (caught) {
      if (epoch.current !== token) return;
      setError(caught instanceof ApiError ? caught.detail : "审核没有完成");
    }
  }

  const canStart = Boolean(props.body) || Boolean(held?.identity === identity && held.unresolved);
  return (
    <section className="mt-4 min-w-0" aria-label="集级合成">
      <button className="rounded bg-neutral-900 px-3 py-2 text-sm text-white disabled:bg-neutral-400" type="button" disabled={!canStart || busy} onClick={() => void start()}>开始多镜合成</button>
      {job ? <p className="mt-2 text-sm" role="status">多镜合成已受理 {job.state}</p> : null}
      {error ? <p className="mt-2 text-sm" role="alert">{error}</p> : null}
      {listError ? <button className="mt-2 rounded border px-3 py-1 text-sm" type="button" onClick={() => setReload((value) => value + 1)}>重新查询成片</button> : null}
      {job && !TERMINAL.has(job.state) ? <button className="mt-2 rounded border px-3 py-1 text-sm" type="button" onClick={() => void cancel()}>取消合成</button> : null}
      <ul className="mt-3 space-y-2">
        {items.map((item) => (
          <li key={item.assetId} className="min-w-0 rounded border p-2 text-sm" data-composite-id={item.assetId}>
            <p>{item.status === "STALE" ? "历史成片" : "当前成片"} · 审核 {item.reviewStatus} · {item.durationMs ?? 0} ms</p>
            <ol>
              {(item.segments ?? []).map((segment) => <li key={`${item.assetId}:${segment.position}:${segment.assetId}`}>{segment.position}. {segment.shotId}</li>)}
            </ol>
            <video className="mt-2 aspect-[9/16] w-full bg-black" controls src={`/api/v1/assets/${item.assetId}/content`} />
            {item.status === "ACTIVE" && item.reviewStatus === "DRAFT" ? (
              <div className="mt-2 flex flex-wrap gap-2">
                <button className="rounded border px-2 py-1" type="button" onClick={() => void review(item, "APPROVE")}>批准成片</button>
                <button className="rounded border px-2 py-1" type="button" onClick={() => void review(item, "REJECT")}>退回成片</button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
