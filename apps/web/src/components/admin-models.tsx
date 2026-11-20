"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  adminLimitsUpdateSchema, adminProviderUpdateSchema, anthropicKeyProblem, anthropicWorkspaceIdValid,
  claudeSetupState, deepseekKeyProblem, providerSetupState, type AdminModelsView, type AdminProviderView, type ClaudeSetupState, type TitleWritingProviderKey,
} from "@ai-drama/contracts";
import { AdminApiError, createAdminModelsClient } from "../lib/admin-models-client";
import { ModelPicker, modelDraftFor, modelProblem, orderedModels, type ModelDraft } from "./admin-model-picker";
import { goToLogin, loginUrl, readSession, type SiteSession } from "../lib/site-session";
import styles from "./admin-models.module.css";

const PROVIDERS: Array<{ key: TitleWritingProviderKey; label: string; caption: string }> = [
  { key: "deepseek", label: "DeepSeek", caption: "默认供应商" },
  { key: "anthropic", label: "Claude", caption: "Anthropic" },
  { key: "openai", label: "OpenAI", caption: "文本创作" },
];
type ProviderDraft = ModelDraft & { baseUrl: string };
type LimitsDraft = { defaultProvider: string; maxCallsPerDay: string; maxActiveRuns: string };
type AuthState = "checking" | "guest" | "unavailable" | "signedin";

function draftFor(provider: AdminProviderView): ProviderDraft {
  return { ...modelDraftFor(provider.providerKey, provider.models), baseUrl: provider.baseUrl };
}
function draftsFor(view: AdminModelsView): Record<string, ProviderDraft> {
  return Object.fromEntries(view.saved.providers.map((provider) => [provider.providerKey, draftFor(provider)]));
}
function limitsFor(view: AdminModelsView): LimitsDraft {
  return {
    defaultProvider: view.saved.defaultProvider ?? "",
    maxCallsPerDay: String(view.saved.maxCallsPerDay),
    maxActiveRuns: String(view.saved.maxActiveRuns),
  };
}

const CREDENTIAL_ERRORS: Record<string, string> = {
  ADMIN_CONFIG_KEY_FORMAT: "Claude API Key 的格式不受支持。请粘贴在 Claude Console 的 API keys 页面创建的完整密钥。没有保存任何内容。",
  ADMIN_CONFIG_KEY_KIND: "这是一种不能用于调用 Claude API 的凭据（例如 Claude Code 或订阅账号的登录令牌、Admin Key、浏览器会话或 JWT）。请改用 Claude Console 创建的 API Key。没有保存任何内容。",
  ADMIN_CONFIG_WORKSPACE_FORMAT: "Workspace ID 格式不正确，应为 Claude Console 工作区页面 ID 列中的 wrkspc_… 值。没有保存任何内容。",
  ADMIN_CONFIG_DEEPSEEK_KEY_FORMAT: "DeepSeek API Key 的格式不受支持：应为 DeepSeek 开放平台 API keys 页面创建的完整密钥，长度 16–256 个字符，不能包含空格、换行或其他特殊字符。没有保存任何内容。",
};

export const DEEPSEEK_DEFAULT_NOTICE = "保存 DeepSeek 会将 DeepSeek 设为新创作的默认供应商；只影响新发起的请求，不改变已有任务，也不会把失败的请求改用其他供应商。";
export const DEEPSEEK_ADVANCED_NOTICE = DEEPSEEK_DEFAULT_NOTICE;
export const CLAUDE_WORKSPACE_HINT = "通常只需填写 API Key。若密钥未限定 Workspace，请在高级设置填写 Workspace ID，或创建限定 Workspace 的密钥。";

function messageFor(error: unknown): string {
  if (!(error instanceof AdminApiError)) return "暂时无法完成请求，请重新读取配置后再试。";
  if (error.status === 409) {
    return error.code === "ADMIN_CONFIG_BUSY"
      ? "配置正在被其他操作更新，请稍后重新读取。本次没有自动重试保存。"
      : "配置已被其他管理员修改。本页草稿已保留，请重新读取最新配置后再编辑。";
  }
  if (error.status === 503) return "管理员配置存储暂不可用，请联系服务器管理员检查初始化与存储状态。";
  if (error.status === 400 && CREDENTIAL_ERRORS[error.code]) return CREDENTIAL_ERRORS[error.code]!;
  if (error.status === 400) return "配置格式不正确，请检查模型 ID、端点和密钥后再保存。";
  if (error.status === 403) return "本次操作未获授权，请退出后重新验证管理员身份。";
  if (error.status === 429) return "验证请求过于频繁，请稍后再试。";
  return "网络连接或回执异常，操作结果尚未确认。请重新读取配置，不要直接重复提交。";
}

export function deepseekStatusText(state: ClaudeSetupState, migrations: string[]): { title: string; detail: string; tone: "neutral" | "success" | "warning" } {
  return writingStatusText("DeepSeek", state, migrations);
}
export function claudeStatusText(state: ClaudeSetupState, migrations: string[]): { title: string; detail: string; tone: "neutral" | "success" | "warning" } {
  return writingStatusText("Claude", state, migrations);
}
function writingStatusText(label: string, state: ClaudeSetupState, migrations: string[]): { title: string; detail: string; tone: "neutral" | "success" | "warning" } {
  switch (state) {
    case "key_missing":
      return { title: `尚未配置 ${label} 服务密钥`, detail: "填写服务密钥并保存后，新任务才能使用该供应商。", tone: "warning" };
    case "pending_restart":
      return { title: `${label} 密钥已保存，等待生效`, detail: "保存不等于可以写作。请由服务器部署流程受控重启 API 后再读取状态。", tone: "warning" };
    case "activation_deferred":
      return { title: `${label} 配置已保存，应用已推迟`, detail: "有创作任务尚未结束，服务继续使用原有配置。", tone: "warning" };
    case "incomplete":
      return { title: `${label} 配置项未齐全`, detail: "当前生效配置缺少可用的密钥或模型。请检查默认模型后重新保存。", tone: "warning" };
    case "feature_off":
      return { title: `${label} 配置已生效，但 AI 创作开关未开启`, detail: "服务端 TITLE_WRITING_ENABLED 未开启（或生产环境未授权），暂时不能写作。", tone: "warning" };
    case "operator_missing":
      return { title: `${label} 配置已生效，但没有可用的调用授权`, detail: "站点登录未启用，且没有设置操作者令牌。", tone: "warning" };
    case "storage_unknown":
      return { title: `${label} 配置已生效，数据库状态暂时无法读取`, detail: "请稍后重新读取配置。", tone: "warning" };
    case "migration_missing":
      return { title: `${label} 配置已生效，但数据库迁移尚未执行`, detail: `需要执行：${migrations.join("、") || "标题创作数据表"}。`, tone: "warning" };
    default:
      return { title: "可以用于写作", detail: "新任务将使用默认模型，已有作品不受影响。", tone: "success" };
  }
}

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <rect x="5" y="10" width="14" height="11" rx="3" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" />
    </svg>
  );
}

function StatusBanner({ title, detail, tone, state }: { title: string; detail: string; tone: "neutral" | "success" | "warning"; state: string }) {
  const className = tone === "success" ? styles.statusSuccess : tone === "warning" ? styles.statusWarning : styles.statusNeutral;
  const mark = tone === "success" ? "✓" : "!";
  return (
    <div className={className} role="status" data-testid="writing-status" data-state={state}>
      <span className={styles.statusIcon} aria-hidden="true">{mark}</span>
      <div>
        <strong>{title}</strong>
        <p>{detail}</p>
      </div>
    </div>
  );
}

export function AdminModels() {
  const client = useMemo(() => createAdminModelsClient(), []);
  const [auth, setAuth] = useState<AuthState>("checking");
  const [session, setSession] = useState<SiteSession | null>(null);
  const [loginError, setLoginError] = useState("");
  const [view, setView] = useState<AdminModelsView | null>(null);
  const [selected, setSelected] = useState<TitleWritingProviderKey>("deepseek");
  const [drafts, setDrafts] = useState<Record<string, ProviderDraft>>({});
  const [limits, setLimits] = useState<LimitsDraft>({ defaultProvider: "", maxCallsPerDay: "30", maxActiveRuns: "1" });
  const [apiKey, setApiKey] = useState("");
  const [replacingKey, setReplacingKey] = useState(false);
  const [clearingKey, setClearingKey] = useState(false);
  const [clearConfirmed, setClearConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mustReload, setMustReload] = useState(false);
  const [busy, setBusy] = useState("");
  const [showModels, setShowModels] = useState(false);
  const [showLimits, setShowLimits] = useState(false);
  const [showModelProblem, setShowModelProblem] = useState(false);
  const [claudeWorkspace, setClaudeWorkspace] = useState("");
  const [claudeWorkspaceClear, setClaudeWorkspaceClear] = useState(false);
  const [viewEpoch, setViewEpoch] = useState(0);
  const busyRef = useRef("");
  const generation = useRef(0);
  const expiryChecking = useRef(false);
  const expiryRetry = useRef<number | undefined>(undefined);

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
    setReplacingKey(false);
    setClearingKey(false);
    setClearConfirmed(false);
    setClaudeWorkspace("");
    setClaudeWorkspaceClear(false);
  }
  function endSession(message: string) {
    generation.current += 1;
    if (expiryRetry.current !== undefined) {
      window.clearTimeout(expiryRetry.current);
      expiryRetry.current = undefined;
    }
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
  function installView(next: AdminModelsView) {
    setView(next);
    setDrafts(draftsFor(next));
    setLimits(limitsFor(next));
    setMustReload(false);
    setShowModelProblem(false);
    setViewEpoch((epoch) => epoch + 1);
    forgetSecrets();
  }
  function acceptSession(next: SiteSession): boolean {
    if (!next.enabled) {
      setAuth("unavailable");
      setLoginError("站点统一登录尚未启用，模型后台保持关闭。请联系服务器管理员。");
      return false;
    }
    if (!next.authenticated || !next.expiresAt || !Number.isFinite(Date.parse(next.expiresAt))) {
      setAuth("guest");
      goToLogin("expired");
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
      const settings = await client.models();
      if (epoch === generation.current) installView(settings);
    } catch (caught) {
      if (epoch !== generation.current) return;
      if (caught instanceof AdminApiError && caught.status === 401) endSession("");
      else if (caught instanceof AdminApiError && caught.status === 503) {
        setAuth("unavailable");
        setLoginError("管理员后台尚未就绪，请联系服务器管理员完成安全存储初始化。");
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
      if (expiryRetry.current !== undefined) window.clearTimeout(expiryRetry.current);
    };
  }, []);

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
      expiryRetry.current = window.setTimeout(() => {
        expiryRetry.current = undefined;
        void confirmExpiry();
      }, 30_000);
    } finally {
      expiryChecking.current = false;
    }
  }

  useEffect(() => {
    if (!session) return;
    const timer = window.setTimeout(() => { void confirmExpiry(); },
      Math.min(2_147_483_647, Math.max(250, Date.parse(session.expiresAt ?? "") - Date.now())));
    return () => window.clearTimeout(timer);
  }, [session]);

  async function reload() {
    const epoch = begin("read");
    if (epoch === null) return;
    setError("");
    setNotice("");
    forgetSecrets();
    try {
      const next = await client.models();
      if (epoch === generation.current) {
        installView(next);
        setNotice("已重新读取当前配置");
      }
    } catch (caught) {
      if (epoch !== generation.current) return;
      if (caught instanceof AdminApiError && caught.status === 401) endSession("管理员会话已过期，请重新验证。");
      else setError(messageFor(caught));
    } finally {
      finish(epoch);
    }
  }

  const saved = view?.saved.providers.find((provider) => provider.providerKey === selected);
  const meta = PROVIDERS.find((provider) => provider.key === selected)!;
  const draft = drafts[selected] ?? { models: [], defaultModel: "", custom: [], pendingCustom: "", baseUrl: "" };
  const canEdit = !busy && !mustReload;
  const setup = view
    ? (selected === "anthropic" ? claudeSetupState(view) : providerSetupState(view, selected))
    : { state: "key_missing" as const, migrations: [] as string[] };
  const status = writingStatusText(meta.label, setup.state, setup.migrations);

  function changeProvider(key: TitleWritingProviderKey) {
    if (busyRef.current) return;
    setSelected(key);
    forgetSecrets();
    setNotice("");
    setError("");
    setShowModelProblem(false);
    setShowModels(false);
    setShowLimits(false);
  }

  function changeDraft(patch: Partial<ProviderDraft>) {
    if (!canEdit || busyRef.current) return;
    setDrafts((old) => ({ ...old, [selected]: { ...draft, ...patch } }));
  }

  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    if (!session || !view || !canEdit || busyRef.current) return;
    if (clearingKey) {
      if (!clearConfirmed) {
        setError("清除密钥前请勾选确认。");
        return;
      }
      const parsed = adminProviderUpdateSchema.safeParse({
        expectedRevision: view.savedRevision,
        models: [],
        secretAction: "clear" as const,
      });
      if (!parsed.success) {
        setError("请检查配置后再保存。");
        return;
      }
      const epoch = begin("save");
      if (epoch === null) return;
      setError("");
      setNotice("");
      try {
        const next = await client.provider(selected, parsed.data);
        if (epoch !== generation.current) return;
        installView(next);
        setNotice("设置已保存");
      } catch (caught) {
        if (epoch !== generation.current) return;
        if (caught instanceof AdminApiError && caught.status === 401) endSession("管理员会话已过期，请重新验证。");
        else {
          setError(messageFor(caught));
          if (caught instanceof AdminApiError && (caught.status === 409 || caught.status === 0)) setMustReload(true);
        }
      } finally {
        finish(epoch);
      }
      return;
    }
    const key = apiKey.trim();
    const secretAction = key ? "replace" as const : "keep" as const;
    // Empty models + a new key is the documented quick setup: the API fills provider defaults.
    const quickKeySetup = secretAction === "replace" && draft.models.length === 0;
    if (!quickKeySetup && modelProblem(draft)) {
      setShowModelProblem(true);
      setShowModels(true);
      setError("请选择至少一个默认模型后再保存。");
      return;
    }
    if (secretAction === "replace") {
      if (selected === "deepseek" && deepseekKeyProblem(key) !== null) {
        setError(CREDENTIAL_ERRORS.ADMIN_CONFIG_DEEPSEEK_KEY_FORMAT!);
        setApiKey("");
        return;
      }
      if (selected === "anthropic") {
        const problem = anthropicKeyProblem(key);
        if (problem !== null) {
          setError(CREDENTIAL_ERRORS[problem === "not_api_credential" ? "ADMIN_CONFIG_KEY_KIND" : "ADMIN_CONFIG_KEY_FORMAT"]!);
          setApiKey("");
          return;
        }
      }
    } else if (!saved?.keyConfigured) {
      setError("请填写服务密钥后再保存。");
      return;
    }
    const workspace = claudeWorkspace.trim();
    if (selected === "anthropic" && workspace.length > 0 && !anthropicWorkspaceIdValid(workspace)) {
      setError(CREDENTIAL_ERRORS.ADMIN_CONFIG_WORKSPACE_FORMAT!);
      return;
    }
    const workspaceUpdate = selected === "anthropic"
      ? (workspace.length > 0
        ? { workspaceAction: "replace" as const, workspaceId: workspace }
        : claudeWorkspaceClear ? { workspaceAction: "clear" as const } : {})
      : {};
    const parsed = adminProviderUpdateSchema.safeParse({
      expectedRevision: view.savedRevision,
      models: quickKeySetup ? [] : orderedModels(draft),
      secretAction,
      ...(secretAction === "replace" ? { apiKey: key } : {}),
      ...workspaceUpdate,
    });
    if (!parsed.success) {
      setError("请检查模型 ID 和密钥格式后再保存。");
      return;
    }
    const epoch = begin("save");
    if (epoch === null) return;
    setError("");
    setNotice("");
    setShowModelProblem(false);
    try {
      const next = await client.provider(selected, parsed.data);
      if (epoch !== generation.current) return;
      installView(next);
      // Saving DeepSeek with a new key also makes it the default for new tasks (server-side). Sync local limits draft.
      if (selected === "deepseek" && secretAction === "replace") {
        setLimits((old) => ({ ...old, defaultProvider: "deepseek" }));
      }
      setNotice("设置已保存");
    } catch (caught) {
      if (epoch !== generation.current) return;
      if (caught instanceof AdminApiError && caught.status === 401) endSession("管理员会话已过期，请重新验证。");
      else {
        setError(messageFor(caught));
        if (caught instanceof AdminApiError && (caught.status === 409 || caught.status === 0)) setMustReload(true);
      }
    } finally {
      if (epoch === generation.current) setApiKey("");
      finish(epoch);
    }
  }

  async function saveLimits(event: FormEvent) {
    event.preventDefault();
    if (!session || !view || !canEdit || busyRef.current) return;
    if (limits.defaultProvider === "deepseek" && !view.saved.providers.find((provider) => provider.providerKey === "deepseek")?.keyConfigured) {
      setError("DeepSeek 还没有保存 API Key，不能设为默认供应商。请先保存 DeepSeek 服务密钥。");
      return;
    }
    const parsed = adminLimitsUpdateSchema.safeParse({
      expectedRevision: view.savedRevision,
      defaultProvider: limits.defaultProvider || null,
      maxCallsPerDay: Number(limits.maxCallsPerDay),
      maxActiveRuns: Number(limits.maxActiveRuns),
    });
    if (!parsed.success) {
      setError("每日调用次数应为 1–500，同时创作数应为 1–10，请填写整数。");
      return;
    }
    const epoch = begin("limits");
    if (epoch === null) return;
    setError("");
    setNotice("");
    try {
      const next = await client.limits(parsed.data);
      if (epoch !== generation.current) return;
      setView(next);
      setLimits(limitsFor(next));
      setNotice("设置已保存");
      setShowLimits(false);
    } catch (caught) {
      if (epoch !== generation.current) return;
      if (caught instanceof AdminApiError && caught.status === 401) endSession("管理员会话已过期，请重新验证。");
      else {
        setError(messageFor(caught));
        if (caught instanceof AdminApiError && (caught.status === 409 || caught.status === 0)) setMustReload(true);
      }
    } finally {
      finish(epoch);
    }
  }

  return (
    <div className={styles.app} data-embedded-admin="models">
      <a href="#admin-content" className={styles.skip}>跳到正文</a>
      <main id="admin-content" className={styles.main}>
        {auth !== "signedin" ? (
          <div className={styles.loginLayout}>
            <section className={styles.loginIntro}>
              <span className={styles.eyebrow}>红果 · 创作基础设施</span>
              <h1>为好故事，<br />接上合适的模型。</h1>
              <p>在一处管理创作使用的模型、访问密钥和调用规则。创作者专注于故事，配置交给管理员。</p>
            </section>
            <section className={styles.loginCard} aria-label="管理员登录">
              <div className={styles.lock}><LockIcon /></div>
              <span className={styles.eyebrow}>受保护的管理入口</span>
              <h2>管理员登录</h2>
              <p>模型后台与创作页面使用同一个账号登录，登录后即可进入。</p>
              {auth === "checking" ? <p role="status" className={styles.loading}>正在检查登录状态…</p>
                : auth === "unavailable" ? (
                  <>
                    <div className={styles.warning} role="alert">{loginError || "管理员后台尚未就绪，请联系服务器管理员完成认证与安全存储初始化。"}</div>
                    <button className={styles.secondary} disabled={!!busy} onClick={() => void checkSession()}>重新检查后台状态</button>
                  </>
                ) : (
                  <>
                    <p className={styles.footnote}>{loginError || "请先登录。登录后会回到模型后台。"}</p>
                    <a className={styles.primary} href={loginUrl("/admin/models")}>前往登录<span aria-hidden="true">→</span></a>
                  </>
                )}
            </section>
          </div>
        ) : (
          <>
            <div className={styles.pageIntro}>
              <h1>文本模型</h1>
              <p>选择写剧本用的模型，再保存设置。</p>
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
                <p>{busy ? "正在读取模型配置…" : "模型配置尚未读取。"}</p>
                <button className={styles.secondary} onClick={() => void reload()} disabled={!!busy}>重新读取</button>
              </section>
            ) : (
              <>
                <div className={styles.providerTabs} role="tablist" aria-label="写作供应商">
                  {PROVIDERS.map((provider) => {
                    const item = view.saved.providers.find((entry) => entry.providerKey === provider.key);
                    const caption = view.saved.defaultProvider === provider.key ? "默认供应商" : provider.caption;
                    return (
                      <button
                        key={provider.key}
                        type="button"
                        role="tab"
                        aria-selected={selected === provider.key}
                        className={`${styles.providerTab} ${selected === provider.key ? styles.providerTabSelected : ""}`}
                        disabled={!!busy}
                        onClick={() => changeProvider(provider.key)}
                      >
                        <strong>{provider.label}</strong>
                        <span>{caption}{item?.keyConfigured ? "" : " · 未配置"}</span>
                      </button>
                    );
                  })}
                </div>

                <section className={styles.settingsCard} aria-label={`${meta.label}写作设置`}>
                  <StatusBanner title={status.title} detail={status.detail} tone={status.tone} state={setup.state} />
                  <h2>{meta.label} 写作设置</h2>
                  {clearingKey ? (
                    <form onSubmit={(event) => void saveSettings(event)}>
                      <fieldset className={styles.fieldset} disabled={!canEdit}>
                        <StatusBanner
                          title="清除后，这项服务会停用"
                          detail="确认清除前，你可以随时取消。"
                          tone="warning"
                          state="clearing"
                        />
                        <p className={styles.footnote}>此操作只清除当前供应商的密钥，其他供应商不受影响。</p>
                        <label className={styles.confirm}>
                          <input
                            type="checkbox"
                            checked={clearConfirmed}
                            onChange={(event) => setClearConfirmed(event.target.checked)}
                          />
                          我确认清除这项服务的密钥
                        </label>
                        <div className={styles.actions}>
                          <button className={styles.primary} type="submit" disabled={!canEdit || !clearConfirmed}>
                            {busy === "save" ? "正在清除…" : "确认清除"}
                          </button>
                          <button
                            className={styles.secondary}
                            type="button"
                            disabled={!!busy}
                            onClick={() => { setClearingKey(false); setClearConfirmed(false); setError(""); }}
                          >
                            取消
                          </button>
                        </div>
                      </fieldset>
                    </form>
                  ) : (
                  <form onSubmit={(event) => void saveSettings(event)}>
                    <fieldset className={styles.fieldset} disabled={!canEdit}>
                      <div className={styles.fieldGrid}>
                        <label className={styles.field}>
                          默认模型
                          <select
                            value={draft.defaultModel}
                            onChange={(event) => {
                              const value = event.target.value;
                              const models = draft.models.includes(value) ? draft.models : value ? [...draft.models, value] : draft.models;
                              changeDraft({ defaultModel: value, models });
                            }}
                          >
                            <option value="">请选择模型</option>
                            {(draft.models.length ? draft.models : [""]).filter(Boolean).map((id) => (
                              <option key={id} value={id}>{id}</option>
                            ))}
                          </select>
                        </label>
                        <label className={styles.field}>
                          服务密钥
                          {saved?.keyConfigured && !replacingKey && !apiKey ? (
                            <button
                              type="button"
                              className={styles.maskedKey}
                              onClick={() => setReplacingKey(true)}
                              aria-label="更换服务密钥"
                            >
                              ••••  ••••  ••••  ••••
                            </button>
                          ) : (
                            <input
                              name="writing-api-key"
                              type="password"
                              autoComplete="off"
                              spellCheck={false}
                              value={apiKey}
                              onChange={(event) => setApiKey(event.target.value)}
                              maxLength={256}
                              placeholder={saved?.keyConfigured ? "填写新密钥以替换" : "粘贴服务密钥"}
                              aria-label={`${meta.label} API Key`}
                              data-testid="writing-key-input"
                            />
                          )}
                        </label>
                      </div>

                      {selected === "anthropic" ? (
                        <details className={styles.advanced}>
                          <summary>高级设置（可不填）：Workspace ID</summary>
                          <p className={styles.footnote} data-testid="claude-workspace-hint">{CLAUDE_WORKSPACE_HINT}</p>
                          <p className={styles.footnote} data-testid="claude-workspace-current">
                            Workspace ID：{saved?.workspaceId ? <code>{saved.workspaceId}</code> : "未设置"}
                          </p>
                          <label className={styles.field}>
                            Workspace ID
                            <input
                              name="claude-workspace-id"
                              type="text"
                              autoComplete="off"
                              spellCheck={false}
                              value={claudeWorkspace}
                              onChange={(event) => { setClaudeWorkspace(event.target.value); setClaudeWorkspaceClear(false); }}
                              maxLength={128}
                              placeholder="wrkspc_…"
                            />
                          </label>
                          {saved?.workspaceId ? (
                            <label className={styles.confirm}>
                              <input type="checkbox" checked={claudeWorkspaceClear} onChange={(event) => {
                                setClaudeWorkspaceClear(event.target.checked);
                                if (event.target.checked) setClaudeWorkspace("");
                              }} />
                              清除已保存的 Workspace ID
                            </label>
                          ) : null}
                        </details>
                      ) : null}

                      <div className={styles.linkRow}>
                        <button type="button" className={styles.textLink} onClick={() => setShowLimits((open) => !open)}>
                          调用限制
                        </button>
                        <button type="button" className={styles.textLink} onClick={() => setShowModels((open) => !open)}>
                          管理可用模型
                        </button>
                        {saved?.keyConfigured ? (
                          <button
                            type="button"
                            className={styles.textLink}
                            onClick={() => { setClearingKey(true); setClearConfirmed(false); setReplacingKey(false); setApiKey(""); setError(""); setNotice(""); }}
                          >
                            清除密钥
                          </button>
                        ) : null}
                      </div>

                      {showModels ? (
                        <div className={styles.expandPanel} data-testid="model-list-panel">
                          <ModelPicker
                            key={`${selected}:${viewEpoch}`}
                            providerKey={selected}
                            draft={draft}
                            showProblem={showModelProblem}
                            clearing={false}
                            onChange={(next) => changeDraft({
                              models: next.models,
                              defaultModel: next.defaultModel,
                              custom: next.custom,
                              pendingCustom: next.pendingCustom,
                            })}
                          />
                        </div>
                      ) : null}

                      <div className={styles.actions}>
                        <button className={styles.primary} type="submit" disabled={!canEdit}>
                          {busy === "save" ? "正在保存…" : "保存设置"}
                        </button>
                        <button className={styles.textButton} type="button" onClick={() => void reload()} disabled={!!busy}>
                          {busy === "read" ? "正在读取…" : "重新读取"}
                        </button>
                      </div>
                      {selected === "deepseek" ? (
                        <p className={styles.footnote} data-testid="deepseek-default-notice">{DEEPSEEK_DEFAULT_NOTICE}</p>
                      ) : null}
                    </fieldset>
                  </form>
                  )}
                </section>

                {showLimits ? (
                  <section className={styles.limitsCard} aria-label="调用限制" data-testid="limits-panel">
                    <div className={styles.limitsHead}>
                      <h2>调用限制</h2>
                      <button type="button" className={styles.iconClose} aria-label="关闭" onClick={() => setShowLimits(false)}>
                        <img src="/design/tailadmin-v2/icon-x.svg" width={18} height={18} alt="" />
                      </button>
                    </div>
                    <p className={styles.footnote}>{meta.label} 写作服务 · 次数限制不等于金额预算</p>
                    <form onSubmit={(event) => void saveLimits(event)}>
                      <fieldset className={styles.fieldset} disabled={!canEdit}>
                        <div className={styles.fieldGrid}>
                          <label className={styles.field}>
                            每天最多调用
                            <input type="number" min="1" max="500" step="1" value={limits.maxCallsPerDay}
                              onChange={(event) => setLimits({ ...limits, maxCallsPerDay: event.target.value })} />
                          </label>
                          <label className={styles.field}>
                            同时运行任务数
                            <input type="number" min="1" max="10" step="1" value={limits.maxActiveRuns}
                              onChange={(event) => setLimits({ ...limits, maxActiveRuns: event.target.value })} />
                          </label>
                        </div>
                        <label className={styles.field}>
                          默认供应商
                          <select value={limits.defaultProvider} onChange={(event) => setLimits({ ...limits, defaultProvider: event.target.value })}>
                            <option value="">暂不指定</option>
                            {PROVIDERS.map((provider) => (
                              <option key={provider.key} value={provider.key}>{provider.label}</option>
                            ))}
                          </select>
                        </label>
                        <div className={styles.actions}>
                          <button className={styles.primary} type="submit" disabled={!canEdit}>
                            {busy === "limits" ? "正在保存…" : "保存限制"}
                          </button>
                          <button className={styles.secondary} type="button" onClick={() => setShowLimits(false)}>取消</button>
                        </div>
                      </fieldset>
                    </form>
                  </section>
                ) : null}
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}
