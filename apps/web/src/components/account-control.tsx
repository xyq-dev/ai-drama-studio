"use client";

import { useEffect, useState } from "react";
import { csrfToken, loginUrl, logout } from "../lib/site-session";
import styles from "./account-control.module.css";

/**
 * The site-wide logout, shown in the shared header and the mobile drawer while a session exists (its readable CSRF
 * cookie is present; the session itself is HttpOnly and checked by the server on every request). Logging out revokes
 * the server session; every protected page and API then needs the login again. Shows nothing without a session, e.g.
 * when the site login is switched off. No extra request is made to render it.
 */
export function AccountControl({ variant }: { variant: "header" | "drawer" }) {
  const [signedIn, setSignedIn] = useState(false);
  const [state, setState] = useState<"idle" | "busy" | "failed">("idle");

  useEffect(() => { setSignedIn(csrfToken() !== null); }, []);

  if (!signedIn) return null;
  const username = "管理员";

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
    <span className={styles.user}><span className={styles.avatar} aria-hidden="true">管</span>{username}</span>
    <button type="button" className={styles.logout} onClick={() => void signOut()} disabled={state === "busy"}>
      {state === "busy" ? "正在退出…" : "退出登录"}
    </button>
    {state === "failed" ? <span className={styles.error} role="alert">退出尚未确认，请重试。</span> : null}
  </div>;
}
