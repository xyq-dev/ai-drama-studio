"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  VIMAX_CANDIDATE_CREATE_SCHEMA, VIMAX_CANDIDATE_PLACE_SHOTS_SCHEMA, VIMAX_CANDIDATE_SAVE_SCENE_SCHEMA,
  type VimaxCandidateBlocker, type VimaxCandidatePage, type VimaxCandidateTargets, type VimaxCandidateView,
  type VimaxPlatformPreviewRequest, type VimaxPlatformPreviewResponse,
} from "@ai-drama/contracts";
import { VimaxCandidateClient, VimaxCandidateError } from "../lib/vimax-candidate-client";
import { clearVimaxCandidatePending, readVimaxCandidatePending, writeVimaxCandidatePending, type VimaxCandidatePending } from "../lib/vimax-candidate-pending";
import { vimaxPreviewSourceMatches } from "../lib/vimax-preview-client";
import { VimaxStoryboardReview } from "./vimax-storyboard-review";
import styles from "./vimax-candidate-panel.module.css";

const defaultClient = new VimaxCandidateClient();
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const errorText = (error: unknown) => error instanceof VimaxCandidateError ? error.message : "尚未确认操作结果，请保留原请求并稍后确认。";
const REASONS: Record<VimaxCandidateBlocker, string> = {
  source_changed: "剧本或角色来源已变化，需要根据新来源准备候选。",
  source_unavailable: "当前来源不可用或未批准，候选历史仍可查看。",
  target_changed: "目标场景已被修改，不能把旧方案覆盖到新版本。",
  target_has_shots: "目标场景已有镜头，请保留现有人工内容。",
  awaiting_scene_save: "请先保存场景草稿。",
  awaiting_scene_approval: "请在现有场景页审核并批准本候选创建的精确版本。",
  active_breakdown: "本集整集拆解正在进行，请等任务结束后重新读取。",
  stale_propagation_pending: "来源变更正在处理，请稍后重新读取。",
  already_saved: "镜头草稿已写入，可在现有镜头页继续编辑和审核。",
};
const DEFINITE_REFUSALS = new Set([
  "VIMAX_CANDIDATE_SOURCE_CHANGED", "VIMAX_CANDIDATE_TARGET_CHANGED", "VIMAX_CANDIDATE_HAS_SHOTS",
  "VIMAX_CANDIDATE_REVIEW_REQUIRED", "VIMAX_CANDIDATE_ACTIVE_BREAKDOWN", "VIMAX_CANDIDATE_CANDIDATE_BLOCKED",
  "VIMAX_CANDIDATE_BLOCKED", "VIMAX_CANDIDATE_ALREADY_SAVED", "REVISION_CONFLICT", "SOURCE_STALE",
]);

export interface VimaxCandidatePanelProps {
  projectId: string;
  episodeId: string;
  scriptReady: boolean;
  refreshEpoch?: number;
  preview?: { request: VimaxPlatformPreviewRequest; response: VimaxPlatformPreviewResponse } | null;
  client?: Pick<VimaxCandidateClient, "targets" | "list" | "get" | "create" | "saveScene" | "placeShots">;
  onOpenScene?: (sceneId: string) => void;
  onChanged?: () => void | Promise<void>;
}

export function VimaxCandidatePanel(props: VimaxCandidatePanelProps) {
  return <CandidateSession key={`${props.projectId}:${props.episodeId}`} {...props} />;
}

function CandidateSession(props: VimaxCandidatePanelProps) {
  const client = props.client ?? defaultClient;
  const epoch = props.refreshEpoch ?? 0;
  const context = useRef({ epoch, scriptReady: props.scriptReady, generation: 0 });
  if (context.current.epoch !== epoch || context.current.scriptReady !== props.scriptReady) {
    context.current = { epoch, scriptReady: props.scriptReady, generation: context.current.generation + 1 };
  }
  const generation = context.current.generation;
  const [opened, setOpened] = useState(false);
  const openedRef = useRef(false);
  const visibleVersion = useRef(0);
  const mounted = useRef(true);
  const readSequence = useRef(0);
  const writeSequence = useRef(0);
  const readAbort = useRef<AbortController | null>(null);
  const writeAbort = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const [readBusy, setReadBusy] = useState(false);
  const [writeBusy, setWriteBusy] = useState(false);
  const [page, setPage] = useState<{ value: VimaxCandidatePage; generation: number } | null>(null);
  const [targets, setTargets] = useState<{ value: VimaxCandidateTargets; generation: number; previewIdentity: string } | null>(null);
  const [selected, setSelected] = useState<{ value: VimaxCandidateView; generation: number } | null>(null);
  const selectedId = useRef<string | null>(null);
  const [targetId, setTargetId] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState<VimaxCandidatePending | null>(null);
  const pendingRef = useRef<VimaxCandidatePending | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refusedKey, setRefusedKey] = useState<string | null>(null);
  const preview = props.preview?.response.report.status === "ready_for_review" ? props.preview : null;
  const previewRef = useRef(preview);
  previewRef.current = preview;
  const previewIdentity = preview ? JSON.stringify(preview.request) : "";
  const previewIdentityRef = useRef(previewIdentity);
  previewIdentityRef.current = previewIdentity;

  const rememberPending = useCallback((value: VimaxCandidatePending | null) => {
    pendingRef.current = value;
    setPending(value);
  }, []);
  const readPending = useCallback(() => {
    try {
      rememberPending(readVimaxCandidatePending(props.projectId, props.episodeId));
      setStorageError(null);
    } catch {
      setStorageError("无法读取本标签页的原请求记录。请保留当前标签页，修复后重新读取；新的保存已暂停。");
    }
  }, [props.projectId, props.episodeId, rememberPending]);

  useEffect(() => {
    mounted.current = true;
    readPending();
    return () => {
      mounted.current = false; readSequence.current += 1; visibleVersion.current += 1;
      readAbort.current?.abort(); writeAbort.current?.abort();
    };
  }, [readPending]);
  useEffect(() => {
    readSequence.current += 1; readAbort.current?.abort(); setReadBusy(false); setConfirmed(false);
  }, [epoch, props.scriptReady]);
  useEffect(() => { setTargetId(""); setConfirmed(false); }, [previewIdentity]);

  const reload = useCallback(async (append = false, chooseId?: string) => {
    if (!openedRef.current) return;
    const sequence = ++readSequence.current;
    const currentGeneration = context.current.generation;
    const currentVisible = visibleVersion.current;
    const snapshot = previewRef.current;
    const identity = previewIdentityRef.current;
    const wanted = chooseId ?? selectedId.current;
    const cursor = append ? page?.value.nextCursor : null;
    if (append && !cursor) return;
    readAbort.current?.abort();
    const controller = new AbortController(); readAbort.current = controller;
    setReadBusy(true); setError(null); setConfirmed(false);
    setSelected((previous) => previous ? { ...previous, generation: -1 } : null);
    setTargets((previous) => previous ? { ...previous, generation: -1 } : null);
    const applies = () => mounted.current && openedRef.current && sequence === readSequence.current
      && currentGeneration === context.current.generation && currentVisible === visibleVersion.current && !controller.signal.aborted;
    try {
      const result = await client.list(props.projectId, props.episodeId, { limit: 10, ...(cursor ? { cursor } : {}) }, controller.signal);
      if (!applies()) return;
      setPage((previous) => ({ generation: currentGeneration, value: { ...result,
        items: append && previous?.generation === currentGeneration
          ? [...previous.value.items, ...result.items.filter((item) => !previous.value.items.some((old) => old.candidateId === item.candidateId))]
          : result.items,
      } }));
      const match = result.items.find((item) => item.candidateId === wanted) ?? (!wanted ? result.items[0] : undefined);
      if (match) {
        selectedId.current = match.candidateId; setSelected({ value: match, generation: currentGeneration });
      } else if (wanted) {
        const value = await client.get(props.projectId, props.episodeId, wanted, controller.signal);
        if (!applies()) return;
        selectedId.current = value.candidateId; setSelected({ value, generation: currentGeneration });
      } else if (!append) {
        selectedId.current = null; setSelected(null);
      }
      if (snapshot && context.current.scriptReady && identity === previewIdentityRef.current) {
        const value = await client.targets(props.projectId, props.episodeId, controller.signal);
        if (!applies() || identity !== previewIdentityRef.current) return;
        setTargets({ value, generation: currentGeneration, previewIdentity: identity });
      }
    } catch (caught) {
      if (applies()) setError(errorText(caught));
    } finally {
      if (mounted.current && sequence === readSequence.current) setReadBusy(false);
    }
  }, [client, page?.value.nextCursor, props.projectId, props.episodeId]);

  const toggle = () => {
    if (!opened) {
      openedRef.current = true; visibleVersion.current += 1; setOpened(true); readPending(); void reload();
    } else {
      openedRef.current = false; visibleVersion.current += 1; readSequence.current += 1;
      readAbort.current?.abort(); setReadBusy(false); setOpened(false); setConfirmed(false);
    }
  };
  const chooseCandidate = async (candidateId: string) => {
    selectedId.current = candidateId;
    setConfirmed(false);
    await reload(false, candidateId);
  };

  const send = async (request: VimaxCandidatePending, retry = false) => {
    if (busyRef.current || storageError) return;
    busyRef.current = true; setWriteBusy(true); setError(null); setNotice(null); setRefusedKey(null);
    const sequence = ++writeSequence.current;
    const currentGeneration = context.current.generation;
    const currentVisible = visibleVersion.current;
    const controller = new AbortController(); writeAbort.current = controller;
    let acknowledged = false;
    const applies = () => mounted.current && openedRef.current && sequence === writeSequence.current
      && currentGeneration === context.current.generation && currentVisible === visibleVersion.current;
    try {
      // Persist before any mutation. On retry this asserts that the exact original body is still retained.
      try { writeVimaxCandidatePending(props.projectId, props.episodeId, request); }
      catch {
        if (mounted.current) {
          setStorageError("无法保留完整原请求，尚未发送。请修复标签页存储后重新读取原请求记录。");
          try { rememberPending(readVimaxCandidatePending(props.projectId, props.episodeId)); } catch { /* Keep the unreadable identity untouched. */ }
        }
        return;
      }
      rememberPending(request);
      let candidateId: string;
      if (request.kind === "create") {
        const result = await client.create(props.projectId, props.episodeId, request.body, request.key, controller.signal);
        candidateId = result.candidate.candidateId;
        if (applies()) setSelected({ value: result.candidate, generation: currentGeneration });
      } else {
        // Reading immutable history is allowed even when current write eligibility is false; never gate a replay on it.
        const expected = retry || selected?.value.candidateId !== request.candidateId
          ? await client.get(props.projectId, props.episodeId, request.candidateId, controller.signal) : selected.value;
        if (request.kind === "save_scene") {
          await client.saveScene(props.projectId, props.episodeId, request.candidateId, request.body, request.key, controller.signal, expected);
        } else {
          await client.placeShots(props.projectId, props.episodeId, request.candidateId, request.body, request.key, controller.signal, expected);
        }
        candidateId = request.candidateId;
      }
      acknowledged = true;
      // A valid late receipt may clear only its own identity, never a newer request or another episode's identity.
      clearVimaxCandidatePending(props.projectId, props.episodeId, request);
      if (!mounted.current) return;
      rememberPending(readVimaxCandidatePending(props.projectId, props.episodeId));
      if (!applies()) { setNotice("原保存请求已确认。请重新读取候选以查看当前状态。"); return; }
      selectedId.current = candidateId;
      setConfirmed(false);
      setNotice(request.kind === "create" ? "候选已保存，可刷新找回。场景和镜头尚未写入。"
        : request.kind === "save_scene" ? "场景草稿已保存。请打开场景页审核并批准这一精确版本。"
          : "镜头草稿已写入，请在现有镜头页继续编辑和审核。");
      if (request.kind !== "create") await props.onChanged?.();
      if (mounted.current && openedRef.current) await reload(false, candidateId);
    } catch (caught) {
      if (mounted.current && sequence === writeSequence.current) {
        if (acknowledged) {
          setNotice("保存回执已确认。页面或本标签页的请求记录尚未更新，请重新读取候选；保留的原请求仍可用于确认。");
          setError("保存已确认，更新页面状态暂时失败。");
        } else {
          setError(errorText(caught));
          if (caught instanceof VimaxCandidateError && DEFINITE_REFUSALS.has(caught.code)) setRefusedKey(request.key);
        }
      }
    } finally {
      if (sequence === writeSequence.current) {
        busyRef.current = false;
        if (mounted.current) setWriteBusy(false);
      }
    }
  };

  const selectedScene = preview?.request.sceneSpans.find((scene) => scene.key === preview.request.selectedSceneKeys[0]);
  const sourceMatches = preview && targets && targets.generation === generation && targets.previewIdentity === previewIdentity
    && vimaxPreviewSourceMatches(targets.value.source, preview.request)
    && same(targets.value.source, preview.response.source);
  const matchingTargets = sourceMatches && selectedScene ? targets!.value.targets.filter((target) => target.eligible
    && target.ordinal === preview!.request.sceneSpans.indexOf(selectedScene) + 1 && target.heading === selectedScene.heading) : [];
  const target = matchingTargets.find((item) => item.sceneId === targetId);
  const selectedFresh = selected !== null && selected.generation === generation;
  const canStart = !writeBusy && !pending && !storageError && !readBusy && props.scriptReady && confirmed;
  const saveCandidate = () => {
    if (!canStart || !preview || !target) return;
    void send({ kind: "create", key: crypto.randomUUID(), body: { schema: VIMAX_CANDIDATE_CREATE_SCHEMA,
      request: preview.request, target: { sceneId: target.sceneId, sceneRevisionId: target.sceneRevisionId, rowVersion: target.rowVersion } } });
  };
  const saveScene = () => {
    if (!canStart || !selectedFresh || !selected.value.eligibility.canSaveScene) return;
    void send({ kind: "save_scene", key: crypto.randomUUID(), candidateId: selected.value.candidateId,
      body: { schema: VIMAX_CANDIDATE_SAVE_SCENE_SCHEMA, expectedVersion: selected.value.rowVersion, confirmedReview: true } });
  };
  const placeShots = () => {
    if (!canStart || !selectedFresh || !selected.value.eligibility.canPlaceShots) return;
    void send({ kind: "place_shots", key: crypto.randomUUID(), candidateId: selected.value.candidateId,
      body: { schema: VIMAX_CANDIDATE_PLACE_SHOTS_SCHEMA, expectedVersion: selected.value.rowVersion, confirmedReview: true } });
  };
  const finishRefusal = () => {
    const value = pendingRef.current;
    if (!value || refusedKey !== value.key || writeBusy) return;
    try {
      clearVimaxCandidatePending(props.projectId, props.episodeId, value);
      rememberPending(readVimaxCandidatePending(props.projectId, props.episodeId));
      setRefusedKey(null); setError(null); setNotice("已结束被拒绝的请求，请重新读取并核对方案。");
      void reload();
    } catch { setStorageError("无法更新原请求记录，请保留当前标签页并重新读取。"); }
  };

  return <section className={styles.panel} aria-label="分镜候选保存与审核">
    <h3 className={styles.heading}><button className={styles.toggle} type="button" aria-expanded={opened} onClick={toggle}>
      <span>保存与审核分镜候选</span><span aria-hidden="true">{opened ? "收起" : "展开"}</span>
    </button></h3>
    {pending && !opened ? <p className={styles.notice}>有一项保存结果待确认，展开后可继续确认原请求。</p> : null}
    {opened ? <div className={styles.body}>
      <p className={styles.muted}>候选可保存并在刷新后找回。保存场景草稿、人工审核、写入镜头草稿是独立步骤；不调用模型。</p>
      <div className={styles.controls}>
        <button className={styles.button} type="button" disabled={readBusy} onClick={() => { readPending(); void reload(); }}>{readBusy ? "正在读取候选…" : "重新读取候选与目标"}</button>
      </div>
      {storageError ? <p className={styles.error} role="alert">{storageError}</p> : null}
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
      {pending ? <div className={styles.notice}>
        <p>上次保存结果尚未确认。新的保存暂时停用，确认时会重放原请求标识和原内容。</p>
        <button className={styles.button} type="button" disabled={writeBusy || storageError !== null} onClick={() => { void send(pending, true); }}>
          {writeBusy ? "正在确认保存…" : "确认上次保存结果"}
        </button>
        {refusedKey === pending.key ? <><p>此请求已明确拒绝，可以结束后重新准备方案。</p>
          <button className={styles.button} type="button" disabled={writeBusy} onClick={finishRefusal}>结束这个已拒绝请求</button></> : null}
      </div> : null}
      {!props.scriptReady ? <p className={styles.notice}>当前剧本尚未批准；已保存候选可查看，新的写入暂不可用。</p> : null}
      <label className={styles.confirm}><input type="checkbox" checked={confirmed} disabled={writeBusy || pending !== null}
        onChange={(event) => setConfirmed(event.currentTarget.checked)} />我已人工核对原文、角色、对白与目标场景</label>
      {preview ? <div className={styles.card}>
        <h4>保存当前预览候选</h4>
        <p className={styles.muted}>仅选择与原文场次、标题一致且没有活动镜头的已有场景。这里只保存候选，不创建场景或镜头。</p>
        {targets && !sourceMatches ? <p className={styles.notice}>预览与当前来源不一致，请重新核验原方案；不会自动更换它的来源。</p> : null}
        <label className={styles.label}>目标场景<select value={targetId} onChange={(event) => { setTargetId(event.currentTarget.value); setConfirmed(false); }}>
          <option value="">请选择匹配的空场景</option>
          {matchingTargets.map((item) => <option key={item.sceneId} value={item.sceneId}>第 {item.ordinal} 场 · {item.heading}</option>)}
        </select></label>
        {targets && sourceMatches && matchingTargets.length === 0 ? <p className={styles.notice}>没有可用的匹配空场景。请先在场景列表建立或核对场次、标题，再重新读取。</p> : null}
        <button className={`${styles.button} ${styles.primary}`} type="button" disabled={!canStart || !target} onClick={saveCandidate}>保存候选</button>
      </div> : <p className={styles.muted}>先在上方完成当前方案的只读校验，即可选择目标场景保存新候选。已有候选无需重新导入。</p>}
      <div className={styles.list} aria-label="已保存候选列表">
        <h4>已保存候选</h4>
        {page && page.value.items.length === 0 ? <p>这一集还没有已保存候选。</p> : null}
        {page?.value.items.map((item) => <button className={`${styles.button} ${selectedId.current === item.candidateId ? styles.selected : ""}`} type="button"
          key={item.candidateId} disabled={writeBusy} onClick={() => { void chooseCandidate(item.candidateId); }}>
          第 {item.frozen.target.ordinal} 场 · {item.frozen.target.heading} · {stateText(item.state)}
        </button>)}
        {page?.value.nextCursor ? <button className={styles.button} type="button" disabled={readBusy} onClick={() => { void reload(true); }}>加载更多候选</button> : null}
      </div>
      {selected ? <article className={styles.card} aria-label="当前候选">
        <h4>当前候选：第 {selected.value.frozen.target.ordinal} 场 · {stateText(selected.value.state)}</h4>
        <p className={styles.muted}>源剧本第 {selected.value.frozen.source.scriptRevisionNo} 版 · 候选版本 {selected.value.rowVersion}</p>
        {!selectedFresh ? <p className={styles.notice}>以下是此前读取的候选，请重新读取后再进行新的写入。</p> : null}
        {selected.value.eligibility.reasons.length > 0 ? <ul className={styles.reasons}>{selected.value.eligibility.reasons.map((reason) => <li key={reason}>{REASONS[reason]}</li>)}</ul> : null}
        <div className={styles.controls}>
          {selected.value.state === "stored" ? <button className={`${styles.button} ${styles.primary}`} type="button"
            disabled={!canStart || !selectedFresh || !selected.value.eligibility.canSaveScene} onClick={saveScene}>保存场景草稿</button> : null}
          {selected.value.sceneReceipt && props.onOpenScene ? <button className={styles.button} type="button" disabled={writeBusy}
            onClick={() => props.onOpenScene?.(selected.value.frozen.target.sceneId)}>打开场景审核</button> : null}
          {selected.value.state === "scene_saved" ? <button className={`${styles.button} ${styles.primary}`} type="button"
            disabled={!canStart || !selectedFresh || !selected.value.eligibility.canPlaceShots} onClick={placeShots}>写入镜头草稿</button> : null}
        </div>
        <details className={styles.details}><summary>查看已保存的原文与分镜</summary>
          <VimaxStoryboardReview report={selected.value.frozen.evaluation} source={selected.value.frozen.source}
            stale={!selectedFresh || selected.value.eligibility.reasons.some((reason) => ["source_changed", "source_unavailable", "target_changed"].includes(reason))}
            note="候选已保存；场景和镜头的审核状态以上方当前信息为准。" />
        </details>
      </article> : null}
    </div> : null}
  </section>;
}

function stateText(state: VimaxCandidateView["state"]): string {
  return state === "stored" ? "候选已保存" : state === "scene_saved" ? "场景草稿已保存" : "镜头草稿已写入";
}
