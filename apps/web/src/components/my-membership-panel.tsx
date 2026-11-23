"use client";

import { useEffect, useState } from "react";
import { withSession } from "../lib/site-session";
import styles from "./account-plan-panel.module.css";

interface MembershipView {
  statusLabel: string;
  planName: string | null;
  startsAt: string | null;
  endsAt: string | null;
  features: Array<{ feature: string; label: string; enabled: boolean; remaining: number }>;
  ledger: Array<{ id: string; summary: string; occurredAt: string; status: string }>;
}

export function MyMembershipPanel() {
  const [view, setView] = useState<MembershipView | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const fetchImpl = withSession(globalThis.fetch.bind(globalThis));
    void fetchImpl("/api/v1/account/membership", { credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("暂时无法读取会员。");
        setView(await response.json() as MembershipView);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "暂时无法读取会员。"));
  }, []);
  return <section className={styles.panel} aria-labelledby="my-membership-title">
    <h1 id="my-membership-title">我的会员</h1>
    <p>这里显示当前会员、剩余额度和使用记录。开通由管理员处理，本页不能购买或续费。</p>
    {error ? <p role="alert">{error}</p> : null}
    <dl>
      <div><dt>状态</dt><dd>{view?.statusLabel ?? "正在读取"}</dd></div>
      <div><dt>套餐</dt><dd>{view?.planName ?? "未开通"}</dd></div>
      <div><dt>开始</dt><dd>{view?.startsAt ? view.startsAt.slice(0, 16).replace("T", " ") : "—"}</dd></div>
      <div><dt>结束</dt><dd>{view?.endsAt ? view.endsAt.slice(0, 16).replace("T", " ") : "—"}</dd></div>
    </dl>
    <h2>剩余额度</h2>
    <ul>{(view?.features ?? []).map((feature) => <li key={feature.feature}>{feature.label}：{feature.enabled ? String(feature.remaining) : "未包含"}</li>)}</ul>
    <h2>使用记录</h2>
    {(view?.ledger.length ?? 0) === 0 ? <p>还没有使用记录。</p> : <ul>{view?.ledger.map((row) => <li key={row.id}>{row.occurredAt.slice(0, 16).replace("T", " ")} {row.summary} {row.status === "unknown" ? "待核对" : ""}</li>)}</ul>}
  </section>;
}
