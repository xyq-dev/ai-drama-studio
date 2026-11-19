"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  MEDIA_KEY_SLOTS,
  adminMediaKeyUpdateSchema,
  type AdminMediaKeySlotView,
  type AdminMediaKeysView,
  type MediaKeySlot,
} from "@ai-drama/contracts";
import { AdminApiError, createAdminMediaKeysClient } from "../lib/admin-media-keys-client";
import { goToLogin, loginUrl, logout as siteLogout, readSession, type SiteSession } from "../lib/site-session";
import styles from "./admin-models.module.css";

type AuthState = "checking" | "guest" | "unavailable" | "signedin";
type SecretAction = "keep" | "replace" | "clear";

const STATUS_LABEL: Record<AdminMediaKeySlotView["status"], string> = {
  saved: "已保存",
  empty: "未填写",
  pending_restart: "等待重启",
};

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

function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "success" | "warning" }) {
  return <span className={`${styles.badge} ${styles[tone]}`}>{children}</span>;
}
function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <rect x="5" y="10" width="14" height="11" rx="3" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" />
    </svg>
  );
}

export function AdminMediaKeys() {
  const client = useMemo(() => createAdminMediaKeysClient(), []);
  const [auth, setAuth] = useState<AuthState>("checking");
  const [session, setSession] = useState<SiteSession | null>(null);
  const [loginError, setLoginError] = useState("");
  const [view, setView] = useState<AdminMediaKeysView | null>(null);
  const [selected, setSelected] = useState<MediaKeySlot>("DASHSCOPE_MEDIA_API_KEY");
  const [secretAction, setSecretAction] = useState<SecretAction>("keep");
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
    setSecretAction("keep");
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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only session bootstrap
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
      setNotice("已重新读取媒体密钥状态（不含完整密钥）。");
    } catch (caught) {
      if (epoch !== generation.current) return;
      if (caught instanceof AdminApiError && caught.status === 401) endSession("管理员会话已过期，请重新验证。");
      else setError(messageFor(caught));
    } finally {
      finish(epoch);
    }
  }

  async function logout() {
    const epoch = begin("logout");
    if (epoch === null) return;
    try {
      await siteLogout();
    } finally {
      if (epoch === generation.current) {
        endSession("已退出登录。");
        window.location.assign(loginUrl("/admin/media-keys", "signed-out"));
      }
    }
  }

  async function saveSlot(event: FormEvent) {
    event.preventDefault();
    if (!session || !view || busyRef.current || mustReload) return;
    if (secretAction === "clear" && !clearConfirmed) {
      setError("清除密钥前请勾选确认。清除后不会回退到服务器环境变量里的旧值。");
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
      const slot = next.slots.find((item) => item.slot === selected);
      const status = slot ? STATUS_LABEL[slot.status] : "已更新";
      setNotice(
        next.pendingRestart
          ? `已保存（${status}）。当前 API 进程尚未加载新密钥，页面如实显示「等待重启」；重启只是加载配置，不是一次代码部署。`
          : `已保存（${status}）。探测与新的出图 / 配音 / 成片调用会按各槽位使用后台密钥；单价仍可尚未计价，也不会自动发起付费生成。`,
      );
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

  const canEdit = auth === "signedin" && !!view && !mustReload && !busy;
  const current = view?.slots.find((item) => item.slot === selected);

  return (
    <div className={styles.app}>
      <a href="#admin-media-content" className={styles.skip}>
        跳到正文
      </a>
      <header className={styles.header}>
        <Link className={styles.brand} href="/studio">
          <span className={styles.brandMark} aria-hidden="true">
            红
          </span>
          <span>
            红果创作<span className={styles.brandSub}>管理员控制台</span>
          </span>
        </Link>
        <div className={styles.headerActions}>
          <Link href="/admin/models" className={styles.backLink}>
            写作模型配置 <span aria-hidden="true">↗</span>
          </Link>
          <Link href="/studio" className={styles.backLink}>
            返回创作中心 <span aria-hidden="true">↗</span>
          </Link>
          {auth === "signedin" && (
            <button type="button" className={styles.secondary} onClick={() => void logout()} disabled={!!busy}>
              {busy === "logout" ? "正在退出…" : "退出"}
            </button>
          )}
        </div>
      </header>
      <main id="admin-media-content" className={styles.main}>
        {auth !== "signedin" ? (
          <div className={styles.loginLayout}>
            <section className={styles.loginIntro}>
              <span className={styles.eyebrow}>红果 · 创作基础设施</span>
              <h1>
                媒体密钥，
                <br />
                放进网页设置。
              </h1>
              <p>管理员可在此填写正式出图、配音与视频密钥，不必再为填 key 走 Hermes 改服务器 .env。普通创作者看不到这些站点级密钥。</p>
            </section>
            <section className={styles.loginCard} aria-label="管理员登录">
              <div className={styles.lock}>
                <LockIcon />
              </div>
              <span className={styles.eyebrow}>受保护的管理入口</span>
              <h2>管理员登录</h2>
              <p>与模型后台、站点登录使用同一套 SITE_AUTH / operator 账号，不另做口令。</p>
              {auth === "checking" ? (
                <p role="status" className={styles.loading}>
                  正在检查登录状态…
                </p>
              ) : auth === "unavailable" ? (
                <>
                  <div className={styles.warning} role="alert">
                    {loginError || "管理员后台尚未就绪。"}
                  </div>
                  <button className={styles.secondary} disabled={!!busy} onClick={() => void checkSession()}>
                    重新检查后台状态
                  </button>
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
            <div className={styles.pageHeading}>
              <div>
                <span className={styles.eyebrow}>管理控制台 / 媒体密钥</span>
                <h1>
                  媒体密钥<span className={styles.headingDot} />
                </h1>
                <p>三个独立槽位，均可留空。OpenAI 生图可一直不填。</p>
              </div>
              <Badge>
                <LockIcon /> 管理员会话有效
              </Badge>
            </div>
            {error && (
              <div className={styles.error} role="alert">
                {error}
              </div>
            )}
            {notice && (
              <div className={styles.success} role="status">
                {notice}
              </div>
            )}
            {!view ? (
              <section className={styles.card}>
                <p>{busy ? "正在读取媒体密钥状态…" : "媒体密钥尚未读取。"}</p>
                <button className={styles.secondary} onClick={() => void reload()} disabled={!!busy}>
                  重新读取配置
                </button>
              </section>
            ) : (
              <>
                <section className={styles.overview} aria-label="密钥概况" data-testid="media-keys-overview">
                  <div>
                    <span>已保存版本</span>
                    <strong>v{view.savedRevision}</strong>
                    <small>{view.source === "managed" ? "后台已托管至少一个槽位" : "仍可回退进程环境变量"}</small>
                  </div>
                  <div>
                    <span>生效方式</span>
                    <strong className={styles.smallStrong}>{view.pendingRestart ? "等待重启" : "热更新"}</strong>
                    <small>{view.pendingRestart ? "保存后需重启进程加载" : "保存后探测与新任务可读到"}</small>
                  </div>
                  <div>
                    <span>校验</span>
                    <strong className={styles.smallStrong}>仅本地</strong>
                    <small>不调用真实供应商</small>
                  </div>
                  <div>
                    <span>售价 / 支付</span>
                    <strong className={styles.smallStrong}>不锁定</strong>
                    <small>尚未计价仍可空</small>
                  </div>
                </section>
                {view.pendingRestart && (
                  <div className={styles.warning} role="status" data-testid="media-keys-pending-restart">
                    <strong>密钥已保存，等待进程重启后生效</strong>
                    <p>页面不会假装供应商已经接通。重启只是加载配置，不是一次代码部署；本页不会自行部署。</p>
                  </div>
                )}
                <ul className={styles.railNote} data-testid="media-keys-notices" style={{ listStyle: "none", padding: "0 0 18px", margin: 0 }}>
                  {view.notices.map((item) => (
                    <li key={item} style={{ fontSize: 12, color: "var(--studio-muted)", lineHeight: 1.8, marginBottom: 6 }}>
                      {item}
                    </li>
                  ))}
                </ul>
                <div className={styles.workspace}>
                  <aside className={styles.providerRail} aria-label="媒体密钥槽位">
                    <div className={styles.railHeading}>
                      <h2>密钥槽位</h2>
                      <span>03</span>
                    </div>
                    {MEDIA_KEY_SLOTS.map((slot) => {
                      const item = view.slots.find((entry) => entry.slot === slot)!;
                      return (
                        <button
                          key={slot}
                          type="button"
                          className={`${styles.providerButton} ${selected === slot ? styles.providerSelected : ""}`}
                          aria-pressed={selected === slot}
                          disabled={!!busy}
                          data-testid={`media-key-slot-${slot}`}
                          onClick={() => {
                            setSelected(slot);
                            forgetSecrets();
                            setError("");
                          }}
                        >
                          <span className={styles.providerInfo}>
                            <strong>{item.label}</strong>
                            <small>{slot}</small>
                            <span className={styles.providerState}>{STATUS_LABEL[item.status]}</span>
                          </span>
                          <span className={styles.providerArrow} aria-hidden="true">
                            ↗
                          </span>
                        </button>
                      );
                    })}
                    <div className={styles.railNote}>
                      <LockIcon />
                      <strong>密钥不会回传</strong>
                      <p>读回接口只返回是否已保存与脱敏状态，不返回完整密钥、前缀或末尾字符。</p>
                    </div>
                  </aside>
                  <section className={styles.card} aria-label={`${current?.label ?? "媒体"}密钥`} data-testid="media-key-editor">
                    <div className={styles.cardHeading}>
                      <div>
                        <span className={styles.eyebrow}>{selected}</span>
                        <h2>{current?.label}</h2>
                        <p>{current?.hint}</p>
                      </div>
                      <Badge tone={current?.status === "saved" ? "success" : current?.status === "pending_restart" ? "warning" : "neutral"}>
                        {current ? STATUS_LABEL[current.status] : "未填写"}
                      </Badge>
                    </div>
                    <div className={styles.activeSummary}>
                      <span>当前来源</span>
                      <strong>
                        {current?.source === "managed" ? "后台已保存" : current?.source === "environment" ? "进程环境变量（尚未后台托管）" : "未配置"}
                      </strong>
                      <span>{current?.managed ? "该槽位已由后台管理；清除后不会回退旧环境变量。" : "从未在后台保存过时可继续使用进程环境变量。"}</span>
                      <small>上传分镜图片不依赖这些密钥。</small>
                    </div>
                    <form onSubmit={(event) => void saveSlot(event)}>
                      <fieldset className={styles.fieldset} disabled={!canEdit}>
                        <div className={styles.secretBlock}>
                          <div className={styles.sectionLabel}>
                            <strong>API 密钥</strong>
                            <Badge>{current?.keyConfigured ? "已保存 · 不可读取" : "尚未保存"}</Badge>
                          </div>
                          <fieldset className={styles.secretActions}>
                            <legend>本次密钥操作</legend>
                            {(
                              [
                                { value: "keep", label: "保留现有" },
                                { value: "replace", label: "填写 / 替换" },
                                { value: "clear", label: "清除密钥" },
                              ] as const
                            ).map((action) => (
                              <label key={action.value} className={secretAction === action.value ? styles.radioSelected : ""}>
                                <input
                                  type="radio"
                                  name="media-secret-action"
                                  value={action.value}
                                  checked={secretAction === action.value}
                                  onChange={() => {
                                    setSecretAction(action.value);
                                    setApiKey("");
                                    setClearConfirmed(false);
                                  }}
                                />
                                {action.label}
                              </label>
                            ))}
                          </fieldset>
                          {secretAction === "replace" && (
                            <label className={styles.field}>
                              新的 API Key
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
                              <small>不会保存在浏览器本地存储。提交结束后输入框会清空。保存不会打真实供应商。</small>
                            </label>
                          )}
                          {secretAction === "clear" && (
                            <label className={styles.confirm}>
                              <input type="checkbox" checked={clearConfirmed} onChange={(event) => setClearConfirmed(event.target.checked)} />
                              确认清除该槽位密钥；清除后不会回退到服务器环境变量中的旧值。
                            </label>
                          )}
                        </div>
                        <div className={styles.formFooter}>
                          <p>
                            仅校验并保存配置
                            <br />
                            <span>不联网测试 · 不产生供应商费用</span>
                          </p>
                          <button type="submit" className={styles.primary} disabled={!canEdit || (secretAction === "replace" && !apiKey.trim()) || (secretAction === "clear" && !clearConfirmed)}>
                            {busy === "save" ? "正在保存…" : "保存此槽位"}
                            <span aria-hidden="true">→</span>
                          </button>
                        </div>
                      </fieldset>
                    </form>
                    <p className={styles.footnote} style={{ marginTop: 16 }}>
                      <button type="button" className={styles.secondary} onClick={() => void reload()} disabled={!!busy}>
                        {busy === "reload" ? "正在读取…" : "重新读取最新配置"}
                      </button>
                    </p>
                  </section>
                </div>
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}
