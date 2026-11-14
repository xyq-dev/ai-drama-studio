"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type {
  ScriptWorkbenchBeat,
  ScriptWorkbenchEpisode,
  ScriptWorkbenchPlan,
  ScriptWorkbenchRevision,
  ScriptWorkbenchRevisionPage,
  ScriptWorkbenchScene,
  ScriptWorkbenchScript,
  ScriptWorkbenchSnapshot,
  ShortSequelAiTaskView,
} from "@ai-drama/contracts";
import { canBindShortSequelFirstPlan, shortSequelDraftIsExpired } from "@ai-drama/contracts";
import { completedShortSequelOutline } from "@ai-drama/domain/short-sequel-plan";
import { ApiError, StudioClient } from "../lib/studio-client";
import {
  expandedShortSequelPlan,
  matchesSequelPrevious,
  readShortSequelPredecessor,
  savedShortSequelOutlineEpisode,
  savedShortSequelSource,
  shortSequelPath,
  shortSequelSource,
  shortSequelWorkbenchUrl,
  type ShortSequelPredecessor,
  type ShortSequelSource,
  type ShortSequelView,
} from "../lib/short-sequel-client";
import { useModalKeyboard } from "../lib/modal-keyboard";
import {
  STAGES,
  REVIEW_CHECKS,
  approved,
  clock,
  documentVersions,
  emptyPlan,
  emptyScript,
  estimateScript,
  invalidateChecks,
  plainText,
  revisionLabel,
  workbenchPlan,
  workbenchScript,
} from "../lib/script-workbench-model";
import {
  emptyWorkbenchBaseline,
  clearImportedScript,
  persistWorkbenchDraft,
  readImportedScript,
  restoreWorkbenchDraft,
  WORKBENCH_DRAFTS_CLEARED_EVENT,
} from "../lib/script-workbench-drafts";
import { CreatorShell } from "./creator-shell";
import { ShortSequelAi, ShortSequelDraftPreview } from "./short-sequel-ai";
import { ShortSequelEntry } from "./short-sequel-entry";
import styles from "./script-workbench.module.css";

const client = new StudioClient();
type Stage = 0 | 1 | 2 | 3 | 4;
interface DeletePreview {
  title: string;
  episodeNo: number;
  revisionNo: number;
  reviewStatus: string;
  version: number;
  dependencies: {
    scenes: number;
    shots: number;
    speech: number;
    video: number;
    other: number;
    total: number;
  };
  canDelete: boolean;
  blockedReason: string | null;
  references?: Array<{
    kind: "scene" | "shot" | "speech" | "video" | "other";
    id: string;
    label: string;
  }>;
}
type Confirmation =
  | { kind: "story"; revision: ScriptWorkbenchRevision }
  | { kind: "script"; episode: ScriptWorkbenchEpisode; revision: ScriptWorkbenchRevision };
type HistoryTarget = "story" | string;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function Field({
  label,
  value,
  onChange,
  hint,
  rows = 3,
  short,
  type = "text",
  min,
  max,
  readOnly = false,
}: {
  label: string;
  value: string | number;
  onChange: (value: string) => void;
  hint?: string;
  rows?: number;
  short?: boolean;
  type?: string;
  min?: number;
  max?: number;
  readOnly?: boolean;
}) {
  return (
    <label className={styles.field}>
      <span>{label}</span>
      {short ? (
        <input
          aria-label={label}
          type={type}
          min={min}
          max={max}
          readOnly={readOnly}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <textarea
          aria-label={label}
          rows={rows}
          readOnly={readOnly}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
      {hint ? <small>{hint}</small> : null}
    </label>
  );
}

function Modal({
  title,
  children,
  footer,
  onClose,
  small = false,
  busy = false,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  small?: boolean;
  busy?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const restore = useRef<HTMLElement | null>(null);
  useModalKeyboard(true, ref, () => {
    if (!busy) onClose();
  });
  useEffect(() => {
    restore.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.querySelector<HTMLElement>("button, input, select, textarea")?.focus();
    return () => {
      if (restore.current?.isConnected) restore.current.focus();
    };
  }, []);
  return (
    <div className={styles.backdrop}>
      <div
        ref={ref}
        className={`${styles.modal} ${small ? styles.small : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className={styles.modalHeader}>
          <h2>{title}</h2>
          <button type="button" disabled={busy} aria-label="关闭弹窗" onClick={onClose}>
            ×
          </button>
        </header>
        <div className={styles.modalBody}>{children}</div>
        {footer ? <footer className={styles.formFooter}>{footer}</footer> : null}
      </div>
    </div>
  );
}

function StatusBadge({ revision }: { revision: ScriptWorkbenchRevision | null }) {
  return (
    <span className={`${styles.badge} ${approved(revision) ? styles.locked : ""}`}>
      {revisionLabel(revision)}
    </span>
  );
}

export function ScriptWorkbench({
  projectId,
  initialHistory,
  initialEpisodes = false,
  initialEpisodeNo,
}: {
  projectId: string;
  initialHistory?: string;
  initialEpisodes?: boolean;
  initialEpisodeNo?: number;
}) {
  const [snapshot, setSnapshot] = useState<ScriptWorkbenchSnapshot | null>(null);
  const [plan, renderPlan] = useState<ScriptWorkbenchPlan | null>(null);
  const [drafts, renderDrafts] = useState<Record<string, ScriptWorkbenchScript>>({});
  const [stage, setStage] = useState<Stage>(0);
  const [selectedEpisode, setSelectedEpisode] = useState("");
  const [selectedScene, setSelectedScene] = useState("");
  const [sequelContexts, setSequelContexts] = useState<Record<string, ShortSequelView>>({});
  const [frozenPredecessor, setFrozenPredecessor] = useState<ShortSequelPredecessor | null>(null);
  const [continuationEpisodeNo, renderContinuationEpisodeNo] = useState<number | null>(null);
  const planIntent = useRef<number | null>(null);
  const [frozenOutlineNos, setFrozenOutlineNos] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  const [reconcile, setReconcile] = useState<{
    episodeId: string | null;
    version: number;
    revisionId: string | null;
    sourceStoryId: string | null;
    server: ScriptWorkbenchPlan | ScriptWorkbenchScript;
    serverText: string;
    draftText: string;
  } | null>(null);
  const [history, setHistory] = useState<HistoryTarget | null>(null);
  const [historyPage, setHistoryPage] = useState<
    | (ScriptWorkbenchRevisionPage & {
        target: HistoryTarget;
        snapshot: ScriptWorkbenchSnapshot;
        loading: boolean;
        error: string | null;
      })
    | null
  >(null);
  const historyRequest = useRef(0);
  const historyInFlight = useRef(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [deletion, setDeletion] = useState<{
    episode: ScriptWorkbenchEpisode;
    revision: ScriptWorkbenchRevision;
    preview: DeletePreview;
  } | null>(null);
  const [legacyConverted, renderLegacyConverted] = useState(new Set<string>());
  const pendingKeys = useRef(new Map<string, string>());
  const requestEpoch = useRef(0);
  const mounted = useRef(true);
  const baseline = useRef(emptyWorkbenchBaseline());
  const live = useRef<{
    plan: ScriptWorkbenchPlan | null;
    drafts: Record<string, ScriptWorkbenchScript>;
  }>({ plan: null, drafts: {} });
  const legacyRef = useRef(new Set<string>());
  const signedOut = useRef(false);
  const recoveryUnreadable = useRef(false);
  const [storageWarning, setStorageWarning] = useState<string | null>(null);
  const persist = useCallback(() => {
    if (signedOut.current || recoveryUnreadable.current) return false;
    try {
      persistWorkbenchDraft(window.sessionStorage, {
        schema: 1,
        projectId,
        plan: live.current.plan,
        scripts: live.current.drafts,
        baseline: baseline.current,
        legacyConverted: [...legacyRef.current],
        continuationEpisodeNo: planIntent.current,
        pendingKeys: [...pendingKeys.current],
      });
      setStorageWarning(null);
      return true;
    } catch {
      setStorageWarning("浏览器未能保存恢复草稿，请先保存到服务器再离开页面。当前编辑内容仍保留。");
      return false;
    }
  }, [projectId]);
  function setPlan(value: ScriptWorkbenchPlan) {
    live.current.plan = value;
    renderPlan(value);
    persist();
  }
  function setDrafts(
    update: (
      current: Record<string, ScriptWorkbenchScript>,
    ) => Record<string, ScriptWorkbenchScript>,
  ) {
    live.current.drafts = update(live.current.drafts);
    renderDrafts(live.current.drafts);
    persist();
  }
  function setLegacyConverted(update: (current: Set<string>) => Set<string>) {
    legacyRef.current = update(legacyRef.current);
    renderLegacyConverted(legacyRef.current);
    persist();
  }
  function setContinuationEpisodeNo(episodeNo: number | null) {
    planIntent.current = episodeNo;
    renderContinuationEpisodeNo(episodeNo);
    persist();
  }
  const episode = snapshot?.episodes.find((item) => item.id === selectedEpisode) ?? null;
  const script = episode ? (drafts[episode.id] ?? emptyScript(episode.title)) : null;
  const scriptDirty = !!(episode && script && !same(script, baseline.current.scripts[episode.id]));
  const previous =
    snapshot?.episodes.find((item) => item.episodeNo === (episode?.episodeNo ?? 0) - 1) ?? null;
  const sequel = episode?.isContinuation ? sequelContexts[episode.id] : null;
  const sequelSource = episode?.isContinuation
    ? baseline.current.sequelSources[episode.id] ?? savedShortSequelSource(episode.script)
    : null;
  const storedSequelDrafts = episode ? baseline.current.pastSequelDrafts[episode.id] ?? [] : [];
  const frozenPreviousId = sequelSource?.previousRevisionId ?? null;
  const frozenPreviousInSnapshot = frozenPreviousId ? previous?.history.find((item) => item.id === frozenPreviousId) : null;
  const needsFrozenLookup = !!(sequel && frozenPreviousId && frozenPreviousId !== sequel.previousRevisionId && !frozenPreviousInSnapshot);
  const currentEpisodeNo = episode?.episodeNo;
  useEffect(() => {
    setFrozenPredecessor(null);
    if (!needsFrozenLookup || !frozenPreviousId || !currentEpisodeNo) return;
    const abort = new AbortController();
    void readShortSequelPredecessor(projectId, currentEpisodeNo, frozenPreviousId, abort.signal)
      .then((value) => { if (!abort.signal.aborted && value.revisionId === frozenPreviousId) setFrozenPredecessor(value); })
      .catch(() => undefined);
    return () => abort.abort();
  }, [projectId, currentEpisodeNo, frozenPreviousId, needsFrozenLookup]);
  const frozenPreviousStale = frozenPreviousInSnapshot?.freshnessStatus === "STALE"
    || (frozenPredecessor?.revisionId === frozenPreviousId && frozenPredecessor?.freshnessStatus === "STALE");
  const storedBodyStale = episode?.script?.freshnessStatus === "STALE" && !baseline.current.sequelSources[episode.id];
  const invalidSequelSource = !!sequel && (storedBodyStale || !!sequelSource && (shortSequelDraftIsExpired(sequelSource, sequel)
    || (scriptDirty && sequelSource.episodeCount === undefined) || frozenPreviousStale));
  const lockedBeforeExpansion = !!(invalidSequelSource && sequel && sequelSource && !scriptDirty
    && approved(episode?.script) && matchesSequelPrevious(sequelSource, sequel));
  const staleSequel = invalidSequelSource && !lockedBeforeExpansion;
  const sequelHasPrevious = !!(sequel?.previousScript && (sequel.previousRevisionId || sequel.originalEpisodeHash));
  const awaitingDraftSources = !!sequel && !!sequelSource && !staleSequel && (sequelSource.episodeCount !== sequel.episodeCount
    || (!!sequelSource.storyRevisionId && sequelSource.storyRevisionId !== sequel.storyRevisionId)
    || !matchesSequelPrevious(sequelSource, sequel));
  const needsFirstPlanBinding = !!(sequel?.storyConfirmed && sequelSource && !staleSequel
    && canBindShortSequelFirstPlan(sequelSource, sequel) && matchesSequelPrevious(sequelSource, sequel));
  const sequelCanSave = !episode?.isContinuation || !!(sequel?.storyConfirmed && sequelHasPrevious && sequel.previousLocked
    && sequel.previousFreshnessStatus === "CURRENT" && !staleSequel && !needsFirstPlanBinding
    && (!sequelSource || (sequelSource.storyRevisionId === sequel.storyRevisionId
      && (sequelSource.episodeCount === undefined || sequelSource.episodeCount === sequel.episodeCount)
      && matchesSequelPrevious(sequelSource, sequel))));
  const planDirty = plan !== null && !same(plan, baseline.current.plan);
  const anyDirty =
    planDirty ||
    Object.entries(drafts).some(([id, value]) => !same(value, baseline.current.scripts[id]));
  const editingConflict =
    snapshot &&
    (stage <= 1
      ? planDirty && baseline.current.planVersion !== snapshot.project.version
      : episode &&
        scriptDirty &&
        (baseline.current.scriptVersions[episode.id] !== episode.rowVersion ||
          (!episode.isContinuation && baseline.current.sourceStoryIds[episode.id] !== snapshot.story?.id)));
  function inspectEditingConflict() {
    if (!snapshot || !plan) return;
    if (stage <= 1) {
      setReconcile({
        episodeId: null,
        version: snapshot.project.version,
        revisionId: snapshot.story?.id ?? null,
        sourceStoryId: null,
        server: workbenchPlan(snapshot.story) ?? emptyPlan(snapshot),
        serverText: snapshot.story ? plainText(snapshot.story.content) : "尚无设定",
        draftText: [
          plan.brief.genre,
          plan.brief.audience,
          plan.brief.logline,
          plan.brief.productionConstraints,
          `时长 ${plan.brief.targetEpisodeSeconds} 秒 / 对白 ${plan.brief.dialogueQuota} 句`,
          plan.bible.ending,
          plan.bible.openThreads,
          ...plan.bible.characters.map((item) => Object.values(item).join(" · ")),
          ...plan.outline.episodes.map((item) => Object.values(item).join(" · ")),
        ].join("\n"),
      });
    } else if (episode && script) {
      setReconcile({
        episodeId: episode.id,
        version: episode.rowVersion,
        revisionId: episode.script?.id ?? null,
        sourceStoryId: snapshot.story?.id ?? null,
        server: workbenchScript(episode.script) ?? emptyScript(episode.title),
        serverText: episode.script ? plainText(episode.script.content) : "尚无正文",
        draftText: [
          script.title,
          script.previousHandoff,
          script.openingHook,
          script.change,
          script.endingHandoff,
          script.characterKnowledge,
          script.unresolvedThreads,
          ...script.scenes.flatMap((scene) => [
            scene.heading,
            ...scene.beats.map(
              (beat) => `${beat.characterId ?? beat.kind}：${beat.text} (${beat.seconds} 秒)`,
            ),
          ]),
        ].join("\n"),
      });
    }
  }
  function adoptInspectedBaseline() {
    if (!reconcile) return;
    if (reconcile.episodeId === null) {
      baseline.current.plan = reconcile.server as ScriptWorkbenchPlan;
      baseline.current.planVersion = reconcile.version;
      baseline.current.planRevisionId = reconcile.revisionId;
    } else {
      const id = reconcile.episodeId;
      baseline.current.scripts[id] = reconcile.server as ScriptWorkbenchScript;
      baseline.current.scriptVersions[id] = reconcile.version;
      baseline.current.scriptRevisionIds[id] = reconcile.revisionId;
      baseline.current.sourceStoryIds[id] = reconcile.sourceStoryId;
      setDrafts((current) => ({
        ...current,
        [id]: invalidateChecks({ ...current[id]!, previousRevisionId: null }),
      }));
    }
    persist();
    setReconcile(null);
    setError(null);
    setConflict(false);
    setNotice(
      "已按你核对的服务器版本更新编辑基线，本地内容保留；尚未写入服务器，请核对后保存新稿。",
    );
  }
  const initialStoryLegacy =
    !!snapshot?.story && !workbenchPlan(snapshot.story) && !legacyConverted.has("story");
  const initialScriptLegacy =
    !!episode?.script && !workbenchScript(episode.script) && !legacyConverted.has(episode.id);
  const hasContinuation = !!snapshot?.episodes.some((item) => item.isContinuation);
  const canSubmitOriginal = hasContinuation && !episode?.isContinuation && initialScriptLegacy
    && !!episode?.script && ["DRAFT", "REJECTED"].includes(episode.script.reviewStatus);
  const sequelCharacters = sequel?.original?.story && plan && snapshot && plan.bible.characters.length === 0
    ? expandedShortSequelPlan(snapshot, plan, sequel, !snapshot.story || initialStoryLegacy).bible.characters
    : plan?.bible.characters ?? [];

  const read = useCallback(
    async (
      options: { initial?: boolean; plan?: boolean; episodeId?: string; all?: boolean } = {},
    ) => {
      const epoch = ++requestEpoch.current;
      const next = await client.get<ScriptWorkbenchSnapshot>(
        `/projects/${projectId}/script-workbench`,
      );
      const contexts = await Promise.all(next.episodes.filter((item) => item.isContinuation).map(async (item) => {
        try {
          const context = await client.get<ShortSequelView>(shortSequelPath(projectId, item.episodeNo));
          return context.episodeId === item.id ? [item.id, context] as const : null;
        } catch { return null; }
      }));
      if (!mounted.current || signedOut.current || epoch !== requestEpoch.current) return next;
      const nextContexts = Object.fromEntries(contexts.filter((context) => context !== null));
      setSnapshot(next);
      setSequelContexts(nextContexts);
      const nextPlan = workbenchPlan(next.story) ?? emptyPlan(next);
      const savedIntent = next.story?.reviewStatus !== "APPROVED" ? savedShortSequelOutlineEpisode(next.story) : null;
      if (options.initial && planIntent.current === null && savedIntent !== null) {
        planIntent.current = savedIntent;
        renderContinuationEpisodeNo(savedIntent);
      }
      const intendedEpisode = next.episodes.find((item) => item.episodeNo === planIntent.current);
      const reference = intendedEpisode ? nextContexts[intendedEpisode.id] : null;
      if (reference) {
        const inherited = expandedShortSequelPlan(next, nextPlan, reference, !workbenchPlan(next.story));
        setFrozenOutlineNos(inherited.outline.episodes.filter((item) =>
          item.episodeNo < reference.episodeNo && completedShortSequelOutline(item)).map((item) => item.episodeNo));
      }
      // A refreshed aggregate version is usable only alongside the exact content loaded from it.
      // Dirty local content keeps its original editing CAS and source, even when another entity is saved.
      if (
        options.plan ||
        options.all ||
        live.current.plan === null ||
        same(live.current.plan, baseline.current.plan)
      ) {
        live.current.plan = nextPlan;
        baseline.current.plan = nextPlan;
        baseline.current.planVersion = next.project.version;
        baseline.current.planRevisionId = next.story?.id ?? null;
        renderPlan(nextPlan);
      }
      const updates: Record<string, ScriptWorkbenchScript> = {};
      for (const item of next.episodes) {
        if (
          options.all ||
          options.episodeId === item.id ||
          !(item.id in live.current.drafts) ||
          same(live.current.drafts[item.id], baseline.current.scripts[item.id])
        ) {
          const outline = nextPlan.outline.episodes.find(
            (entry) => entry.episodeNo === item.episodeNo,
          );
          const context = nextContexts[item.id];
          const nextScript = workbenchScript(item.script) ?? {
            ...emptyScript(outline?.title || `第${item.episodeNo}集`),
            previousRevisionId: context?.previousRevisionId ?? null,
            previousHandoff: context?.previousHandoff ?? "",
            openingHook: outline?.openingHook ?? "",
            change: outline?.change ?? "",
            endingHandoff: outline?.endingHandoff ?? "",
          };
          updates[item.id] = nextScript;
          baseline.current.scripts[item.id] = nextScript;
          baseline.current.scriptVersions[item.id] = item.rowVersion;
          baseline.current.scriptRevisionIds[item.id] = item.script?.id ?? null;
          baseline.current.sourceStoryIds[item.id] = next.story?.id ?? null;
          delete baseline.current.sequelSources[item.id];
        }
      }
      const initialEpisode = options.initial ? next.episodes.find(item => item.episodeNo === 1) : undefined;
      let imported: string | null = null;
      if (initialEpisode && !initialEpisode.script && !(initialEpisode.id in live.current.drafts) && !recoveryUnreadable.current) {
        try { imported = readImportedScript(window.sessionStorage, projectId); }
        catch { /* Existing editor remains usable without browser recovery storage. */ }
        const draft = updates[initialEpisode.id];
        if (imported && draft) {
          updates[initialEpisode.id] = { ...draft, scenes: [{ id: "imported-scene", heading: "导入的剧本",
            interiorExterior: "INT", timeOfDay: "DAY", characterIds: [],
            beats: [{ id: "imported-text", kind: "action", text: imported, seconds: 0 }] }] };
          setNotice("第 1 集原文已放入草稿。请拆分场次、补齐设定，再保存并审稿。");
        }
      }
      live.current.drafts = { ...live.current.drafts, ...updates };
      renderDrafts(live.current.drafts);
      if (persist() && imported) {
        try { clearImportedScript(window.sessionStorage, projectId); }
        catch { /* The saved editor draft takes precedence on reload. */ }
      }
      if (options.initial) {
        const first = next.episodes.find((item) => !approved(item.script)) ?? next.episodes[0];
        const requestedHistory = next.episodes.find((item) => item.id === initialHistory);
        const requestedEpisode = next.episodes.find((item) => item.episodeNo === initialEpisodeNo);
        const firstSaved = initialEpisodes ? next.episodes.find((item) => item.script) : undefined;
        setSelectedEpisode(requestedHistory?.id ?? requestedEpisode?.id ?? firstSaved?.id ?? (imported ? initialEpisode?.id : first?.id) ?? "");
        setStage(planIntent.current ? 1 : requestedHistory || requestedEpisode || firstSaved || imported || (approved(next.story) && first) ? 2 : 0);
        if (requestedHistory) setHistory(requestedHistory.id);
      } else
        setSelectedEpisode((current) =>
          next.episodes.some((item) => item.id === current)
            ? current
            : (next.episodes[0]?.id ?? ""),
        );
      return next;
    },
    [projectId, persist, initialHistory, initialEpisodes, initialEpisodeNo],
  );

  useEffect(() => {
    mounted.current = true;
    signedOut.current = false;
    recoveryUnreadable.current = false;
    setStorageWarning(null);
    baseline.current = emptyWorkbenchBaseline();
    live.current = { plan: null, drafts: {} };
    pendingKeys.current.clear();
    legacyRef.current = new Set();
    renderPlan(null);
    renderDrafts({});
    renderLegacyConverted(new Set());
    setSnapshot(null);
    setSequelContexts({});
    planIntent.current = null;
    renderContinuationEpisodeNo(null);
    setFrozenOutlineNos([]);
    try {
      const restored = restoreWorkbenchDraft(window.sessionStorage, projectId);
      if (restored) {
        baseline.current = restored.baseline;
        live.current = { plan: restored.plan, drafts: restored.scripts };
        pendingKeys.current = new Map(restored.pendingKeys);
        legacyRef.current = new Set(restored.legacyConverted);
        renderPlan(restored.plan);
        renderDrafts(restored.scripts);
        renderLegacyConverted(legacyRef.current);
        planIntent.current = restored.continuationEpisodeNo ?? null;
        renderContinuationEpisodeNo(planIntent.current);
        setNotice("已恢复此标签页的未保存草稿；保留原编辑版本，服务器更新不会被自动覆盖。");
      }
    } catch {
      recoveryUnreadable.current = true;
      setStorageWarning("本地恢复草稿无法读取，原记录已保留；请先保存到服务器再离开页面。");
    }
    const onSignedOut = () => {
      signedOut.current = true;
      requestEpoch.current += 1;
      historyRequest.current += 1;
      setHistory(null);
      setHistoryPage(null);
      baseline.current = emptyWorkbenchBaseline();
      live.current = { plan: null, drafts: {} };
      pendingKeys.current.clear();
      legacyRef.current.clear();
      renderPlan(null);
      renderDrafts({});
      renderLegacyConverted(new Set());
      setSnapshot(null);
      setSequelContexts({});
      planIntent.current = null;
      renderContinuationEpisodeNo(null);
    };
    window.addEventListener(WORKBENCH_DRAFTS_CLEARED_EVENT, onSignedOut);
    window.addEventListener("pagehide", persist);
    setLoading(true);
    void read({ initial: true })
      .catch((caught: unknown) => {
        if (mounted.current) setError(message(caught));
      })
      .finally(() => {
        if (mounted.current) setLoading(false);
      });
    return () => {
      mounted.current = false;
      requestEpoch.current += 1;
      window.removeEventListener(WORKBENCH_DRAFTS_CLEARED_EVENT, onSignedOut);
      window.removeEventListener("pagehide", persist);
    };
  }, [read, projectId, persist]);

  useEffect(() => {
    if (!anyDirty) return;
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [anyDirty]);

  async function mutate(path: string, body: unknown, ifMatch: number) {
    if (signedOut.current) throw new Error("已退出登录，请重新登录后继续。");
    const fingerprint = JSON.stringify({ path, body, ifMatch });
    let key = pendingKeys.current.get(fingerprint);
    if (!key) {
      key = crypto.randomUUID();
      pendingKeys.current.set(fingerprint, key);
    }
    persist();
    const result = await client.write({ path, body, ifMatch, idempotencyKey: key });
    return { result, fingerprint };
  }

  async function action(work: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setNotice("");
    setConflict(false);
    try {
      await work();
    } catch (caught) {
      setError(message(caught));
      setConflict(caught instanceof ApiError && [409, 412].includes(caught.status));
    } finally {
      busyRef.current = false;
      if (mounted.current) {
        persist();
        setBusy(false);
      }
    }
  }

  async function savePlan(submit: boolean) {
    if (!snapshot || !plan) return;
    await action(async () => {
      let latest = snapshot;
      if (planDirty || !snapshot.story || initialStoryLegacy) {
        const { fingerprint } = await mutate(
          `/projects/${projectId}/script-workbench/plan`,
          { plan, ...(planIntent.current === null ? {} : { continuationEpisodeNo: planIntent.current }) },
          baseline.current.planVersion ?? snapshot.project.version,
        );
        latest = await read({ plan: true });
        pendingKeys.current.delete(fingerprint);
      }
      if (
        submit &&
        latest.story &&
        latest.story.reviewStatus !== "IN_REVIEW" &&
        latest.story.reviewStatus !== "APPROVED"
      ) {
        const { fingerprint } = await mutate(
          `/projects/${projectId}/stories/${latest.story.id}/review`,
          { to: "IN_REVIEW", expectedReviewVersion: latest.story.reviewVersion },
          latest.project.version,
        );
        await read();
        pendingKeys.current.delete(fingerprint);
      }
      setNotice(
        submit
          ? "设定已提交审稿。检查后在「定稿交接」确认这个版本。"
          : "设定草稿已保存，原有版本保留在版本记录中。",
      );
      if (submit) setStage(4);
    });
  }

  async function saveScript(submit: boolean) {
    if (!snapshot || !episode || !script) return;
    const target = episode,
      value = script;
    await action(async () => {
      if (!sequelCanSave) {
        throw new Error("请核对本集引用的设定、大纲和前集版本，再保存或提交。");
      }
      if (!approved(snapshot.story))
        throw new Error("请先在「定稿交接」确认设定与大纲的具体版本，再保存本集正文。");
      let latest = snapshot;
      if (scriptDirty || !target.script || initialScriptLegacy) {
        const frozen = sequel ? sequelSource ?? shortSequelSource(sequel) : null;
        const sourceStoryRevisionId = frozen?.storyRevisionId ?? baseline.current.sourceStoryIds[target.id] ?? snapshot.story!.id;
        const { fingerprint } = await mutate(
          `/projects/${projectId}/episodes/${target.id}/script-workbench`,
          {
            script: frozen ? { ...value, previousRevisionId: frozen.previousRevisionId } : value,
            sourceStoryRevisionId,
            ...(frozen ? { continuation: {
              previousRevisionId: frozen.previousRevisionId,
              originalRunId: frozen.originalRunId,
              originalEpisodeHash: frozen.originalEpisodeHash,
              episodeCount: frozen.episodeCount ?? sequel?.episodeCount,
              planConfirmation: frozen.planConfirmation ?? sequel?.planConfirmation,
              ...(frozen.aiAttemptId ? { aiAttemptId: frozen.aiAttemptId } : {}),
            } } : {}),
          },
          baseline.current.scriptVersions[target.id] ?? target.rowVersion,
        );
        latest = await read({ episodeId: target.id });
        pendingKeys.current.delete(fingerprint);
      }
      const saved = latest.episodes.find((item) => item.id === target.id);
      if (
        submit &&
        saved?.script &&
        !["IN_REVIEW", "APPROVED"].includes(saved.script.reviewStatus)
      ) {
        const { fingerprint } = await mutate(
          `/projects/${projectId}/episodes/${saved.id}/scripts/${saved.script.id}/review`,
          { to: "IN_REVIEW", expectedReviewVersion: saved.script.reviewVersion },
          saved.rowVersion,
        );
        await read();
        pendingKeys.current.delete(fingerprint);
      }
      setNotice(
        submit
          ? `第 ${target.episodeNo} 集已提交审稿，尚未进入制作。`
          : `第 ${target.episodeNo} 集草稿已保存。`,
      );
      if (submit) setStage(3);
    });
  }

  function updateScript(patch: Partial<ScriptWorkbenchScript>, checksOnly = false) {
    if (!episode || !script) return;
    if (episode.isContinuation) {
      if (!sequel || staleSequel || lockedBeforeExpansion) return;
      baseline.current.sequelSources[episode.id] = sequelSource ?? shortSequelSource(sequel);
    }
    setDrafts((current) => ({
      ...current,
      [episode.id]: checksOnly
        ? { ...script, ...patch }
        : invalidateChecks({ ...script, ...patch }),
    }));
  }

  async function submitOriginalScript() {
    if (!episode?.script || !canSubmitOriginal) return;
    const revision = episode.script;
    await action(async () => {
      const { fingerprint } = await mutate(
        `/projects/${projectId}/episodes/${episode.id}/scripts/${revision.id}/review`,
        { to: "IN_REVIEW", expectedReviewVersion: revision.reviewVersion },
        episode.rowVersion,
      );
      await read();
      pendingKeys.current.delete(fingerprint);
      setNotice(`第 ${episode.episodeNo} 集原文已提交审稿，请在「定稿交接」确认版本。`);
      setStage(4);
    });
  }

  function prepareSequelPlan() {
    if (!snapshot || !plan || !sequel) return;
    if (planDirty && continuationEpisodeNo !== sequel.episodeNo) {
      setError("尚有未保存的设定或大纲，请先处理这些修改。");
      setStage(1);
      return;
    }
    const saved = workbenchPlan(snapshot.story);
    const inherited = expandedShortSequelPlan(snapshot, saved ?? emptyPlan(snapshot), sequel, !saved);
    const editable = continuationEpisodeNo === sequel.episodeNo ? plan : inherited;
    setFrozenOutlineNos(inherited.outline.episodes.filter((item) => item.episodeNo < sequel.episodeNo && completedShortSequelOutline(item))
      .map((item) => item.episodeNo));
    setContinuationEpisodeNo(sequel.episodeNo);
    setPlan(editable);
    if (initialStoryLegacy) setLegacyConverted((current) => new Set(current).add("story"));
    setStage(1);
  }

  function bindFirstSequelPlan() {
    if (!episode || !script || !sequel || !needsFirstPlanBinding) return;
    baseline.current.sequelSources[episode.id] = { ...sequelSource!, storyRevisionId: sequel.storyRevisionId };
    setDrafts((current) => ({ ...current, [episode.id]: invalidateChecks(script) }));
    setNotice("本集草稿已引用你核对的新设定与大纲，可以保存正文。");
  }

  function startFreshSequelDraft() {
    if (!episode || !script || !sequel || !invalidSequelSource) return;
    if (!lockedBeforeExpansion) baseline.current.pastSequelDrafts[episode.id] = [...storedSequelDrafts, script];
    baseline.current.sequelSources[episode.id] = shortSequelSource(sequel);
    const outline = plan?.outline.episodes.find((item) => item.episodeNo === episode.episodeNo);
    setDrafts((current) => ({
      ...current,
      [episode.id]: lockedBeforeExpansion ? invalidateChecks({
        ...script,
        previousRevisionId: sequel.previousRevisionId,
        previousHandoff: sequel.previousHandoff ?? script.previousHandoff,
      }) : {
        ...emptyScript(outline?.title ?? episode.title),
        previousRevisionId: sequel.previousRevisionId,
        previousHandoff: sequel.previousHandoff ?? "",
        openingHook: outline?.openingHook ?? "",
        change: outline?.change ?? "",
        endingHandoff: outline?.endingHandoff ?? "",
      },
    }));
    setSelectedScene("");
    setStage(2);
  }

  function selectEpisode(id: string) {
    setSelectedEpisode(id);
    setSelectedScene("");
    if (snapshot?.episodes.some((item) => item.id === id && item.isContinuation)) {
      void read().catch((caught: unknown) => setError(message(caught)));
    }
  }

  function adoptSequelAi(task: ShortSequelAiTaskView) {
    if (!episode || !sequel || episode.script || task.stale || !task.script
      || task.episodeCount !== sequel.episodeCount || task.source.planConfirmation === undefined
      || !matchesSequelPrevious(task.source, sequel)
      || (task.source.storyRevisionId && task.source.storyRevisionId !== sequel.storyRevisionId)
      || !same(live.current.drafts[episode.id], baseline.current.scripts[episode.id])) {
      setError("本集或引用版本已变化，AI 草稿保留在续写任务中。");
      return;
    }
    baseline.current.sequelSources[episode.id] = shortSequelSource({ ...task.source,
      episodeCount: task.episodeCount, aiAttemptId: task.attemptId });
    const draft = task.script;
    setDrafts((current) => ({ ...current, [episode.id]: invalidateChecks(draft) }));
    setSelectedScene("");
    setStage(2);
  }

  async function confirmVersion() {
    if (!snapshot || !confirmation) return;
    const target = confirmation;
    await action(async () => {
      const story = target.kind === "story";
      const { fingerprint } = await mutate(
        story
          ? `/projects/${projectId}/stories/${target.revision.id}/review`
          : `/projects/${projectId}/episodes/${target.episode.id}/scripts/${target.revision.id}/review`,
        { to: "APPROVED", expectedReviewVersion: target.revision.reviewVersion },
        story ? snapshot.project.version : target.episode.rowVersion,
      );
      await read();
      pendingKeys.current.delete(fingerprint);
      setConfirmation(null);
      setNotice(
        story
          ? `设定 v${target.revision.revisionNo} 已确认，可以逐集编写。`
          : `第 ${target.episode.episodeNo} 集 v${target.revision.revisionNo} 已定稿。`,
      );
    });
  }

  async function previewDelete(
    targetEpisode: ScriptWorkbenchEpisode,
    revision: ScriptWorkbenchRevision,
  ) {
    await action(async () => {
      if (!same(drafts[targetEpisode.id], baseline.current.scripts[targetEpisode.id]))
        throw new Error("这一集有未保存的修改，请先保存草稿再删除版本。");
      const preview = await client.get<DeletePreview>(
        `/projects/${projectId}/episodes/${targetEpisode.id}/scripts/${revision.id}/deletion-preview`,
      );
      setHistory(null);
      setDeletion({ episode: targetEpisode, revision, preview });
    });
  }

  async function trashRevision() {
    if (!deletion) return;
    const target = deletion;
    await action(async () => {
      const { fingerprint } = await mutate(
        `/projects/${projectId}/episodes/${target.episode.id}/scripts/${target.revision.id}/trash`,
        { expectedVersion: target.preview.version },
        target.preview.version,
      );
      await read({ episodeId: target.episode.id });
      pendingKeys.current.delete(fingerprint);
      setDeletion(null);
      setHistory(null);
      setNotice(
        `第 ${target.episode.episodeNo} 集 v${target.revision.revisionNo} 已移入回收站，可从「我的作品 → 回收站」恢复。`,
      );
    });
  }

  function loadHistoryAsDraft(target: ScriptWorkbenchEpisode, revision: ScriptWorkbenchRevision) {
    if (!same(drafts[target.id], baseline.current.scripts[target.id])) {
      setError("请先保存当前编辑，再载入历史版本。");
      return;
    }
    const restored = workbenchScript(revision) ?? {
      ...emptyScript(target.title),
      scenes: [
        {
          id: crypto.randomUUID(),
          heading: "原稿整理",
          interiorExterior: "INT" as const,
          timeOfDay: "DAY" as const,
          characterIds: [],
          beats: [
            {
              id: crypto.randomUUID(),
              kind: "action" as const,
              text: plainText(revision.content),
              seconds: 0,
            },
          ],
        },
      ],
    };
    if (target.isContinuation) {
      const source = savedShortSequelSource(revision);
      if (!source) {
        setError("这个版本没有完整的续写来源，仍可在版本历史中查看。");
        return;
      }
      baseline.current.sequelSources[target.id] = source;
    }
    setDrafts((current) => ({
      ...current,
      [target.id]: invalidateChecks({ ...restored, previousRevisionId: null }),
    }));
    setLegacyConverted((current) => new Set(current).add(target.id));
    setSelectedEpisode(target.id);
    setSelectedScene("");
    setHistory(null);
    setStage(2);
    setNotice(
      `已载入第 ${target.episodeNo} 集 v${revision.revisionNo}，请重新核对连续性后保存为新草稿。原版本保持不变。`,
    );
  }

  function convertLegacy() {
    if (initialStoryLegacy && snapshot?.story && plan) {
      setPlan({
        ...plan,
        brief: {
          ...plan.brief,
          productionConstraints: `${plan.brief.productionConstraints}${plan.brief.productionConstraints ? "\n\n" : ""}原始设定：\n${plainText(snapshot.story.content)}`,
        },
      });
      setLegacyConverted((current) => new Set(current).add("story"));
    } else if (initialScriptLegacy && episode?.script && script) {
      updateScript({
        scenes: [
          {
            id: crypto.randomUUID(),
            heading: "原稿整理",
            interiorExterior: "INT",
            timeOfDay: "DAY",
            characterIds: [],
            beats: [
              {
                id: crypto.randomUUID(),
                kind: "action",
                text: plainText(episode.script.content),
                seconds: 0,
              },
            ],
          },
        ],
      });
      setLegacyConverted((current) => new Set(current).add(episode.id));
    }
  }

  function refreshPreservingEdits() {
    void action(async () => {
      await read();
      setNotice("已刷新干净稿件；未保存内容及其原编辑版本保留。发生冲突时，请先对照服务器版本。");
    });
  }
  const estimate = script ? estimateScript(script) : null;
  const historyEpisode = snapshot?.episodes.find((item) => item.id === history);
  const initialHistoryRevisions =
    (history === "story" ? snapshot?.storyHistory : historyEpisode?.history) ?? [];
  const activeHistoryPage =
    historyPage?.target === history && historyPage.snapshot === snapshot ? historyPage : null;
  const historyRevisions = activeHistoryPage?.items ?? initialHistoryRevisions;
  const historyCursor = activeHistoryPage
    ? activeHistoryPage.nextCursor
    : initialHistoryRevisions.length >= 100
      ? String(initialHistoryRevisions.at(-1)!.revisionNo)
      : null;
  const versions = documentVersions(snapshot?.story);

  useEffect(() => {
    historyRequest.current += 1;
    historyInFlight.current = false;
    // A canceled page read must not leave its cached target disabled when the dialog is reopened.
    setHistoryPage((current) => (current?.loading ? { ...current, loading: false } : current));
    return () => {
      historyRequest.current += 1;
      historyInFlight.current = false;
    };
  }, [history, snapshot]);

  async function loadMoreHistory() {
    if (!snapshot || !history || !historyCursor || historyInFlight.current || busy) return;
    historyInFlight.current = true;
    const epoch = ++historyRequest.current;
    const before = {
      target: history,
      snapshot,
      items: historyRevisions,
      nextCursor: historyCursor,
    };
    setHistoryPage({ ...before, loading: true, error: null });
    try {
      const path =
        history === "story"
          ? `/projects/${projectId}/stories`
          : `/projects/${projectId}/episodes/${history}/scripts`;
      const next = await client.get<ScriptWorkbenchRevisionPage>(
        `${path}?cursor=${encodeURIComponent(historyCursor)}`,
      );
      if (!mounted.current || signedOut.current || epoch !== historyRequest.current) return;
      const seen = new Set(before.items.map((item) => item.id));
      setHistoryPage({
        ...before,
        items: [...before.items, ...next.items.filter((item) => !seen.has(item.id))],
        nextCursor: next.nextCursor,
        loading: false,
        error: null,
      });
    } catch (caught) {
      if (mounted.current && !signedOut.current && epoch === historyRequest.current)
        setHistoryPage({ ...before, loading: false, error: message(caught) });
    } finally {
      if (epoch === historyRequest.current) historyInFlight.current = false;
    }
  }

  return (
    <div className={styles.theme}>
      <CreatorShell activePath="/studio">
        <main className={styles.page}>
          <header className={styles.heading}>
            <div>
              <h1>剧本工作台</h1>
              <p>
                {snapshot
                  ? `《${snapshot.project.title}》${plan?.brief.genre ? ` · ${plan.brief.genre}` : ""}`
                  : "从一个想法，到可以交接的剧本"}
              </p>
            </div>
            <div className={styles.headerActions}>
              <a href="/studio" className={styles.subtle}>
                返回我的作品
              </a>
              <button
                type="button"
                className={styles.button}
                disabled={!snapshot || busy}
                onClick={() => setHistory(episode && stage >= 2 ? episode.id : "story")}
              >
                版本记录
              </button>
            </div>
          </header>
          <nav className={styles.stages} role="tablist" aria-label="剧本创作阶段">
            {STAGES.map((label, index) => (
              <button
                type="button"
                key={label}
                role="tab"
                aria-selected={stage === index}
                aria-controls={`stage-${index}`}
                id={`stage-tab-${index}`}
                className={styles.stage}
                onClick={() => setStage(index as Stage)}
              >
                <span className={styles.stageNumber}>{index + 1}</span>
                {label}
              </button>
            ))}
          </nav>
          {editingConflict ? (
            <div className={styles.warning} role="status">
              服务器版本已更新。当前未保存稿仍使用原编辑基线，刷新不会覆盖新版本。
              <button type="button" disabled={busy} onClick={inspectEditingConflict}>
                对照并处理版本冲突
              </button>
            </div>
          ) : null}
          {storageWarning ? (
            <p className={styles.warning} role="status">
              {storageWarning}
            </p>
          ) : null}
          {error ? (
            <div role="alert" className={styles.error}>
              {error}
              {conflict ? (
                <button type="button" disabled={busy} onClick={refreshPreservingEdits}>
                  读取最新版本，保留编辑内容
                </button>
              ) : null}
              {!snapshot ? (
                <button
                  type="button"
                  onClick={() => {
                    setLoading(true);
                    void action(async () => {
                      await read({ initial: true });
                    }).finally(() => setLoading(false));
                  }}
                >
                  重新加载
                </button>
              ) : null}
            </div>
          ) : null}
          {notice ? (
            <div className={styles.success} role="status">
              {notice}
            </div>
          ) : null}
          {loading ? (
            <div className={styles.empty} role="status">
              正在加载剧本和版本…
            </div>
          ) : null}
          {!loading && snapshot && plan ? (
            <fieldset disabled={busy} className={styles.fields}>
              <section id={`stage-${stage}`} role="tabpanel" aria-labelledby={`stage-tab-${stage}`}>
                {stage <= 1 ? (
                  <div className={styles.twoColumn}>
                    <div className={styles.card}>
                      <div className={styles.cardHeader}>
                        <h2>{stage === 0 ? "创作简报" : "系列圣经与分集大纲"}</h2>
                        <StatusBadge revision={snapshot.story} />
                      </div>
                      {initialStoryLegacy ? (
                        <div className={styles.cardBody}>
                          <LegacyContent
                            text={plainText(snapshot.story!.content)}
                            onConvert={convertLegacy}
                          />
                        </div>
                      ) : (
                        <div className={styles.cardBody}>
                          {continuationEpisodeNo !== null ? (
                            <p className={styles.notice}>沿用原作设定。已有完整的前集大纲只读，本次可补写分集大纲。</p>
                          ) : null}
                          {stage === 0 ? (
                            <BriefForm plan={plan} onChange={setPlan} fixedDuration={hasContinuation}
                              fixedSettings={continuationEpisodeNo !== null} />
                          ) : (
                            <BibleForm plan={plan} onChange={setPlan} fixedSettings={continuationEpisodeNo !== null}
                              frozenOutlineNos={frozenOutlineNos} />
                          )}
                        </div>
                      )}
                      <footer className={styles.formFooter}>
                        <span className={styles.muted}>
                          {planDirty ? "有未保存的修改" : "保存为独立版本，旧稿保留"}
                        </span>
                        <button
                          className={styles.button}
                          disabled={busy || initialStoryLegacy || (!planDirty && !!snapshot.story)}
                          onClick={() => void savePlan(false)}
                        >
                          保存草稿
                        </button>
                        <button
                          className={styles.primary}
                          disabled={
                            busy ||
                            initialStoryLegacy ||
                            (!planDirty &&
                              ["APPROVED", "IN_REVIEW"].includes(
                                snapshot.story?.reviewStatus ?? "",
                              ))
                          }
                          onClick={() => void savePlan(true)}
                        >
                          提交设定审稿
                        </button>
                        {continuationEpisodeNo !== null ? (
                          <button className={styles.subtle} type="button" disabled={planDirty}
                            onClick={() => { setContinuationEpisodeNo(null); setFrozenOutlineNos([]); }}>结束续写大纲编辑</button>
                        ) : null}
                      </footer>
                    </div>
                    <aside className={styles.card}>
                      <div className={styles.cardHeader}>
                        <h2>{stage === 0 ? "先明确边界" : "让每一集接得上"}</h2>
                      </div>
                      <div className={styles.continuity}>
                        <section>
                          <h3>{stage === 0 ? "制作配置" : "先定结局"}</h3>
                          <p>
                            {stage === 0
                              ? `共 ${snapshot.project.episodeCount} 集，每集 ${clock(plan.brief.targetEpisodeSeconds)}，最多 ${plan.brief.dialogueQuota} 句对白。`
                              : "写清最终结局，再倒推伏笔与各集的改变。"}
                          </p>
                        </section>
                        <section>
                          <h3>{stage === 0 ? "一句话梗概" : "角色身份保持一致"}</h3>
                          <p>
                            {stage === 0
                              ? "谁想得到什么，遇到什么阻碍，失败会失去什么。"
                              : "角色 ID 绑定对白。定妆、声线、称呼和角色已知信息一起维护。"}
                          </p>
                        </section>
                        <section>
                          <h3>版本确认</h3>
                          <p>
                            简报、梗概、系列圣经和分集大纲分别编号。审稿后，确认具体设定版本再写正文。
                          </p>
                        </section>
                        {versions ? (
                          <section>
                            <h3>当前文档编号</h3>
                            <p>
                              简报 v{versions.brief} · 梗概 v{versions.synopsis}
                              <br />
                              圣经 v{versions.bible} · 大纲 v{versions.outline}
                            </p>
                          </section>
                        ) : null}
                      </div>
                    </aside>
                  </div>
                ) : null}

                {stage === 2 || stage === 3 ? (
                  <div className={styles.workspace}>
                    <EpisodeNavigation
                      snapshot={snapshot}
                      selected={selectedEpisode}
                      selectedScene={selectedScene}
                      drafts={drafts}
                      busy={busy}
                      onSelect={selectEpisode}
                      onScene={setSelectedScene}
                      onDelete={previewDelete}
                    />
                    {episode && script ? (
                      <div className={`${styles.card} ${styles.editor}`}>
                        <div className={styles.cardHeader}>
                          <h2>
                            第{episode.episodeNo}集 {script.title}
                          </h2>
                          <StatusBadge revision={episode.script} />
                        </div>
                        <div className={styles.meter}>
                          <span>
                            本集估时{" "}
                            <strong
                              className={
                                estimate!.seconds > plan.brief.targetEpisodeSeconds
                                  ? styles.over
                                  : ""
                              }
                            >
                              {clock(estimate!.seconds)} / {clock(plan.brief.targetEpisodeSeconds)}
                            </strong>
                          </span>
                          <span>
                            对白配额{" "}
                            <strong
                              className={
                                estimate!.dialogueCount > plan.brief.dialogueQuota
                                  ? styles.over
                                  : ""
                              }
                            >
                              {estimate!.dialogueCount} / {plan.brief.dialogueQuota} 句
                            </strong>
                          </span>
                        </div>
                        <div className={styles.cardBody}>
                          {episode.isContinuation && !sequel ? (
                            <p className={styles.warning} role="status">暂时无法读取本集引用版本。<button type="button" onClick={refreshPreservingEdits}>重新读取</button></p>
                          ) : null}
                          {sequel && !sequel.storyConfirmed ? (
                            <div className={styles.notice}>
                              <p>为 {sequel.episodeCount} 集作品补写本集大纲，并在「定稿交接」确认新版设定与大纲后保存正文。</p>
                              <button className={styles.button} type="button" onClick={prepareSequelPlan}>编写新版大纲</button>
                            </div>
                          ) : !episode.isContinuation && !approved(snapshot.story) ? (
                            <p className={styles.warning}>
                              设定与大纲尚未锁定或已有更新，请先在「定稿交接」确认。
                            </p>
                          ) : null}
                          {sequel ? (
                            <>
                              <p className={styles.muted}>手动写可以直接在下方编辑。新剧情从第 {sequel.previousEpisodeNo} 集的结局接起。</p>
                              {!sequelHasPrevious ? <p className={styles.warning}>前集正文暂不可用，保存前需要恢复前集正文。</p> : null}
                              {awaitingDraftSources ? <p className={styles.muted}>草稿仍引用原版本，待前集或大纲版本确认后可重新核对。</p> : null}
                              {needsFirstPlanBinding ? (
                                <p className={styles.warning}>
                                  本集草稿写于新版设定确认前，请核对草稿与新版大纲。
                                  <button type="button" onClick={bindFirstSequelPlan}>已核对新版设定与大纲</button>
                                </p>
                              ) : null}
                              {staleSequel ? (
                                <p className={styles.warning}>
                                  本集草稿的来源版本已过期。
                                  <button type="button" onClick={startFreshSequelDraft}>按当前版本重写</button>
                                </p>
                              ) : null}
                              {lockedBeforeExpansion ? (
                                <p className={styles.notice}>本集已定稿，可按当前设定与大纲另写一个修订稿。
                                  <button type="button" onClick={startFreshSequelDraft}>新建本集修订稿</button>
                                </p>
                              ) : null}
                              {storedSequelDrafts.map((draft, index) => <ShortSequelDraftPreview
                                key={index} script={draft} title={`查看过期草稿 ${index + 1}`} />)}
                              <ShortSequelAi key={episode.id} projectId={projectId} episodeNo={episode.episodeNo}
                                hasBody={!!episode.script} hasUnsaved={scriptDirty}
                                hasPlan={!!sequel.storyRevisionId}
                                source={JSON.stringify(shortSequelSource(sequel))} onAdopt={adoptSequelAi} />
                            </>
                          ) : null}
                          {staleSequel || lockedBeforeExpansion
                            ? <ShortSequelDraftPreview script={script} title={staleSequel ? "查看当前过期草稿" : "查看已定稿正文"} />
                          : (episode.isContinuation && !sequel) ? null
                          : initialScriptLegacy ? (
                            <LegacyContent
                              text={plainText(episode.script!.content)}
                              onConvert={convertLegacy}
                            />
                          ) : stage === 2 ? (
                            <SceneEditor
                              script={script}
                              characters={sequelCharacters}
                              selectedScene={selectedScene}
                              onScene={setSelectedScene}
                              onChange={updateScript}
                            />
                          ) : (
                            <ReviewEditor
                              script={script}
                              characters={sequelCharacters}
                              onChange={updateScript}
                            />
                          )}
                        </div>
                        <footer className={styles.formFooter}>
                          <span className={styles.muted}>
                            {scriptDirty
                              ? "有未保存的修改"
                              : approved(episode.script)
                                ? "修改后另存新版本，原定稿保留"
                                : "保存后可提交审稿"}
                          </span>
                          <button
                            className={styles.button}
                            disabled={
                              busy ||
                              initialScriptLegacy ||
                              !approved(snapshot.story) ||
                              !sequelCanSave ||
                              (!scriptDirty && !!episode.script) ||
                              (episode.isContinuation && !scriptDirty && !episode.script)
                            }
                            onClick={() => void saveScript(false)}
                          >
                            {episode.isContinuation ? "保存本集正文" : "保存草稿"}
                          </button>
                          <button
                            className={styles.primary}
                            disabled={
                              busy ||
                              initialScriptLegacy ||
                              !approved(snapshot.story) ||
                              !sequelCanSave ||
                              (episode.isContinuation && !scriptDirty && !episode.script) ||
                              (!scriptDirty &&
                                ["IN_REVIEW", "APPROVED"].includes(
                                  episode.script?.reviewStatus ?? "",
                                ))
                            }
                            onClick={() => void saveScript(true)}
                          >
                            提交审稿
                          </button>
                          {canSubmitOriginal ? (
                            <button className={styles.primary} type="button" disabled={busy}
                              onClick={() => void submitOriginalScript()}>提交原文审稿</button>
                          ) : null}
                          {snapshot.project.writingMode === "short" && snapshot.project.targetEpisodeSeconds !== null && episode.episodeNo < 6 ? (
                            <ShortSequelEntry key={episode.id} projectId={projectId} afterEpisodeNo={episode.episodeNo} />
                          ) : null}
                        </footer>
                      </div>
                    ) : (
                      <div className={styles.card}>
                        <div className={styles.empty}>
                          <h2>先确认设定，再逐集编写</h2>
                          <p>保存简报和大纲后提交审稿，在定稿交接中确认具体版本。</p>
                          <button className={styles.primary} onClick={() => setStage(4)}>
                            去定稿交接
                          </button>
                        </div>
                      </div>
                    )}
                    {episode && script ? (
                      <ContinuityPanel
                        episode={episode}
                        script={script}
                        previous={previous}
                        sequel={sequel}
                        sequelSource={sequelSource}
                        frozenPredecessor={frozenPreviousInSnapshot ? {
                          revisionId: frozenPreviousInSnapshot.id, revisionNo: frozenPreviousInSnapshot.revisionNo,
                          content: frozenPreviousInSnapshot.content, handoff: workbenchScript(frozenPreviousInSnapshot)?.endingHandoff ?? null,
                          freshnessStatus: frozenPreviousInSnapshot.freshnessStatus,
                        } : frozenPredecessor?.revisionId === frozenPreviousId ? frozenPredecessor : null}
                        locked={invalidSequelSource || (episode.isContinuation === true && !sequel)}
                        projectId={projectId}
                        onChange={updateScript}
                        onBible={() => setStage(1)}
                      />
                    ) : null}
                  </div>
                ) : null}

                {stage === 4 ? (
                  <div className={styles.twoColumn}>
                    <div className={styles.card}>
                      <div className={styles.cardHeader}>
                        <h2>确认具体版本</h2>
                        <span className={styles.badge}>{snapshot.project.episodeCount} 集</span>
                      </div>
                      <div className={styles.cardBody}>
                        <div className={styles.documentRow}>
                          <div>
                            <h3>
                              设定与大纲 <StatusBadge revision={snapshot.story} />
                            </h3>
                            <p>
                              {versions
                                ? `简报 v${versions.brief} · 一句话梗概 v${versions.synopsis} · 系列圣经 v${versions.bible} · 分集大纲 v${versions.outline}`
                                : "尚未保存结构化设定"}
                            </p>
                            {planDirty ? <p>有未保存修改，先保存并提交审稿。</p> : null}
                          </div>
                          <div className={styles.actions}>
                            <button className={styles.subtle} onClick={() => setHistory("story")}>
                              查看版本
                            </button>
                            <button
                              className={styles.primary}
                              disabled={
                                busy ||
                                !snapshot.story ||
                                snapshot.story.reviewStatus !== "IN_REVIEW" ||
                                planDirty ||
                                snapshot.story.freshnessStatus !== "CURRENT"
                              }
                              onClick={() =>
                                snapshot.story &&
                                setConfirmation({ kind: "story", revision: snapshot.story })
                              }
                            >
                              确认设定版本
                            </button>
                          </div>
                        </div>
                        {snapshot.episodes.map((item) => {
                          const dirty = !same(drafts[item.id], baseline.current.scripts[item.id]);
                          const context = sequelContexts[item.id];
                          const source = savedShortSequelSource(item.script);
                          const invalidSequel = item.isContinuation && (!context?.storyConfirmed || !context.previousLocked
                            || context.previousFreshnessStatus !== "CURRENT" || !source || source.storyRevisionId !== context.storyRevisionId
                            || !matchesSequelPrevious(source, context) || shortSequelDraftIsExpired(source, context));
                          return (
                            <div className={styles.documentRow} key={item.id}>
                              <div>
                                <h3>
                                  第{item.episodeNo}集{" "}
                                  {workbenchScript(item.script)?.title ?? item.title}
                                </h3>
                                <p>
                                  {revisionLabel(item.script)}
                                  {dirty ? " · 有未保存修改" : ""}
                                </p>
                                <p>
                                  {approved(item.script)
                                    ? "正文已定稿，可交接这个版本。"
                                    : "先完成审稿检查，再确认本集正文。"}
                                </p>
                              </div>
                              <div className={styles.actions}>
                                <button
                                  className={styles.subtle}
                                  onClick={() => {
                                    selectEpisode(item.id);
                                    setStage(3);
                                  }}
                                >
                                  审稿
                                </button>
                                <button
                                  className={styles.subtle}
                                  onClick={() => setHistory(item.id)}
                                >
                                  版本
                                </button>
                                <button
                                  className={styles.primary}
                                  disabled={
                                    busy ||
                                    !item.script ||
                                    item.script.reviewStatus !== "IN_REVIEW" ||
                                    item.script.freshnessStatus !== "CURRENT" ||
                                    invalidSequel ||
                                    dirty ||
                                    planDirty
                                  }
                                  onClick={() =>
                                    item.script &&
                                    setConfirmation({
                                      kind: "script",
                                      episode: item,
                                      revision: item.script,
                                    })
                                  }
                                >
                                  确认本集定稿
                                </button>
                              </div>
                            </div>
                          );
                        })}
                        {!snapshot.story ? (
                          <p className={styles.notice}>
                            还没有可确认的版本。请先保存并提交设定审稿。
                          </p>
                        ) : null}
                      </div>
                    </div>
                    <aside className={styles.card}>
                      <div className={styles.cardHeader}>
                        <h2>制作交接</h2>
                      </div>
                      <div className={styles.cardBody}>
                        <p className={styles.muted}>
                          仅使用用户确认、且来源仍有效的具体版本。新草稿不会自动替换制作素材。
                        </p>
                        {snapshot.project.writingMode === "series" ? (
                          <p className={styles.notice}>
                            系列模式当前支持文本写作与定稿，分镜、配音及视频制作暂未开放。
                          </p>
                        ) : (
                          <>
                            <label className={styles.field}>
                              选择交接集数
                              <select
                                value={selectedEpisode}
                                onChange={(event) => setSelectedEpisode(event.target.value)}
                              >
                                {snapshot.episodes.map((item) => (
                                  <option key={item.id} value={item.id}>
                                    第{item.episodeNo}集{" "}
                                    {workbenchScript(item.script)?.title ?? item.title}
                                  </option>
                                ))}
                              </select>
                            </label>
                            {episode && approved(episode.script) && !scriptDirty && !planDirty ? (
                              <>
                                <p className={styles.success}>
                                  第{episode.episodeNo}集 v{episode.script!.revisionNo} 已定稿
                                </p>
                                <div className={styles.handoffGrid}>
                                  <a
                                    className={styles.button}
                                    href={`/projects/${projectId}?focus=script&episode=${episode.episodeNo}#script-breakdown`}
                                  >
                                    分镜
                                  </a>
                                  <a
                                    className={styles.button}
                                    href={`/projects/${projectId}?focus=script&episode=${episode.episodeNo}#episode-speech`}
                                  >
                                    配音
                                  </a>
                                  <a
                                    className={styles.button}
                                    href={`/projects/${projectId}?focus=script&episode=${episode.episodeNo}#episode-scenes`}
                                  >
                                    视频制作
                                  </a>
                                </div>
                              </>
                            ) : (
                              <p className={styles.warning}>所选集待定稿，制作入口暂未开放。</p>
                            )}
                          </>
                        )}
                        <a className={styles.subtle} href="/studio/trash">
                          打开回收站 →
                        </a>
                      </div>
                    </aside>
                  </div>
                ) : null}
              </section>
            </fieldset>
          ) : null}
        </main>
      </CreatorShell>

      {reconcile ? (
        <Modal
          title="处理编辑版本冲突"
          onClose={() => setReconcile(null)}
          footer={
            <>
              <button className={styles.button} onClick={() => setReconcile(null)}>
                保留原基线
              </button>
              <button className={styles.primary} onClick={adoptInspectedBaseline}>
                保留我的内容，采用此基线
              </button>
            </>
          }
        >
          <p className={styles.notice}>
            对照这次读取的服务器版本与本地内容。确认只更新编辑基线；之后保存为新稿，仍需重新审稿。若服务器再次变化，保存仍会被阻止。
          </p>
          <h3>服务器版本</h3>
          <pre>{reconcile.serverText}</pre>
          <h3>本地未保存内容</h3>
          <pre>{reconcile.draftText}</pre>
        </Modal>
      ) : null}
      {history !== null && snapshot ? (
        <Modal title="版本记录" onClose={() => setHistory(null)} busy={busy}>
          <label className={styles.field}>
            稿件
            <select value={history} onChange={(event) => setHistory(event.target.value)}>
              <option value="story">设定与大纲</option>
              {snapshot.episodes.map((item) => (
                <option key={item.id} value={item.id}>
                  第{item.episodeNo}集 {drafts[item.id]?.title ?? item.title}
                </option>
              ))}
            </select>
          </label>
          {!historyRevisions?.length ? (
            <p className={styles.empty}>还没有版本记录</p>
          ) : (
            historyRevisions.map((revision) => (
              <article key={revision.id} className={styles.revision}>
                <div className={styles.revisionTop}>
                  <strong>
                    {history === "story" ? "设定与大纲" : `第${historyEpisode?.episodeNo}集`} ·{" "}
                    {revisionLabel(revision)}
                  </strong>
                  {historyEpisode ? (
                    <div className={styles.actions}>
                      <button
                        className={styles.subtle}
                        disabled={
                          busy ||
                          !same(
                            drafts[historyEpisode.id],
                            baseline.current.scripts[historyEpisode.id],
                          )
                        }
                        onClick={() => loadHistoryAsDraft(historyEpisode, revision)}
                      >
                        载入为修订草稿
                      </button>
                      <button
                        className={`${styles.subtle} ${styles.dangerText}`}
                        disabled={
                          busy ||
                          !same(
                            drafts[historyEpisode.id],
                            baseline.current.scripts[historyEpisode.id],
                          )
                        }
                        onClick={() => void previewDelete(historyEpisode, revision)}
                      >
                        删除{approved(revision) ? "已锁版本" : "稿件"}
                      </button>
                    </div>
                  ) : null}
                </div>
                <p className={styles.revisionMeta}>
                  {formatDate(revision.createdAt)}
                  {revision.freshnessStatus === "STALE" ? " · 来源已更新，需复核" : ""}
                </p>
                <details>
                  <summary className={styles.subtle}>查看这个版本的正文</summary>
                  <pre>{plainText(revision.content)}</pre>
                </details>
              </article>
            ))
          )}
          {activeHistoryPage?.error ? (
            <p className={styles.warning} role="alert">
              {activeHistoryPage.error} 已载入的版本仍保留，可重试加载。
            </p>
          ) : null}
          {historyCursor ? (
            <button
              className={styles.button}
              disabled={busy || activeHistoryPage?.loading}
              onClick={() => void loadMoreHistory()}
            >
              {activeHistoryPage?.loading ? "正在加载更早版本…" : "加载更早版本"}
            </button>
          ) : null}
          <p className={styles.muted}>
            载入历史版本前请先保存当前编辑。载入后需重新核对、审稿并保存为新版本；不会恢复原批准状态。删除前会核对关联分镜、配音和视频。
          </p>
        </Modal>
      ) : null}
      {confirmation ? (
        <Modal
          title={
            confirmation.kind === "story"
              ? "确认这版设定？"
              : `确认第 ${confirmation.episode.episodeNo} 集定稿？`
          }
          onClose={() => setConfirmation(null)}
          busy={busy}
          small
          footer={
            <>
              <button
                className={styles.button}
                disabled={busy}
                onClick={() => setConfirmation(null)}
              >
                返回检查
              </button>
              <button
                className={styles.primary}
                disabled={busy}
                onClick={() => void confirmVersion()}
              >
                确认锁定 v{confirmation.revision.revisionNo}
              </button>
            </>
          }
        >
          <p>
            《{snapshot?.project.title}》 ·{" "}
            {confirmation.kind === "story"
              ? "设定与大纲"
              : `第 ${confirmation.episode.episodeNo} 集`}{" "}
            · v{confirmation.revision.revisionNo}
          </p>
          {confirmation.kind === "story" ? (
            <p className={styles.notice}>
              {(() => {
                const v = documentVersions(confirmation.revision);
                return v
                  ? `简报 v${v.brief}、梗概 v${v.synopsis}、系列圣经 v${v.bible}、分集大纲 v${v.outline} 将一并确认。`
                  : "将确认当前展示的设定版本。";
              })()}
            </p>
          ) : (
            <p className={styles.notice}>
              确认后，下游制作使用这一版正文。后续改稿会保存为新版本，需要重新审稿。
            </p>
          )}
          <details>
            <summary className={styles.subtle}>复核版本内容</summary>
            <pre>{plainText(confirmation.revision.content)}</pre>
          </details>
          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
        </Modal>
      ) : null}
      {deletion ? (
        <Modal
          title={`删除第 ${deletion.preview.episodeNo} 集${deletion.preview.reviewStatus === "APPROVED" ? "已锁版本" : "草稿"}？`}
          onClose={() => setDeletion(null)}
          busy={busy}
          small
          footer={
            <>
              <button className={styles.button} disabled={busy} onClick={() => setDeletion(null)}>
                取消
              </button>
              <button
                className={styles.danger}
                disabled={busy || !deletion.preview.canDelete}
                onClick={() => void trashRevision()}
              >
                移入回收站
              </button>
            </>
          }
        >
          <p>
            《{deletion.preview.title}》 · 第 {deletion.preview.episodeNo} 集 · v
            {deletion.preview.revisionNo}
          </p>
          <p className={styles.muted}>移入回收站后可恢复。已有素材不会被一并删除。</p>
          <ul className={styles.dependencies}>
            <li>
              场景 {deletion.preview.dependencies.scenes} · 分镜{" "}
              {deletion.preview.dependencies.shots}
            </li>
            <li>
              配音 {deletion.preview.dependencies.speech} · 视频{" "}
              {deletion.preview.dependencies.video}
            </li>
            {deletion.preview.dependencies.other ? (
              <li>其他引用 {deletion.preview.dependencies.other}</li>
            ) : null}
          </ul>
          {deletion.preview.references?.length ? (
            <details open>
              <summary className={styles.subtle}>引用此版本的内容</summary>
              <ul className={styles.dependencies}>
                {deletion.preview.references.map((reference) => (
                  <li key={`${reference.kind}:${reference.id}`}>
                    <strong>
                      {
                        {
                          scene: "场景",
                          shot: "分镜",
                          speech: "配音",
                          video: "视频",
                          other: "其他",
                        }[reference.kind]
                      }
                    </strong>{" "}
                    · {reference.label}{" "}
                    <small title={reference.id}>（{reference.id.slice(0, 8)}）</small>
                  </li>
                ))}
              </ul>
              {deletion.preview.dependencies.total > deletion.preview.references.length ? (
                <p className={styles.muted}>
                  仅展示前 {deletion.preview.references.length} 项引用。
                </p>
              ) : null}
            </details>
          ) : null}
          {!deletion.preview.canDelete ? (
            <p className={styles.warning}>
              {deletion.preview.blockedReason ?? "稿件仍有引用，暂不能删除。"}
            </p>
          ) : null}
          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
        </Modal>
      ) : null}
    </div>
  );
}

function message(caught: unknown): string {
  return caught instanceof ApiError
    ? caught.detail
    : caught instanceof Error
      ? caught.message
      : "操作未完成，编辑内容已保留，请稍后重试。";
}
function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? ""
    : date.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}

function LegacyContent({ text, onConvert }: { text: string; onConvert: () => void }) {
  return (
    <>
      <p className={styles.notice}>
        这是原有稿件，原文保留在下方。转入结构化草稿后可整理场次与连续性；保存会创建新版本。
      </p>
      <div className={styles.readOnly}>{text}</div>
      <button className={styles.button} onClick={onConvert}>
        转入结构化草稿
      </button>
    </>
  );
}

function BriefForm({
  plan,
  onChange,
  fixedDuration,
  fixedSettings,
}: {
  plan: ScriptWorkbenchPlan;
  onChange: (plan: ScriptWorkbenchPlan) => void;
  fixedDuration: boolean;
  fixedSettings: boolean;
}) {
  const change = (patch: Partial<ScriptWorkbenchPlan["brief"]>) => {
    if (!fixedSettings) onChange({ ...plan, brief: { ...plan.brief, ...patch } });
  };
  return (
    <div className={styles.form}>
      <div className={styles.formGrid}>
        <Field
          short
          label="题材"
          value={plan.brief.genre}
          readOnly={fixedSettings}
          onChange={(genre) => change({ genre })}
        />
        <Field
          short
          label="目标受众"
          value={plan.brief.audience}
          readOnly={fixedSettings}
          onChange={(audience) => change({ audience })}
        />
      </div>
      <Field
        label="一句话梗概"
        value={plan.brief.logline}
        readOnly={fixedSettings}
        onChange={(logline) => change({ logline })}
        rows={2}
        hint="写清主角、目标、阻碍和代价。"
      />
      <Field
        label="制作边界"
        value={plan.brief.productionConstraints}
        readOnly={fixedSettings}
        onChange={(productionConstraints) => change({ productionConstraints })}
        hint="场地、演员、时代背景、镜头难度，以及本次不能拍的内容。"
      />
      <div className={styles.formGrid}>
        <Field
          short
          type="number"
          min={5}
          max={3600}
          label="单集目标时长（秒）"
          value={plan.brief.targetEpisodeSeconds}
          readOnly={fixedDuration || fixedSettings}
          onChange={(value) => change({ targetEpisodeSeconds: Number(value) })}
          hint="按作品设置，例如 27 秒或 210 秒。"
        />
        <Field
          short
          type="number"
          min={0}
          max={1000}
          label="单集对白配额（句）"
          value={plan.brief.dialogueQuota}
          readOnly={fixedSettings}
          onChange={(value) => change({ dialogueQuota: Number(value) })}
          hint="每一个对白块计为一句；动作和停顿也计时。"
        />
      </div>
    </div>
  );
}

function BibleForm({
  plan,
  onChange,
  fixedSettings,
  frozenOutlineNos,
}: {
  plan: ScriptWorkbenchPlan;
  onChange: (plan: ScriptWorkbenchPlan) => void;
  fixedSettings: boolean;
  frozenOutlineNos: number[];
}) {
  const changeBible = (patch: Partial<ScriptWorkbenchPlan["bible"]>) => {
    if (!fixedSettings) onChange({ ...plan, bible: { ...plan.bible, ...patch } });
  };
  return (
    <>
      <h3 className={styles.sectionTitle}>系列圣经</h3>
      <div className={styles.form}>
        <Field
          label="故事结局"
          value={plan.bible.ending}
          readOnly={fixedSettings}
          onChange={(ending) => changeBible({ ending })}
          hint="先确定人物最终的选择和结局，再倒推伏笔。"
        />
        <Field
          label="伏笔与未回收悬念"
          value={plan.bible.openThreads}
          readOnly={fixedSettings}
          onChange={(openThreads) => changeBible({ openThreads })}
        />
      </div>
      <h3 className={styles.sectionTitle}>角色档案</h3>
      {plan.bible.characters.length === 0 && !fixedSettings ? (
        <p className={styles.notice}>添加角色，为每句对白绑定稳定的角色 ID。</p>
      ) : null}
      {plan.bible.characters.map((character, index) => {
        const update = (patch: Partial<typeof character>) =>
          changeBible({
            characters: plan.bible.characters.map((item, at) =>
              at === index ? { ...item, ...patch } : item,
            ),
          });
        return (
          <div className={styles.character} key={index}>
            <div className={styles.characterTitle}>
              <strong>
                角色 {index + 1} · {character.id}
              </strong>
              {!fixedSettings ? <button
                className={`${styles.subtle} ${styles.dangerText}`}
                onClick={() =>
                  changeBible({ characters: plan.bible.characters.filter((_, at) => at !== index) })
                }
              >
                移除角色 {index + 1}
              </button> : null}
            </div>
            <div className={styles.formGrid}>
              <Field
                short
                label={`角色 ${index + 1} ID`}
                value={character.id}
                readOnly={fixedSettings}
                onChange={(id) => update({ id })}
                hint="用于对白绑定，建立后请保持不变。"
              />
              <Field
                short
                label={`角色 ${index + 1} 姓名`}
                value={character.name}
                readOnly={fixedSettings}
                onChange={(name) => update({ name })}
              />
              <Field
                label={`角色 ${index + 1} 定妆`}
                value={character.appearance}
                readOnly={fixedSettings}
                onChange={(appearance) => update({ appearance })}
                rows={2}
              />
              <Field
                label={`角色 ${index + 1} 声线`}
                value={character.voice}
                readOnly={fixedSettings}
                onChange={(voice) => update({ voice })}
                rows={2}
              />
              <Field
                short
                label={`角色 ${index + 1} 称呼`}
                value={character.aliases}
                readOnly={fixedSettings}
                onChange={(aliases) => update({ aliases })}
              />
              <Field
                label={`角色 ${index + 1} 已知信息`}
                value={character.knownInformation}
                readOnly={fixedSettings}
                onChange={(knownInformation) => update({ knownInformation })}
                rows={2}
              />
            </div>
          </div>
        );
      })}
      {!fixedSettings ? <button
        className={styles.button}
        onClick={() => {
          let number = plan.bible.characters.length + 1;
          while (
            plan.bible.characters.some((item) => item.id === `R${String(number).padStart(2, "0")}`)
          )
            number += 1;
          changeBible({
            characters: [
              ...plan.bible.characters,
              {
                id: `R${String(number).padStart(2, "0")}`,
                name: "",
                appearance: "",
                voice: "",
                aliases: "",
                knownInformation: "",
              },
            ],
          });
        }}
      >
        ＋ 添加角色
      </button> : null}
      <h3 className={styles.sectionTitle}>分集大纲</h3>
      {plan.outline.episodes.map((item, index) => {
        const outlineReadOnly = frozenOutlineNos.includes(item.episodeNo);
        const update = (patch: Partial<typeof item>) => {
          if (!outlineReadOnly) onChange({
            ...plan,
            outline: {
              episodes: plan.outline.episodes.map((value, at) =>
                at === index ? { ...value, ...patch } : value,
              ),
            },
          });
        };
        return (
          <section className={styles.outline} key={item.episodeNo}>
            <h3>第 {item.episodeNo} 集</h3>
            <div className={styles.formGrid}>
              <Field
                short
                label={`第 ${item.episodeNo} 集标题`}
                value={item.title}
                readOnly={outlineReadOnly}
                onChange={(title) => update({ title })}
              />
              <Field
                label={`第 ${item.episodeNo} 集开场 3 秒`}
                value={item.openingHook}
                readOnly={outlineReadOnly}
                onChange={(openingHook) => update({ openingHook })}
                rows={2}
              />
              <Field
                label={`第 ${item.episodeNo} 集发生的改变`}
                value={item.change}
                readOnly={outlineReadOnly}
                onChange={(change) => update({ change })}
                rows={2}
              />
              <Field
                label={`第 ${item.episodeNo} 集尾交接`}
                value={item.endingHandoff}
                readOnly={outlineReadOnly}
                onChange={(endingHandoff) => update({ endingHandoff })}
                rows={2}
              />
            </div>
          </section>
        );
      })}
    </>
  );
}

function EpisodeNavigation({
  snapshot,
  selected,
  selectedScene,
  drafts,
  busy,
  onSelect,
  onScene,
  onDelete,
}: {
  snapshot: ScriptWorkbenchSnapshot;
  selected: string;
  selectedScene: string;
  drafts: Record<string, ScriptWorkbenchScript>;
  busy: boolean;
  onSelect: (id: string) => void;
  onScene: (id: string) => void;
  onDelete: (episode: ScriptWorkbenchEpisode, revision: ScriptWorkbenchRevision) => Promise<void>;
}) {
  return (
    <aside className={styles.card}>
      <div className={styles.cardHeader}>
        <h2>分集与场次</h2>
      </div>
      <div className={styles.episodeList}>
        {snapshot.episodes.map((item) => {
          const script = drafts[item.id];
          return (
            <div className={styles.episodeRow} key={item.id}>
              <div className={styles.episodeLine} data-active={selected === item.id}>
                <button
                  className={styles.episodeButton}
                  onClick={() => onSelect(item.id)}
                  aria-pressed={selected === item.id}
                >
                  <strong>
                    第{item.episodeNo}集 {script?.title || item.title}
                  </strong>
                  <small>{revisionLabel(item.script)}</small>
                </button>
                {item.script && item.script.reviewStatus !== "APPROVED" ? (
                  <button
                    className={styles.deleteButton}
                    disabled={busy}
                    aria-label={`删除第 ${item.episodeNo} 集草稿`}
                    onClick={() => void onDelete(item, item.script!)}
                  >
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.7"
                      aria-hidden="true"
                    >
                      <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" />
                    </svg>
                  </button>
                ) : null}
              </div>
              {selected === item.id && script?.scenes.length ? (
                <ol className={styles.sceneList}>
                  {script.scenes.map((scene, index) => (
                    <li key={scene.id}>
                      <button
                        aria-current={scene.id === selectedScene || (!selectedScene && index === 0)}
                        onClick={() => onScene(scene.id)}
                      >
                        {String(index + 1).padStart(2, "0")} {scene.heading || "未命名场次"}
                      </button>
                    </li>
                  ))}
                </ol>
              ) : null}
            </div>
          );
        })}
        {snapshot.episodes.length === 0 ? (
          <p className={styles.muted}>确认设定后显示分集。</p>
        ) : null}
      </div>
    </aside>
  );
}

function SceneEditor({
  script,
  characters,
  selectedScene,
  onScene,
  onChange,
}: {
  script: ScriptWorkbenchScript;
  characters: ScriptWorkbenchPlan["bible"]["characters"];
  selectedScene: string;
  onScene: (id: string) => void;
  onChange: (patch: Partial<ScriptWorkbenchScript>) => void;
}) {
  const scene = script.scenes.find((item) => item.id === selectedScene) ?? script.scenes[0];
  const updateScene = (patch: Partial<ScriptWorkbenchScene>) => {
    if (scene)
      onChange({
        scenes: script.scenes.map((item) => (item.id === scene.id ? { ...item, ...patch } : item)),
      });
  };
  const addScene = () => {
    const next: ScriptWorkbenchScene = {
      id: crypto.randomUUID(),
      heading: "",
      interiorExterior: "INT",
      timeOfDay: "DAY",
      characterIds: [],
      beats: [],
    };
    onChange({ scenes: [...script.scenes, next] });
    onScene(next.id);
  };
  const addBeat = (kind: ScriptWorkbenchBeat["kind"]) => {
    if (scene)
      updateScene({
        beats: [
          ...scene.beats,
          {
            id: crypto.randomUUID(),
            kind,
            text: "",
            seconds: 0,
            ...(kind === "dialogue"
              ? { characterId: scene.characterIds[0] ?? characters[0]?.id ?? "" }
              : {}),
          },
        ],
      });
  };
  return (
    <>
      <Field
        short
        label="本集标题"
        value={script.title}
        onChange={(title) => onChange({ title })}
      />
      {scene ? (
        <>
          <div className={styles.sceneHeading}>
            <span className={styles.sceneNumber}>
              {String(script.scenes.indexOf(scene) + 1).padStart(2, "0")}
            </span>
            <input
              aria-label="场次名称"
              value={scene.heading}
              placeholder="写下场次名称"
              onChange={(event) => updateScene({ heading: event.target.value })}
            />
          </div>
          <div className={styles.sceneMeta}>
            <label className={styles.field}>
              内外景
              <select
                value={scene.interiorExterior}
                onChange={(event) =>
                  updateScene({ interiorExterior: event.target.value as "INT" | "EXT" })
                }
              >
                <option value="INT">内景</option>
                <option value="EXT">外景</option>
              </select>
            </label>
            <label className={styles.field}>
              日夜
              <select
                value={scene.timeOfDay}
                onChange={(event) =>
                  updateScene({ timeOfDay: event.target.value as "DAY" | "NIGHT" })
                }
              >
                <option value="DAY">日</option>
                <option value="NIGHT">夜</option>
              </select>
            </label>
          </div>
          <div className={styles.field}>
            <span>出场角色</span>
            <div className={styles.cast}>
              {characters.map((character) => (
                <label key={character.id}>
                  <input
                    type="checkbox"
                    checked={scene.characterIds.includes(character.id)}
                    onChange={(event) =>
                      updateScene({
                        characterIds: event.target.checked
                          ? [...scene.characterIds, character.id]
                          : scene.characterIds.filter((id) => id !== character.id),
                      })
                    }
                  />
                  {character.name || character.id} <small>{character.id}</small>
                </label>
              ))}
              {characters.length === 0 ? (
                <span className={styles.muted}>请先在系列圣经中添加角色。</span>
              ) : null}
            </div>
          </div>
          <div className={styles.beats}>
            {scene.beats.map((beat, index) => (
              <div className={styles.beat} key={beat.id} data-kind={beat.kind}>
                <div className={styles.beatTools}>
                  <strong>
                    {{ action: "动作", dialogue: "对白", sound: "声音", pause: "停顿" }[beat.kind]}
                  </strong>
                  {beat.kind === "dialogue" ? (
                    <select
                      aria-label={`第 ${index + 1} 段对白角色`}
                      value={beat.characterId ?? ""}
                      onChange={(event) =>
                        updateScene({
                          beats: scene.beats.map((item) =>
                            item.id === beat.id
                              ? { ...item, characterId: event.target.value }
                              : item,
                          ),
                        })
                      }
                    >
                      <option value="">选择角色</option>
                      {characters.map((character) => (
                        <option key={character.id} value={character.id}>
                          {character.name} · {character.id}
                        </option>
                      ))}
                    </select>
                  ) : null}
                  <label>
                    {beat.kind === "dialogue" ? "预计" : "时长"}
                    <input
                      aria-label={`第 ${index + 1} 段时长（秒）`}
                      type="number"
                      min="0"
                      max="3600"
                      step="0.5"
                      value={beat.seconds}
                      onChange={(event) =>
                        updateScene({
                          beats: scene.beats.map((item) =>
                            item.id === beat.id
                              ? { ...item, seconds: Number(event.target.value) }
                              : item,
                          ),
                        })
                      }
                    />
                    秒
                  </label>
                  <button
                    aria-label={`移除第 ${index + 1} 段`}
                    onClick={() =>
                      updateScene({ beats: scene.beats.filter((item) => item.id !== beat.id) })
                    }
                  >
                    移除
                  </button>
                </div>
                <textarea
                  aria-label={`第 ${index + 1} 段${{ action: "动作", dialogue: "对白", sound: "声音", pause: "停顿" }[beat.kind]}`}
                  rows={2}
                  value={beat.text}
                  placeholder={
                    beat.kind === "action"
                      ? "写到可以拆成镜头的动作…"
                      : beat.kind === "dialogue"
                        ? "角色说了什么…"
                        : beat.kind === "pause"
                          ? "停顿时观众看到什么…"
                          : "观众听到什么…"
                  }
                  onChange={(event) =>
                    updateScene({
                      beats: scene.beats.map((item) =>
                        item.id === beat.id ? { ...item, text: event.target.value } : item,
                      ),
                    })
                  }
                />
              </div>
            ))}
          </div>
          <div className={styles.addBeats}>
            {(
              [
                ["action", "动作"],
                ["dialogue", "对白"],
                ["sound", "声音"],
                ["pause", "停顿"],
              ] as const
            ).map(([kind, label]) => (
              <button className={styles.button} key={kind} onClick={() => addBeat(kind)}>
                ＋ {label}
              </button>
            ))}
          </div>
          <p className={styles.muted}>
            估时包含动作、对白、声音和停顿；对白按每秒 4
            字估算，可填写更长时长；实际拍摄需另行校时。
          </p>
        </>
      ) : (
        <p className={styles.empty}>添加第一个场次，把动作和对白写到能拍。</p>
      )}
      <div className={styles.actions}>
        <button className={styles.subtle} onClick={addScene}>
          ＋ 添加场次
        </button>
        {scene ? (
          <button
            className={`${styles.subtle} ${styles.dangerText}`}
            onClick={() => {
              onChange({ scenes: script.scenes.filter((item) => item.id !== scene.id) });
              onScene("");
            }}
          >
            移除当前场次
          </button>
        ) : null}
      </div>
    </>
  );
}

function ReviewEditor({
  script,
  characters,
  onChange,
}: {
  script: ScriptWorkbenchScript;
  characters: ScriptWorkbenchPlan["bible"]["characters"];
  onChange: (patch: Partial<ScriptWorkbenchScript>, checksOnly?: boolean) => void;
}) {
  const review = script.review ?? emptyScript("").review!;
  return (
    <>
      <h3 className={styles.sectionTitle}>换一双眼睛看这一集</h3>
      <p className={styles.muted}>
        让没看过大纲的人只看画面、听对白。完成检查后保存，并提交这一版审稿。
      </p>
      <ul className={styles.checklist}>
        {REVIEW_CHECKS.map(([key, label]) => (
          <li key={key}>
            <label>
              <input
                type="checkbox"
                checked={review[key]}
                onChange={(event) =>
                  onChange({ review: { ...review, [key]: event.target.checked } }, true)
                }
              />
              {label}
            </label>
          </li>
        ))}
      </ul>
      <div className={styles.form}>
        <Field
          label="审稿记录与修订说明"
          value={review.note}
          onChange={(note) => onChange({ review: { ...review, note } }, true)}
        />
      </div>
      <details>
        <summary className={styles.subtle}>只看本集画面、对白与声音</summary>
        {script.scenes.map((scene, index) => (
          <section key={scene.id}>
            <h3 className={styles.sectionTitle}>
              {String(index + 1).padStart(2, "0")} {scene.heading} ·{" "}
              {scene.interiorExterior === "INT" ? "内景" : "外景"} ·{" "}
              {scene.timeOfDay === "DAY" ? "日" : "夜"}
            </h3>
            {scene.beats.map((beat) => (
              <p key={beat.id} className={styles.readOnly}>
                <strong>
                  {beat.kind === "dialogue"
                    ? `${characters.find((character) => character.id === beat.characterId)?.name ?? "未绑定角色"} · ${beat.characterId ?? ""}`
                    : { action: "动作", sound: "声音", pause: "停顿" }[beat.kind]}
                </strong>{" "}
                {beat.text}
              </p>
            ))}
          </section>
        ))}
      </details>
    </>
  );
}

function ContinuityPanel({
  episode,
  script,
  previous,
  sequel,
  sequelSource,
  frozenPredecessor,
  locked,
  projectId,
  onChange,
  onBible,
}: {
  episode: ScriptWorkbenchEpisode;
  script: ScriptWorkbenchScript;
  previous: ScriptWorkbenchEpisode | null;
  sequel?: ShortSequelView | null;
  sequelSource: ShortSequelSource | null;
  frozenPredecessor: ShortSequelPredecessor | null;
  locked: boolean;
  projectId: string;
  onChange: (patch: Partial<ScriptWorkbenchScript>) => void;
  onBible: () => void;
}) {
  const previousScript = workbenchScript(previous?.script);
  const previousReady = sequel ? sequel.previousLocked : previous && approved(previous.script);
  const frozenPackage = !!sequelSource?.originalRunId && sequelSource.originalRunId === sequel?.original?.runId
    && sequelSource.originalEpisodeHash === sequel.original.previousStageHash;
  const differentPrevious = !!sequelSource?.previousRevisionId && sequelSource.previousRevisionId !== sequel?.previousRevisionId;
  const displayedPredecessor = !sequel ? null : differentPrevious ? frozenPredecessor?.content ?? null
    : frozenPackage ? { text: sequel.original?.previousScriptText } : sequel.previousScript;
  const previousText = displayedPredecessor ? plainText(displayedPredecessor) : null;
  const displayedHandoff = !sequel ? previousScript?.endingHandoff : differentPrevious ? frozenPredecessor?.handoff
    : frozenPackage ? sequel.original?.previousScript?.handoffFacts.join("；") : sequel.previousHandoff;
  const confirmed = sequel ? previousReady && (!sequelSource || matchesSequelPrevious(sequelSource, sequel))
    : previousReady && script.previousRevisionId === previous?.script?.id;
  const previousStatus = differentPrevious && frozenPredecessor
    ? `草稿引用前集 v${frozenPredecessor.revisionNo}。`
    : previousReady && previous?.script ? `前集已锁定 v${previous.script.revisionNo}`
      : sequel ? "请先锁定有效的前集版本，再保存本集正文或提交定稿。" : "前集尚未锁定，暂不能提交本集定稿。";
  const originalUrl = `/projects/${projectId}/auto?run=${sequel?.original?.runId ?? ""}`;
  return (
    <aside className={`${styles.card} ${styles.rightColumn}`}>
      <div className={styles.cardHeader}>
        <h2>连续性检查</h2>
        <button className={styles.subtle} onClick={onBible}>
          系列圣经
        </button>
      </div>
      <div className={styles.continuity}>
        <section>
          <h3>接上集</h3>
          {episode.episodeNo > 1 ? (
            <>
              <p className={styles.muted}>{previousStatus}</p>
              {displayedHandoff ? <p>{displayedHandoff}</p> : null}
              {sequel && previousText ? (
                <details>
                  <summary>查看前集正文（只读）{differentPrevious && frozenPredecessor ? ` · v${frozenPredecessor.revisionNo}` : ""}</summary>
                  <p className={styles.referenceText}>{previousText}</p>
                </details>
              ) : null}
              {differentPrevious && !frozenPredecessor ? <p className={styles.muted}>暂未读取草稿引用的前集版本。</p> : null}
              {sequel?.original ? (
                <div className={styles.actions}>
                  {sequel.original.research ? <a className={styles.subtle} href={`${originalUrl}#auto-research-title`}>原作研究</a> : null}
                  {sequel.original.topic ? <a className={styles.subtle} href={`${originalUrl}#auto-direction-title`}>原作选题</a> : null}
                  {sequel.original.story ? <a className={styles.subtle} href={`${originalUrl}#auto-bible-title`}>原作设定</a> : null}
                  {sequel.originalRunId ? <a className={styles.subtle} href={`${originalUrl}#auto-episodes-title`}>去原任务写入前集剧本</a> : null}
                  {previous?.script && !previousReady ? <a className={styles.subtle} href={shortSequelWorkbenchUrl(projectId, sequel.previousEpisodeNo)}>打开前集审稿</a> : null}
                </div>
              ) : null}
              <label className={styles.field}>
                <span className="sr-only">本集接住上集的动作或信息</span>
                <textarea
                  value={script.previousHandoff}
                  readOnly={locked || (!!sequel && !!displayedHandoff)}
                  onChange={(event) => onChange({ previousHandoff: event.target.value })}
                  placeholder="接住上集哪个动作或信息…"
                />
              </label>
              <button
                className={styles.subtle}
                disabled={!previousReady || !previous?.script || locked || (!!sequelSource && !!sequel && !matchesSequelPrevious(sequelSource, sequel))}
                onClick={() =>
                  onChange({
                    previousRevisionId: previous!.script!.id,
                    previousHandoff: displayedHandoff ?? script.previousHandoff,
                  })
                }
              >
                {confirmed ? "✓ 已核对前集版本" : "我已核对前集版本"}
              </button>
            </>
          ) : (
            <p>第一集从开场建立人物和目标。</p>
          )}
        </section>
        {(
          [
            ["openingHook", "开场 3 秒"],
            ["change", "本集改变"],
            ["endingHandoff", "集尾交接"],
            ["characterKnowledge", "角色掌握的信息"],
            ["unresolvedThreads", "未回收悬念"],
          ] as const
        ).map(([key, title]) => (
          <section key={key}>
            <h3>{title}</h3>
            <label>
              <span className="sr-only">{title}</span>
              <textarea
                aria-label={title}
                  readOnly={locked}
                value={script[key]}
                onChange={(event) => onChange({ [key]: event.target.value })}
              />
            </label>
          </section>
        ))}
        <section>
          <h3>制作状态</h3>
          <p>
            {approved(episode.script)
              ? `${revisionLabel(episode.script)}，改动需另存新稿。`
              : "本集待定稿"}
          </p>
        </section>
      </div>
    </aside>
  );
}
