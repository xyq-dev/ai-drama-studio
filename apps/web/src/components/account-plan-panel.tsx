"use client";

import { useEffect, useState } from "react";
import {
  formatCreatorPlanRemaining,
  formatCreatorPlanUnitPrice,
} from "@ai-drama/domain/creator-account-plan";
import { withSession } from "../lib/site-session";
import styles from "./account-plan-panel.module.css";

interface PlanResponse {
  accountId: string;
  planName: string | null;
  unitPriceLabel: string;
  remainingLabel: string;
  entitlementStatus: string | null;
  unitPriceAmount: string | null;
  remainingUnits: string | null;
}

interface LedgerItem {
  id: string;
  display: string;
  status: string;
  occurredAt: string;
}

/**
 * Creator-visible plan / remaining quota and ledger skeleton.
 * Unpriced amounts stay 「尚未计价」; no payment or top-up UI.
 */
export function AccountPlanPanel() {
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [ledger, setLedger] = useState<LedgerItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchImpl = withSession(globalThis.fetch.bind(globalThis));
    void (async () => {
      try {
        const [planRes, ledgerRes] = await Promise.all([
          fetchImpl("/api/v1/account/plan", { credentials: "same-origin", cache: "no-store" }),
          fetchImpl("/api/v1/account/ledger?limit=20", { credentials: "same-origin", cache: "no-store" }),
        ]);
        if (!planRes.ok) {
          setError("暂时无法读取用量计划。");
          return;
        }
        const planBody = await planRes.json() as PlanResponse;
        setPlan(planBody);
        if (ledgerRes.ok) {
          const ledgerBody = await ledgerRes.json() as { items: LedgerItem[] };
          setLedger(ledgerBody.items ?? []);
        }
      } catch {
        setError("网络异常，没有读到用量计划。");
      }
    })();
  }, []);

  const unitPrice = plan
    ? plan.unitPriceLabel
    : formatCreatorPlanUnitPrice({ unitPriceAmount: null });
  const remaining = plan
    ? plan.remainingLabel
    : formatCreatorPlanRemaining({ remainingUnits: null, entitlementStatus: "unpriced", unitPriceAmount: null });

  return <section className={styles.panel} data-testid="account-plan-panel" aria-labelledby="account-plan-title">
    <h1 id="account-plan-title">用量计划</h1>
    <p className={styles.intro}>可配置的用量计划骨架。单价未配置时如实显示尚未计价；本页不收款、不充值、不绑定银行卡。</p>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    <dl className={styles.facts}>
      <div><dt>套餐</dt><dd data-testid="account-plan-name">{plan?.planName ?? "默认用量计划"}</dd></div>
      <div><dt>单价</dt><dd data-testid="account-plan-unit-price">{unitPrice}</dd></div>
      <div><dt>余量</dt><dd data-testid="account-plan-remaining">{remaining}</dd></div>
    </dl>
    <h2>账本</h2>
    {ledger.length === 0
      ? <p className={styles.empty} data-testid="account-ledger-empty">暂无入账记录。未确认的点击不会写入账本。</p>
      : <ul className={styles.ledger} data-testid="account-ledger-list">
        {ledger.map((item) => <li key={item.id}>{item.display}</li>)}
      </ul>}
  </section>;
}
