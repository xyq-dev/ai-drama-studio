"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useOperatorGate } from "./admin-access";
import styles from "./admin-directory.module.css";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface WorkDetail {
  id: string;
  title: string;
  updatedAt: string;
  ownerName: string;
  ownerLegacy: boolean;
  productionLabel: string;
  episodeProgress: string;
  recentTask: string;
}

/**
 * Read-only operator review. No save, generate, publish, or creator-studio link.
 */
export function AdminWorkReview({ id, fetchImpl }: { id: string; fetchImpl?: FetchLike }) {
  const fetchRef = useRef(fetchImpl);
  fetchRef.current = fetchImpl;
  const impl = useCallback((input: string, init?: RequestInit) => {
    const next = fetchRef.current ?? globalThis.fetch.bind(globalThis);
    return next(input, init);
  }, []);
  const { gate, reload } = useOperatorGate(impl);
  const [work, setWork] = useState<WorkDetail | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (gate !== "ready") return;
    let live = true;
    setFailed(false);
    impl(`/api/v1/admin/works/${id}`, { headers: { Accept: "application/json" }, credentials: "same-origin", cache: "no-store" })
      .then(async (response) => {
        if (!live) return;
        if (!response.ok) {
          setFailed(true);
          return;
        }
        setWork(await response.json() as WorkDetail);
      })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [gate, id, impl]);

  return (
    <div className={styles.page} data-page="work-review">
      <header className={styles.intro}>
        <div>
          <h1>作品核对</h1>
          <p>打开后仅供运营核对制作进度与产出，不会发布到抖音或红果平台，也不会进入创作者工作台编辑。</p>
        </div>
      </header>
      {gate === "forbidden" ? (
        <section className={styles.state} data-state="forbidden">
          <h2>没有作品管理权限</h2>
          <p>作品总览仅平台管理员可查看。普通创作者请返回创作工作台，只能看到自己的作品。</p>
          <a className={styles.primary} href="/studio">返回创作中心</a>
        </section>
      ) : null}
      {gate === "loading" || (gate === "ready" && !work && !failed) ? (
        <section className={styles.state} data-state="loading">
          <h2>正在加载作品</h2>
          <p>正在读取制作进度与产出，请稍候。本次不会改动任何作品。</p>
        </section>
      ) : null}
      {gate === "ready" && failed ? (
        <section className={styles.state} data-state="failed">
          <h2>作品加载失败</h2>
          <p>暂时无法读取这部作品，请重试。本次不会改动任何作品。</p>
          <button type="button" className={styles.primary} onClick={reload}>重新加载</button>
        </section>
      ) : null}
      {work ? (
        <section className={styles.panel}>
          <div className={styles.panelHead}>
            <h2>{work.title}</h2>
            <span>{work.productionLabel}</span>
          </div>
          <dl className={styles.meta}>
            <div><dt>所属创作者</dt><dd>{work.ownerLegacy ? "历史作品" : work.ownerName}</dd></div>
            <div><dt>更新时间</dt><dd>{work.updatedAt}</dd></div>
            <div><dt>分集进度</dt><dd>{work.episodeProgress}</dd></div>
            <div><dt>最近任务</dt><dd>{work.recentTask}</dd></div>
          </dl>
          <p className={styles.footnote}>这里只展示进度和产出。没有发布、删除、保存或生成入口。</p>
          <div className={styles.drawerActions}>
            <a className={styles.secondary} href="/admin/works">返回作品列表</a>
          </div>
        </section>
      ) : null}
    </div>
  );
}
