"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { storageDraftUpdateSchema, type StorageConfigurationView, type StorageProvider, type StorageSettingsView } from "@ai-drama/contracts";
import { createStorageSettingsClient, StorageSettingsError } from "../lib/storage-settings-client";
import { useModalKeyboard } from "../lib/modal-keyboard";
import { CreatorShell } from "./creator-shell";
import styles from "./storage-settings.module.css";

const PROVIDERS: Array<{ key: StorageProvider; label: string }> = [
  { key: "cos", label: "腾讯云 COS" }, { key: "oss", label: "阿里云 OSS" },
  { key: "s3", label: "Amazon S3" }, { key: "minio", label: "MinIO" },
];
const labelOf = (key: StorageProvider) => PROVIDERS.find((item) => item.key === key)!.label;
type Form = Pick<StorageConfigurationView, "provider" | "bucket" | "region" | "endpoint" | "prefix" | "forcePathStyle">;
const DEFAULTS: Record<StorageProvider, Form> = {
  cos: { provider: "cos", bucket: "", region: "ap-guangzhou", endpoint: "https://cos.ap-guangzhou.myqcloud.com", prefix: "", forcePathStyle: false },
  oss: { provider: "oss", bucket: "", region: "cn-guangzhou", endpoint: "https://oss-cn-guangzhou.aliyuncs.com", prefix: "", forcePathStyle: false },
  s3: { provider: "s3", bucket: "", region: "us-east-1", endpoint: "https://s3.us-east-1.amazonaws.com", prefix: "", forcePathStyle: false },
  minio: { provider: "minio", bucket: "", region: "us-east-1", endpoint: "", prefix: "", forcePathStyle: true },
};
function formOf(value: StorageConfigurationView): Form {
  return { provider: value.provider, bucket: value.bucket, region: value.region, endpoint: value.endpoint, prefix: value.prefix, forcePathStyle: value.forcePathStyle };
}
function endpointOf(provider: StorageProvider, region: string, current: string): string {
  if (provider === "cos") return `https://cos.${region}.myqcloud.com`;
  if (provider === "oss") return `https://oss-${region}.aliyuncs.com`;
  if (provider === "s3") return `https://s3.${region}.amazonaws.com${region.startsWith("cn-") ? ".cn" : ""}`;
  return current;
}
function CloudIcon({ storage = false }: { storage?: boolean }) {
  return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {storage ? <><rect x="3" y="3" width="18" height="18" rx="3" /><path d="M3 9h18M7 6h.01M7 13h4M7 17h4" /></>
      : <path d="M6 19a4.5 4.5 0 0 1-.8-8.9A7 7 0 0 1 18.8 9 5 5 0 0 1 18 19Z" />}
  </svg>;
}
function safeMessage(error: unknown): string {
  if (!(error instanceof StorageSettingsError)) return "操作暂未完成，请重新读取配置后再试。";
  if (error.status === 401 || error.status === 403) return "登录已失效或没有操作权限，请重新登录。";
  if (error.status === 409) return "配置已变化或当前有操作正在进行。未保存的内容仍在，请重新读取后再操作。";
  if (error.status === 503) return "对象存储设置尚未就绪，请由服务器管理员完成安全配置初始化。当前存储不会被切换。";
  if (error.status === 400 || error.status === 422) return "配置未通过检查，请核对地域、存储桶、服务地址和凭据。";
  return "没有收到可靠的操作回执，结果暂未确认。请先重新读取状态，不要重复提交。";
}

export function StorageSettings() {
  const client = useMemo(() => createStorageSettingsClient(), []);
  const [view, setView] = useState<StorageSettingsView | null>(null);
  const [form, setForm] = useState<Form>({ ...DEFAULTS.cos });
  const [baseline, setBaseline] = useState("");
  const [replaceKeys, setReplaceKeys] = useState(true);
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [busy, setBusy] = useState("读取配置");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mustReload, setMustReload] = useState(false);
  const [confirm, setConfirm] = useState<"activate" | "reload" | null>(null);
  const [clock, setClock] = useState(Date.now());
  const alive = useRef(false);
  const busyRef = useRef(false);
  const dialog = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const restoreFocus = useRef(false);
  const saved = view?.draft ?? view?.active;
  const canKeepKeys = !!saved?.hasCredentials && form.provider === saved.provider;
  const changed = JSON.stringify(form) !== baseline || (canKeepKeys && replaceKeys) || !!accessKeyId || !!secretAccessKey;
  const validTest = !!view && view.test.status === "passed" && !!view.test.expiresAt && Date.parse(view.test.expiresAt) > clock;
  const isActive = !!view?.draft?.id && view.draft.id === view.active.id;
  const locked = !!busy || mustReload || !view;
  const canTest = !locked && !changed && !!view?.draft;
  const canActivate = canTest && validTest && !isActive;

  function install(next: StorageSettingsView) {
    const selected = next.draft ?? next.active;
    const nextForm = formOf(selected);
    setView(next); setForm(nextForm); setBaseline(JSON.stringify(nextForm));
    setReplaceKeys(!selected.hasCredentials); setAccessKeyId(""); setSecretAccessKey(""); setMustReload(false);
    setClock(Date.now());
  }

  useEffect(() => {
    alive.current = true;
    let current = true;
    void client.read().then((next) => { if (current) install(next); })
      .catch((cause: unknown) => { if (current) setError(safeMessage(cause)); })
      .finally(() => { if (current) setBusy(""); });
    return () => { current = false; alive.current = false; };
  }, [client]);
  useEffect(() => {
    if (!view?.test.expiresAt || view.test.status !== "passed") return;
    const remaining = Date.parse(view.test.expiresAt) - Date.now();
    if (remaining <= 0) { setClock(Date.now()); return; }
    const timer = setTimeout(() => setClock(Date.now()), Math.min(remaining + 20, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [view]);
  const closeDialog = () => { restoreFocus.current = true; setConfirm(null); };
  useModalKeyboard(!!confirm, dialog, closeDialog);
  useEffect(() => {
    if (confirm) dialog.current?.querySelector<HTMLButtonElement>("button")?.focus();
    else if (restoreFocus.current) { restoreFocus.current = false; opener.current?.focus(); }
  }, [confirm]);
  function openDialog(kind: "activate" | "reload") {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setConfirm(kind);
  }

  async function run(kind: "read" | "save" | "test" | "activate") {
    if (busyRef.current || (kind !== "read" && locked)) return;
    if (kind === "test" && !canTest) return;
    // Recheck wall time at the actual click; a suspended tab must not reuse an expired test.
    if (kind === "activate" && (!canActivate || Date.parse(view!.test.expiresAt!) <= Date.now())) { setClock(Date.now()); return; }
    const payload = { ...form, expectedRevision: view?.revision ?? 0,
      secretAction: replaceKeys || !canKeepKeys ? "replace" as const : "keep" as const,
      ...((replaceKeys || !canKeepKeys) ? { accessKeyId, secretAccessKey } : {}) };
    if (kind === "save" && !storageDraftUpdateSchema.safeParse(payload).success) {
      setError("请填写有效的存储桶、地域和服务地址；更换凭据时需同时填写访问 ID 与密钥，目录前缀只能包含字母、数字、横线、下划线和 /。"); return;
    }
    busyRef.current = true;
    setBusy(({ read: "读取配置", save: "保存草稿", test: "检测连接", activate: "启用配置" })[kind]);
    setError(""); setNotice(""); setConfirm(null);
    try {
      const next = kind === "read" ? await client.read() : kind === "save" ? await client.save(payload)
        : kind === "test" ? await client.test(view!.revision) : await client.activate(view!.revision);
      if (!alive.current) return;
      install(next);
      setNotice(kind === "save" ? "草稿已保存。当前存储未改变，请检测连接。"
        : kind === "test" ? next.test.status === "passed" ? "连接检测通过，15 分钟内可启用此版本。" : "连接检测未通过，配置未启用。请核对参数及存储桶权限后重新检测。"
          : kind === "activate" ? "配置已启用。新文件使用新存储，已有文件保留原存储引用。" : "已重新读取最新配置。");
    } catch (cause) {
      if (!alive.current) return;
      setError(safeMessage(cause));
      if (kind !== "read" && (!(cause instanceof StorageSettingsError) || cause.status === 0 || cause.status === 409 || cause.status >= 500)) setMustReload(true);
      if (cause instanceof StorageSettingsError && (cause.status === 401 || cause.status === 403)) { setView(null); setMustReload(true); }
    } finally {
      busyRef.current = false;
      if (alive.current) { setBusy(""); setAccessKeyId(""); setSecretAccessKey(""); }
    }
  }

  function changeProvider(provider: StorageProvider) {
    if (locked || provider === form.provider) return;
    setForm(saved?.provider === provider ? formOf(saved) : { ...DEFAULTS[provider] });
    setReplaceKeys(!(saved?.provider === provider && saved.hasCredentials));
    setAccessKeyId(""); setSecretAccessKey(""); setError(""); setNotice("");
  }
  function update<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((current) => ({ ...current, [key]: value,
      ...(key === "region" ? { endpoint: endpointOf(current.provider, String(value), current.endpoint) } : {}) }));
    setNotice("");
  }
  function submit(event: FormEvent) { event.preventDefault(); void run("save"); }
  const keyLabel = form.provider === "cos" ? "SecretId" : "Access Key ID";
  const secretLabel = form.provider === "cos" ? "SecretKey" : "Access Key Secret";
  const testLabel = !view?.draft || changed ? "未检测" : view.test.status === "passed" ? validTest ? "检测通过" : "检测已过期" : view.test.status === "failed" ? "检测失败" : "未检测";

  return <CreatorShell activePath="/settings/storage"><main className={styles.page}>
    <header className={styles.heading}><h1>对象存储设置</h1><p>配置图片、配音和视频素材的存放位置。</p></header>
    {error ? <div className={styles.notice} data-error="true" role="alert"><p>{error}</p>
      <button className={styles.button} disabled={!!busy} onClick={() => changed && view ? openDialog("reload") : void run("read")}>重新读取配置</button></div> : null}
    {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
    {busy === "读取配置" ? <p role="status">正在读取配置…</p> : null}
    <fieldset className={styles.providers} disabled={locked} aria-label="存储服务商">
      {PROVIDERS.map((provider) => <label key={provider.key} className={styles.provider}>
        <CloudIcon storage={provider.key === "minio"} /><span>{provider.label}</span>
        <input type="radio" name="storage-provider" value={provider.key} checked={form.provider === provider.key} onChange={() => changeProvider(provider.key)} />
      </label>)}
    </fieldset>
    <div className={styles.layout}>
      <section className={styles.panel} aria-labelledby="storage-config-heading">
        <div className={styles.panelTitle}><h2 id="storage-config-heading">{labelOf(form.provider)} 配置</h2>
          <span className={styles.badge} data-tone={!changed && isActive ? "success" : "warning"}>{!view ? "配置未读取" : changed ? "有未保存修改" : isActive ? "当前已启用" : view.draft ? "草稿 · 未启用" : "尚未保存草稿"}</span></div>
        <p className={styles.muted}>填写连接参数，保存后检测连接。</p>
        <form onSubmit={submit}>
          <div className={styles.formGrid}>
            <label className={styles.field}><span>存储桶 Bucket <span className={styles.required}>*</span></span>
              <input className={styles.input} value={form.bucket} onChange={(event) => update("bucket", event.target.value)} disabled={locked} maxLength={63} required placeholder={form.provider === "cos" ? "例如 hongguo-media-1250000000" : "例如 hongguo-media"} autoComplete="off" /></label>
            <label className={styles.field}><span>所属地域 Region <span className={styles.required}>*</span></span>
              <input className={styles.input} value={form.region} onChange={(event) => update("region", event.target.value)} disabled={locked} required maxLength={64} autoComplete="off" /></label>
            <label className={`${styles.field} ${styles.wide}`}>服务地址 Endpoint
              <input className={styles.input} value={form.endpoint} onChange={(event) => update("endpoint", event.target.value)} disabled={locked} readOnly={form.provider !== "minio"} type="url" required placeholder="https://storage.example.com" maxLength={512} autoComplete="off" /></label>
            {canKeepKeys ? <label className={`${styles.check} ${styles.wide}`}><input type="checkbox" checked={replaceKeys} disabled={locked} onChange={(event) => { setReplaceKeys(event.target.checked); setAccessKeyId(""); setSecretAccessKey(""); }} />更换已保存的凭据（不勾选则保留）</label> : null}
            <label className={styles.field}><span>{keyLabel} <span className={styles.required}>*</span></span>
              <input className={styles.input} type="password" value={accessKeyId} onChange={(event) => setAccessKeyId(event.target.value)} disabled={locked || (canKeepKeys && !replaceKeys)} required={!canKeepKeys || replaceKeys} maxLength={256} autoComplete="new-password" spellCheck={false} placeholder={canKeepKeys && !replaceKeys ? "已配置，不回显" : `填写 ${keyLabel}`} /></label>
            <label className={styles.field}><span>{secretLabel} <span className={styles.required}>*</span></span>
              <input className={styles.input} type="password" value={secretAccessKey} onChange={(event) => setSecretAccessKey(event.target.value)} disabled={locked || (canKeepKeys && !replaceKeys)} required={!canKeepKeys || replaceKeys} minLength={8} maxLength={256} autoComplete="new-password" spellCheck={false} placeholder={canKeepKeys && !replaceKeys ? "已配置，不回显" : `填写 ${secretLabel}`} /></label>
            <p className={`${styles.secretNote} ${styles.wide}`}>密钥仅在服务端加密保存，不回显。更换时需同时填写两个凭据。</p>
            <label className={`${styles.field} ${styles.wide}`}>文件目录前缀
              <input className={styles.input} value={form.prefix} onChange={(event) => update("prefix", event.target.value)} disabled={locked} placeholder="例如 hongguo/（可留空）" maxLength={180} autoComplete="off" /></label>
            {form.provider === "minio" ? <p className={`${styles.secretNote} ${styles.wide}`}>寻址方式：路径式。本版本的 MinIO 配置使用路径式寻址。</p> : null}
          </div>
          <div className={styles.access}><span>访问方式</span><strong>私有存储</strong><span>通过本站登录鉴权后预览与下载</span></div>
          <div className={styles.actions}>
            <button className={`${styles.button} ${styles.primary}`} type="submit" disabled={locked}>{busy === "保存草稿" ? "正在保存…" : "保存草稿"}</button>
            <button className={styles.button} type="button" disabled={!canTest} onClick={() => void run("test")}>{busy === "检测连接" ? "正在检测…" : "检测连接"}</button>
            <button className={styles.button} type="button" disabled={!canActivate} onClick={() => openDialog("activate")}>{busy === "启用配置" ? "正在启用…" : "启用此配置"}</button>
          </div>
          <p className={styles.bottomNote}>检测会写入、读回并清理一个临时测试文件，可能产生少量存储请求费用。检测通过后 15 分钟内可启用该版本；修改参数需重新保存、检测。</p>
        </form>
      </section>
      <aside className={styles.panel} aria-label="存储状态">
        <h2>当前使用</h2>
        {view ? <><div className={styles.sideTitle}><CloudIcon storage={view.active.provider === "minio"} />{labelOf(view.active.provider)}</div>
          <dl className={styles.facts}><dt>存储桶</dt><dd>{view.active.bucket}</dd><dt>所属地域</dt><dd>{view.active.region}</dd>
            <dt>配置来源</dt><dd>{view.active.source === "environment" ? "服务器配置" : "已启用配置"}</dd><dt>访问方式</dt><dd>本站登录鉴权</dd></dl></> : <p className={styles.muted}>尚未读取到当前配置。</p>}
        <hr className={styles.divider} /><h3>待切换配置</h3>
        <div className={styles.sideTitle}><CloudIcon />{labelOf(form.provider)}</div>
        <dl className={styles.facts}><dt>连接检测</dt><dd><span className={styles.badge} data-tone={testLabel === "检测通过" ? "success" : "warning"}>{testLabel}</span></dd></dl>
        <p className={styles.bottomNote}>保存草稿不会更换当前存储。</p>
        <div className={styles.rules}><h3>切换规则</h3><ul><li>启用后，新文件写入新存储</li><li>已有文件保留原存储引用</li><li>已开始上传的文件继续使用原配置</li></ul></div>
        <p className={styles.bottomNote}>历史文件迁移单独处理。已生成的本地成片保留原下载方式。</p>
        <p className={styles.bottomNote}>自定义 CDN 域名暂未开放，避免绕过私有素材的访问权限。</p>
      </aside>
    </div>
    {confirm ? <div className={styles.modalBackdrop}><div ref={dialog} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="storage-confirm-title">
      <h2 id="storage-confirm-title">{confirm === "activate" ? "启用新的存储配置？" : "重新读取最新配置？"}</h2>
      <p>{confirm === "activate" ? `新的素材将写入 ${labelOf(form.provider)} 的 ${form.bucket}。已有文件仍从原存储读取，不会自动搬迁。` : "未保存的参数修改将被丢弃，凭据输入会清空。"}</p>
      <div className={styles.actions}><button className={styles.button} onClick={closeDialog}>取消</button>
        <button className={`${styles.button} ${styles.primary}`} onClick={() => void run(confirm === "activate" ? "activate" : "read")}>{confirm === "activate" ? "确认启用" : "重新读取"}</button></div>
    </div></div> : null}
  </main></CreatorShell>;
}
