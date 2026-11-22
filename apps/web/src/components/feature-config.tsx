"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  FEATURE_KEYS,
  FEATURE_VENDOR_KEYS,
  featureCapability,
  type FeatureCardView,
  type FeatureConfigView,
  type FeatureKey,
  type FeatureSlotView,
  type FeatureVendor,
} from "@ai-drama/contracts";
import { AdminFrame, AdminGateView, useOperatorGate } from "./admin-access";
import { SAVED_SECRET_MASK } from "../lib/ai-model-vendors";
import { createFeatureConfigClient, featureErrorCopy } from "../lib/feature-config-client";
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
      <div className={styles.introHead}>
        <h1>模型与密钥</h1>
      </div>
      <p>按功能管理模型与凭证。</p>
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
        item.draftStatus === "testing" ||
        (item.draftStatus === "passed" && !liveMatches(card, item)),
    ) ?? null
  );
}

type ChangeKind = "empty" | "saved" | "failed" | "passed" | "enabled";

function changeKind(card: FeatureCardView, slot: FeatureSlotView | null): ChangeKind {
  if (!slot || slot.draftStatus === "blank") return "empty";
  if (slot.draftStatus === "failed") return "failed";
  if (slot.draftStatus === "saved" || slot.draftStatus === "testing") return "saved";
  if (slot.draftStatus === "passed") return liveMatches(card, slot) ? "enabled" : "passed";
  return "empty";
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
  const model = fieldKey ? (models[fieldKey] ?? slot?.model ?? slot?.models[0]?.id ?? "") : "";
  const enteringKey = Boolean(slot && (replacingKey || !slot.keyConfigured));
  const dirtyModel = Boolean(slot && model && model !== (slot.model ?? slot.models[0]?.id ?? ""));
  const dirtyKey = enteringKey && draftKey.length > 0;
  const needsKey = Boolean(slot?.connected && enteringKey && draftKey.trim().length < 8);
  const canSave = Boolean(slot?.connected && !busy && !needsKey);
  const canTest = Boolean(
    slot?.connected &&
    slot.keyConfigured &&
    (slot.draftStatus === "saved" || slot.draftStatus === "failed") &&
    !dirtyKey &&
    !dirtyModel &&
    !busy,
  );
  const canEnable = Boolean(
    slot?.connected &&
    slot.draftStatus === "passed" &&
    slot.testToken &&
    !dirtyKey &&
    !dirtyModel &&
    !busy &&
    card &&
    !liveMatches(card, slot),
  );
  const kind = card && slot ? changeKind(card, slot) : "empty";
  const extra = vendor ? featureCapability(feature, vendor) : null;
  const showingUnconnected = editing && extra !== null && !extra.connected;
  const connected = showingUnconnected ? card?.slots.find((item) => item.connected) : null;

  function selectFeature(next: PageTab) {
    setChosen(next);
    setVendor(null);
    setEditing(false);
    setDialog(null);
    setError("");
    setNotice("");
    if (next !== "video") replaceSelection(next, null);
  }

  async function rollback() {
    if (!view || chosen === "video" || busyRef.current) return;
    busyRef.current = true;
    setBusy("rollback");
    setError("");
    setNotice("");
    try {
      const next = await client.rollback(feature, { expectedRevision: view.revision });
      setView(next);
      setNotice("已回退到上一配置版本。进行中的任务保持提交时锁定的版本。");
    } catch (caught) {
      setError(featureErrorCopy(caught));
    } finally {
      busyRef.current = false;
      setBusy("");
    }
  }

  function selectVendor(next: FeatureVendor) {
    setChosen(feature);
    setVendor(next);
    setEditing(true);
    setDialog(null);
    setError("");
    replaceSelection(feature, next);
  }

  function beginConfigure() {
    // Open on the draft or live vendor shown in 配置变更, not always the first vendor.
    const preferred =
      (slot?.connected ? slot.vendor : null) ??
      card?.slots.find((item) => item.connected)?.vendor ??
      "bailian";
    selectVendor(preferred);
  }

  async function save() {
    if (!card || !slot || !view || !canSave || busyRef.current) return;
    busyRef.current = true;
    setBusy("save");
    setError("");
    setNotice("");
    const secretAction = enteringKey && draftKey ? ("replace" as const) : ("keep" as const);
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
      setEditing(false);
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
        setFailureCopy(
          message && !message.includes(draftKey) ? message : "测试没有通过，草稿已保留，可以重试。",
        );
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
          <p>视频尚未接入功能配置。现有视频任务链路保持不变，这里不能保存、检测或启用。</p>
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
            error={error}
            notice={notice}
            onTest={() => {
              if (canTest) setDialog("test");
            }}
            onEnable={() => {
              if (canEnable) setDialog("enable");
            }}
            onRollback={() => void rollback()}
            rollingBack={busy === "rollback"}
          />
        </>
      )}
      {editing && card && slot ? (
        <div className={styles.modal}>
          <div className={styles.drawer} role="dialog" aria-modal="true" aria-label="修改配置">
            {showingUnconnected && extra ? (
              <section className={styles.state} data-state="unconnected">
                <h2>该服务商尚未接入</h2>
                <p>{extra.gap ?? "该服务商尚未接入。"}</p>
                <button
                  type="button"
                  className={styles.primary}
                  onClick={() => (connected ? selectVendor(connected.vendor) : setEditing(false))}
                >
                  返回已接入服务商
                </button>
              </section>
            ) : (
              <Editor
                card={card}
                slot={slot}
                model={model}
                draftKey={draftKey}
                replacing={replacingKey}
                busy={busy}
                canSave={canSave}
                needsKey={needsKey}
                error={error}
                onVendor={selectVendor}
                onModel={(value) => setModels((current) => ({ ...current, [fieldKey]: value }))}
                onKey={(value) => setKeys((current) => ({ ...current, [fieldKey]: value }))}
                onReplace={() => setReplacing((current) => ({ ...current, [fieldKey]: true }))}
                onSave={() => void save()}
                onClose={() => {
                  setEditing(false);
                  setError("");
                }}
              />
            )}
          </div>
        </div>
      ) : null}
      {dialog === "test" && slot ? (
        <div className={styles.modal}>
          <div className={styles.dialog} role="dialog" aria-modal="true" aria-label="确认测试费用">
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
      {dialog === "failed" ? (
        <div className={styles.modal}>
          <div className={styles.dialog} role="dialog" aria-modal="true" aria-label="测试没有通过">
            <h2>测试没有通过</h2>
            <p>{failureCopy}</p>
            <div className={styles.dialogActions}>
              <button type="button" className={styles.primary} onClick={() => setDialog(null)}>
                知道了
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {dialog === "enable" && slot ? (
        <div className={styles.modal}>
          <div className={styles.dialog} role="dialog" aria-modal="true" aria-label="确认启用">
            <h2>确认启用</h2>
            <p>
              启用后，新的{PAGE_LABEL[card.feature]}任务使用 {slot.label} ·{" "}
              {slot.models.find((item) => item.id === model)?.label ?? model}
              。已经提交的任务保持锁定的版本，不会悄悄切换。
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
  notice,
  onTest,
  onEnable,
  onRollback,
  rollingBack,
}: {
  card: FeatureCardView;
  slot: FeatureSlotView | null;
  kind: ChangeKind;
  busy: string;
  canTest: boolean;
  canEnable: boolean;
  error: string;
  notice: string;
  onTest: () => void;
  onEnable: () => void;
  onRollback: () => void;
  rollingBack: boolean;
}) {
  const step = kind === "empty" ? 1 : kind === "saved" || kind === "failed" ? 2 : 3;
  const done2 = kind === "passed" || kind === "enabled";
  const done3 = kind === "enabled";
  return (
    <section className={styles.change} aria-label="配置变更">
      <h2>配置变更</h2>
      <ol className={styles.steps}>
        <li
          className={
            step > 1 || kind === "enabled"
              ? styles.stepDone
              : step === 1
                ? styles.stepOn
                : styles.step
          }
        >
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
          <p>修改配置后，可在这里检测并启用新版本。</p>
        </div>
      ) : slot ? (
        <div className={styles.changeBody}>
          {kind === "saved" ? (
            <p className={styles.mutedLine}>
              <span className={styles.dotWarn} />
              草稿未启用
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
          <p>
            {kind === "saved" ? "当前生效配置仍用于新任务。" : null}
            {kind === "failed"
              ? `${slot.failureMessage ? `原因：${slot.failureMessage} ` : ""}草稿已保留，不能启用。当前生效配置未切换。`
              : null}
            {kind === "passed" ? "连接检测已通过，等待确认启用。" : null}
            {kind === "enabled" ? "本次变更仅对本功能的新任务生效。" : null}
            {notice && kind !== "failed" ? ` ${notice}` : null}
          </p>
          {error ? (
            <p className={styles.fail} role="alert">
              {error}
            </p>
          ) : null}
          {kind === "saved" || kind === "failed" ? (
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
              disabled={busy !== "" || rollingBack}
              onClick={onRollback}
            >
              {rollingBack ? "正在回退…" : "回退到上一配置版本"}
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
      <p className={styles.vendorLabel}>供应商</p>
      <div className={styles.vendors} role="group" aria-label="供应商">
        {card.slots.map((item) => (
          <button
            key={item.vendor}
            type="button"
            className={item.vendor === slot.vendor ? styles.vendorOn : styles.vendor}
            aria-pressed={item.vendor === slot.vendor}
            onClick={() => onVendor(item.vendor)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className={styles.fields}>
        <label className={styles.field}>
          <span>模型</span>
          <select
            aria-label="模型"
            value={model}
            disabled={!slot.connected || busy !== ""}
            onChange={(event) => onModel(event.target.value)}
          >
            {slot.models.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <div className={styles.field}>
          <span>凭证 · {slot.label}</span>
          {slot.keyConfigured && !replacing ? (
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
        </div>
      </div>
      {needsKey ? (
        <small className={styles.hint}>
          请填写这一家服务商的 API Key。密钥只在这次保存时发送，页面不会记住它。
        </small>
      ) : null}
      <p className={styles.hint}>保存草稿或检测连接都不会切换当前生效配置。</p>
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
