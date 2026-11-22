"use client";

import { useEffect, useMemo, useState } from "react";
import {
  type AdminModelsView,
  type AdminProviderView,
  type FeatureConfigView,
  type TitleWritingProviderKey,
} from "@ai-drama/contracts";
import { MODEL_CANDIDATES } from "../lib/admin-model-catalog";
import { AdminFrame, AdminGateView, useOperatorGate } from "./admin-access";
import {
  AI_MODELS_CATALOG_HREF,
  AI_MODEL_VENDORS,
  SAVED_SECRET_MASK,
  aiModelVendor,
  isAiModelVendorId,
  type AiModelVendorDef,
  type AiModelVendorId,
} from "../lib/ai-model-vendors";
import { createAdminModelsClient, AdminApiError } from "../lib/admin-models-client";
import { createFeatureConfigClient, featureErrorCopy } from "../lib/feature-config-client";
import styles from "./ai-model-vendors.module.css";

const VAULT_VENDORS: readonly TitleWritingProviderKey[] = ["openai", "anthropic", "deepseek"];

function isVaultVendor(id: AiModelVendorId): id is TitleWritingProviderKey {
  return (VAULT_VENDORS as readonly string[]).includes(id);
}

function modelLabel(vendor: AiModelVendorId, id: string): string {
  if (isVaultVendor(vendor)) {
    const found = MODEL_CANDIDATES[vendor].find((item) => item.id === id);
    if (found) return found.name;
  }
  if (vendor === "bailian" && id === "qwen-plus") return "通义千问 Plus";
  return id;
}

function providerOf(
  models: AdminModelsView | null,
  id: TitleWritingProviderKey,
): AdminProviderView | null {
  return models?.saved.providers.find((item) => item.providerKey === id) ?? null;
}

function defaultModel(
  models: AdminModelsView | null,
  features: FeatureConfigView | null,
  id: AiModelVendorId,
): { id: string; label: string } | null {
  if (id === "bailian") {
    return featureBound(features, "bailian") ? { id: "qwen-plus", label: "通义千问 Plus" } : null;
  }
  if (!isVaultVendor(id)) return null;
  const saved = providerOf(models, id)?.models[0];
  return saved ? { id: saved, label: modelLabel(id, saved) } : null;
}

/**
 * The vault replaces a provider's whole model list on save. Keep every configured model and only move the chosen
 * default to the front, so saving a credential never deletes other models.
 */
export function preservedModels(existing: readonly string[], chosen: string): string[] {
  if (!chosen) return [...existing];
  return [chosen, ...existing.filter((item) => item !== chosen)].slice(0, 10);
}

/** Neutral copy when the saved vendor config is not yet what the running API uses. Never implies 连接正常. */
export function activationCopy(view: AdminModelsView | null): string | null {
  if (!view) return null;
  if (view.activationDeferred) {
    return "配置已保存，应用已推迟：有创作任务尚未结束，运行中的服务继续使用原有凭证。";
  }
  if (view.pendingRestart) {
    return "配置已保存，尚未生效：运行中的服务仍使用原有凭证，需由部署流程受控重启 API 后才会使用新凭证。";
  }
  return null;
}

function secretCopy(configured: boolean, label: string): string {
  return configured ? `${label} 项目密钥  ${SAVED_SECRET_MASK}` : "未绑定";
}

function featureBound(features: FeatureConfigView | null, vendor: AiModelVendorId): boolean {
  return Boolean(
    features?.features.some((card) =>
      card.slots.some((slot) => slot.vendor === vendor && slot.keyConfigured),
    ),
  );
}

export function AiModelCatalog() {
  const modelsClient = useMemo(() => createAdminModelsClient(), []);
  const featureClient = useMemo(() => createFeatureConfigClient(), []);
  const { gate, reload } = useOperatorGate();
  const [models, setModels] = useState<AdminModelsView | null>(null);
  const [features, setFeatures] = useState<FeatureConfigView | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (gate !== "ready") return;
    let live = true;
    setFailed(false);
    Promise.all([modelsClient.models(), featureClient.view()])
      .then(([nextModels, nextFeatures]) => {
        if (!live) return;
        setModels(nextModels);
        setFeatures(nextFeatures);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [modelsClient, featureClient, gate]);

  if (gate !== "ready") {
    return (
      <AdminFrame>
        <CatalogIntro />
        <AdminGateView gate={gate} onRetry={gate === "failed" ? reload : undefined} />
      </AdminFrame>
    );
  }
  if (failed) {
    return (
      <AdminFrame>
        <CatalogIntro />
        <AdminGateView
          gate="failed"
          onRetry={() => {
            setFailed(false);
            reload();
          }}
        />
      </AdminFrame>
    );
  }
  if (!models || !features) {
    return (
      <AdminFrame>
        <CatalogIntro />
        <AdminGateView gate="loading" />
      </AdminFrame>
    );
  }

  return (
    <AdminFrame>
      <CatalogIntro />
      <section className={styles.table} aria-label="模型供应商">
        <div className={styles.columns}>
          <span>供应商</span>
          <span>默认模型</span>
          <span>API 凭证</span>
          <span />
        </div>
        <ul>
          {AI_MODEL_VENDORS.map((vendor) => (
            <CatalogRow key={vendor.id} vendor={vendor} models={models} features={features} />
          ))}
        </ul>
      </section>
    </AdminFrame>
  );
}

function CatalogIntro() {
  return (
    <header className={styles.intro}>
      <div className={styles.introHead}>
        <h1>模型供应商</h1>
      </div>
      <p>按厂商管理模型、密钥和 SDK 接入。</p>
    </header>
  );
}

function CatalogRow({
  vendor,
  models,
  features,
}: {
  vendor: AiModelVendorDef;
  models: AdminModelsView;
  features: FeatureConfigView;
}) {
  const vault = isVaultVendor(vendor.id) ? providerOf(models, vendor.id) : null;
  const configured =
    vendor.id === "bailian" ? featureBound(features, "bailian") : Boolean(vault?.keyConfigured);
  const model = defaultModel(models, features, vendor.id);
  return (
    <li className={styles.row}>
      <div className={styles.vendorCell}>
        <span className={styles.mark} data-vendor={vendor.id}>
          {vendor.mark}
        </span>
        <div>
          <strong>{vendor.label}</strong>
          <small>{vendor.capability}</small>
        </div>
      </div>
      <div>{configured || vendor.id === "bailian" ? (model?.label ?? "未设置") : "未设置"}</div>
      <div>
        {vendor.id === "bailian"
          ? configured
            ? `功能配置已绑定  ${SAVED_SECRET_MASK}`
            : "未绑定"
          : secretCopy(configured, vendor.shortLabel)}
      </div>
      <div className={styles.rowAction}>
        <a href={vendor.href}>进入设置</a>
      </div>
    </li>
  );
}

export function AiModelVendorSettings({ vendorId }: { vendorId: string }) {
  const vendor = isAiModelVendorId(vendorId) ? aiModelVendor(vendorId) : null;
  const modelsClient = useMemo(() => createAdminModelsClient(), []);
  const featureClient = useMemo(() => createFeatureConfigClient(), []);
  const { gate, reload } = useOperatorGate();
  const [models, setModels] = useState<AdminModelsView | null>(null);
  const [features, setFeatures] = useState<FeatureConfigView | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [draftKey, setDraftKey] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [draftModel, setDraftModel] = useState("");
  const [workspace, setWorkspace] = useState("");

  useEffect(() => {
    if (gate !== "ready" || !vendor) return;
    let live = true;
    setFailed(false);
    Promise.all([modelsClient.models(), featureClient.view()])
      .then(([nextModels, nextFeatures]) => {
        if (!live) return;
        setModels(nextModels);
        setFeatures(nextFeatures);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [modelsClient, featureClient, gate, vendor]);

  if (!vendor) {
    return (
      <AdminFrame>
        <p className={styles.fail}>没有这家供应商。</p>
        <a className={styles.back} href={AI_MODELS_CATALOG_HREF}>
          全部供应商
        </a>
      </AdminFrame>
    );
  }
  if (gate !== "ready") {
    return (
      <AdminFrame>
        <SettingsIntro vendor={vendor} />
        <AdminGateView gate={gate} onRetry={gate === "failed" ? reload : undefined} />
      </AdminFrame>
    );
  }
  if (failed) {
    return (
      <AdminFrame>
        <SettingsIntro vendor={vendor} />
        <AdminGateView
          gate="failed"
          onRetry={() => {
            setFailed(false);
            reload();
          }}
        />
      </AdminFrame>
    );
  }
  if (!models || !features) {
    return (
      <AdminFrame>
        <SettingsIntro vendor={vendor} />
        <AdminGateView gate="loading" />
      </AdminFrame>
    );
  }

  const vault = isVaultVendor(vendor.id) ? providerOf(models, vendor.id) : null;
  const configured =
    vendor.id === "bailian" ? featureBound(features, "bailian") : Boolean(vault?.keyConfigured);
  const currentModel = defaultModel(models, features, vendor.id);
  const candidates = isVaultVendor(vendor.id)
    ? MODEL_CANDIDATES[vendor.id]
    : vendor.id === "bailian"
      ? [{ id: "qwen-plus", name: "通义千问 Plus", note: "编剧一期锁定的中国站兼容模型" }]
      : [];
  // Vendor vault has no connection-test receipt. A saved key stays "待测试" after refresh
  // and this page never shows 连接正常.
  const statusCopy = configured ? "密钥已保存 · 连接待测试" : "未绑定";

  async function save() {
    if (!vendor || !isVaultVendor(vendor.id) || !models || busy) return;
    const modelsToSave = preservedModels(vault?.models ?? [], draftModel);
    const secretAction =
      replacing && draftKey.trim().length >= 8 ? ("replace" as const) : ("keep" as const);
    if (replacing && secretAction !== "replace") {
      setError("请填写这一家服务商的 API Key。");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const next = await modelsClient.provider(vendor.id, {
        expectedRevision: models.savedRevision,
        models: modelsToSave,
        secretAction,
        ...(secretAction === "replace" ? { apiKey: draftKey.trim() } : {}),
        ...(vendor.id === "anthropic" && secretAction === "replace"
          ? workspace.trim()
            ? { workspaceAction: "replace" as const, workspaceId: workspace.trim() }
            : { workspaceAction: "clear" as const }
          : vendor.id === "anthropic"
            ? { workspaceAction: "keep" as const }
            : {}),
      });
      setModels(next);
      setDraftKey("");
      setReplacing(false);
      setEditing(false);
      setNotice(secretAction === "replace" ? "密钥已保存 · 连接待测试" : "配置已保存。");
    } catch (caught) {
      setError(caught instanceof AdminApiError ? "这份配置无法保存。" : featureErrorCopy(caught));
    } finally {
      setBusy(false);
    }
  }

  function openEdit() {
    setDraftModel(currentModel?.id ?? candidates[0]?.id ?? "");
    setDraftKey("");
    setReplacing(!configured);
    setWorkspace(vault?.workspaceId ?? "");
    setError("");
    setEditing(true);
  }

  return (
    <AdminFrame>
      <a className={styles.back} href={AI_MODELS_CATALOG_HREF}>
        全部供应商
      </a>
      <SettingsIntro vendor={vendor} />
      <section className={styles.current} aria-label="当前配置">
        <div className={styles.currentHead}>
          <h2>当前配置</h2>
          <button
            type="button"
            className={styles.primary}
            onClick={openEdit}
            disabled={vendor.id === "bailian"}
          >
            编辑设置
          </button>
        </div>
        <dl className={styles.facts}>
          <div>
            <dt>默认模型</dt>
            <dd>{currentModel?.label ?? "未设置"}</dd>
          </div>
          <div>
            <dt>API 凭证</dt>
            <dd>
              {vendor.id === "bailian"
                ? configured
                  ? `功能配置已绑定  ${SAVED_SECRET_MASK}`
                  : "未绑定"
                : secretCopy(configured, vendor.shortLabel)}
            </dd>
          </div>
          <div>
            <dt>配置状态</dt>
            <dd>{vendor.id === "bailian" ? (configured ? "按功能绑定" : "未绑定") : statusCopy}</dd>
          </div>
        </dl>
        {vendor.id === "bailian" ? (
          <p className={styles.hint}>
            阿里云百炼的密钥目前按功能保存在功能配置中，没有供应商级凭证仓。请到
            <a href="/admin/features?feature=writing"> 功能配置 → 编剧 </a>
            保存或测试写作凭证。本页不会把未接入的能力画成已接通。
          </p>
        ) : (
          <p className={styles.hint}>
            密钥只显示掩码。保存成功后，在实际检测通过前显示「密钥已保存 ·
            连接待测试」，不会显示「连接正常」。
          </p>
        )}
        {notice ? (
          <p className={styles.banner} role="status">
            {notice}
          </p>
        ) : null}
        {isVaultVendor(vendor.id) && configured && activationCopy(models) ? (
          <p className={styles.banner} role="note" data-state="pending-activation">
            {activationCopy(models)}
          </p>
        ) : null}
      </section>
      {vendor.sdk ? (
        <section className={styles.sdk} aria-label="SDK">
          <div>
            <h2>Vercel AI SDK</h2>
            <p>{vendor.sdk}</p>
          </div>
          <button
            type="button"
            className={styles.secondary}
            disabled
            title="隔离环境不会对供应商发出真实预览调用"
          >
            预览调用
          </button>
        </section>
      ) : (
        <section className={styles.sdk} aria-label="SDK">
          <div>
            <h2>SDK 接入</h2>
            <p>这家供应商目前没有供应商级 SDK 预览，写作走功能配置中的已接入适配器。</p>
          </div>
        </section>
      )}
      <section className={styles.models} aria-label="可选模型">
        <h2>可选模型</h2>
        <ul>
          {candidates.map((item) => (
            <li key={item.id}>
              <span>{item.name}</span>
              <code>{item.id}</code>
            </li>
          ))}
        </ul>
      </section>
      {editing && isVaultVendor(vendor.id) ? (
        <div className={styles.modal}>
          <div className={styles.drawer} role="dialog" aria-modal="true" aria-label="编辑设置">
            <div className={styles.drawerHead}>
              <h2>编辑设置</h2>
              <button
                type="button"
                className={styles.quiet}
                onClick={() => setEditing(false)}
                disabled={busy}
              >
                取消
              </button>
            </div>
            <label className={styles.field}>
              <span>默认模型</span>
              <select
                aria-label="默认模型"
                value={draftModel}
                disabled={busy}
                onChange={(event) => setDraftModel(event.target.value)}
              >
                {candidates.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
            <div className={styles.field}>
              <span>API 凭证</span>
              {configured && !replacing ? (
                <div className={styles.keyRow}>
                  <span aria-label="已保存密钥">{SAVED_SECRET_MASK}</span>
                  <button type="button" onClick={() => setReplacing(true)}>
                    更换
                  </button>
                </div>
              ) : (
                <input
                  aria-label="API Key"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  value={draftKey}
                  disabled={busy}
                  onChange={(event) => setDraftKey(event.target.value)}
                />
              )}
            </div>
            {vendor.id === "anthropic" && (replacing || !configured) ? (
              <label className={styles.field}>
                <span>Workspace ID（可选）</span>
                <input
                  aria-label="Workspace ID"
                  value={workspace}
                  disabled={busy}
                  onChange={(event) => setWorkspace(event.target.value)}
                />
              </label>
            ) : null}
            {error ? (
              <p className={styles.fail} role="alert">
                {error}
              </p>
            ) : null}
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.primary}
                disabled={busy}
                onClick={() => void save()}
              >
                {busy ? "正在保存…" : "保存凭证"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </AdminFrame>
  );
}

function SettingsIntro({ vendor }: { vendor: AiModelVendorDef }) {
  return (
    <header className={styles.intro}>
      <div className={styles.vendorTitle}>
        <span className={styles.mark} data-vendor={vendor.id}>
          {vendor.mark}
        </span>
        <div>
          <div className={styles.introHead}>
            <h1>{vendor.label}</h1>
          </div>
          <p>供应商设置</p>
        </div>
      </div>
    </header>
  );
}
