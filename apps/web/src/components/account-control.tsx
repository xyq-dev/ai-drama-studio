"use client";

import { useEffect, useState } from "react";
import { csrfToken, loginUrl, logout, readSession } from "../lib/site-session";
import styles from "./account-control.module.css";

/**
 * Site-wide account chrome for the creator shell.
 * Admin is a separate /admin entry — no 「进入管理控制台」 link here. Creators must not see a 「管」 badge.
 */
export function AccountControl({ variant }: { variant: "header" | "drawer" }) {
  const [signedIn, setSignedIn] = useState(false);
  const [label, setLabel] = useState("账号");
  const [mark, setMark] = useState("创");
  const [state, setState] = useState<"idle" | "busy" | "failed">("idle");

  useEffect(() => {
    const present = csrfToken() !== null;
    setSignedIn(present);
    // Only enrich the signed-in label when a session cookie exists; signed-out mounts must not hit /auth/session.
    if (!present) return;
    void readSession(globalThis.fetch.bind(globalThis), { passive: true }).then((session) => {
      if (!session.authenticated) return;
      const name = session.username?.trim() || (session.role === "operator" ? "管理员" : "创作者");
      setLabel(name);
      // Creators never show a 「管」 badge. Operators use the username initial in the creator shell.
      setMark(Array.from(name)[0] || (session.role === "operator" ? "管" : "创"));
    }).catch(() => undefined);
  }, []);

  if (!signedIn) return null;

  async function signOut() {
    if (state === "busy") return;
    setState("busy");
    try {
      await logout();
      window.location.assign(loginUrl(`${window.location.pathname}${window.location.search}`, "signed-out"));
    } catch {
      setState("failed");
    }
  }

  return <div className={`${styles.account} ${variant === "drawer" ? styles.drawer : ""}`}>
    <span className={styles.user}><span className={styles.avatar} aria-hidden="true">{mark}</span>{label}</span>
    <a className={styles.logout} href="/account" style={{ textDecoration: "none" }}>用量计划</a>
    <button type="button" className={styles.logout} onClick={() => void signOut()} disabled={state === "busy"}>
      {state === "busy" ? "正在退出…" : "退出登录"}
    </button>
    {state === "failed" ? <span className={styles.error} role="alert">退出尚未确认，请重试。</span> : null}
  </div>;
}
