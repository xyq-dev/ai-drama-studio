"use client";

import { useEffect, useMemo, useState } from "react";
import type { UsageRecordView, UsageSummaryView } from "@ai-drama/contracts";
import { AdminFrame, AdminGateView, useOperatorGate } from "./admin-access";
import { createFeatureConfigClient, featureErrorCopy } from "../lib/feature-config-client";
import styles from "./feature-config.module.css";

const RESULT_LABEL = { succeeded: "成功", failed: "失败", unknown: "未知" } as const;

function when(value: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "未知";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(time);
}

export function CallRecords() {
  const client = useMemo(() => createFeatureConfigClient(), []);
  const { gate, reload } = useOperatorGate();
  const [summary, setSummary] = useState<UsageSummaryView | null>(null);
  const [projectPick, setProjectPick] = useState<string | null>(null);
  const [episodePick, setEpisodePick] = useState<string | null>(null);
  const [failed, setFailed] = useState("");
  const [detail, setDetail] = useState<UsageRecordView | null>(null);
  const [detailError, setDetailError] = useState("");

  useEffect(() => {
    if (gate !== "ready") return;
    let live = true;
    setFailed("");
    setSummary(null);
    client.usage(projectPick, episodePick)
      .then((next) => { if (live) setSummary(next); })
      .catch((error: unknown) => { if (live) setFailed(featureErrorCopy(error)); });
    return () => { live = false; };
  }, [client, gate, projectPick, episodePick]);

  async function openDetail(record: UsageRecordView) {
    setDetailError("");
    setDetail(record);
    try {
      const next = await client.detail(record.id);
      setDetail(next);
    } catch (error) {
      setDetailError(featureErrorCopy(error));
    }
  }

  if (gate !== "ready" || (failed && !summary) || !summary) {
    const state = gate !== "ready" ? gate : failed ? "failed" : "loading";
    return (
      <AdminFrame>
        <header className={styles.intro}>
          <h1>调用记录</h1>
          <p>按作品和分集核对生产用量。区分成功、失败和供应商未回传的数据。</p>
        </header>
        <AdminGateView gate={state} onRetry={state === "failed" ? reload : undefined} />
      </AdminFrame>
    );
  }

  const shownProject = projectPick ?? summary.projectId ?? "";
  const shownEpisode = episodePick ?? (shownProject === (summary.projectId ?? "") ? summary.episodeId ?? "" : "");
  const episodes = summary.episodes.filter((item) => !shownProject || item.projectId === shownProject);
  return (
    <AdminFrame>
      <header className={styles.intro}>
        <h1>调用记录</h1>
        <p>按作品和分集核对生产用量。区分成功、失败和供应商未回传的数据。</p>
      </header>
      <div className={styles.filters}>
        <label>
          <span>作品</span>
          <select aria-label="作品" value={shownProject} onChange={(event) => { setProjectPick(event.target.value); setEpisodePick(""); }}>
            <option value="">全部作品</option>
            {summary.projects.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>
        <label>
          <span>分集</span>
          <select aria-label="分集" value={shownEpisode} onChange={(event) => setEpisodePick(event.target.value)}>
            <option value="">全部剧集</option>
            {episodes.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>
        <p className={styles.scope}>统计范围：本集生产任务</p>
      </div>
      <section className={styles.totals} aria-label="本集用量">
        {summary.totals.map((item) => (
          <article key={item.feature}>
            <h2>{item.featureLabel}</h2>
            <strong>{item.usageText}</strong>
            <span>{item.costText.startsWith("¥") || item.costText.startsWith("US$") ? `已知费用 ${item.costText}` : item.costText}</span>
          </article>
        ))}
      </section>
      <section className={styles.records} aria-label="本集调用">
        <div className={styles.recordHeadLine}>
          <h2>本集调用</h2>
          <span>最近 {summary.records.length} 条</span>
        </div>
        {summary.records.length === 0 ? <p className={styles.empty}>这一范围内还没有生产调用。用量保持未知，不会显示为 0。</p> : (
          <div className={styles.table}>
            <div className={styles.columns} aria-hidden="true">
              <span>任务</span><span>功能</span><span>服务商</span><span>执行模型</span><span>实际用量</span><span>结果</span>
            </div>
            <ul>
              {summary.records.map((record) => (
                <li key={record.id}>
                  <button type="button" className={styles.record} onClick={() => void openDetail(record)}>
                    <strong>{record.taskId}</strong>
                    <span>{record.featureLabel}</span>
                    <span>{record.vendorLabel}</span>
                    <span>{record.modelLabel}</span>
                    <span>{record.usageText}</span>
                    <span className={record.result === "failed" ? styles.pillFail : record.result === "succeeded" ? styles.pillOk : styles.pillUnknown}>{RESULT_LABEL[record.result]}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
      <p className={styles.footnote}>{summary.footnote}</p>
      {detail ? (
        <div className={styles.modal}>
        <div className={styles.dialog} role="dialog" aria-modal="true" aria-label="任务详情">
          <h2>任务详情</h2>
          <dl className={styles.detail}>
            <div><dt>功能</dt><dd>{detail.featureLabel}</dd></div>
            <div><dt>服务商</dt><dd>{detail.vendorLabel}</dd></div>
            <div><dt>模型</dt><dd>{detail.modelLabel}</dd></div>
            <div><dt>配置版本</dt><dd>{detail.configVersion ?? "未知"}</dd></div>
            <div><dt>结果</dt><dd>{RESULT_LABEL[detail.result]}</dd></div>
            <div><dt>时间</dt><dd>{when(detail.startedAt)}</dd></div>
            <div><dt>用量</dt><dd>{detail.usageText}</dd></div>
            <div><dt>费用</dt><dd>{detail.costText}</dd></div>
            <div><dt>作品</dt><dd>{detail.projectLabel}</dd></div>
            <div><dt>剧集</dt><dd>{detail.episodeLabel}</dd></div>
            <div><dt>任务</dt><dd>{detail.taskId}</dd></div>
          </dl>
          {detailError ? <p className={styles.fail} role="alert">{detailError}</p> : null}
          <div className={styles.dialogActions}>
            <button type="button" className={styles.primary} onClick={() => setDetail(null)}>关闭</button>
          </div>
        </div>
        </div>
      ) : null}
    </AdminFrame>
  );
}
