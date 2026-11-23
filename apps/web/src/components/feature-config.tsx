"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  BAILIAN_PLAN_KEY_MESSAGE,
  FEATURE_KEYS,
  FEATURE_VENDOR_KEYS,
  isBailianPlanKey,
  type FeatureCardView,
  type FeatureConfigView,
  type FeatureKey,
  type FeatureSlotView,
  type FeatureVendor,
} from "@ai-drama/contracts";
import { AdminFrame, AdminGateView, useOperatorGate } from "./admin-access";
import { SAVED_SECRET_MASK } from "../lib/ai-model-vendors";
import { ModelSelect } from "./model-select";
import { useModalKeyboard } from "../lib/modal-keyboard";
import {
  FeatureApiError,
  createFeatureConfigClient,
  featureErrorCopy,
} from "../lib/feature-config-client";
import styles from "./feature-config.module.css";

const PAGE_LABEL: Record<FeatureKey, string> = {
  writing: "编剧",
  storyboard: "生图",
  voice: "配音",
};

type PageTab = FeatureKey | "video";

function ConfigIntro() {
  return (
    <header className={styles.intro}>
      <h1>模型与密钥</h1>
    </header>
  );
}

/** URL only. Live state is unknown until the view arrives, so a missing feature stays unset. */
function readSelection(): { feature: FeatureKey | null; vendor: FeatureVendor | null } {
  if (typeof window === "undefined") return { feature: null, vendor: null };
  const params = new URLSearchParams(window.location.search);
  const featureValue = params.get("feature");
  const feature = (FEATURE_KEYS as readonly string[]).includes(featureValue ?? "")
    ? (featureValue as FeatureKey)
    : null;
  const vendorValue = params.get("vendor");
  const vendor =
    feature && (FEATURE_VENDOR_KEYS as readonly string[]).includes(vendorValue ?? "")
      ? (vendorValue as FeatureVendor)
      : null;
  return { feature, vendor };
}

function replaceSelection(feature: FeatureKey, vendor: FeatureVendor | null) {
  const params = new URLSearchParams(window.location.search);
  params.set("feature", feature);
  if (vendor) params.set("vendor", vendor);
  else params.delete("vendor");
  const query = params.toString();
  window.history.replaceState(
    null,
    "",
    query ? `${window.location.pathname}?${query}` : window.location.pathname,
  );
}

function liveMatches(card: FeatureCardView, slot: FeatureSlotView): boolean {
  if (typeof slot.isLive === "boolean") return slot.isLive;
  return Boolean(card.live && card.live.vendor === slot.vendor && card.live.model === slot.model);
}

function pendingDraft(card: FeatureCardView): FeatureSlotView | null {
  return (
    card.slots.find(
      (item) =>
        item.draftStatus === "saved" ||
        item.draftStatus === "failed" ||
        item.draftStatus === "unknown" ||
        item.draftStatus === "testing" ||
        (item.draftStatus === "passed" && !liveMatches(card, item)),
    ) ?? null
  );
}

const DRAFT_STATUS_LABEL = {
  saved: "草稿未启用",
  testing: "正在检测…",
  failed: "检测未通过",
  unknown: "结果未知",
  passed: "检测通过",
};

function formError(caught: unknown) {
  return {
    message: featureErrorCopy(caught),
    code: caught instanceof FeatureApiError ? caught.code : undefined,
  };
}

export function FeatureConfig() {
  const client = useMemo(() => createFeatureConfigClient(), []);
  const { gate, reload } = useOperatorGate();
  const initial = readSelection();
  const [chosen, setChosen] = useState<PageTab | null>(initial.feature);
  const [vendor, setVendor] = useState<FeatureVendor | null>(initial.vendor);
  const [editing, setEditing] = useState(false);
  const [view, setView] = useState<FeatureConfigView | null>(null);
  const [failed, setFailed] = useState(false);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [replacing, setReplacing] = useState<Record<string, boolean>>({});
  const [editedModel, setEditedModel] = useState<string | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<{ message: string; code?: string; unknown?: boolean } | null>(
    null,
  );
  const [dialog, setDialog] = useState<"test" | "enable" | null>(null);
  const selectionVersion = useRef(0);
  const priorVendor = useRef<FeatureVendor | null>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalKeyboard(editing && !dialog, drawerRef, cancelEdit);
  useModalKeyboard(Boolean(dialog), dialogRef, () => setDialog(null));
  const busyRef = useRef(false);

  useEffect(() => {
    if (!editing) return;
    const opener = document.activeElement;
    drawerRef.current?.querySelector<HTMLElement>("button")?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [editing]);

  useEffect(() => {
    if (!dialog) return;
    const trigger = document.activeElement;
    dialogRef.current?.querySelector<HTMLElement>("button")?.focus();
    return () => {
      if (
        trigger instanceof HTMLElement &&
        trigger.isConnected &&
        drawerRef.current?.contains(trigger)
      ) {
        trigger.focus();
      } else {
        drawerRef.current?.querySelector<HTMLElement>("button")?.focus();
      }
    };
  }, [dialog]);

  useEffect(() => {
    if (gate !== "ready") return;
    let live = true;
    setFailed(false);
    setView(null);
    client
      .view()
      .then((next) => {
        if (live) setView(next);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [client, gate]);

  // Explicit `?feature=` or a later click wins. Otherwise prefer a live feature, then 剧本编写.
  const feature: FeatureKey =
    (chosen && chosen !== "video" ? chosen : null) ??
    view?.features.find((item) => item.live)?.feature ??
    "writing";
  const card = view?.features.find((item) => item.feature === feature) ?? null;
  const slot =
    (vendor ? card?.slots.find((item) => item.vendor === vendor) : null) ??
    (card ? pendingDraft(card) : null) ??
    card?.slots.find((item) => item.connected && item.vendor === card.live?.vendor) ??
    card?.slots.find((item) => item.connected) ??
    card?.slots[0] ??
    null;
  const selectedVendor = slot?.vendor ?? null;
  const fieldKey = selectedVendor ? `${feature}:${selectedVendor}` : "";
  const draftKey = fieldKey ? (keys[fieldKey] ?? "") : "";
  const replacingKey = fieldKey ? replacing[fieldKey] === true : false;
  const savedModel =
    slot?.model ?? (card?.live?.vendor === selectedVendor ? card?.live?.model : "") ?? "";
  const model = editing ? (editedModel ?? savedModel) : savedModel;
  const available = Boolean(slot?.models.some((entry) => entry.id === model));
  const canBindVendor = Boolean(
    slot?.connected && !slot.keyConfigured && slot.vendorKeyConfigured && !replacingKey,
  );
  const enteringKey = Boolean(
    slot && (replacingKey || (!slot.keyConfigured && !slot.vendorKeyConfigured)),
  );
  const planKey =
    feature === "writing" && selectedVendor === "bailian" && isBailianPlanKey(draftKey);
  const keyError =
    planKey || error?.code === "FEATURE_BAILIAN_PLAN_KEY" ? BAILIAN_PLAN_KEY_MESSAGE : null;
  const needsKey = Boolean(slot?.connected && enteringKey && draftKey.trim().length < 8);
  const canSave = Boolean(slot?.connected && available && !busy && !needsKey && !keyError);
  const savedStatus =
    slot?.keyConfigured &&
    slot.draftStatus !== "blank" &&
    editedModel === null &&
    model === slot.model &&
    !replacingKey &&
    !draftKey
      ? slot.draftStatus
      : null;
  const needsTest =
    savedStatus === "saved" || savedStatus === "failed" || savedStatus === "unknown";
  const canTest = Boolean(
    needsTest && slot?.connected && available && slot.keyConfigured && !busy && !keyError,
  );
  const visibleStatus = savedStatus && busy === `test:${fieldKey}` ? "testing" : savedStatus;
  const needsEnable = Boolean(savedStatus === "passed" && card && slot && !liveMatches(card, slot));
  const storageError = needsEnable && error?.code === "FEATURE_WRITING_STORAGE_UNAVAILABLE";
  const enableBlockReason = slot?.enableBlockReason || (storageError ? error.message : null);
  const canEnable = Boolean(
    needsEnable &&
    slot?.connected &&
    available &&
    slot.testToken &&
    !enableBlockReason &&
    !keyError &&
    !busy,
  );

  // A newer server revision may be adopted after navigation; its receipt must not close a new editor.
  function acceptView(next: FeatureConfigView) {
    setView((previous) => (previous && previous.revision > next.revision ? previous : next));
  }

  function selectFeature(next: PageTab) {
    selectionVersion.current++;
    setEditedModel(null);
    setKeys({});
    setReplacing({});
    setChosen(next);
    setVendor(null);
    setEditing(false);
    setDialog(null);
    setError(null);
    if (next !== "video") replaceSelection(next, null);
  }

  async function rollback() {
    if (!view || chosen === "video" || busyRef.current) return;
    const version = selectionVersion.current;
    busyRef.current = true;
    setBusy("rollback");
    setError(null);
    try {
      const next = await client.rollback(feature, { expectedRevision: view.revision });
      acceptView(next);
    } catch (caught) {
      if (selectionVersion.current === version) setError(formError(caught));
    } finally {
      busyRef.current = false;
      setBusy("");
    }
  }

  function selectVendor(next: FeatureVendor) {
    selectionVersion.current++;
    setEditedModel("");
    setChosen(feature);
    setVendor(next);
    setEditing(true);
    setDialog(null);
    setError(null);
    replaceSelection(feature, next);
  }

  function cancelEdit() {
    selectionVersion.current++;
    setEditedModel(null);
    setKeys({});
    setReplacing({});
    setVendor(priorVendor.current);
    setEditing(false);
    setError(null);
    replaceSelection(feature, priorVendor.current);
  }

  function beginConfigure() {
    if (!slot) return;
    priorVendor.current = vendor;
    selectVendor(slot.vendor);
    setEditedModel(null);
  }

  async function save() {
    if (!card || !slot || !view || !canSave || busyRef.current) return;
    const version = selectionVersion.current;
    busyRef.current = true;
    setBusy("save");
    setError(null);
    const secretAction =
      enteringKey && draftKey
        ? ("replace" as const)
        : canBindVendor
          ? ("bind_vendor" as const)
          : ("keep" as const);
    try {
      const next = await client.saveDraft(feature, {
        expectedRevision: view.revision,
        vendor: slot.vendor,
        model,
        secretAction,
        ...(secretAction === "replace" ? { apiKey: draftKey } : {}),
      });
      acceptView(next);
      if (selectionVersion.current !== version) return;
      priorVendor.current = slot.vendor;
      setEditedModel(null);
      setKeys({});
      setReplacing({});
    } catch (caught) {
      if (selectionVersion.current === version) setError(formError(caught));
    } finally {
      busyRef.current = false;
      setBusy("");
    }
  }

  async function confirmTest() {
    if (!card || !slot || !view || !canTest || busyRef.current) return;
    const version = selectionVersion.current;
    busyRef.current = true;
    setBusy(`test:${fieldKey}`);
    setDialog(null);
    setError(null);
    try {
      const result = await client.testDraft(feature, {
        expectedRevision: view.revision,
        vendor: slot.vendor,
        confirmCost: true,
      });
      acceptView(result.view);
    } catch (caught) {
      if (version === selectionVersion.current) {
        const unknown =
          caught instanceof FeatureApiError &&
          (caught.status === 0 || caught.status === 408 || caught.status === 504);
        setError({
          unknown,
          code: caught instanceof FeatureApiError ? caught.code : undefined,
          message: unknown
            ? "结果未知，请刷新配置并核对供应商调用记录。"
            : featureErrorCopy(caught),
        });
      }
    } finally {
      busyRef.current = false;
      setBusy("");
    }
  }

  async function confirmEnable() {
    if (!card || !slot?.testToken || !view || !canEnable || busyRef.current) return;
    const version = selectionVersion.current;
    busyRef.current = true;
    setBusy("enable");
    setDialog(null);
    setError(null);
    try {
      const next = await client.enable(feature, {
        expectedRevision: view.revision,
        vendor: slot.vendor,
        testToken: slot.testToken,
      });
      acceptView(next);
      if (selectionVersion.current === version) {
        priorVendor.current = slot.vendor;
        cancelEdit();
      }
    } catch (caught) {
      if (selectionVersion.current === version) setError(formError(caught));
    } finally {
      busyRef.current = false;
      setBusy("");
    }
  }

  if (gate !== "ready") {
    return (
      <AdminFrame>
        <ConfigIntro />
        <AdminGateView gate={gate} onRetry={gate === "failed" ? reload : undefined} />
      </AdminFrame>
    );
  }
  if (failed) {
    return (
      <AdminFrame>
        <ConfigIntro />
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
  if (!view || !card) {
    return (
      <AdminFrame>
        <ConfigIntro />
        <AdminGateView gate="loading" />
      </AdminFrame>
    );
  }

  return (
    <AdminFrame>
      <ConfigIntro />
      <div className={styles.tabs} role="tablist" aria-label="功能">
        {(["writing", "storyboard", "video", "voice"] as const).map((tab) => {
          if (tab === "video") {
            return (
              <button
                key="video"
                type="button"
                role="tab"
                aria-selected={chosen === "video"}
                className={chosen === "video" ? styles.tabOn : styles.tab}
                onClick={() => selectFeature("video")}
              >
                视频
              </button>
            );
          }
          const item = view.features.find((entry) => entry.feature === tab);
          if (!item) return null;
          return (
            <button
              key={item.feature}
              type="button"
              role="tab"
              aria-selected={item.feature === feature && chosen !== "video"}
              className={item.feature === feature && chosen !== "video" ? styles.tabOn : styles.tab}
              onClick={() => selectFeature(item.feature)}
            >
              {PAGE_LABEL[item.feature]}
            </button>
          );
        })}
      </div>
      {chosen === "video" ? (
        <section className={styles.state} data-state="video-empty">
          <img src="/design/tailadmin-v2/icon-list-video.svg" width={28} height={28} alt="" />
          <h2>视频尚未接入</h2>
        </section>
      ) : vendor && !card.slots.some((item) => item.vendor === vendor) ? (
        <section className={styles.state}>
          <h2>该服务商尚未接入</h2>
          <button type="button" className={styles.secondary} onClick={() => selectFeature(feature)}>
            返回已接入服务商
          </button>
        </section>
      ) : (
        <CurrentCard card={card}>
          <button type="button" className={styles.secondary} onClick={beginConfigure}>
            修改配置
          </button>
          {card.canRollback && (
            <button
              type="button"
              className={styles.secondary}
              disabled={Boolean(busy)}
              onClick={() => void rollback()}
            >
              {busy === "rollback" ? "正在回退…" : "回退到上一配置版本"}
            </button>
          )}
          {!editing && error && (
            <p className={styles.fail} role="alert">
              {error.message}
            </p>
          )}
        </CurrentCard>
      )}
      {editing && card && slot ? (
        <div className={styles.modal} hidden={Boolean(dialog)}>
          <div
            ref={drawerRef}
            className={styles.drawer}
            role="dialog"
            aria-modal="true"
            aria-label="修改配置"
          >
            <Editor
              card={card}
              slot={slot}
              model={model}
              draftKey={draftKey}
              replacing={replacingKey}
              bindingVendorKey={canBindVendor}
              busy={busy}
              needsKey={needsKey}
              keyError={keyError}
              onVendor={selectVendor}
              onModel={(value) => {
                selectionVersion.current++;
                setEditedModel(value);
                setError(null);
              }}
              onKey={(value) => {
                selectionVersion.current++;
                setKeys((current) => ({ ...current, [fieldKey]: value }));
                setError(null);
              }}
              onReplace={() => {
                selectionVersion.current++;
                setReplacing((current) => ({ ...current, [fieldKey]: true }));
                setError(null);
              }}
              onClose={cancelEdit}
            >
              {visibleStatus && !error && (
                <div role="status" className={styles.draftStatus} data-outcome={visibleStatus}>
                  <strong>{DRAFT_STATUS_LABEL[visibleStatus]}</strong>
                  {(visibleStatus === "failed" || visibleStatus === "unknown") &&
                    slot.failureMessage && <p>{slot.failureMessage}</p>}
                </div>
              )}
              {error && !keyError && !storageError && (
                <p className={error.unknown ? styles.hint : styles.fail} role="alert">
                  {error.message}
                </p>
              )}
              {needsEnable && enableBlockReason && (
                <p id="feature-enable-block" className={styles.hint}>
                  {enableBlockReason}
                </p>
              )}
              <div className={styles.actions}>
                {!savedStatus || !available || (savedStatus === "testing" && !busy) ? (
                  <button
                    type="button"
                    className={styles.primary}
                    disabled={!canSave}
                    onClick={() => void save()}
                  >
                    {busy === "save" ? "正在保存…" : "保存草稿"}
                  </button>
                ) : null}
                {needsTest && (
                  <button
                    type="button"
                    className={styles.primary}
                    disabled={!canTest}
                    onClick={() => setDialog("test")}
                  >
                    验证草稿
                  </button>
                )}
                {needsEnable && (
                  <button
                    type="button"
                    className={styles.primary}
                    disabled={!canEnable}
                    aria-describedby={enableBlockReason ? "feature-enable-block" : undefined}
                    onClick={() => setDialog("enable")}
                  >
                    {busy === "enable" ? "正在启用…" : "确认启用"}
                  </button>
                )}
              </div>
            </Editor>
          </div>
        </div>
      ) : null}
      {dialog === "test" && slot ? (
        <div className={styles.modal}>
          <div
            ref={dialogRef}
            className={styles.dialog}
            role="dialog"
            aria-modal="true"
            aria-label="确认测试费用"
          >
            <h2>确认测试</h2>
            <p>
              {slot.label} · {slot.models.find((item) => item.id === model)?.label ?? model}
            </p>
            <p>规模：{card.probeScale}</p>
            <p>{card.probeCostNote}</p>
            <div className={styles.dialogActions}>
              <button type="button" className={styles.secondary} onClick={() => setDialog(null)}>
                取消
              </button>
              <button type="button" className={styles.primary} onClick={() => void confirmTest()}>
                确认测试
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {dialog === "enable" && slot ? (
        <div className={styles.modal}>
          <div
            ref={dialogRef}
            className={styles.dialog}
            role="dialog"
            aria-modal="true"
            aria-label="确认启用"
          >
            <h2>确认启用</h2>
            <p>
              启用后，新的{PAGE_LABEL[card.feature]}任务使用 {slot.label} ·{" "}
              {slot.models.find((item) => item.id === model)?.label ?? model}
              。已提交的任务继续使用原配置。
            </p>
            <div className={styles.dialogActions}>
              <button type="button" className={styles.secondary} onClick={() => setDialog(null)}>
                取消
              </button>
              <button type="button" className={styles.primary} onClick={() => void confirmEnable()}>
                确认启用
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </AdminFrame>
  );
}

function CurrentCard({ card, children }: { card: FeatureCardView; children: ReactNode }) {
  return (
    <section className={styles.current} aria-label="当前生效配置">
      <div className={styles.editorHead}>
        <h2>当前生效配置</h2>
        {card.live ? (
          <span className={styles.badgeOk}>已生效</span>
        ) : (
          <span className={styles.badgeMuted}>尚未配置</span>
        )}
      </div>
      <dl className={styles.facts}>
        <div>
          <dt>供应商</dt>
          <dd>{card.live ? card.live.vendorLabel : "未设置"}</dd>
        </div>
        <div>
          <dt>模型</dt>
          <dd>{card.live ? card.live.modelLabel : "未设置"}</dd>
        </div>
        <div>
          <dt>凭证</dt>
          <dd>{card.live ? `${PAGE_LABEL[card.feature]}专用  ${SAVED_SECRET_MASK}` : "未绑定"}</dd>
        </div>
      </dl>
      <div className={styles.actions}>{children}</div>
    </section>
  );
}

function Editor({
  card,
  slot,
  model,
  draftKey,
  replacing,
  bindingVendorKey,
  busy,
  needsKey,
  keyError,
  onVendor,
  onModel,
  onKey,
  onReplace,
  children,
  onClose,
}: {
  card: FeatureCardView;
  slot: FeatureSlotView;
  model: string;
  draftKey: string;
  replacing: boolean;
  bindingVendorKey: boolean;
  busy: string;
  needsKey: boolean;
  keyError: string | null;
  onVendor: (vendor: FeatureVendor) => void;
  onModel: (model: string) => void;
  onKey: (value: string) => void;
  onReplace: () => void;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <section className={styles.editor} aria-label={`${PAGE_LABEL[card.feature]}草稿`}>
      <div className={styles.editorHead}>
        <h2>修改配置</h2>
        <button type="button" className={styles.quiet} onClick={onClose}>
          取消
        </button>
      </div>
      <p className={styles.live}>
        <span>当前生效</span>{" "}
        <strong>
          {card.live ? `${card.live.vendorLabel} / ${card.live.modelLabel}` : "尚未配置"}
        </strong>
      </p>
      <div className={styles.fields}>
        <label className={styles.field}>
          <span>供应商</span>
          <select
            value={slot.vendor}
            onChange={(event) => onVendor(event.target.value as FeatureVendor)}
            disabled={busy === "save"}
          >
            {card.slots.map((item) => (
              <option key={item.vendor} value={item.vendor}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <ModelSelect
          key={slot.vendor}
          label="模型"
          value={model}
          options={slot.models}
          onChange={onModel}
          disabled={!slot.connected || busy === "save"}
        />
        {!slot.connected ? (
          <small className={styles.hint}>该供应商尚未接入，请选择其他供应商。</small>
        ) : null}
        {slot.connected ? (
          <div className={styles.field}>
            <span>凭证 · {slot.label}</span>
            {(slot.keyConfigured || bindingVendorKey) && !replacing ? (
              <div className={styles.keyRow}>
                <span aria-label="已保存密钥">{SAVED_SECRET_MASK}</span>
                <button type="button" onClick={onReplace}>
                  更换
                </button>
              </div>
            ) : (
              <input
                aria-label="API Key"
                aria-invalid={Boolean(keyError)}
                aria-describedby={keyError ? "feature-key-error" : undefined}
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={draftKey}
                disabled={busy !== ""}
                onChange={(event) => onKey(event.target.value)}
              />
            )}
            {bindingVendorKey && !replacing ? (
              <small className={styles.hint}>使用「AI 大模型」已保存的密钥。</small>
            ) : null}
            {keyError ? (
              <small className={styles.fail} role="alert" id="feature-key-error">
                {keyError}
              </small>
            ) : needsKey ? (
              <small className={styles.hint}>请输入至少 8 位的 API Key。</small>
            ) : null}
          </div>
        ) : null}
      </div>
      {children}
    </section>
  );
}
