"use client";

import { useState, type FormEvent } from "react";
import styles from "./login-page.module.css";

export function ActivatePage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    const token = new URLSearchParams(window.location.search).get("token") ?? "";
    const response = await fetch("/api/v1/auth/invites/accept", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ token, password }),
    });
    const body = await response.json().catch(() => ({})) as { error?: { message?: string } };
    if (!response.ok) {
      setError(body.error?.message ?? "邀请没有完成。");
      return;
    }
    setDone(true);
    setPassword("");
  }
  return <main className={styles.page}>
    <section className={styles.card} aria-labelledby="activate-title">
      <h1 id="activate-title">设置管理员密码</h1>
      <p>邀请链接只能使用一次，并在 24 小时后失效。设置密码后即可登录。</p>
      {done ? <p role="status">密码已设置。请使用新密码登录。</p> : <form onSubmit={(event) => void submit(event)}>
        <label className={styles.field}>密码
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" minLength={8} required />
        </label>
        {error ? <p role="alert">{error}</p> : null}
        <button className={styles.primary} type="submit">设置密码并激活</button>
      </form>}
      <a href="/login">前往登录</a>
    </section>
  </main>;
}
