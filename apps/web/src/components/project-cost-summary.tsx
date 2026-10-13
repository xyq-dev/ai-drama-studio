"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError, StudioClient } from "../lib/studio-client";

interface CostCurrency {
  currency: string;
  actualAmount: string;
  outstandingEstimatedAmount: string;
  actualEntryCount: number;
  outstandingEstimatedEntryCount: number;
}

interface CostSummary {
  schema: string;
  projectId: string;
  snapshotAt: string;
  ledgerRowCount: number;
  currencies: CostCurrency[];
  boundary: {
    localEncodeCostMetered: false;
    totalProductionCostKnown: false;
  };
}

export function ProjectCostSummary(props: { projectId: string; client?: StudioClient }) {
  const fallback = useRef<StudioClient | null>(null);
  if (!fallback.current) fallback.current = new StudioClient();
  const client = props.client ?? fallback.current;
  const session = useRef(0);
  const requestGen = useRef(0);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState<CostSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  useEffect(() => () => {
    session.current += 1;
  }, []);

  useEffect(() => {
    session.current += 1;
    requestGen.current += 1;
    setOpen(false);
    setLoading(false);
    setSummary(null);
    setError(null);
    setRefreshError(null);
  }, [props.projectId]);

  async function load(kind: "open" | "refresh") {
    const token = ++requestGen.current;
    const seen = session.current;
    const projectId = props.projectId;
    setLoading(true);
    if (kind === "open") setError(null);
    try {
      const body = await client.get<CostSummary>(`/projects/${projectId}/cost-summary`);
      if (session.current !== seen || requestGen.current !== token || body.projectId !== projectId) return;
      setSummary(body);
      setError(null);
      setRefreshError(null);
    } catch (caught) {
      if (session.current !== seen || requestGen.current !== token) return;
      const message = caught instanceof ApiError ? caught.detail : "已记录成本暂时无法读取";
      if (summary?.projectId === projectId) setRefreshError(message);
      else setError(message);
    } finally {
      if (session.current === seen && requestGen.current === token) setLoading(false);
    }
  }

  return (
    <section className="creator-cost-summary mt-3 min-w-0 border-t pt-3" aria-label="已记录成本">
      <button
        className="ui-button ui-button-secondary"
        type="button"
        aria-expanded={open}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next && !summary && !loading) void load("open");
        }}
      >
        {open ? "收起已记录成本" : "已记录成本"}
      </button>
      {open ? (
        <div className="mt-3 min-w-0 text-sm">
          {loading ? <p>正在读取已记录成本</p> : null}
          {error ? <p role="alert">{error}</p> : null}
          {summary ? (
            <div className="min-w-0">
              <p>包含本项目历史调用；本地编码等成本尚未计量。</p>
              <p className="break-all text-neutral-600">读取时间 {summary.snapshotAt}</p>
              {refreshError ? <p role="alert">刷新没有完成，以下仍是上次读取的结果。{refreshError}</p> : null}
              {summary.ledgerRowCount === 0 ? <p>没有已记录的账本行。没有记录不等于免费。</p> : null}
              <ul className="mt-2 space-y-2">
                {summary.currencies.map((row) => (
                  <li key={row.currency} className="min-w-0 break-all rounded border p-2">
                    <p>{row.currency}</p>
                    <p>已记录实际金额 {row.actualAmount}</p>
                    <p>未结算估算 {row.outstandingEstimatedAmount}</p>
                    <p className="text-neutral-600">实际 {row.actualEntryCount} 笔 · 未结算估算 {row.outstandingEstimatedEntryCount} 笔</p>
                  </li>
                ))}
              </ul>
              <button className="ui-button ui-button-secondary mt-2" type="button" onClick={() => void load("refresh")}>刷新已记录成本</button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
