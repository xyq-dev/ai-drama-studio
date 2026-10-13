"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { DEFAULT_AFTER_LOGIN, readSession, safeReturnTo } from "../lib/site-session";
import styles from "./login-page.module.css";

const REASONS: Record<string, string> = {
  expired: "登录已过期或已退出，请重新登录。登录后会回到刚才的页面。",
  "signed-out": "已退出登录。",
  unavailable: "登录服务暂时无法确认身份，已拒绝访问。请稍后重试，或联系服务器管理员。",
};

const FAILURES: Record<string, string> = {
  AUTH_LOGIN_FAILED: "账号或密码不正确。",
  AUTH_RATE_LIMITED: "登录尝试过于频繁，请一分钟后再试。",
  AUTH_SESSION_LIMIT: "同时登录的会话过多，请稍后再试。",
  AUTH_NOT_CONFIGURED: "登录服务配置不完整，已拒绝访问。请联系服务器管理员。",
  AUTH_ORIGIN_REJECTED: "请从本站地址打开登录页后再试。",
};

/**
 * The one sign-in for the whole site. The password exists only in this form's state and the login request; it is
 * cleared after every attempt and never stored. After signing in the browser returns to the page it came from
 * (a path on this site only), or to 我的作品.
 */
export function LoginPage() {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [returnTo, setReturnTo] = useState(DEFAULT_AFTER_LOGIN);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const target = safeReturnTo(query.get("returnTo"));
    setReturnTo(target);
    setNotice(REASONS[query.get("reason") ?? ""] ?? "");
    // Already signed in (or login switched off): go straight on.
    void readSession().then((session) => {
      if (!session.enabled || session.authenticated) window.location.replace(target);
    }).catch(() => undefined);
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError("");
    const submitted = password;
    setPassword("");
    try {
      const response = await fetch("/api/v1/auth/login", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password: submitted }),
      });
      if (response.ok) {
        window.location.replace(returnTo);
        return;
      }
      let code = "";
      try { code = String(((await response.json()) as { error?: { code?: unknown } }).error?.code ?? ""); } catch { /* not JSON */ }
      setError(FAILURES[code] ?? "暂时无法登录，请稍后再试。");
      setBusy(false);
      passwordRef.current?.focus();
    } catch {
      setError("网络连接异常，没有完成登录。请检查网络后重试。");
      setBusy(false);
    }
  }

  return <div className={styles.page} data-ui="hongguo">
    <main className={styles.main}>
      <div className={styles.brand}><span className={styles.mark} aria-hidden="true"><span /></span><span>红果创作<small>把故事，做成短剧</small></span></div>
      <section className={styles.card} aria-labelledby="login-title">
        <h1 id="login-title">登录红果创作</h1>
        <p className={styles.intro}>登录一次，即可使用创作页面、作品和模型后台。</p>
        {notice ? <div className={styles.notice} role="status">{notice}</div> : null}
        <form onSubmit={(event) => void submit(event)} noValidate>
          <label className={styles.field}>账号
            <input name="username" autoComplete="username" spellCheck={false} value={username} maxLength={64} required
              onChange={(event) => setUsername(event.target.value)} disabled={busy} />
          </label>
          <label className={styles.field}>密码
            <input ref={passwordRef} name="password" type="password" autoComplete="current-password" value={password} maxLength={1024}
              required autoFocus onChange={(event) => setPassword(event.target.value)} disabled={busy} />
          </label>
          {error ? <div className={styles.error} role="alert">{error}</div> : null}
          <button className={styles.primary} type="submit" disabled={busy || !password || !username.trim()}>
            {busy ? "正在登录…" : "登录"}
          </button>
        </form>
        <p className={styles.footnote}>本页不会把密码保存在浏览器存储中。登录状态在一段时间不用后自动结束，退出后需要重新登录。</p>
      </section>
    </main>
  </div>;
}
