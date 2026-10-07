import { useEffect, useRef, useState } from "react";
import type { StudioClient } from "../lib/studio-client";
import { ApiError } from "../lib/studio-client";
import { useChangeNotice } from "../lib/use-change-notice";

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
  /** Called when a compose is accepted, reaches a terminal state, or a composite is reviewed. */
  onChanged?: () => void;
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
  reviewedContentHash?: string | null;
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

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function dedupeComposites(items: CompositeItem[]): CompositeItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.assetId)) return false;
    seen.add(item.assetId);
    return true;
  });
}

function preferListed(current: CompositeItem[], incoming: CompositeItem[]): CompositeItem[] {
  const previous = new Map(current.map((item) => [item.assetId, item]));
  return dedupeComposites(incoming).map((item) => {
    const prior = previous.get(item.assetId);
    if (!prior) return item;
    if (item.rowVersion < prior.rowVersion) return prior;
    if (item.rowVersion === prior.rowVersion && prior.status === "STALE" && item.status === "ACTIVE") return prior;
    return {
      ...item,
      reviewedContentHash: item.reviewedContentHash ?? prior.reviewedContentHash ?? null,
    };
  });
}

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELED"]);
const DEFINITE_COMPOSE_REJECTION = new Set([
  "VALIDATION_ERROR",
  "COMPOSE_INPUT_CHANGED",
  "COMPOSE_INPUT_INVALID",
  "CONFIGURATION_ERROR",
  "NOT_FOUND",
  "REVIEW_REQUIRED",
  "STALE_RECALCULATION_PENDING",
  "IDEMPOTENCY_KEY_REUSED",
]);

export function EpisodeComposeJobPanel(props: EpisodeComposeJobPanelProps) {
  const identity = `${props.projectId}:${props.episodeId}`;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<JobView | null>(null);
  const notifyChanged = useChangeNotice(job, props.onChanged);
  const [items, setItems] = useState<CompositeItem[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [held, setHeld] = useState<HeldSubmit | null>(null);
  const [reload, setReload] = useState(0);
  const [pendingDownloads, setPendingDownloads] = useState<Record<string, "mp4" | "json">>({});
  const [downloadErrors, setDownloadErrors] = useState<Record<string, string>>({});
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const epoch = useRef(0);
  const listEpoch = useRef(0);
  const jobGen = useRef(0);
  const readGen = useRef(0);
  const listGen = useRef(0);
  const loadedPages = useRef(1);
  const historyCursorRef = useRef<string | null>(null);
  const readSerial = useRef(0);
  const reading = useRef(false);
  const hidden = useRef(typeof document !== "undefined" && document.visibilityState === "hidden");
  const downloadSession = useRef(0);
  const downloadGeneration = useRef(new Map<string, number>());
  const downloadInflight = useRef(new Map<string, number>());

  function rememberCursor(value: string | null) {
    historyCursorRef.current = value;
    setHistoryCursor(value);
  }

  function reset(nextEpoch: number) {
    epoch.current = nextEpoch;
    jobGen.current += 1;
    readGen.current += 1;
    listGen.current += 1;
    loadedPages.current = 1;
    readSerial.current += 1;
    reading.current = false;
    setBusy(false);
    setError(null);
    setJob(null);
    setItems([]);
    setListError(null);
    setHeld(null);
    downloadSession.current += 1;
    downloadInflight.current.clear();
    setPendingDownloads({});
    setDownloadErrors({});
    rememberCursor(null);
  }

  useEffect(() => () => {
    downloadSession.current += 1;
  }, []);

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
      const serial = ++readSerial.current;
      reading.current = true;
      const readToken = ++listGen.current;
      const pageCount = loadedPages.current;
      try {
        const collected: CompositeItem[] = [];
        let cursor: string | null = null;
        let nextCursor: string | null = null;
        for (let index = 0; index < pageCount; index += 1) {
          const suffix: string = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
          const listed: CompositePage = await props.client.get<CompositePage>(
            `/projects/${props.projectId}/episodes/${props.episodeId}/composites?limit=10${suffix}`,
          );
          if (stopped || listEpoch.current !== token || listGen.current !== readToken) return;
          collected.push(...listed.items);
          nextCursor = listed.nextCursor;
          if (!listed.nextCursor) break;
          cursor = listed.nextCursor;
        }
        if (stopped || listEpoch.current !== token || listGen.current !== readToken) return;
        setItems((current) => preferListed(current, collected));
        rememberCursor(nextCursor);
        setListError(null);
      } catch (caught) {
        if (stopped || listEpoch.current !== token || listGen.current !== readToken) return;
        setListError(caught instanceof ApiError ? caught.detail : "集级成片暂时无法读取");
      } finally {
        if (readSerial.current === serial) reading.current = false;
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
    const generation = jobGen.current;
    const jobId = job.id;
    let timer = 0;
    let active = false;
    let stopped = false;
    const stillCurrent = () => !stopped && epoch.current === token && jobGen.current === generation && !hidden.current;
    const read = async () => {
      if (stopped || hidden.current || active || epoch.current !== token || jobGen.current !== generation) return;
      const seenRead = readGen.current;
      active = true;
      try {
        const next = await props.client.get<JobView>(`/generation-jobs/${jobId}`);
        const fresh = !stopped && epoch.current === token && jobGen.current === generation && readGen.current === seenRead;
        if (!fresh || next.id !== jobId) {
          if (stillCurrent()) timer = window.setTimeout(() => void read(), 1500);
          return;
        }
        setJob(next);
        if (!TERMINAL.has(next.state) && stillCurrent() && readGen.current === seenRead) {
          timer = window.setTimeout(() => void read(), 1500);
        }
      } catch (caught) {
        if (stopped || epoch.current !== token || jobGen.current !== generation || readGen.current !== seenRead) {
          if (stillCurrent()) timer = window.setTimeout(() => void read(), 1500);
          return;
        }
        setError(caught instanceof ApiError ? caught.detail : "任务暂时无法读取");
        if (stillCurrent()) timer = window.setTimeout(() => void read(), 1500);
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
      jobGen.current += 1;
      readGen.current += 1;
      setHeld({ ...request, unresolved: false });
      setJob({ id: jobId, state: result.body.state ?? "QUEUED", errorMessage: null });
      notifyChanged();
    } catch (caught) {
      if (epoch.current !== token) return;
      const definite = caught instanceof ApiError && DEFINITE_COMPOSE_REJECTION.has(caught.code);
      if (definite) setHeld({ ...request, unresolved: false });
      if (caught instanceof ApiError) setError(caught.detail);
      else if (caught instanceof SyntaxError) setError("响应无法解析，将使用同一请求重试");
      else setError("网络异常，将使用同一请求重试");
    } finally {
      if (epoch.current === token) setBusy(false);
    }
  }

  async function cancel() {
    if (!job) return;
    const token = epoch.current;
    const generation = jobGen.current;
    const jobId = job.id;
    readGen.current += 1;
    try {
      await props.client.write({
        path: `/generation-jobs/${jobId}/cancel`,
        body: {},
        idempotencyKey: crypto.randomUUID(),
      });
      if (epoch.current !== token || jobGen.current !== generation) return;
      const next = await props.client.get<JobView>(`/generation-jobs/${jobId}`);
      if (epoch.current !== token || jobGen.current !== generation || next.id !== jobId) return;
      if (TERMINAL.has(next.state)) {
        jobGen.current += 1;
        readGen.current += 1;
      }
      setJob(next);
    } catch (caught) {
      if (epoch.current !== token || jobGen.current !== generation) return;
      setError(caught instanceof ApiError ? caught.detail : "取消没有完成");
    }
  }

  async function loadHistory() {
    const cursor = historyCursorRef.current;
    const token = listEpoch.current;
    if (!cursor) return;
    loadedPages.current += 1;
    const readToken = ++listGen.current;
    try {
      const page = await props.client.get<CompositePage>(
        `/projects/${props.projectId}/episodes/${props.episodeId}/composites?limit=10&cursor=${encodeURIComponent(cursor)}`,
      );
      if (listEpoch.current !== token || listGen.current !== readToken) return;
      setItems((current) => {
        const incoming = new Map(page.items.map((item) => [item.assetId, item]));
        const updated = current.map((entry) => {
          const next = incoming.get(entry.assetId);
          return next ? preferListed([entry], [next])[0] ?? entry : entry;
        });
        const seen = new Set(updated.map((item) => item.assetId));
        return [...updated, ...page.items.filter((item) => !seen.has(item.assetId))];
      });
      rememberCursor(page.nextCursor);
      setListError(null);
    } catch (caught) {
      if (listEpoch.current === token && listGen.current === readToken) {
        loadedPages.current = Math.max(1, loadedPages.current - 1);
        setListError(caught instanceof ApiError ? caught.detail : "集级成片暂时无法读取");
      }
    }
  }

  function downloadIsCurrent(assetId: string, generation: number, session: number) {
    return downloadSession.current === session && downloadGeneration.current.get(assetId) === generation;
  }

  async function download(item: CompositeItem, kind: "mp4" | "json") {
    const assetId = item.assetId;
    if (downloadInflight.current.has(assetId)) return;
    const generation = (downloadGeneration.current.get(assetId) ?? 0) + 1;
    downloadGeneration.current.set(assetId, generation);
    downloadInflight.current.set(assetId, generation);
    const session = downloadSession.current;
    setPendingDownloads((current) => ({ ...current, [assetId]: kind }));
    setDownloadErrors((current) => {
      if (current[assetId] === undefined) return current;
      const next = { ...current };
      delete next[assetId];
      return next;
    });
    const leaf = kind === "mp4" ? "download" : "export-manifest";
    const accept = kind === "mp4" ? "video/mp4" : "application/json";
    try {
      const result = await props.client.readAttachment(
        `/projects/${props.projectId}/episodes/${props.episodeId}/composites/${assetId}/${leaf}?expectedContentHash=${item.checksumSha256}`,
        accept,
      );
      if (!downloadIsCurrent(assetId, generation, session)) return;
      if (!result.ok) {
        setDownloadErrors((current) => ({ ...current, [assetId]: result.message }));
        if (result.refresh) setReload((value) => value + 1);
        return;
      }
      saveBlob(result.blob, result.filename);
    } catch {
      if (downloadIsCurrent(assetId, generation, session)) {
        setDownloadErrors((current) => ({ ...current, [assetId]: "下载没有完成" }));
      }
    } finally {
      if (downloadInflight.current.get(assetId) === generation) downloadInflight.current.delete(assetId);
      if (downloadIsCurrent(assetId, generation, session)) {
        setPendingDownloads((current) => {
          if (current[assetId] === undefined) return current;
          const next = { ...current };
          delete next[assetId];
          return next;
        });
      }
    }
  }

  async function review(item: CompositeItem, action: "APPROVE" | "REJECT") {
    const token = epoch.current;
    const listToken = listEpoch.current;
    listGen.current += 1;
    try {
      const result = await props.client.write<{ reviewStatus: CompositeItem["reviewStatus"]; rowVersion: number; contentHash: string }>({
        path: `/assets/${item.assetId}/review`,
        body: { decision: action, note: "", contentHash: item.checksumSha256 },
        idempotencyKey: crypto.randomUUID(),
        ifMatch: item.rowVersion,
      });
      if (epoch.current !== token || listEpoch.current !== listToken) return;
      listGen.current += 1;
      setItems((current) => current.map((entry) => entry.assetId === item.assetId ? {
        ...entry,
        reviewStatus: result.body.reviewStatus,
        rowVersion: result.body.rowVersion,
        checksumSha256: result.body.contentHash,
        reviewedContentHash: result.body.contentHash,
      } : entry));
      props.onReviewed?.();
      notifyChanged();
    } catch (caught) {
      if (epoch.current !== token || listEpoch.current !== listToken) return;
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
      {historyCursor ? <button className="mt-2 rounded border px-3 py-1 text-sm" type="button" onClick={() => void loadHistory()}>加载更早的成片</button> : null}
      {job && !TERMINAL.has(job.state) ? <button className="mt-2 rounded border px-3 py-1 text-sm" type="button" onClick={() => void cancel()}>取消合成</button> : null}
      <ul className="mt-3 space-y-2">
        {items.map((item) => (
          <li
            key={item.assetId}
            className="min-w-0 rounded border p-2 text-sm"
            data-composite-id={item.assetId}
            data-asset-status={item.status}
            data-review-status={item.reviewStatus}
            data-row-version={item.rowVersion}
            data-reviewed-content={item.reviewedContentHash ?? ""}
          >
            <p>{item.status === "STALE" ? "历史成片" : "当前成片"} · 审核 {item.reviewStatus} · {item.durationMs ?? 0} ms</p>
            <ol>
              {(item.segments ?? []).map((segment) => <li key={`${item.assetId}:${segment.position}:${segment.assetId}`}>{segment.position}. {segment.shotId}</li>)}
            </ol>
            <video className="mt-2 aspect-[9/16] w-full bg-black" controls src={`/api/v1/assets/${item.assetId}/content`} />
            {item.status === "ACTIVE" && item.reviewStatus === "APPROVED" ? (
              <div className="mt-2 flex flex-wrap gap-2">
                <button className="rounded border px-2 py-1" type="button" disabled={pendingDownloads[item.assetId] !== undefined} onClick={() => void download(item, "mp4")}>
                  {pendingDownloads[item.assetId] === "mp4" ? "正在下载" : "下载 MP4"}
                </button>
                <button className="rounded border px-2 py-1" type="button" disabled={pendingDownloads[item.assetId] !== undefined} onClick={() => void download(item, "json")}>
                  {pendingDownloads[item.assetId] === "json" ? "正在下载" : "下载来源清单"}
                </button>
              </div>
            ) : null}
            {downloadErrors[item.assetId] !== undefined ? <p className="mt-2" role="alert">{downloadErrors[item.assetId]}</p> : null}
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
