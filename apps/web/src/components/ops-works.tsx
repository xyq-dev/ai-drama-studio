"use client";

import { useEffect, useState } from "react";
import { withSession } from "../lib/site-session";
import styles from "./my-works.module.css";

interface OpsItem { id: string; title: string; premise: string }

/**
 * Explicit operator ops view of every work in the product workspace.
 * Never mixed into a normal creator 「我的作品」 list (which uses /library/projects without view=ops).
 */
export function OpsWorks() {
  const [items, setItems] = useState<OpsItem[] | null>(null);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchImpl = withSession(globalThis.fetch.bind(globalThis));
    void (async () => {
      try {
        const access = await fetchImpl("/api/v1/account/ops-access", { credentials: "same-origin", cache: "no-store" });
        if (!access.ok) {
          setDenied(true);
          return;
        }
        const body = await access.json() as { opsViewAvailable?: boolean };
        if (body.opsViewAvailable !== true) {
          setDenied(true);
          return;
        }
        const list = await fetchImpl("/api/v1/library/projects?view=ops", { credentials: "same-origin", cache: "no-store" });
        if (!list.ok) {
          setError("暂时无法读取运维作品列表。");
          return;
        }
        const page = await list.json() as { items: OpsItem[] };
        setItems(page.items ?? []);
      } catch {
        setError("网络异常。");
      }
    })();
  }, []);

  if (denied) {
    return <main className={styles.page}><p data-testid="ops-works-denied">运维作品视图仅对 operator 开放。</p></main>;
  }

  return <main className={styles.page} data-testid="ops-works">
    <h1>运维作品视图</h1>
    <p>这是明确的运维入口，不是创作者的「我的作品」。创作者账号在此看不到他人作品。</p>
    {error ? <p role="alert">{error}</p> : null}
    {items === null && !error ? <p>加载中…</p> : null}
    {items ? <ul>{items.map((item) => <li key={item.id}><a href={`/projects/${item.id}`}>{item.title}</a></li>)}</ul> : null}
  </main>;
}
