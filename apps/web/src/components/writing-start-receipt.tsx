"use client";

import { useEffect, useRef, useState } from "react";
import { StudioClient } from "../lib/studio-client";
import { isEntityId } from "../lib/title-writing-client";
import styles from "./title-writing.module.css";

const client = new StudioClient();
type Target = { kind: "writing" | "auto"; projectId: string } | { kind: "series" };

/** Reading an exact receipt never starts a run, even if the request had never reached the server. */
export function WritingStartReceipt({ target, requestKey, onRecovered }: {
  target: Target; requestKey: string; onRecovered: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const active = useRef<AbortController | null>(null);
  useEffect(() => () => { active.current?.abort(); }, [requestKey]);

  async function readReceipt() {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setNotice("");
    try {
      const path = target.kind === "series" ? "/writing/series/start-receipt"
        : `/projects/${target.projectId}/${target.kind === "writing" ? "title-runs" : "auto-runs"}/start-receipt`;
      const { receipt } = await client.get<{ receipt: { projectId: string; runId?: string } | null }>(path, {
        idempotencyKey: requestKey, signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (receipt === null) {
        setNotice("暂未查到上次请求的回执。");
        return;
      }
      if (!isEntityId(receipt?.projectId) || (target.kind !== "series" && (receipt.projectId !== target.projectId || !isEntityId(receipt.runId)))) {
        throw new Error("Invalid start receipt");
      }
      onRecovered();
      const query = target.kind === "series" ? "" : `?run=${receipt.runId}`;
      window.location.assign(`/projects/${receipt.projectId}/${target.kind}${query}`);
    } catch {
      if (!controller.signal.aborted) setNotice("暂时无法读取回执，请稍后再查。");
    } finally {
      active.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return <><button className={styles.secondary} type="button" disabled={busy} onClick={() => { void readReceipt(); }}>
    {busy ? "正在查询…" : "查询上次请求"}
  </button>{notice && <span role="status">{notice}</span>}</>;
}
