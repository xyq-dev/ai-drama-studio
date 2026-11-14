"use client";

import { useEffect, useRef, useState } from "react";
import {
  confirmShortSequel,
  readShortSequelList,
  shortSequelWorkbenchUrl,
  type ShortSequelListView,
} from "../lib/short-sequel-client";
import { ApiError } from "../lib/studio-client";
import styles from "./title-writing.module.css";

export function ShortSequelEntry({ projectId, afterEpisodeNo }: {
  projectId: string;
  afterEpisodeNo: number;
}) {
  const [view, setView] = useState<ShortSequelListView | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retryRead, setRetryRead] = useState(0);
  const [readFailed, setReadFailed] = useState(false);
  const request = useRef<{ episodeNo: number; key: string; busy: boolean } | null>(null);
  const episodeNo = afterEpisodeNo + 1;

  useEffect(() => {
    const abort = new AbortController();
    void readShortSequelList(projectId, abort.signal)
      .then((value) => { if (!abort.signal.aborted) { setView(value); setReadFailed(false); } })
      .catch((caught: unknown) => {
        if (!abort.signal.aborted && (!(caught instanceof ApiError) || caught.status !== 404)) setReadFailed(true);
      });
    return () => abort.abort();
  }, [projectId, retryRead]);

  async function createEpisode() {
    if (request.current?.busy) return;
    const key = request.current?.episodeNo === episodeNo ? request.current.key : crypto.randomUUID();
    request.current = { episodeNo, key, busy: true };
    setBusy(true);
    setError("");
    try {
      const { body } = await confirmShortSequel(projectId, episodeNo, key);
      if (body.episodeNo !== episodeNo) throw new Error("未确认新增集数。");
      setView((current) => current && ({
        ...current,
        episodeCount: body.episodeCount,
        continuations: [...current.continuations.filter((item) => item.episodeNo !== episodeNo), body],
      }));
      window.location.assign(shortSequelWorkbenchUrl(projectId, episodeNo));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.detail : "未确认是否已新增本集，可以安全重试。");
    } finally {
      request.current.busy = false;
      setBusy(false);
    }
  }

  if (!view) return readFailed ? <p className={styles.warning}>暂时无法读取续写状态。 <button className={styles.textLink}
    type="button" onClick={() => setRetryRead((current) => current + 1)}>重新读取</button></p> : null;
  if (view.continuations.some((item) => item.episodeNo === episodeNo)) {
    return <a className={styles.secondary} href={shortSequelWorkbenchUrl(projectId, episodeNo)}>打开第 {episodeNo} 集</a>;
  }
  if (view.nextEpisodeNo !== episodeNo) return null;

  return (
    <div className={styles.actions}>
      {confirming ? (
        <>
          <p className={styles.helper}>确认后，作品计划集数为 {episodeNo} 集。</p>
          <button className={styles.primary} type="button" disabled={busy} onClick={() => void createEpisode()}>
            在本作品新增第 {episodeNo} 集
          </button>
          <button className={styles.secondary} type="button" disabled={busy} onClick={() => { setConfirming(false); setError(""); }}>取消</button>
        </>
      ) : (
        <button className={styles.secondary} type="button" onClick={() => setConfirming(true)}>续写下一集</button>
      )}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
    </div>
  );
}
