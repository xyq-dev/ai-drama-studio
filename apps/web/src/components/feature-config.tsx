"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  FEATURE_KEYS, FEATURE_LABELS, FEATURE_VENDOR_KEYS, featureCapability,
  type FeatureCardView, type FeatureConfigView, type FeatureKey, type FeatureSlotView, type FeatureVendor,
} from "@ai-drama/contracts";
import { AdminFrame, AdminGateView, useOperatorGate } from "./admin-access";
import { createFeatureConfigClient, featureErrorCopy } from "../lib/feature-config-client";
import styles from "./feature-config.module.css";

const FEATURE_ICON: Record<FeatureKey, string> = {
  writing: "/design/tailadmin-v2/icon-script-ai.svg",
  storyboard: "/design/tailadmin-v2/icon-images.svg",
  voice: "/design/tailadmin-v2/icon-status.svg",
};

function ConfigIntro() {
  return (
    <header className={styles.intro}>
      <h1>功能配置</h1>
      <p>分别管理编剧、生图和配音。选择一项，查看线上配置并编辑草稿。</p>
    </header>
  );
}

const CTA: Record<FeatureKey, string> = {
  writing: "配置阿里云编剧",
  storyboard: "配置阿里云生图",
  voice: "配置阿里云配音",
};

const FIRST_BODY: Record<FeatureKey, string> = {
  writing: "选择编剧服务商，填写密钥并测试后即可启用。",
  storyboard: "选择生图服务商，填写密钥并测试后即可启用。",
  voice: "选择配音服务商，填写密钥并测试后即可启用。",
};

/** URL only. Live state is unknown until the view arrives, so a missing feature stays unset. */
function readSelection(): { feature: FeatureKey | null; vendor: FeatureVendor | null } {
  if (typeof window === "undefined") return { feature: null, vendor: null };
  const params = new URLSearchParams(window.location.search);
  const featureValue = params.get("feature");
  const feature = (FEATURE_KEYS as readonly string[]).includes(featureValue ?? "") ? featureValue as FeatureKey : null;
  const vendorValue = params.get("vendor");
  const vendor = feature && (FEATURE_VENDOR_KEYS as readonly string[]).includes(vendorValue ?? "") ? vendorValue as FeatureVendor : null;
  return { feature, vendor };
}

function replaceSelection(feature: FeatureKey, vendor: FeatureVendor | null) {
  const params = new URLSearchParams(window.location.search);
  params.set("feature", feature);
  if (vendor) params.set("vendor", vendor);
  else params.delete("vendor");
  const query = params.toString();
  window.history.replaceState(null, "", query ? `${window.location.pathname}?${query}` : window.location.pathname);
}

export function FeatureConfig() {
  const client = useMemo(() => createFeatureConfigClient(), []);
  const { gate, reload } = useOperatorGate();
  const initial = readSelection();
  const [chosen, setChosen] = useState<FeatureKey | null>(initial.feature);
  const [vendor, setVendor] = useState<FeatureVendor | null>(initial.vendor);
  const [phase, setPhase] = useState<"overview" | "editor">(initial.vendor ? "editor" : "overview");
  const [view, setView] = useState<FeatureConfigView | null>(null);
  const [failed, setFailed] = useState(false);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [replacing, setReplacing] = useState<Record<string, boolean>>({});
  const [models, setModels] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [dialog, setDialog] = useState<"test" | "enable" | "failed" | null>(null);
  const [failureCopy, setFailureCopy] = useState("");
  const busyRef = useRef(false);

  useEffect(() => {
    if (gate !== "ready") return;
    let live = true;
    setFailed(false);
    setView(null);
    client.view().then((next) => { if (live) setView(next); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [client, gate]);

  // Explicit `?feature=` or a later click wins. Otherwise prefer a live feature, then 剧本编写.
  const feature: FeatureKey = chosen ?? view?.features.find((item) => item.live)?.feature ?? "writing";
  const card = view?.features.find((item) => item.feature === feature) ?? null;
  const slot = (vendor ? card?.slots.find((item) => item.vendor === vendor) : null)
    ?? card?.slots.find((item) => item.connected && item.vendor === card.live?.vendor)
    ?? card?.slots.find((item) => item.connected)
    ?? card?.slots[0]
    ?? null;
  const selectedVendor = slot?.vendor ?? null;
  const fieldKey = selectedVendor ? `${feature}:${selectedVendor}` : "";
  const draftKey = fieldKey ? keys[fieldKey] ?? "" : "";
  const replacingKey = fieldKey ? replacing[fieldKey] === true : false;
  const model = fieldKey ? models[fieldKey] ?? slot?.model ?? slot?.models[0]?.id ?? "" : "";
  const enteringKey = Boolean(slot && (replacingKey || !slot.keyConfigured));
  const dirtyModel = Boolean(slot && model && model !== (slot.model ?? slot.models[0]?.id ?? ""));
  const dirtyKey = enteringKey && draftKey.length > 0;
  const needsKey = Boolean(slot?.connected && enteringKey && draftKey.trim().length < 8);
  const canSave = Boolean(slot?.connected && !busy && !needsKey);
  const canTest = Boolean(slot?.connected && slot.keyConfigured && (slot.draftStatus === "saved" || slot.draftStatus === "failed") && !dirtyKey && !dirtyModel && !busy);
  const canEnable = Boolean(slot?.connected && slot.draftStatus === "passed" && slot.testToken && !dirtyKey && !dirtyModel && !busy);

  function selectFeature(next: FeatureKey) {
    setChosen(next);
    setVendor(null);
    setPhase("overview");
    setDialog(null);
    setError("");
    replaceSelection(next, null);
  }

  function selectVendor(next: FeatureVendor) {
    setChosen(feature);
    setVendor(next);
    setPhase("editor");
    setDialog(null);
    setError("");
    replaceSelection(feature, next);
  }

  function beginConfigure() {
    selectVendor("bailian");
  }

  async function save() {
    if (!card || !slot || !view || !canSave || busyRef.current) return;
    busyRef.current = true;
    setBusy("save");
    setError("");
    setNotice("");
    const secretAction = enteringKey && draftKey ? "replace" as const : "keep" as const;
    try {
      const next = await client.saveDraft(feature, {
        expectedRevision: view.revision,
        vendor: slot.vendor,
        model,
        secretAction,
        ...(secretAction === "replace" ? { apiKey: draftKey } : {}),
      });
      setView(next);
      setKeys((current) => ({ ...current, [fieldKey]: "" }));
      setReplacing((current) => ({ ...current, [fieldKey]: false }));
      setNotice("草稿已保存。线上任务仍使用当前生效配置。");
    } catch (caught) {
      setError(featureErrorCopy(caught));
    } finally {
      busyRef.current = false;
      setBusy("");
    }
  }

  async function confirmTest() {
    if (!card || !slot || !view || busyRef.current) return;
    busyRef.current = true;
    setBusy("test");
    setDialog(null);
    setError("");
    try {
      const result = await client.testDraft(feature, {
        expectedRevision: view.revision,
        vendor: slot.vendor,
        confirmCost: true,
      });
      setView(result.view);
      if (!result.probe?.ok) {
        const message = result.probe?.message ?? "";
        setFailureCopy(message && !message.includes(draftKey) ? message : "测试没有通过，草稿已保留，可以重试。");
        setDialog("failed");
      } else {
        setNotice("测试已通过。线上任务仍使用当前生效配置，启用后只影响新任务。");
      }
    } catch (caught) {
      setError(featureErrorCopy(caught));
    } finally {
      busyRef.current = false;
      setBusy("");
    }
  }

  async function confirmEnable() {
    if (!card || !slot?.testToken || !view || busyRef.current) return;
    busyRef.current = true;
    setBusy("enable");
    setDialog(null);
    setError("");
    try {
      const next = await client.enable(feature, {
        expectedRevision: view.revision,
        vendor: slot.vendor,
        testToken: slot.testToken,
      });
      setView(next);
      setNotice("已启用。新任务将使用这一版配置。进行中的任务保持提交时锁定的版本。");
    } catch (caught) {
      setError(featureErrorCopy(caught));
    } finally {
      busyRef.current = false;
      setBusy("");
    }
  }

  if (gate !== "ready") {
    return <AdminFrame><ConfigIntro /><AdminGateView gate={gate} onRetry={gate === "failed" ? reload : undefined} /></AdminFrame>;
  }
  if (failed) {
    return <AdminFrame><ConfigIntro /><AdminGateView gate="failed" onRetry={() => { setFailed(false); reload(); }} /></AdminFrame>;
  }
  if (!view || !card) {
    return <AdminFrame><ConfigIntro /><AdminGateView gate="loading" /></AdminFrame>;
  }

  const extra = vendor ? featureCapability(feature, vendor) : null;
  const showingUnconnected = phase === "editor" && extra !== null && !extra.connected;
  const showingFirst = card.firstTime && phase === "overview";
  const connected = showingUnconnected ? card.slots.find((item) => item.connected) : null;

  return (
    <AdminFrame>
      <ConfigIntro />
      <div className={styles.cards} role="group" aria-label="功能卡" data-state="editor">
        {view.features.map((item) => (
          <button key={item.feature} type="button" className={item.feature === feature ? styles.cardOn : styles.card} onClick={() => selectFeature(item.feature)} aria-pressed={item.feature === feature}>
            <img src={FEATURE_ICON[item.feature]} width={18} height={18} alt="" />
            <strong>{item.label}</strong>
            <small>当前生效</small>
            <span>{item.live ? `${item.live.vendorLabel} · ${item.live.modelLabel}` : "尚未配置"}</span>
          </button>
        ))}
      </div>
      <div className={styles.tabs} role="tablist" aria-label="功能">
        {view.features.map((item) => (
          <button key={item.feature} type="button" role="tab" aria-selected={item.feature === feature} className={item.feature === feature ? styles.tabOn : styles.tab} onClick={() => selectFeature(item.feature)}>
            {item.label}
          </button>
        ))}
      </div>
      {showingUnconnected && extra ? (
        <section className={styles.state} data-state="unconnected">
          <img src="/design/tailadmin-v2/icon-key-round.svg" width={28} height={28} alt="" />
          <h2>该服务商尚未接入</h2>
          <p>{extra.gap ?? "该服务商尚未接入。"}</p>
          <button type="button" className={styles.primary} onClick={() => connected ? selectVendor(connected.vendor) : selectFeature("storyboard")}>
            返回已接入服务商
          </button>
        </section>
      ) : showingFirst ? (
        <section className={styles.state} data-state="first-time">
          <img src="/design/tailadmin-v2/icon-key-round.svg" width={28} height={28} alt="" />
          <h2>尚未配置{FEATURE_LABELS[feature]}</h2>
          <p>{FIRST_BODY[feature]}</p>
          <button type="button" className={styles.primary} onClick={beginConfigure}>{CTA[feature]}</button>
        </section>
      ) : slot ? <Editor
        card={card}
        slot={slot}
        model={model}
        draftKey={draftKey}
        replacing={replacingKey}
        busy={busy}
        canSave={canSave}
        canTest={canTest}
        canEnable={canEnable}
        needsKey={needsKey}
        error={error}
        notice={notice}
        onVendor={selectVendor}
        onModel={(value) => setModels((current) => ({ ...current, [fieldKey]: value }))}
        onKey={(value) => setKeys((current) => ({ ...current, [fieldKey]: value }))}
        onReplace={() => setReplacing((current) => ({ ...current, [fieldKey]: true }))}
        onSave={() => void save()}
        onTest={() => { if (canTest) setDialog("test"); }}
        onEnable={() => { if (canEnable) setDialog("enable"); }}
      /> : null}
      {dialog === "test" && slot ? (
        <div className={styles.modal}>
          <div className={styles.dialog} role="dialog" aria-modal="true" aria-label="确认测试费用">
            <h2>确认测试</h2>
            <p>{slot.label} · {slot.models.find((item) => item.id === model)?.label ?? model}</p>
            <p>规模：{card.probeScale}</p>
            <p>{card.probeCostNote}</p>
            <div className={styles.dialogActions}>
              <button type="button" className={styles.secondary} onClick={() => setDialog(null)}>取消</button>
              <button type="button" className={styles.primary} onClick={() => void confirmTest()}>确认测试</button>
            </div>
          </div>
        </div>
      ) : null}
      {dialog === "failed" ? (
        <div className={styles.modal}>
          <div className={styles.dialog} role="dialog" aria-modal="true" aria-label="测试没有通过">
            <h2>测试没有通过</h2>
            <p>{failureCopy}</p>
            <div className={styles.dialogActions}>
              <button type="button" className={styles.primary} onClick={() => setDialog(null)}>知道了</button>
            </div>
          </div>
        </div>
      ) : null}
      {dialog === "enable" && slot ? (
        <div className={styles.modal}>
          <div className={styles.dialog} role="dialog" aria-modal="true" aria-label="确认启用">
            <h2>确认启用</h2>
            <p>启用后，新的{card.label}任务使用 {slot.label} · {slot.models.find((item) => item.id === model)?.label ?? model}。已经提交的任务保持锁定的版本，不会悄悄切换。</p>
            <div className={styles.dialogActions}>
              <button type="button" className={styles.secondary} onClick={() => setDialog(null)}>取消</button>
              <button type="button" className={styles.primary} onClick={() => void confirmEnable()}>确认启用</button>
            </div>
          </div>
        </div>
      ) : null}
    </AdminFrame>
  );
}

function Editor({
  card, slot, model, draftKey, replacing, busy, canSave, canTest, canEnable, needsKey, error, notice,
  onVendor, onModel, onKey, onReplace, onSave, onTest, onEnable,
}: {
  card: FeatureCardView;
  slot: FeatureSlotView;
  model: string;
  draftKey: string;
  replacing: boolean;
  busy: string;
  canSave: boolean;
  canTest: boolean;
  canEnable: boolean;
  needsKey: boolean;
  error: string;
  notice: string;
  onVendor: (vendor: FeatureVendor) => void;
  onModel: (model: string) => void;
  onKey: (value: string) => void;
  onReplace: () => void;
  onSave: () => void;
  onTest: () => void;
  onEnable: () => void;
}) {
  const badge = slot.draftStatus === "saved" ? "草稿已保存"
    : slot.draftStatus === "passed" ? "测试已通过"
      : slot.draftStatus === "testing" ? "正在测试"
        : slot.draftStatus === "failed" ? "测试未通过"
          : "";
  const bannerLead = slot.draftStatus === "saved" ? "等待测试"
    : slot.draftStatus === "passed" ? "测试已通过"
      : slot.draftStatus === "testing" ? "正在测试"
        : slot.draftStatus === "failed" ? "测试未通过"
          : "";
  const bannerBody = notice || (slot.draftStatus === "saved"
    ? "草稿已保存，线上任务仍使用当前生效配置。"
    : slot.draftStatus === "passed"
      ? "可以启用。线上任务仍使用当前生效配置。"
      : slot.draftStatus === "testing"
        ? "正在测试这一份草稿。"
        : slot.draftStatus === "failed"
          ? (slot.failureMessage || "测试没有通过，草稿已保留，可以重试。")
          : "");
  return (
    <section className={styles.editor} aria-label={`${card.label}草稿`}>
      <div className={styles.editorHead}>
        <h2>{card.label}配置</h2>
        {badge ? <span className={styles.badge}>{badge}</span> : null}
      </div>
      <p className={styles.live}><span>当前生效</span> <strong>{card.live ? `${card.live.vendorLabel} / ${card.live.modelLabel}` : "尚未配置"}</strong></p>
      <p className={styles.vendorLabel}>编辑服务商</p>
      <div className={styles.vendors} role="group" aria-label="服务商">
        {card.slots.map((item) => (
          <button key={item.vendor} type="button" className={item.vendor === slot.vendor ? styles.vendorOn : styles.vendor} aria-pressed={item.vendor === slot.vendor} onClick={() => onVendor(item.vendor)}>
            {item.label}
          </button>
        ))}
      </div>
      <div className={styles.fields}>
        <label className={styles.field}>
          <span>模型</span>
          <select aria-label="模型" value={model} disabled={!slot.connected || busy !== ""} onChange={(event) => onModel(event.target.value)}>
            {slot.models.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>
        <div className={styles.field}>
          <span>API Key · {slot.label} / {card.label}</span>
          {slot.keyConfigured && !replacing ? (
            <div className={styles.keyRow}>
              <span aria-label="已保存密钥">••••••••</span>
              <button type="button" onClick={onReplace}>更换</button>
            </div>
          ) : (
            <input
              aria-label="API Key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={draftKey}
              disabled={busy !== ""}
              onChange={(event) => onKey(event.target.value)}
            />
          )}
        </div>
      </div>
      {needsKey ? <small className={styles.hint}>请填写这一家服务商的 API Key。密钥只在这次保存时发送，页面不会记住它。</small> : null}
      {bannerBody ? (
        <p className={slot.draftStatus === "failed" ? styles.fail : styles.banner} role="status">
          {bannerLead ? <strong>{bannerLead}</strong> : null} {bannerBody}
        </p>
      ) : null}
      {error ? <p className={styles.fail} role="alert">{error}</p> : null}
      <div className={styles.actions}>
        <button type="button" className={styles.secondary} disabled={!canSave} onClick={onSave}>{busy === "save" ? "正在保存…" : "保存草稿"}</button>
        <button type="button" className={styles.primary} disabled={!canTest} onClick={onTest}>{busy === "test" ? "正在测试…" : "测试配置"}</button>
        <button type="button" className={canEnable ? styles.primary : styles.quiet} disabled={!canEnable} onClick={onEnable}>{busy === "enable" ? "正在启用…" : "启用配置"}</button>
      </div>
    </section>
  );
}
