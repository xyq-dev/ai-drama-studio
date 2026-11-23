"use client";

import { useEffect, useRef, useState } from "react";
import {
  BAILIAN_PLAN_KEY_MESSAGE,
  isBailianPlanKey,
  isBailianWorkspaceId,
  WRITING_MODEL_CHANNELS,
  type AdminVendorCheckResult,
  type AdminVendorView,
} from "@ai-drama/contracts";
import { AdminFrame, AdminGateView, useOperatorGate } from "./admin-access";
import {
  AI_MODELS_CATALOG_HREF,
  AI_MODEL_VENDORS,
  SAVED_SECRET_MASK,
  aiModelVendor,
  type AiModelVendorDef,
  type AiModelVendorId,
} from "../lib/ai-model-vendors";
import { createAdminModelsClient, AdminApiError } from "../lib/admin-models-client";
import { useModalKeyboard } from "../lib/modal-keyboard";
import { ModelSelect } from "./model-select";
import styles from "./ai-model-vendors.module.css";

type Client = ReturnType<typeof createAdminModelsClient>;
type CheckReceipt = Pick<AdminVendorCheckResult, "status" | "message">;
const UNKNOWN_CHECK: CheckReceipt = { status: "unknown", message: "结果未知" };

function channelLabel(view: AdminVendorView) {
  const official = WRITING_MODEL_CHANNELS[view.vendor];
  return view.channel === official.id ? official.label : view.channel;
}

function emptyCatalogHint(view: AdminVendorView) {
  return view.vendor === "openai" || view.vendor === "anthropic"
    ? "请先为此渠道配置可用模型白名单。"
    : "当前渠道暂无可选模型";
}

function SavedModel({ view }: { view: AdminVendorView }) {
  if (!view.model) return <>未设置</>;
  const selected = view.models.find(({ id }) => id === view.model);
  return selected ? (
    <>{selected.label}</>
  ) : (
    <>
      {view.model}
      <small className={styles.detail}>当前列表不可用</small>
    </>
  );
}

export function AiModelCatalog() {
  return <VendorScreen />;
}

export function AiModelVendorSettings({ vendorId }: { vendorId: string }) {
  const vendor = aiModelVendor(vendorId);
  if (vendor) return <VendorScreen key={vendor.id} vendor={vendor} />;
  return (
    <AdminFrame>
      <p className={styles.fail}>没有这家供应商。</p>
      <BackLink />
    </AdminFrame>
  );
}

function BackLink() {
  return (
    <a className={styles.back} href={AI_MODELS_CATALOG_HREF}>
      全部供应商
    </a>
  );
}

function VendorScreen({ vendor }: { vendor?: AiModelVendorDef }) {
  const [client] = useState(() => createAdminModelsClient());
  const { gate, reload } = useOperatorGate();
  const [views, setViews] = useState<AdminVendorView[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (gate !== "ready") return;
    let current = true;
    setFailed(false);
    const read = vendor ? client.vendor(vendor.id).then((view) => [view]) : client.vendors();
    read
      .then((received) => {
        if (current) setViews(received);
      })
      .catch(() => {
        if (current) setFailed(true);
      });
    return () => {
      current = false;
    };
  }, [client, gate, vendor]);

  const state = gate !== "ready" ? gate : failed ? "failed" : !views ? "loading" : "ready";
  return (
    <AdminFrame>
      {vendor && <BackLink />}
      <header className={styles.intro}>
        {vendor ? (
          <div className={styles.vendorTitle}>
            <span className={styles.mark} data-vendor={vendor.id}>
              {vendor.mark}
            </span>
            <div>
              <h1>{vendor.label}</h1>
              <p>供应商设置</p>
            </div>
          </div>
        ) : (
          <h1>模型供应商</h1>
        )}
      </header>
      {state !== "ready" ? (
        <AdminGateView gate={state} onRetry={state === "failed" ? reload : undefined} />
      ) : vendor && views?.[0] ? (
        <VendorSettings
          client={client}
          view={views[0]}
          onSave={(next) => {
            if (next.vendor === vendor.id) setViews([next]);
            else window.location.assign(aiModelVendor(next.vendor)!.href);
          }}
        />
      ) : (
        <section className={styles.table} aria-label="模型供应商">
          <div className={styles.columns}>
            <span>供应商</span>
            <span>默认模型</span>
            <span>API 凭证</span>
            <span />
          </div>
          <ul>
            {AI_MODEL_VENDORS.map((item) => {
              const view = views?.find(({ vendor }) => vendor === item.id);
              if (!view) return null;
              return (
                <li key={item.id} className={styles.row}>
                  <div className={styles.vendorCell}>
                    <span className={styles.mark} data-vendor={item.id}>
                      {item.mark}
                    </span>
                    <div>
                      <strong>{item.label}</strong>
                      <small>{view.models.length} 个可选模型</small>
                    </div>
                  </div>
                  <div>
                    <SavedModel view={view} />
                  </div>
                  <div>
                    {view.keyConfigured
                      ? `${item.shortLabel} 项目密钥  ${SAVED_SECRET_MASK}`
                      : "未绑定"}
                  </div>
                  <div className={styles.rowAction}>
                    <a href={item.href}>进入设置</a>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </AdminFrame>
  );
}

function apiError(error: unknown) {
  if (error instanceof AdminApiError) {
    if (error.code === "ADMIN_CONFIG_BAILIAN_PLAN_KEY") return BAILIAN_PLAN_KEY_MESSAGE;
    if (error.code === "ADMIN_CONFIG_BAILIAN_WORKSPACE_FORMAT")
      return "请核对北京地域的业务空间 ID。";
    if (error.status === 409) return "配置已更新，请刷新后再操作。";
    if (error.status === 401 || error.status === 403) return "请使用有配置权限的账号重新登录。";
  }
  return "操作未完成，请检查连接后再试。";
}

function VendorSettings({
  client,
  view,
  onSave,
}: {
  client: Client;
  view: AdminVendorView;
  onSave: (next: AdminVendorView) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [receipt, setReceipt] = useState<CheckReceipt | null>(null);
  const [pendingRevision, setPendingRevision] = useState<number | null>(null);
  const checking = view.revision === pendingRevision;
  const editButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const epoch = useRef(0);
  const pending = useRef(new Set<number>());
  const selected = view.models.some((item) => item.id === view.model);
  const needsWorkspace = view.vendor === "bailian" && !isBailianWorkspaceId(view.workspaceId ?? "");
  const canCheck = view.keyConfigured && selected && !needsWorkspace;
  const status =
    receipt?.message ??
    (!view.keyConfigured
      ? "请先保存密钥"
      : view.model && !selected
        ? "请更换模型后再检测"
        : needsWorkspace && selected
          ? "请先在编辑设置中保存业务空间 ID"
          : "密钥已保存 · 连接待测试");

  useEffect(() => {
    if (!editing && restoreFocus.current) {
      editButton.current?.focus();
      restoreFocus.current = false;
    }
  }, [editing]);

  function invalidate() {
    epoch.current++;
    setReceipt(null);
  }
  async function check() {
    if (!canCheck || !view.model || pending.current.has(view.revision)) return;
    const generation = ++epoch.current;
    pending.current.add(view.revision);
    setPendingRevision(view.revision);
    setReceipt(null);
    try {
      const result = await client.checkVendor(view.vendor, {
        expectedRevision: view.revision,
        channel: view.channel,
        model: view.model,
      });
      if (generation !== epoch.current) return;
      if (
        result.revision !== view.revision ||
        result.vendor !== view.vendor ||
        result.channel !== view.channel ||
        result.model !== view.model ||
        !result.message
      ) {
        setReceipt(UNKNOWN_CHECK);
        return;
      }
      setReceipt({ status: result.status, message: result.message });
    } catch (error) {
      if (generation === epoch.current) {
        setReceipt(
          error instanceof AdminApiError &&
            error.status > 0 &&
            error.status < 500 &&
            error.status !== 408
            ? { status: "failed", message: apiError(error) }
            : UNKNOWN_CHECK,
        );
      }
    } finally {
      pending.current.delete(view.revision);
      setPendingRevision((revision) => (revision === view.revision ? null : revision));
    }
  }
  function close() {
    restoreFocus.current = true;
    setEditing(false);
  }

  return (
    <>
      <section className={styles.current} aria-label="当前配置">
        <div className={styles.currentHead}>
          <h2>当前配置</h2>
          <div className={styles.buttons}>
            <button
              type="button"
              className={styles.secondary}
              disabled={!canCheck || checking}
              aria-describedby="vendor-check-status"
              onClick={() => void check()}
            >
              {checking ? "正在检测…" : "检测连接"}
            </button>
            <button
              ref={editButton}
              type="button"
              className={styles.primary}
              onClick={() => setEditing(true)}
            >
              编辑设置
            </button>
          </div>
        </div>
        <dl className={styles.facts}>
          <div>
            <dt>默认模型</dt>
            <dd>
              {!view.model && view.keyConfigured && view.models.length ? (
                "请先选择并保存模型"
              ) : (
                <SavedModel view={view} />
              )}
            </dd>
          </div>
          <div>
            <dt>API 凭证</dt>
            <dd>{view.keyConfigured ? SAVED_SECRET_MASK : "未绑定"}</dd>
          </div>
          <div>
            <dt>配置状态</dt>
            <dd id="vendor-check-status" role="status" data-outcome={receipt?.status}>
              {checking ? "正在读取模型列表…" : status}
            </dd>
          </div>
        </dl>
      </section>
      <section className={styles.channel} aria-label="接入渠道">
        <h2>接入渠道</h2>
        <span>{channelLabel(view)}</span>
      </section>
      <section className={styles.models} aria-label="可选模型">
        <h2>可选模型</h2>
        {view.models.length ? (
          <ul>
            {view.models.map((item) => (
              <li key={item.id}>
                <span>{item.label}</span>
                <code>{item.id}</code>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.hint}>{emptyCatalogHint(view)}</p>
        )}
      </section>
      {editing && (
        <VendorEditor
          client={client}
          initial={view}
          onChange={invalidate}
          onClose={close}
          onSave={(next) => {
            invalidate();
            close();
            onSave(next);
          }}
        />
      )}
    </>
  );
}

function VendorEditor({
  client,
  initial,
  onClose,
  onSave,
  onChange,
}: {
  client: Client;
  initial: AdminVendorView;
  onClose: () => void;
  onSave: (view: AdminVendorView) => void;
  onChange: () => void;
}) {
  const [vendor, setVendor] = useState(initial.vendor);
  const [view, setView] = useState<AdminVendorView | null>(initial);
  const [model, setModel] = useState(initial.model ?? "");
  const [key, setKey] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [workspace, setWorkspace] = useState(initial.workspaceId ?? "");
  const bailian = vendor === "bailian";
  const planKey = bailian && isBailianPlanKey(key);
  const [error, setError] = useState<{
    field: "key" | "workspace" | "model" | "form";
    text: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const pendingSave = useRef(false);
  const requestNumber = useRef(0);
  const modal = useRef<HTMLDivElement>(null);

  function fieldError(field: "key" | "workspace" | "model" | "form") {
    return (
      error?.field === field && (
        <p className={styles.fail} role="alert" id={`vendor-${field}-error`}>
          {error.text}
        </p>
      )
    );
  }
  function clearField(field: "key" | "workspace" | "model") {
    setError((previous) => (previous?.field === field ? null : previous));
  }

  const dirty = Boolean(
    key || (model && model !== view?.model) || workspace !== (view?.workspaceId ?? ""),
  );
  function cancel() {
    if (!pendingSave.current && (!dirty || window.confirm("放弃未保存的修改？"))) onClose();
  }
  useModalKeyboard(true, modal, cancel);
  useEffect(() => {
    modal.current?.querySelector("select")?.focus();
    return () => {
      requestNumber.current++;
    };
  }, []);

  async function switchVendor(id: AiModelVendorId) {
    const request = ++requestNumber.current;
    setVendor(id);
    setView(null);
    setModel("");
    setKey("");
    setWorkspace("");
    setError(null);
    setReplacing(false);
    onChange();
    try {
      const next = await client.vendor(id);
      if (request !== requestNumber.current) return;
      setView(next);
      setWorkspace(next.workspaceId ?? "");
    } catch (caught) {
      if (request === requestNumber.current) setError({ field: "form", text: apiError(caught) });
    }
  }

  async function save() {
    if (!view || pendingSave.current || planKey) return;
    const secret = key.trim();
    const replace = replacing || secret.length > 0;
    if (replace && (secret.length < 8 || secret.length > 256 || /\s/u.test(secret))) {
      setError({ field: "key", text: "请输入 8 至 256 个不含空格的密钥字符。" });
      return;
    }
    if (!model && (view.model || !replace)) {
      setError({ field: "model", text: "请选择模型" });
      return;
    }
    const spaceId = workspace.trim();
    if (bailian && spaceId && !isBailianWorkspaceId(spaceId)) {
      setError({ field: "workspace", text: "请填写北京地域的业务空间 ID，无需填写网址。" });
      return;
    }
    const updateWorkspace =
      (bailian && (replace || spaceId !== (view.workspaceId ?? ""))) ||
      (vendor === "anthropic" && replace);
    const request = requestNumber.current;
    pendingSave.current = true;
    setSaving(true);
    setError(null);
    try {
      const next = await client.saveVendor(view.vendor, {
        expectedRevision: view.revision,
        channel: view.channel,
        model: model || null,
        secretAction: replace ? "replace" : "keep",
        ...(replace ? { apiKey: secret } : {}),
        ...(updateWorkspace
          ? spaceId
            ? { workspaceAction: "replace", workspaceId: spaceId }
            : { workspaceAction: "clear" }
          : {}),
      });
      if (request === requestNumber.current) onSave(next);
    } catch (caught) {
      if (request !== requestNumber.current) return;
      if (caught instanceof AdminApiError && caught.code === "ADMIN_CONFIG_BAILIAN_PLAN_KEY") {
        setError({ field: "key", text: BAILIAN_PLAN_KEY_MESSAGE });
      } else if (
        caught instanceof AdminApiError &&
        caught.code === "ADMIN_CONFIG_BAILIAN_WORKSPACE_FORMAT"
      ) {
        setError({ field: "workspace", text: apiError(caught) });
      } else if (
        caught instanceof AdminApiError &&
        [
          "ADMIN_CONFIG_KEY_KIND",
          "ADMIN_CONFIG_KEY_FORMAT",
          "ADMIN_CONFIG_DEEPSEEK_KEY_FORMAT",
        ].includes(caught.code)
      ) {
        setError({ field: "key", text: "密钥格式不符，请填写此供应商签发的 API Key。" });
      } else if (
        caught instanceof AdminApiError &&
        caught.code === "ADMIN_CONFIG_WORKSPACE_FORMAT"
      ) {
        setError({ field: "workspace", text: "请核对 Workspace ID 的格式。" });
      } else {
        setError({ field: "form", text: apiError(caught) });
      }
    } finally {
      pendingSave.current = false;
      setSaving(false);
    }
  }

  return (
    <div className={styles.modal}>
      <div
        ref={modal}
        className={styles.drawer}
        role="dialog"
        aria-modal="true"
        aria-label="编辑设置"
      >
        <div className={styles.drawerHead}>
          <h2>编辑设置</h2>
          <button type="button" className={styles.quiet} onClick={cancel} disabled={saving}>
            取消
          </button>
        </div>
        <label className={styles.field}>
          <span>供应商</span>
          <select
            value={vendor}
            disabled={saving}
            onChange={(event) => void switchVendor(event.target.value as AiModelVendorId)}
          >
            {AI_MODEL_VENDORS.map(({ id, label }) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {view && <small className={styles.detail}>{channelLabel(view)}</small>}
        <div className={styles.field}>
          <ModelSelect
            key={vendor}
            label="模型"
            value={model}
            options={view?.models ?? []}
            disabled={saving || !view?.models.length}
            onChange={(value) => {
              setModel(value);
              clearField("model");
              onChange();
            }}
          />
          {fieldError("model")}
          {view && !view.models.length && (
            <small className={styles.detail}>{emptyCatalogHint(view)}</small>
          )}
        </div>
        {view && (
          <>
            <div className={styles.field}>
              <span>API 凭证</span>
              {view.keyConfigured && !replacing ? (
                <div className={styles.keyRow}>
                  <span aria-label="已保存密钥">{SAVED_SECRET_MASK}</span>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => {
                      setReplacing(true);
                      setWorkspace("");
                      clearField("key");
                      onChange();
                    }}
                  >
                    更换
                  </button>
                </div>
              ) : (
                <>
                  <input
                    aria-label="API Key"
                    aria-invalid={planKey || error?.field === "key"}
                    aria-describedby={
                      planKey || error?.field === "key" ? "vendor-key-error" : undefined
                    }
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={key}
                    disabled={saving}
                    onChange={(event) => {
                      setKey(event.target.value);
                      clearField("key");
                      onChange();
                    }}
                  />
                  {replacing && <small className={styles.detail}>保存后将替换现有密钥。</small>}
                </>
              )}
              {planKey ? (
                <p id="vendor-key-error" role="alert" className={styles.fail}>
                  {BAILIAN_PLAN_KEY_MESSAGE}
                </p>
              ) : (
                fieldError("key")
              )}
            </div>
            {(bailian || (vendor === "anthropic" && (replacing || !view.keyConfigured))) && (
              <div className={styles.field}>
                <label htmlFor="vendor-workspace">
                  {bailian ? "业务空间 ID" : "Workspace ID（可选）"}
                </label>
                <input
                  id="vendor-workspace"
                  value={workspace}
                  disabled={saving}
                  spellCheck={false}
                  aria-invalid={error?.field === "workspace"}
                  aria-describedby={
                    error?.field === "workspace"
                      ? "vendor-workspace-error"
                      : bailian && !workspace
                        ? "vendor-workspace-hint"
                        : undefined
                  }
                  onChange={(event) => {
                    setWorkspace(event.target.value);
                    clearField("workspace");
                    onChange();
                  }}
                />
                {bailian && !workspace && error?.field !== "workspace" && (
                  <small id="vendor-workspace-hint" className={styles.detail}>
                    检测连接时需要，请从百炼控制台北京地域复制。
                  </small>
                )}
                {fieldError("workspace")}
              </div>
            )}
          </>
        )}
        {fieldError("form")}
        <div className={styles.actions}>
          {!view && error ? (
            <button
              type="button"
              className={styles.secondary}
              onClick={() => void switchVendor(vendor)}
            >
              重新读取
            </button>
          ) : (
            <button
              type="button"
              className={styles.primary}
              disabled={saving || !view || planKey}
              onClick={() => void save()}
            >
              {saving ? "正在保存…" : "保存设置"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
