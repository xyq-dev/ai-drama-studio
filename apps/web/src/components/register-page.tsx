"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { DEFAULT_AFTER_LOGIN, readSession, safeReturnTo } from "../lib/site-session";
import styles from "./login-page.module.css";

/**
 * Public creator registration page. The server flag defaults OFF; when disabled this page explains that
 * self-service registration is closed. CI uses fixture accounts only.
 */
export function RegisterPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [returnTo, setReturnTo] = useState(DEFAULT_AFTER_LOGIN);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    setReturnTo(safeReturnTo(query.get("returnTo")));
    void readSession().then((session) => {
      if (session.authenticated) {
        window.location.replace(safeReturnTo(query.get("returnTo")));
        return;
      }
      setEnabled(session.publicRegistrationEnabled === true);
    }).catch(() => setEnabled(false));
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !password || enabled !== true) return;
    setBusy(true);
    setError("");
    const submitted = password;
    setPassword("");
    try {
      const response = await fetch("/api/v1/auth/register", {
        method: "POST", credentials: "same-origin", cache: "no-store",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password: submitted }),
      });
      if (response.ok) {
        const login = await fetch("/api/v1/auth/login", {
          method: "POST", credentials: "same-origin", cache: "no-store",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ username: username.trim(), password: submitted }),
        });
        if (login.ok) {
          window.location.replace(returnTo);
          return;
        }
        window.location.replace(`/login?returnTo=${encodeURIComponent(returnTo)}`);
        return;
      }
      let code = "";
      try { code = String(((await response.json()) as { error?: { code?: unknown } }).error?.code ?? ""); } catch { /* ignore */ }
      setError(code === "AUTH_REGISTRATION_DISABLED" ? "公开自助注册未开启。" : "暂时无法注册，请稍后再试。");
      setBusy(false);
      passwordRef.current?.focus();
    } catch {
      setError("网络连接异常，没有完成注册。");
      setBusy(false);
    }
  }

  return <div className={styles.page} data-ui="hongguo">
    <main className={styles.main}>
      <div className={styles.brand}><span className={styles.mark} aria-hidden="true"><span /></span><span>红果创作<small>把故事，做成短剧</small></span></div>
      <section className={styles.card} aria-labelledby="register-title">
        <h1 id="register-title">创建创作者账号</h1>
        {enabled === false ? <p className={styles.intro} data-testid="register-closed">公开自助注册未开启。请使用已有账号登录，或联系管理员开通账号。</p> : null}
        {enabled === true ? <>
          <p className={styles.intro}>注册后只能看到并操作自己创建的作品。本站不开放支付或充值。</p>
          <form onSubmit={(event) => void submit(event)} noValidate>
            <label className={styles.field}>账号
              <input name="username" autoComplete="username" spellCheck={false} value={username} maxLength={64} required
                onChange={(event) => setUsername(event.target.value)} disabled={busy} />
            </label>
            <label className={styles.field}>密码
              <input ref={passwordRef} name="password" type="password" autoComplete="new-password" value={password} maxLength={1024}
                required minLength={8} onChange={(event) => setPassword(event.target.value)} disabled={busy} />
            </label>
            {error ? <div className={styles.error} role="alert">{error}</div> : null}
            <button className={styles.primary} type="submit" disabled={busy || !password || !username.trim()}>
              {busy ? "正在注册…" : "注册"}
            </button>
          </form>
        </> : null}
        <p className={styles.footnote}><a href="/login">返回登录</a></p>
      </section>
    </main>
  </div>;
}
