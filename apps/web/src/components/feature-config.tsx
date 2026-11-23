"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  FEATURE_KEYS,
  FEATURE_VENDOR_KEYS,
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

type ChangeKind = "empty" | "saved" | "testing" | "failed" | "unknown" | "passed" | "enabled";

function changeKind(card: FeatureCardView, slot: FeatureSlotView | null): ChangeKind {
  if (!slot || slot.draftStatus === "blank") return "empty";
  if (slot.draftStatus === "passed") return liveMatches(card, slot) ? "enabled" : "passed";
  return slot.draftStatus;
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
  const [error, setError] = useState("");
  const [dialog, setDialog] = useState<"test" | "enable" | null>(null);
  const selectionVersion = useRef(0);
  const priorVendor = useRef<FeatureVendor | null>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalKeyboard(editing, drawerRef, cancelEdit);
  useModalKeyboard(Boolean(dialog), dialogRef, () => setDialog(null));
  const busyRef = useRef(false);

  useEffect(() => {
    const modal = editing ? drawerRef.current : dialog ? dialogRef.current : null;
    if (!modal) return;
    const previous = document.activeElement;
    modal.querySelector<HTMLElement>("button, select")?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [editing, dialog]);

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
  const needsKey = Boolean(slot?.connected && enteringKey && draftKey.trim().length < 8);
  const canSave = Boolean(slot?.connected && available && !busy && !needsKey);
  const canTest = Boolean(
    slot?.connected &&
    available &&
    slot.keyConfigured &&
    !editing &&
    !busy &&
    (slot.draftStatus === "saved" ||
      slot.draftStatus === "failed" ||
      slot.draftStatus === "unknown"),
  );
  const canEnable = Boolean(
    slot?.connected &&
    available &&
    slot.draftStatus === "passed" &&
    slot.testToken &&
    !editing &&
    !busy &&
    card &&
    !liveMatches(card, slot),
  );
  const kind = card && slot ? changeKind(card, slot) : "empty";

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
    setError("");
    if (next !== "video") replaceSelection(next, null);
  }

  async function rollback() {
    if (!view || chosen === "video" || busyRef.current) return;
    const version = selectionVersion.current;
    busyRef.current = true;
    setBusy("rollback");
    setError("");
    try {
      const next = await client.rollback(feature, { expectedRevision: view.revision });
      acceptView(next);
    } catch (caught) {
      if (selectionVersion.current === version) setError(featureErrorCopy(caught));
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
    setError("");
    replaceSelection(feature, next);
  }

  /** 取消 discards unsaved model, key and 更换 choices for this feature so 检测连接 / 确认启用 use the saved draft again. */
  function cancelEdit() {
    selectionVersion.current++;
    setEditedModel(null);
    setKeys({});
    setReplacing({});
    setVendor(priorVendor.current);
    setEditing(false);
    setError("");
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
    setError("");
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
      setEditedModel(null);
      setKeys({});
      setReplacing({});
      setEditing(false);
    } catch (caught) {
      if (selectionVersion.current === version) setError(featureErrorCopy(caught));
    } finally {
      busyRef.current = false;
      setBusy("");
    }
  }

  async function confirmTest() {
    if (!card || !slot || !view || !canTest || busyRef.current) return;
    const version = selectionVersion.current;
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
      acceptView(result.view);
    } catch (caught) {
      if (version === selectionVersion.current) {
        const unknown =
          caught instanceof FeatureApiError &&
          (caught.status === 0 || caught.status === 408 || caught.status === 504);
        setError(unknown ? "结果未知，请刷新配置并核对供应商调用记录。" : featureErrorCopy(caught));
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
    setError("");
    try {
      const next = await client.enable(feature, {
        expectedRevision: view.revision,
        vendor: slot.vendor,
        testToken: slot.testToken,
      });
      acceptView(next);
    } catch (caught) {
      if (selectionVersion.current === version) setError(featureErrorCopy(caught));
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
        <>
          <CurrentCard card={card} onEdit={beginConfigure} />
          <ChangePanel
            card={card}
            slot={kind === "empty" ? null : slot}
            kind={kind}
            busy={busy}
            canTest={canTest}
            canEnable={canEnable}
            error={editing ? "" : error}
            onTest={() => {
              if (canTest) setDialog("test");
            }}
            onEnable={() => {
              if (canEnable) setDialog("enable");
            }}
            onRollback={() => void rollback()}
          />
        </>
      )}
      {editing && card && slot ? (
        <div className={styles.modal}>
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
              canSave={canSave}
              needsKey={needsKey}
              error={error}
              onVendor={selectVendor}
              onModel={(value) => {
                setEditedModel(value);
                setError("");
              }}
              onKey={(value) => {
                setKeys((current) => ({ ...current, [fieldKey]: value }));
                setError("");
              }}
              onReplace={() => setReplacing((current) => ({ ...current, [fieldKey]: true }))}
              onSave={() => void save()}
              onClose={cancelEdit}
            />
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

function CurrentCard({ card, onEdit }: { card: FeatureCardView; onEdit: () => void }) {
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
      <button type="button" className={styles.secondary} onClick={onEdit}>
        修改配置
      </button>
    </section>
  );
}

function ChangePanel({
  card,
  slot,
  kind,
  busy,
  canTest,
  canEnable,
  error,
  onTest,
  onEnable,
  onRollback,
}: {
  card: FeatureCardView;
  slot: FeatureSlotView | null;
  kind: ChangeKind;
  busy: string;
  canTest: boolean;
  canEnable: boolean;
  error: string;
  onTest: () => void;
  onEnable: () => void;
  onRollback: () => void;
}) {
  const step = kind === "empty" ? 1 : kind === "passed" || kind === "enabled" ? 3 : 2;
  const done2 = kind === "passed" || kind === "enabled";
  const done3 = kind === "enabled";
  return (
    <section className={styles.change} aria-label="配置变更">
      <h2>配置变更</h2>
      <ol className={styles.steps}>
        <li className={step === 1 ? styles.stepOn : styles.stepDone}>
          <span>1</span> 保存草稿
        </li>
        <li className={done2 ? styles.stepDone : step === 2 ? styles.stepOn : styles.step}>
          <span>2</span> 检测连接
        </li>
        <li className={done3 ? styles.stepDone : step === 3 ? styles.stepOn : styles.step}>
          <span>3</span> 确认启用
        </li>
      </ol>
      {kind === "empty" ? (
        <div className={styles.changeBody}>
          <p className={styles.mutedLine}>
            <span className={styles.dotMuted} />
            暂无草稿
          </p>
        </div>
      ) : slot ? (
        <div className={styles.changeBody}>
          {kind === "saved" || kind === "testing" || kind === "unknown" ? (
            <p className={styles.mutedLine}>
              <span className={styles.dotWarn} />
              {kind === "testing" ? "正在检测…" : kind === "unknown" ? "结果未知" : "草稿未启用"}
            </p>
          ) : null}
          {kind === "failed" ? (
            <p className={styles.failLine}>
              <span className={styles.dotFail} />
              检测未通过
            </p>
          ) : null}
          {kind === "passed" ? (
            <p className={styles.okLine}>
              <span className={styles.dotOk} />
              检测通过
            </p>
          ) : null}
          {kind === "enabled" ? (
            <p className={styles.okLine}>
              <span className={styles.dotOk} />
              已生效
            </p>
          ) : null}
          <p className={styles.draftMeta}>
            <strong>{slot.label}</strong>
            <span>{slot.models.find((item) => item.id === slot.model)?.label ?? slot.model}</span>
          </p>
          {(kind === "failed" || kind === "unknown") && slot.failureMessage ? (
            <p role="status">{slot.failureMessage}</p>
          ) : null}
          {slot.model && !slot.models.some((item) => item.id === slot.model) ? (
            <p>当前列表不可用，请修改配置。</p>
          ) : null}
          {error ? (
            <p className={styles.fail} role="alert">
              {error}
            </p>
          ) : null}
          {kind === "saved" || kind === "failed" || kind === "unknown" ? (
            <button type="button" className={styles.primary} disabled={!canTest} onClick={onTest}>
              {busy === "test" ? "正在检测…" : "检测连接"}
            </button>
          ) : null}
          {kind === "passed" ? (
            <button
              type="button"
              className={styles.primary}
              disabled={!canEnable}
              onClick={onEnable}
            >
              {busy === "enable" ? "正在启用…" : "确认启用"}
            </button>
          ) : null}
          {card.canRollback ? (
            <button
              type="button"
              className={styles.secondary}
              disabled={busy !== ""}
              onClick={onRollback}
            >
              {busy === "rollback" ? "正在回退…" : "回退到上一配置版本"}
            </button>
          ) : null}
        </div>
      ) : null}
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
  canSave,
  needsKey,
  error,
  onVendor,
  onModel,
  onKey,
  onReplace,
  onSave,
  onClose,
}: {
  card: FeatureCardView;
  slot: FeatureSlotView;
  model: string;
  draftKey: string;
  replacing: boolean;
  bindingVendorKey: boolean;
  busy: string;
  canSave: boolean;
  needsKey: boolean;
  error: string;
  onVendor: (vendor: FeatureVendor) => void;
  onModel: (model: string) => void;
  onKey: (value: string) => void;
  onReplace: () => void;
  onSave: () => void;
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
            {needsKey ? <small className={styles.hint}>请输入至少 8 位的 API Key。</small> : null}
          </div>
        ) : null}
      </div>
      {error ? (
        <p className={styles.fail} role="alert">
          {error}
        </p>
      ) : null}
      <div className={styles.actions}>
        <button type="button" className={styles.primary} disabled={!canSave} onClick={onSave}>
          {busy === "save" ? "正在保存…" : "保存草稿"}
        </button>
      </div>
    </section>
  );
}
