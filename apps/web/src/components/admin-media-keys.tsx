"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  adminMediaKeyUpdateSchema,
  type AdminMediaKeySlotView,
  type AdminMediaKeysView,
  type MediaKeySlot,
} from "@ai-drama/contracts";
import { AdminApiError, createAdminMediaKeysClient } from "../lib/admin-media-keys-client";
import { goToLogin, loginUrl, readSession, type SiteSession } from "../lib/site-session";
import styles from "./admin-models.module.css";

type AuthState = "checking" | "guest" | "unavailable" | "signedin";
type Mode = "view" | "replace" | "clear";

const VENDORS: Array<{ slot: MediaKeySlot; title: string; vendor: string }> = [
  { slot: "MINIMAX_API_KEY", title: "角色配音", vendor: "MiniMax" },
  { slot: "OPENAI_MEDIA_API_KEY", title: "图像生成", vendor: "OpenAI" },
  { slot: "DASHSCOPE_MEDIA_API_KEY", title: "百炼媒体", vendor: "DashScope" },
];

/** Status copy derived from the server slot view — never hardcoded Figma preview sentences. */
export function mediaKeyStatus(slot: AdminMediaKeySlotView | undefined): {
  title: string;
  detail: string;
  tone: "neutral" | "success" | "warning" | "danger";
} {
  if (!slot || slot.serviceState === "unconfigured") {
    return {
      title: "尚未配置密钥",
      detail: "填写并保存服务密钥后，才能用于对应能力。保存不会调用真实供应商。",
      tone: "neutral",
    };
  }
  if (slot.status === "pending_restart" || slot.serviceState === "saved_not_ready") {
    const gaps: string[] = [];
    if (!slot.priceConfigured) gaps.push("单价尚未配置");
    if (slot.status === "pending_restart") gaps.push("进程尚未加载新密钥");
    if (gaps.length === 0) gaps.push("服务尚未就绪");
    return {
      title: "配置还不完整",
      detail: `密钥已保存。${gaps.join("；")}。未知项标记为待核验，不会伪报可用。`,
      tone: "warning",
    };
  }
  if (slot.serviceState === "single_failure") {
    return {
      title: "服务可用，最近有一次失败",
      detail: "密钥与单价已就绪；单次生成失败可重试，不代表整项服务不可用。",
      tone: "warning",
    };
  }
  if (slot.serviceState === "ready") {
    return {
      title: "可以用于当前用途",
      detail: "密钥已保存，服务检查通过。这不代表已发起付费生成。",
      tone: "success",
    };
  }
  return {
    title: "状态待核验",
    detail: "服务端未返回完整就绪信息，请重新读取后再判断。",
    tone: "neutral",
  };
}

function messageFor(error: unknown): string {
  if (!(error instanceof AdminApiError)) return "暂时无法完成请求，请重新读取配置后再试。";
  if (error.status === 409) {
    return error.code === "ADMIN_CONFIG_BUSY"
      ? "配置正在被其他操作更新，请稍后重新读取。本次没有自动重试保存。"
      : "配置已被其他管理员修改。本页草稿已保留，请重新读取最新配置后再编辑。";
  }
  if (error.status === 503) return "媒体密钥存储暂不可用，请联系服务器管理员检查初始化与存储状态。";
  if (error.status === 400) return "密钥格式不正确：长度 8–512，且不能包含空格或换行。没有保存任何内容。";
  if (error.status === 403) return "本次操作未获授权，请退出后重新验证管理员身份。";
  if (error.status === 401) return "管理员会话已过期，请重新登录。";
  return "网络连接或回执异常，操作结果尚未确认。请重新读取配置，不要直接重复提交。";
}

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <rect x="5" y="10" width="14" height="11" rx="3" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" />
    </svg>
  );
}

function StatusBanner({ title, detail, tone }: { title: string; detail: string; tone: "neutral" | "success" | "warning" | "danger" }) {
  const className = tone === "success" ? styles.statusSuccess
    : tone === "warning" ? styles.statusWarning
      : tone === "danger" ? styles.statusDanger
        : styles.statusNeutral;
  const mark = tone === "success" ? "✓" : "!";
  return (
    <div className={className} role="status" data-testid="media-key-status">
      <span className={styles.statusIcon} aria-hidden="true">{mark}</span>
      <div>
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
    </div>
  );
}

export function AdminMediaKeys() {
  const client = useMemo(() => createAdminMediaKeysClient(), []);
  const [auth, setAuth] = useState<AuthState>("checking");
  const [session, setSession] = useState<SiteSession | null>(null);
  const [loginError, setLoginError] = useState("");
  const [view, setView] = useState<AdminMediaKeysView | null>(null);
  const [selected, setSelected] = useState<MediaKeySlot>("MINIMAX_API_KEY");
  const [mode, setMode] = useState<Mode>("view");
  const [apiKey, setApiKey] = useState("");
  const [clearConfirmed, setClearConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mustReload, setMustReload] = useState(false);
  const [busy, setBusy] = useState("");
  const busyRef = useRef("");
  const generation = useRef(0);

  function begin(kind: string): number | null {
    if (busyRef.current) return null;
    busyRef.current = kind;
    setBusy(kind);
    return generation.current;
  }
  function finish(epoch: number) {
    if (epoch !== generation.current) return;
    busyRef.current = "";
    setBusy("");
  }
  function forgetSecrets() {
    setApiKey("");
    setMode("view");
    setClearConfirmed(false);
  }
  function endSession(message: string) {
    generation.current += 1;
    busyRef.current = "";
    setBusy("");
    setSession(null);
    setView(null);
    setAuth("guest");
    forgetSecrets();
    setError("");
    setNotice("");
    setLoginError(message);
    setMustReload(false);
  }
  function installView(next: AdminMediaKeysView) {
    setView(next);
    setMustReload(false);
    forgetSecrets();
  }
  function acceptSession(next: SiteSession): boolean {
    if (!next.enabled) {
      setAuth("unavailable");
      setLoginError("站点统一登录尚未启用，媒体密钥后台保持关闭。请联系服务器管理员。");
      return false;
    }
    if (!next.authenticated || !next.expiresAt || !Number.isFinite(Date.parse(next.expiresAt))) {
      setAuth("guest");
      goToLogin("expired");
      return false;
    }
    if (next.role === "creator") {
      setAuth("unavailable");
      setLoginError("当前账号不是管理员，不能查看或填写站点级媒体密钥。");
      return false;
    }
    setSession(next);
    setAuth("signedin");
    setLoginError("");
    return true;
  }

  async function checkSession() {
    const epoch = begin("session");
    if (epoch === null) return;
    setAuth("checking");
    setLoginError("");
    try {
      const next = await readSession();
      if (epoch !== generation.current || !acceptSession(next)) return;
      const loaded = await client.view();
      if (epoch === generation.current) installView(loaded);
    } catch (caught) {
      if (epoch !== generation.current) return;
      if (caught instanceof AdminApiError && caught.status === 401) endSession("");
      else if (caught instanceof AdminApiError && caught.status === 503) {
        setAuth("unavailable");
        setLoginError("管理员后台尚未就绪，请联系服务器管理员完成认证与安全存储初始化。");
      } else {
        setAuth("unavailable");
        setLoginError("暂时无法确认登录状态，请重试。");
        setSession(null);
      }
    } finally {
      finish(epoch);
    }
  }

  useEffect(() => {
    void checkSession();
    return () => {
      generation.current += 1;
      busyRef.current = "";
    };
  }, []);

  async function reload() {
    if (!session || busyRef.current) return;
    const epoch = begin("reload");
    if (epoch === null) return;
    setError("");
    setNotice("");
    try {
      const next = await client.view();
      if (epoch !== generation.current) return;
      installView(next);
      setNotice("已重新读取当前配置");
    } catch (caught) {
      if (epoch !== generation.current) return;
      if (caught instanceof AdminApiError && caught.status === 401) endSession("管理员会话已过期，请重新验证。");
      else setError(messageFor(caught));
    } finally {
      finish(epoch);
    }
  }

  async function submit(secretAction: "replace" | "clear") {
    if (!session || !view || busyRef.current || mustReload) return;
    if (secretAction === "clear" && !clearConfirmed) {
      setError("清除密钥前请勾选确认。");
      return;
    }
    const parsed = adminMediaKeyUpdateSchema.safeParse({
      expectedRevision: view.savedRevision,
      slot: selected,
      secretAction,
      ...(secretAction === "replace" ? { apiKey } : {}),
    });
    if (!parsed.success) {
      setError("密钥格式不正确：长度 8–512，且不能包含空格或换行。没有保存任何内容。");
      return;
    }
    const epoch = begin("save");
    if (epoch === null) return;
    setError("");
    setNotice("");
    try {
      const next = await client.update(parsed.data);
      if (epoch !== generation.current) return;
      installView(next);
      setNotice(secretAction === "clear" ? "设置已保存" : "设置已保存");
    } catch (caught) {
      if (epoch !== generation.current) return;
      forgetSecrets();
      if (caught instanceof AdminApiError && caught.status === 401) endSession("管理员会话已过期，请重新验证。");
      else {
        setError(messageFor(caught));
        if (caught instanceof AdminApiError && (caught.status === 409 || caught.status === 0)) setMustReload(true);
      }
    } finally {
      finish(epoch);
    }
  }

  function changeVendor(slot: MediaKeySlot) {
    if (busyRef.current) return;
    setSelected(slot);
    forgetSecrets();
    setError("");
    setNotice("");
  }

  const canEdit = auth === "signedin" && !!view && !mustReload && !busy;
  const current = view?.slots.find((item) => item.slot === selected);
  const meta = VENDORS.find((item) => item.slot === selected)!;
  const status = mediaKeyStatus(current);

  return (
    <div className={styles.app} data-embedded-admin="media-keys">
      <a href="#admin-media-content" className={styles.skip}>跳到正文</a>
      <main id="admin-media-content" className={styles.main}>
        {auth !== "signedin" ? (
          <div className={styles.loginLayout}>
            <section className={styles.loginIntro}>
              <span className={styles.eyebrow}>红果 · 创作基础设施</span>
              <h1>媒体密钥，<br />放进网页设置。</h1>
              <p>管理员可在此填写正式出图、配音与视频密钥。普通创作者看不到这些站点级密钥。</p>
            </section>
            <section className={styles.loginCard} aria-label="管理员登录">
              <div className={styles.lock}><LockIcon /></div>
              <span className={styles.eyebrow}>受保护的管理入口</span>
              <h2>管理员登录</h2>
              <p>与模型后台、站点登录使用同一套账号，不另做口令。</p>
              {auth === "checking" ? (
                <p role="status" className={styles.loading}>正在检查登录状态…</p>
              ) : auth === "unavailable" ? (
                <>
                  <div className={styles.warning} role="alert">{loginError || "管理员后台尚未就绪。"}</div>
                  <button className={styles.secondary} disabled={!!busy} onClick={() => void checkSession()}>重新检查后台状态</button>
                </>
              ) : (
                <>
                  <p className={styles.footnote}>{loginError || "请先登录。登录后会回到媒体密钥页。"}</p>
                  <a className={styles.primary} href={loginUrl("/admin/media-keys")}>
                    前往登录<span aria-hidden="true">→</span>
                  </a>
                </>
              )}
            </section>
          </div>
        ) : (
          <>
            <div className={styles.pageIntro}>
              <h1>媒体密钥</h1>
              <p>选择用途，查看或更换服务密钥。</p>
            </div>
            {error ? <div className={styles.error} role="alert">{error}</div> : null}
            {notice ? <div className={styles.success} role="status">{notice}</div> : null}
            {mustReload ? (
              <div className={styles.warning} role="status">
                <strong>请重新读取最新配置</strong>
                <p>本页草稿已保留。版本冲突后不会自动重试保存。</p>
              </div>
            ) : null}
            {!view ? (
              <section className={styles.card}>
                <p>{busy ? "正在读取媒体密钥状态…" : "媒体密钥尚未读取。"}</p>
                <button className={styles.secondary} onClick={() => void reload()} disabled={!!busy}>重新读取</button>
              </section>
            ) : (
              <>
                <div className={styles.providerTabs} role="tablist" aria-label="媒体服务">
                  {VENDORS.map((vendor) => (
                    <button
                      key={vendor.slot}
                      type="button"
                      role="tab"
                      aria-selected={selected === vendor.slot}
                      className={`${styles.providerTab} ${selected === vendor.slot ? styles.providerTabSelected : ""}`}
                      disabled={!!busy}
                      data-testid={`media-key-slot-${vendor.slot}`}
                      onClick={() => changeVendor(vendor.slot)}
                    >
                      <strong>{vendor.title}</strong>
                      <span>{vendor.vendor}</span>
                    </button>
                  ))}
                </div>

                <section className={styles.settingsCard} aria-label={`${meta.vendor}服务密钥`} data-testid="media-key-editor">
                  {mode === "clear" ? (
                    <>
                      <StatusBanner
                        title="清除后，这项服务会停用"
                        detail="确认清除前，你可以随时取消。"
                        tone="danger"
                      />
                      <h2>清除 {meta.vendor} 密钥</h2>
                      <p className={styles.footnote}>此操作只清除当前服务的密钥，其他供应商不受影响。</p>
                      <label className={styles.confirm}>
                        <input
                          type="checkbox"
                          checked={clearConfirmed}
                          onChange={(event) => setClearConfirmed(event.target.checked)}
                        />
                        我确认清除这项服务的密钥
                      </label>
                      <div className={styles.actions}>
                        <button
                          type="button"
                          className={styles.danger}
                          disabled={!canEdit || !clearConfirmed}
                          onClick={() => void submit("clear")}
                        >
                          {busy === "save" ? "正在清除…" : "确认清除"}
                        </button>
                        <button
                          type="button"
                          className={styles.secondary}
                          disabled={!!busy}
                          onClick={() => { setMode("view"); setClearConfirmed(false); setError(""); }}
                        >
                          取消
                        </button>
                      </div>
                    </>
                  ) : mode === "replace" ? (
                    <>
                      <StatusBanner title={status.title} detail={status.detail} tone={status.tone === "danger" ? "warning" : status.tone} />
                      <h2>{meta.vendor} 服务密钥</h2>
                      <p className={styles.footnote}>填写新密钥以替换。保存只做本地校验，不会调用真实供应商。</p>
                      <form onSubmit={(event: FormEvent) => { event.preventDefault(); void submit("replace"); }}>
                        <fieldset className={styles.fieldset} disabled={!canEdit}>
                          <label className={styles.field}>
                            服务密钥
                            <input
                              name="media-api-key"
                              type="password"
                              autoComplete="off"
                              spellCheck={false}
                              value={apiKey}
                              onChange={(event) => setApiKey(event.target.value)}
                              maxLength={512}
                              placeholder="仅本次提交使用，保存后不会显示"
                              data-testid="media-key-input"
                            />
                          </label>
                          <div className={styles.checks} data-testid="media-key-checks">
                            <span>密钥：{current?.keyConfigured ? "已保存（掩码）" : "未填写"}</span>
                            <span>单价：{current?.priceConfigured ? "已配置" : "待核验 / 未配置"}</span>
                            <span>服务：{current?.serviceState === "ready" || current?.serviceState === "single_failure" ? "可用" : current?.serviceState === "saved_not_ready" ? "未就绪" : "待核验"}</span>
                          </div>
                          <div className={styles.actions}>
                            <button className={styles.primary} type="submit" disabled={!canEdit || !apiKey.trim()}>
                              {busy === "save" ? "正在保存…" : "保存密钥"}
                            </button>
                            <button
                              type="button"
                              className={styles.textButton}
                              disabled={!!busy}
                              onClick={() => { setMode("view"); setApiKey(""); }}
                            >
                              取消
                            </button>
                          </div>
                        </fieldset>
                      </form>
                    </>
                  ) : (
                    <>
                      <StatusBanner title={status.title} detail={status.detail} tone={status.tone === "danger" ? "warning" : status.tone} />
                      <h2>{meta.vendor} 服务密钥</h2>
                      <p className={styles.footnote}>已保存的密钥仅显示为圆点。</p>
                      <div className={styles.maskedKey} aria-label={current?.keyConfigured ? "已保存的密钥（掩码）" : "尚未保存密钥"}>
                        {current?.keyConfigured ? "••••  ••••  ••••  ••••" : "尚未填写"}
                      </div>
                      <div className={styles.checks} data-testid="media-key-checks">
                        <span>密钥：{current?.keyConfigured ? "已保存" : "未填写"}</span>
                        <span>单价：{current?.priceConfigured ? "已配置" : "待核验 / 未配置"}</span>
                        <span>服务：{current?.serviceState === "ready" || current?.serviceState === "single_failure" ? "可用" : current?.serviceState === "saved_not_ready" ? "未就绪" : "待核验"}</span>
                      </div>
                      <div className={styles.actions}>
                        <button
                          type="button"
                          className={styles.primary}
                          disabled={!canEdit}
                          onClick={() => { setMode("replace"); setApiKey(""); setError(""); }}
                        >
                          {current?.keyConfigured ? "更换密钥" : "填写密钥"}
                        </button>
                        <button type="button" className={styles.textButton} onClick={() => void reload()} disabled={!!busy}>
                          {busy === "reload" ? "正在读取…" : "重新读取"}
                        </button>
                        {current?.keyConfigured ? (
                          <button
                            type="button"
                            className={styles.dangerText}
                            disabled={!canEdit}
                            onClick={() => { setMode("clear"); setClearConfirmed(false); setError(""); }}
                          >
                            清除密钥
                          </button>
                        ) : null}
                      </div>
                    </>
                  )}
                </section>
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}
