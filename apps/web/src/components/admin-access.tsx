"use client";

import { useEffect, useState, type ReactNode } from "react";
import { readSession } from "../lib/site-session";
import styles from "./feature-config.module.css";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type AdminGate = "loading" | "forbidden" | "unavailable" | "failed" | "ready";

/** Session gate shared by feature configuration and call records. Creators never reach the data request. */
export function useOperatorGate(fetchImpl?: FetchLike): { gate: AdminGate; reload: () => void } {
  const [gate, setGate] = useState<AdminGate>("loading");
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    let live = true;
    setGate("loading");
    readSession(fetchImpl)
      .then((session) => {
        if (!live) return;
        if (!session.enabled) setGate("unavailable");
        else if (!session.authenticated || session.role !== "operator") setGate("forbidden");
        else setGate("ready");
      })
      .catch(() => { if (live) setGate("failed"); });
    return () => { live = false; };
  }, [fetchImpl, epoch]);
  return { gate, reload: () => setEpoch((value) => value + 1) };
}

export function AdminGateView({ gate, onRetry }: { gate: Exclude<AdminGate, "ready">; onRetry?: () => void }) {
  if (gate === "forbidden") {
    return (
      <section className={styles.state} data-state="forbidden">
        <img src="/design/tailadmin-v2/icon-key-round.svg" width={28} height={28} alt="" />
        <h2>没有配置权限</h2>
        <p>功能配置仅管理员可以查看和修改。普通创作者请返回创作工作台。</p>
        <a className={styles.primary} href="/studio">返回创作中心</a>
      </section>
    );
  }
  if (gate === "loading") {
    return (
      <section className={styles.state} data-state="loading">
        <h2>正在加载配置</h2>
      </section>
    );
  }
  return (
    <section className={styles.state} data-state={gate === "unavailable" ? "unavailable" : "failed"}>
      <h2>{gate === "unavailable" ? "管理员后台尚未就绪" : "配置读取失败"}</h2>
      {gate === "unavailable" && <p>请联系服务器管理员完成安全存储初始化。</p>}
      {onRetry ? <button type="button" className={styles.secondary} onClick={onRetry}>重试</button> : null}
    </section>
  );
}

export function AdminFrame({ children }: { children: ReactNode }) {
  return <div className={styles.page}>{children}</div>;
}
