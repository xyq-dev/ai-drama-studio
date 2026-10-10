"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  adminLimitsUpdateSchema, adminProviderUpdateSchema,
  type AdminModelsView, type AdminProviderView, type TitleWritingProviderKey,
} from "@ai-drama/contracts";
import { AdminApiError, createAdminModelsClient } from "../lib/admin-models-client";
import { goToLogin, loginUrl, logout as siteLogout, readSession, type SiteSession } from "../lib/site-session";
import styles from "./admin-models.module.css";

const PROVIDERS: Array<{ key: TitleWritingProviderKey; label: string; mark: string; description: string }> = [
  { key: "qwen", label: "千问", mark: "千", description: "阿里云百炼" },
  { key: "openai", label: "OpenAI", mark: "O", description: "Responses API" },
  { key: "deepseek", label: "DeepSeek", mark: "D", description: "Chat Completions API" },
];
type ProviderDraft = { models: string; baseUrl: string };
type LimitsDraft = { defaultProvider: string; maxCallsPerDay: string; maxActiveRuns: string };
type AuthState = "checking" | "guest" | "unavailable" | "signedin";

function draftFor(provider: AdminProviderView): ProviderDraft {
  return { models: provider.models.join("\n"), baseUrl: provider.baseUrl };
}
function draftsFor(view: AdminModelsView): Record<string, ProviderDraft> {
  return Object.fromEntries(view.saved.providers.map((provider) => [provider.providerKey, draftFor(provider)]));
}
function limitsFor(view: AdminModelsView): LimitsDraft {
  return { defaultProvider: view.saved.defaultProvider ?? "", maxCallsPerDay: String(view.saved.maxCallsPerDay),
    maxActiveRuns: String(view.saved.maxActiveRuns) };
}
function messageFor(error: unknown): string {
  if (!(error instanceof AdminApiError)) return "暂时无法完成请求，请重新读取配置后再试。";
  if (error.status === 409) return error.code === "ADMIN_CONFIG_BUSY"
    ? "配置正在被其他操作更新，请稍后重新读取。本次没有自动重试保存。"
    : "配置已被其他管理员修改。本页草稿已保留，请重新读取最新配置后再编辑。";
  if (error.status === 503) return "管理员配置存储暂不可用，请联系服务器管理员检查初始化与存储状态。";
  if (error.status === 400) return "配置格式不正确，请检查模型 ID、端点和密钥后再保存。";
  if (error.status === 403) return "本次操作未获授权，请退出后重新验证管理员身份。";
  if (error.status === 429) return "验证请求过于频繁，请稍后再试。";
  return "网络连接或回执异常，操作结果尚未确认。请重新读取配置，不要直接重复提交。";
}
function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "success" | "warning" }) {
  return <span className={`${styles.badge} ${styles[tone]}`}>{children}</span>;
}
function LockIcon() {
  return <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <rect x="5" y="10" width="14" height="11" rx="3" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" />
  </svg>;
}

export function AdminModels() {
  const client = useMemo(() => createAdminModelsClient(), []);
  const [auth, setAuth] = useState<AuthState>("checking");
  const [session, setSession] = useState<SiteSession | null>(null);
  const [loginError, setLoginError] = useState("");
  const [view, setView] = useState<AdminModelsView | null>(null);
  const [selected, setSelected] = useState<TitleWritingProviderKey>("qwen");
  const [drafts, setDrafts] = useState<Record<string, ProviderDraft>>({});
  const [limits, setLimits] = useState<LimitsDraft>({ defaultProvider: "", maxCallsPerDay: "30", maxActiveRuns: "1" });
  const [secretAction, setSecretAction] = useState<"keep" | "replace" | "clear">("keep");
  const [apiKey, setApiKey] = useState("");
  const [clearConfirmed, setClearConfirmed] = useState(false);
  const [secretNotice, setSecretNotice] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reloadConfirmed, setReloadConfirmed] = useState(false);
  const [mustReload, setMustReload] = useState(false);
  const [busy, setBusy] = useState("");
  const busyRef = useRef("");
  const generation = useRef(0);
  const expiryChecking = useRef(false);
  const expiryRetry = useRef<number | undefined>(undefined);

  function begin(kind: string): number | null {
    if (busyRef.current) return null;
    busyRef.current = kind; setBusy(kind);
    return generation.current;
  }
  function finish(epoch: number) {
    if (epoch !== generation.current) return;
    busyRef.current = ""; setBusy("");
  }
  function forgetSecrets() {
    setApiKey(""); setSecretAction("keep"); setClearConfirmed(false); setSecretNotice("");
  }
  function endSession(message: string) {
    generation.current += 1;
    if (expiryRetry.current !== undefined) { window.clearTimeout(expiryRetry.current); expiryRetry.current = undefined; }
    busyRef.current = ""; setBusy("");
    setSession(null); setView(null); setDrafts({}); setAuth("guest");
    forgetSecrets(); setError(""); setNotice(""); setLoginError(message); setMustReload(false);
  }
  function installView(next: AdminModelsView) {
    setView(next); setDrafts(draftsFor(next)); setLimits(limitsFor(next));
    setMustReload(false); setReloadConfirmed(false); forgetSecrets();
  }
  /** The console uses the site login. Signed out goes to /login; with the site login off the console stays closed. */
  function acceptSession(next: SiteSession): boolean {
    if (!next.enabled) {
      setAuth("unavailable"); setLoginError("站点统一登录尚未启用，模型后台保持关闭。请联系服务器管理员。");
      return false;
    }
    if (!next.authenticated || !next.expiresAt || !Number.isFinite(Date.parse(next.expiresAt))) {
      setAuth("guest"); goToLogin("expired");
      return false;
    }
    setSession(next); setAuth("signedin"); setLoginError("");
    return true;
  }

  async function checkSession() {
    const epoch = begin("session");
    if (epoch === null) return;
    setAuth("checking"); setLoginError("");
    try {
      const next = await readSession();
      if (epoch !== generation.current || !acceptSession(next)) return;
      const settings = await client.models();
      if (epoch === generation.current) installView(settings);
    } catch (caught) {
      if (epoch !== generation.current) return;
      if (caught instanceof AdminApiError && caught.status === 401) endSession("");
      else if (caught instanceof AdminApiError && caught.status === 503) { setAuth("unavailable"); setLoginError("管理员后台尚未就绪，请联系服务器管理员完成安全存储初始化。"); }
      else { setAuth("unavailable"); setLoginError("暂时无法确认登录状态，请重试。"); setSession(null); }
    } finally { finish(epoch); }
  }

  useEffect(() => {
    void checkSession();
    return () => {
      generation.current += 1; busyRef.current = "";
      if (expiryRetry.current !== undefined) window.clearTimeout(expiryRetry.current);
    };
    // The initial authentication request owns this mount; actions start their own guarded requests.
  }, []);

  /**
   * At the expiry the page last saw, ask the server (passively: the check is not activity) whether the session is
   * still there. Reads and writes may have extended it: then only the snapshot and the timer move, drafts stay.
   * Only a confirmed end clears sensitive input and goes to the login; a failed check is not an end, it is asked again.
   * This never reinstalls the settings view, so unsaved edits are kept.
   */
  async function confirmExpiry() {
    if (expiryChecking.current) return;
    expiryChecking.current = true;
    const epoch = generation.current;
    try {
      const next = await readSession(undefined, { passive: true });
      if (epoch !== generation.current) return;
      if (next.enabled && next.authenticated && next.expiresAt && Number.isFinite(Date.parse(next.expiresAt))) {
        setSession((current) => (current ? { ...current, ...next } : current));
        return;
      }
      endSession("登录已过期，请重新登录。");
      goToLogin("expired");
    } catch {
      if (epoch !== generation.current) return;
      expiryRetry.current = window.setTimeout(() => { expiryRetry.current = undefined; void confirmExpiry(); }, 30_000);
    } finally {
      expiryChecking.current = false;
    }
  }

  useEffect(() => {
    if (!session) return;
    // At least a short delay, so a timer firing a little early cannot spin.
    const timer = window.setTimeout(() => { void confirmExpiry(); },
      Math.min(2_147_483_647, Math.max(250, Date.parse(session.expiresAt ?? "") - Date.now())));
    return () => window.clearTimeout(timer);
  }, [session]);

  async function logout() {
    if (!session) return;
    const epoch = begin("logout");
    if (epoch === null) return;
    forgetSecrets();
    try {
      await siteLogout();
      if (epoch === generation.current) { endSession("已退出登录。"); window.location.assign(loginUrl("/admin/models", "signed-out")); }
    } catch {
      if (epoch !== generation.current) return;
      setError("退出尚未确认，请重试退出。输入的密钥已清空。");
    } finally { finish(epoch); }
  }

  async function reload() {
    const epoch = begin("read");
    if (epoch === null) return;
    setError(""); setNotice(""); forgetSecrets();
    try {
      const next = await client.models();
      if (epoch === generation.current) { installView(next); setNotice("已重新读取服务器配置。"); }
    } catch (caught) {
      if (epoch !== generation.current) return;
      if (caught instanceof AdminApiError && caught.status === 401) endSession("管理员会话已过期，请重新验证。");
      else setError(messageFor(caught));
    } finally { finish(epoch); }
  }

  const saved = view?.saved.providers.find((provider) => provider.providerKey === selected);
  const active = view?.active.providers.find((provider) => provider.providerKey === selected);
  const meta = PROVIDERS.find((provider) => provider.key === selected)!;
  const draft = drafts[selected] ?? { models: "", baseUrl: "" };
  const dirty = !!view && (JSON.stringify(drafts) !== JSON.stringify(draftsFor(view))
    || JSON.stringify(limits) !== JSON.stringify(limitsFor(view)) || secretAction !== "keep");
  const canEdit = !busy && !mustReload;

  function changeProvider(key: TitleWritingProviderKey) {
    if (busyRef.current) return;
    setSelected(key); forgetSecrets(); setNotice("");
  }
  function changeDraft(patch: Partial<ProviderDraft>) {
    if (!canEdit || busyRef.current) return;
    setDrafts((old) => ({ ...old, [selected]: { ...draft, ...patch } }));
  }

  async function saveProvider(event: FormEvent) {
    event.preventDefault();
    if (!session || !view || !canEdit || busyRef.current) return;
    const parsed = adminProviderUpdateSchema.safeParse({
      expectedRevision: view.savedRevision,
      models: [...new Set(draft.models.split(/[\n,，]/).map((item) => item.trim()).filter(Boolean))],
      ...(selected === "qwen" ? { baseUrl: draft.baseUrl.trim() } : {}),
      secretAction, ...(secretAction === "replace" ? { apiKey: apiKey.trim() } : {}),
    });
    if (!parsed.success || (secretAction === "clear" && !clearConfirmed)) {
      setError("请检查模型 ID（最多 10 个）、密钥格式和清除确认，再保存配置。"); return;
    }
    const epoch = begin("provider");
    if (epoch === null) return;
    const providerKey = selected;
    const replaced = secretAction === "replace";
    setError(""); setNotice(""); setSecretNotice("");
    try {
      const next = await client.provider(providerKey, parsed.data);
      if (epoch !== generation.current) return;
      setView(next);
      const updated = next.saved.providers.find((provider) => provider.providerKey === providerKey);
      if (updated) setDrafts((old) => ({ ...old, [providerKey]: draftFor(updated) }));
      setSecretAction("keep"); setClearConfirmed(false);
      setNotice(`${meta.label}配置已保存。${next.pendingRestart ? "等待 API 重启后应用。" : "以当前生效配置为准。"}没有发起模型调用。`);
    } catch (caught) {
      if (epoch !== generation.current) return;
      if (caught instanceof AdminApiError && caught.status === 401) endSession("管理员会话已过期，请重新验证。");
      else {
        setError(messageFor(caught));
        if (caught instanceof AdminApiError && (caught.status === 409 || caught.status === 0)) setMustReload(true);
        if (replaced) setSecretNotice("本次密钥输入已清空。如需再次替换，请重新输入。");
      }
    } finally { if (epoch === generation.current) setApiKey(""); finish(epoch); }
  }

  async function saveLimits(event: FormEvent) {
    event.preventDefault();
    if (!session || !view || !canEdit || busyRef.current) return;
    const parsed = adminLimitsUpdateSchema.safeParse({ expectedRevision: view.savedRevision,
      defaultProvider: limits.defaultProvider || null, maxCallsPerDay: Number(limits.maxCallsPerDay), maxActiveRuns: Number(limits.maxActiveRuns) });
    if (!parsed.success) { setError("每日调用次数应为 1–500，同时创作数应为 1–10，请填写整数。"); return; }
    const epoch = begin("limits");
    if (epoch === null) return;
    setError(""); setNotice("");
    try {
      const next = await client.limits(parsed.data);
      if (epoch !== generation.current) return;
      setView(next); setLimits(limitsFor(next));
      setNotice(`调用规则已保存。${next.pendingRestart ? "等待 API 重启后应用。" : "以当前生效配置为准。"}次数限制不等于金额预算。`);
    } catch (caught) {
      if (epoch !== generation.current) return;
      if (caught instanceof AdminApiError && caught.status === 401) endSession("管理员会话已过期，请重新验证。");
      else { setError(messageFor(caught)); if (caught instanceof AdminApiError && (caught.status === 409 || caught.status === 0)) setMustReload(true); }
    } finally { finish(epoch); }
  }

  return <div className={styles.app}>
    <a href="#admin-content" className={styles.skip}>跳到正文</a>
    <header className={styles.header}>
      <Link className={styles.brand} href="/studio"><span className={styles.brandMark} aria-hidden="true">红</span><span>红果创作<span className={styles.brandSub}>管理员控制台</span></span></Link>
      <div className={styles.headerActions}><Link href="/studio" className={styles.backLink}>返回创作中心 <span aria-hidden="true">↗</span></Link>
        {auth === "signedin" && <button type="button" className={styles.secondary} onClick={() => void logout()} disabled={!!busy}>{busy === "logout" ? "正在退出…" : "退出"}</button>}</div>
    </header>
    <main id="admin-content" className={styles.main}>
      {auth !== "signedin" ? <div className={styles.loginLayout}>
        <section className={styles.loginIntro}><span className={styles.eyebrow}>红果 · 创作基础设施</span><h1>为好故事，<br />接上合适的模型。</h1><p>在一处管理创作使用的模型、访问密钥和调用规则。创作者专注于故事，配置交给管理员。</p>
          <div className={styles.loginFacts}><div><span>01</span><strong>三家供应商</strong><p>千问、OpenAI 与 DeepSeek</p></div><div><span>02</span><strong>密钥只写不读</strong><p>保存后不会从接口回传</p></div><div><span>03</span><strong>手动保存配置</strong><p>保存不会触发付费调用</p></div></div></section>
        <section className={styles.loginCard} aria-label="管理员登录"><div className={styles.lock}><LockIcon /></div><span className={styles.eyebrow}>受保护的管理入口</span><h2>管理员登录</h2><p>模型后台与创作页面使用同一个账号登录，登录后即可进入。</p>
          {auth === "checking" ? <p role="status" className={styles.loading}>正在检查登录状态…</p>
            : auth === "unavailable" ? <><div className={styles.warning} role="alert">{loginError || "管理员后台尚未就绪，请联系服务器管理员完成认证与安全存储初始化。"}</div><button className={styles.secondary} disabled={!!busy} onClick={() => void checkSession()}>重新检查后台状态</button></>
              : <><p className={styles.footnote}>{loginError || "请先登录。登录后会回到模型后台。"}</p>
                <a className={styles.primary} href={loginUrl("/admin/models")}>前往登录<span aria-hidden="true">→</span></a></>}
        </section>
      </div> : <>
        <div className={styles.pageHeading}><div><span className={styles.eyebrow}>管理控制台 / 模型配置</span><h1>模型配置<span className={styles.headingDot} /></h1><p>连接创作能力，掌握每一次调用。</p></div><Badge><LockIcon /> 管理员会话有效</Badge></div>
        {error && <div className={styles.error} role="alert">{error}</div>}
        {notice && <div className={styles.success} role="status">{notice}</div>}
        {!view ? <section className={styles.card}><p>{busy ? "正在读取模型配置…" : "模型配置尚未读取。"}</p><button className={styles.secondary} onClick={() => void reload()} disabled={!!busy}>重新读取配置</button></section> : <>
          <section className={styles.overview} aria-label="配置概况"><div><span>已保存版本</span><strong>v{view.savedRevision}</strong><small>{view.source === "managed" ? "管理员配置" : "服务器环境配置"}</small></div><div><span>当前生效版本</span><strong>v{view.activeRevision}</strong><small>{view.pendingRestart ? "新配置尚未应用" : "与已保存配置一致"}</small></div><div><span>标题 AI 创作</span><strong className={styles.smallStrong}>{view.titleWriting.enabled ? "已开启" : "未开启"}</strong><small>{view.titleWriting.productionBlocked ? "生产环境强制关闭" : "由服务器功能开关控制"}</small></div><div><span>操作者授权</span><strong className={styles.smallStrong}>{view.titleWriting.operatorConfigured ? "已配置" : "未配置"}</strong><small>与站点登录账号分别管理</small></div></section>
          {view.pendingRestart && <div className={styles.warning} role="status"><strong>配置已保存，等待 API 重启生效</strong><p>请由服务器管理员按发布流程重启 API。本页面不会重启服务，也不会自动启用 AI 创作。</p></div>}
          {view.activationDeferred && <div className={styles.warning} role="status"><strong>有创作任务尚未结束，配置应用已推迟</strong><p>服务继续使用原有的生效配置，避免改变正在执行或恢复中的模型请求。请在任务结束后联系服务器管理员处理。</p></div>}
          <div className={styles.workspace}>
            <aside className={styles.providerRail} aria-label="模型供应商"><div className={styles.railHeading}><h2>模型供应商</h2><span>03</span></div>
              {PROVIDERS.map((provider) => { const settings = view.saved.providers.find((item) => item.providerKey === provider.key); return <button key={provider.key} type="button" className={`${styles.providerButton} ${selected === provider.key ? styles.providerSelected : ""}`} aria-pressed={selected === provider.key} disabled={!!busy} onClick={() => changeProvider(provider.key)}>
                <span className={`${styles.providerMark} ${styles[provider.key]}`} aria-hidden="true">{provider.mark}</span><span className={styles.providerInfo}><strong>{provider.label}</strong><small>{provider.description}</small><span className={styles.providerState}>{settings?.keyConfigured ? "密钥已配置" : "密钥未配置"}</span></span><span className={styles.providerArrow} aria-hidden="true">↗</span></button>; })}
              <div className={styles.railNote}><LockIcon /><strong>密钥不会回传</strong><p>页面只显示是否配置，不显示密钥、前缀或末尾字符。</p></div>
            </aside>
            <section className={styles.card} aria-label={`${meta.label}设置`}>
              <div className={styles.cardHeading}><div className={styles.providerTitle}><span className={`${styles.providerMark} ${styles[selected]}`} aria-hidden="true">{meta.mark}</span><div><h2>{meta.label}</h2><p>{meta.description}</p></div></div><Badge tone={saved?.keyConfigured ? "success" : "neutral"}>{saved?.keyConfigured ? "密钥已配置" : "等待配置"}</Badge></div>
              <div className={styles.activeSummary}><span>当前生效</span><strong>{active?.ready ? "配置项齐全" : "配置项未齐全"}</strong><span>{active?.models.length ? active.models.join("、") : "尚未指定模型"}</span><small>配置项齐全不代表供应商连通或模型已验收。</small></div>
              <form onSubmit={(event) => void saveProvider(event)}>
                <fieldset className={styles.fieldset} disabled={!canEdit}>
                  <label className={styles.field}>服务端点{selected === "qwen" ? <input type="url" value={draft.baseUrl} onChange={(event) => changeDraft({ baseUrl: event.target.value })} placeholder="填写账户地域对应的官方兼容模式端点" spellCheck={false} autoComplete="off" maxLength={512} /> : <input type="text" readOnly value={selected === "openai" ? "https://api.openai.com/v1/responses" : "https://api.deepseek.com/chat/completions"} />}
                    <small>{selected === "qwen" ? "仅支持已允许的百炼官方 HTTPS 端点，路径为 /compatible-mode/v1。" : "固定为供应商官方端点，不能填写转发或代理地址。"}</small></label>
                  <label className={styles.field}>允许使用的模型 ID<textarea value={draft.models} onChange={(event) => changeDraft({ models: event.target.value })} rows={3} maxLength={1500} placeholder="填写账户实际可用的模型 ID，每行一个" spellCheck={false} autoComplete="off" /><small>最多 10 个，可用换行或逗号分隔。顺序会保留；不会自动猜测模型名称。</small></label>
                  <div className={styles.secretBlock}><div className={styles.sectionLabel}><strong>API 密钥</strong><Badge>{saved?.keyConfigured ? "已保存 · 不可读取" : "尚未保存"}</Badge></div>
                    <fieldset className={styles.secretActions}><legend>本次密钥操作</legend>{([{ value: "keep", label: "保留现有" }, { value: "replace", label: "填写 / 替换" }, { value: "clear", label: "清除密钥" }] as const).map((action) => <label key={action.value} className={secretAction === action.value ? styles.radioSelected : ""}><input type="radio" name="secret-action" value={action.value} checked={secretAction === action.value} onChange={() => { setSecretAction(action.value); setApiKey(""); setClearConfirmed(false); setSecretNotice(""); }} />{action.label}</label>)}</fieldset>
                    {secretAction === "replace" && <label className={styles.field}>新的 API Key<input name="provider-api-key" type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={(event) => setApiKey(event.target.value)} maxLength={256} placeholder="仅本次提交使用，保存后不会显示" /><small>不会保存在浏览器本地存储。提交结束后，无论成功或失败，输入框都会清空。</small></label>}
                    {secretAction === "clear" && <label className={styles.confirm}><input type="checkbox" checked={clearConfirmed} onChange={(event) => setClearConfirmed(event.target.checked)} />我确认清除该供应商已保存的密钥；配置应用后将无法用它发起新调用。</label>}
                    {secretAction === "keep" && <p className={styles.footnote}>本次不发送密钥，保持服务器已保存的密钥状态。</p>}
                  </div>
                  {secretNotice && <p className={styles.footnote} role="status">{secretNotice}</p>}
                  <div className={styles.formFooter}><p>仅校验并保存配置<br /><span>不联网测试 · 不产生模型费用</span></p><button className={styles.primary} type="submit" disabled={!canEdit || (secretAction === "replace" && !apiKey.trim()) || (secretAction === "clear" && !clearConfirmed)}>{busy === "provider" ? "正在保存…" : "校验并保存配置"}<span aria-hidden="true">→</span></button></div>
                </fieldset>
              </form>
            </section>
          </div>
          <section className={styles.card} aria-label="默认供应商与调用规则"><div className={styles.cardHeading}><div><span className={styles.eyebrow}>创作调用规则</span><h2>默认选择与使用限额</h2><p>控制调用次数与同时运行的创作任务，费用仍以供应商账单为准。</p></div><Badge>次数限制 ≠ 金额预算</Badge></div>
            <form onSubmit={(event) => void saveLimits(event)}><fieldset className={styles.fieldset} disabled={!canEdit}><div className={styles.limitFields}>
              <label className={styles.field}>默认供应商<select value={limits.defaultProvider} onChange={(event) => setLimits({ ...limits, defaultProvider: event.target.value })}><option value="">暂不指定</option>{PROVIDERS.map((provider) => <option key={provider.key} value={provider.key}>{provider.label}</option>)}</select><small>用于创作者的默认选择，不会自动切换失败的供应商。</small></label>
              <label className={styles.field}>每日最多调用次数<input type="number" min="1" max="500" step="1" value={limits.maxCallsPerDay} onChange={(event) => setLimits({ ...limits, maxCallsPerDay: event.target.value })} /><small>1–500 次；一次创作可能包含多次请求。</small></label>
              <label className={styles.field}>同时创作任务数<input type="number" min="1" max="10" step="1" value={limits.maxActiveRuns} onChange={(event) => setLimits({ ...limits, maxActiveRuns: event.target.value })} /><small>1–10 个；不会终止已经运行的任务。</small></label>
            </div><div className={styles.formFooter}><p>当前生效：{PROVIDERS.find((provider) => provider.key === view.active.defaultProvider)?.label ?? "未指定"} · 每日 {view.active.maxCallsPerDay} 次 · 同时 {view.active.maxActiveRuns} 个<span className={styles.block}>金额费用未知时保持 unknown，不显示为 0。</span></p><button className={styles.secondary} type="submit" disabled={!canEdit}>{busy === "limits" ? "正在保存…" : "保存调用规则"}</button></div></fieldset></form>
          </section>
          <section className={styles.bottomGrid}><div className={styles.card}><h2>最近配置活动</h2><p className={styles.footnote}>只记录操作类型和版本，不记录密钥内容。</p>{view.audit.length ? <ol className={styles.audit}>{view.audit.slice(-8).reverse().map((item, index) => <li key={`${item.at}-${index}`}><span className={styles.auditDot} /><div><strong>{item.action === "activated" ? "配置已应用" : item.action === "limits_updated" ? "调用规则已保存" : `${PROVIDERS.find((provider) => provider.key === item.providerKey)?.label ?? "供应商"}配置已保存`}</strong><time dateTime={item.at}>{new Date(item.at).toLocaleString("zh-CN", { hour12: false })}</time></div><span>v{item.revision}</span></li>)}</ol> : <p className={styles.empty}>还没有管理员配置记录</p>}</div>
            <div className={styles.card}><h2>读取最新配置</h2><p className={styles.footnote}>保存采用版本校验，其他管理员的修改不会被静默覆盖。重新读取会清空本页所有未保存内容和密钥输入。</p>{dirty && <label className={styles.confirm}><input type="checkbox" checked={reloadConfirmed} onChange={(event) => setReloadConfirmed(event.target.checked)} disabled={!!busy} />我确认放弃本页未保存的修改</label>}<button type="button" className={styles.secondary} onClick={() => void reload()} disabled={!!busy || (dirty && !reloadConfirmed)}>{busy === "read" ? "正在读取…" : "重新读取最新配置"}</button><p className={styles.footnote}>站点登录密码、AI 操作者令牌及功能开关仍由服务器管理员管理。</p></div>
          </section>
        </>}
      </>}
      <footer className={styles.footer}><span>红果创作 · 管理员控制台</span><span>保存配置不等于启用 AI，也不代表真实模型验收通过。</span></footer>
    </main>
  </div>;
}
