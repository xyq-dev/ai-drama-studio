"use client";

import { useEffect, useState } from "react";
import { csrfToken, loginUrl, logout, readSession } from "../lib/site-session";
import styles from "./account-control.module.css";

/**
 * The site-wide logout, shown in the shared header and the mobile drawer while a session exists (its readable CSRF
 * cookie is present; the session itself is HttpOnly and checked by the server on every request). Logging out revokes
 * the server session; every protected page and API then needs the login again. Shows nothing without a session, e.g.
 * when the site login is switched off. No session request is made until a CSRF cookie is present (signed-out chrome
 * and offline preview trees stay API-silent).
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
      setMark(session.role === "operator" ? "管" : Array.from(name)[0] || "创");
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
