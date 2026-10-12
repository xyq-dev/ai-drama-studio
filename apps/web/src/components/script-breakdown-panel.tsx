"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { currentUncertainCallIds, type ScriptBreakdownOutput } from "@ai-drama/contracts";
import {
  ScriptBreakdownClient,
  type ScriptBreakdownOptionsView,
  type ScriptBreakdownPlacementOutcome,
  type ScriptBreakdownRunView,
} from "../lib/script-breakdown-client";
import { TitleWritingError } from "../lib/title-writing-client";

import { clearBreakdownPending, readBreakdownPending, writeBreakdownPending, type BreakdownPendingStart, type BreakdownPendingResume } from "../lib/script-breakdown-pending";

interface Reads { inFlight: boolean; again: boolean }
interface Operation { runId: string | null; snapshot: number; scope: Reads }
const refused = (caught: unknown): caught is TitleWritingError => caught instanceof TitleWritingError && caught.status >= 400 && caught.status < 500;

const defaultClient = new ScriptBreakdownClient();
/** Resume refusals that come after the server found no receipt for the key and that the same request can never pass. */
const RESUME_RELEASED_BY = new Set(["TITLE_WRITING_CONFIRMATION_STALE", "TITLE_WRITING_NEEDS_CONFIRMATION", "SCRIPT_BREAKDOWN_SOURCE_CHANGED",
  "TITLE_WRITING_NOT_RESUMABLE"]);
const POLL_MS = 2_000;

const STATE_TEXT: Record<string, string> = {
  running: "进行中",
  completed: "已完成",
  partial: "部分完成",
  needs_attention: "需要处理",
  canceled: "已取消",
  failed: "失败",
};

/** Why a step or a run stopped, in the words shown to the person. */
export const BREAKDOWN_ERROR_TEXT: Record<string, string> = {
  invalid_json: "模型返回的不是有效 JSON，结果没有使用。",
  invalid_output: "模型返回的结构不符合要求或超出范围，结果没有使用。",
  episode_mismatch: "模型返回的集号与所选集不一致，结果没有使用。",
  duplicate_key: "模型返回的场景或镜头标识重复，结果没有使用。",
  missing_reference: "模型引用了不存在的场景或角色，或有场景没有镜头，结果没有使用。",
  dialogue_not_in_script: "模型给出的对白或说话人在剧本里找不到，结果没有使用。",
  unsafe_content: "模型返回了不允许的内容（网址、HTML 等），结果没有使用。",
  duration_out_of_range: "各镜预计时长的合计超出范围，结果没有使用。",
  truncated: "模型输出被截断。没有自动续写，也没有改用模板。",
  breakdown_source_changed: "生成期间来源剧本或引用的角色已改变：结果保留在这里，没有写入场景，也没有被标为当前可用。",
  breakdown_conflict: "生成期间这一集的场景或镜头被修改：结果保留在这里，没有覆盖任何新版本。",
  executor_lost: "服务中断时调用已发出，结果未知，可能已经计费。确认后才会重新发送。",
  executor_lost_before_send: "服务中断时调用还没有发出。",
  canceled_before_send: "在发送前取消，没有发出调用。",
  TITLE_WRITING_DAILY_CAP: "最近 24 小时的调用次数已用完。",
  TITLE_WRITING_RUN_CAP: "这次拆解的调用次数已用完。",
  provider_unconfigured: "所选模型服务没有配置完整。",
};

export function breakdownErrorText(code: string | null): string | null {
  if (!code) return null;
  return BREAKDOWN_ERROR_TEXT[code] ?? `未完成（${code}）`;
}

const REVIEW_TEXT: Record<string, string> = { DRAFT: "待审核", IN_REVIEW: "审核中", APPROVED: "已通过", REJECTED: "已退回" };

function sceneStatus(scene: ScriptBreakdownRunView["scenes"][number]): string {
  if (scene.current.archived) return "已被取代（历史版本保留）";
  const review = scene.current.reviewStatus ? REVIEW_TEXT[scene.current.reviewStatus] ?? scene.current.reviewStatus : "无当前版本";
  const fresh = scene.current.freshnessStatus === "STALE" ? " · 已过期，需要重新生成" : "";
  const edited = scene.current.currentRevisionId !== scene.sceneRevisionId ? " · 已被人工修改" : "";
  return `${review}${edited}${fresh}`;
}

export interface ScriptBreakdownPanelProps {
  projectId: string;
  episodeId: string;
  episodeNo: number;
  /** The episode's current script is approved and CURRENT (the script gate). */
  scriptReady: boolean;
  /** Scenes this episode has now (from the scene list), so a start can ask before replacing them. */
  sceneCount: number;
  onOpenScene: (sceneId: string) => void;
  /** After a save or shot placement: reload the episode and its scene list. */
  onChanged: () => Promise<void>;
  client?: ScriptBreakdownClient;
  /** Parent saved/reviewed text; read the current source even after a task is terminal. */
  refreshEpoch?: number;
}

/**
 * "AI 拆解场景与分镜" for one episode. It starts, shows, stops or resumes one breakdown and writes the proposed shots of
 * approved scenes. It never reviews anything and never retries a paid call by itself.
 */
export function ScriptBreakdownPanel(props: ScriptBreakdownPanelProps) {
  const client = props.client ?? defaultClient;
  const [options, setOptions] = useState<ScriptBreakdownOptionsView | null>(null);
  const [run, setRun] = useState<ScriptBreakdownRunView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [token, setToken] = useState("");
  const [replaceExisting, setReplaceExisting] = useState(false);
  const [confirmedFor, setConfirmedFor] = useState<string | null>(null);
  const [acceptSceneChanged, setAcceptSceneChanged] = useState(false);
  const [placement, setPlacement] = useState<ScriptBreakdownPlacementOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [cancelFailed, setCancelFailed] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [identityError, setIdentityError] = useState(false);
  const [pendingStart, setPendingStart] = useState<BreakdownPendingStart | null>(null);
  const [pendingResume, setPendingResume] = useState<BreakdownPendingResume | null>(null);
  const [optionsError, setOptionsError] = useState(false);
  const [optionsLoading, setOptionsLoading] = useState(false);
  /** The server refused a start because the episode has scenes, which the parent's count may not show yet. */
  const [scenesExist, setScenesExist] = useState(false);
  const reads = useRef<Reads>({ inFlight: false, again: false });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const shown = useRef<{ runId: string | null; generation: number; state: string | null }>({ runId: null, generation: 0, state: null });
  const operation = useRef<Operation | null>(null);
  const onChanged = useRef(props.onChanged);
  onChanged.current = props.onChanged;

  const show = useCallback((next: ScriptBreakdownRunView | null) => {
    const runId = next?.runId ?? null;
    if (runId !== shown.current.runId) {
      if (operation.current?.runId) { operation.current = null; setBusy(false); }
      setMessage(null);
      setPlacement(null);
      setConfirmedFor(null);
      setAcceptSceneChanged(false);
    }
    shown.current = { runId, generation: shown.current.generation + 1, state: next?.state ?? null };
    setRun(next);
  }, []);

  const schedule = useCallback((next: ScriptBreakdownRunView | null, poll: () => void) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = next?.state === "running" ? setTimeout(poll, POLL_MS) : undefined;
  }, []);

  // One GET per mounted project/episode. Follow-up reads coalesce and discard the superseded answer.
  const refresh = useCallback(() => {
    const scope = reads.current;
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
    if (scope.inFlight) { scope.again = true; return; }
    scope.inFlight = true;
    void (async () => {
      try {
        for (;;) {
          scope.again = false;
          let next: ScriptBreakdownRunView | null = null;
          let failure: unknown = null;
          try { next = await client.latest(props.projectId, props.episodeId); }
          catch (caught) { failure = caught ?? new Error("Read failed"); }
          if (reads.current !== scope) return;
          if (scope.again) continue;
          setLoaded(true);
          if (failure) { setReadError("拆解状态暂时无法读取，稍后刷新再试。已显示的内容可能不是最新状态。"); return; }
          const finished = shown.current.runId === next?.runId && shown.current.state === "running" && next?.state !== "running";
          show(next);
          setReadError(null);
          if (finished) void onChanged.current().catch(() => undefined);
          schedule(next, refresh);
          return;
        }
      } finally { scope.inFlight = false; }
    })();
  }, [client, props.projectId, props.episodeId, show, schedule]);

  // Reads only the feature settings: never a task or a model call. One read at a time per mounted project/episode; an
  // answer for a scope that was left (another episode, unmount) is dropped.
  const optionsRead = useRef<Reads | null>(null);
  const loadOptions = useCallback(() => {
    const scope = reads.current;
    if (optionsRead.current === scope) return;
    optionsRead.current = scope;
    setOptionsLoading(true);
    void client.options().then((view) => {
      if (reads.current === scope) { setOptions(view); setOptionsError(false); }
    }).catch(() => {
      if (reads.current === scope) setOptionsError(true);
    }).finally(() => {
      if (optionsRead.current !== scope) return;
      optionsRead.current = null;
      if (reads.current === scope) setOptionsLoading(false);
    });
  }, [client]);

  useEffect(() => {
    const scope: Reads = { inFlight: false, again: false };
    reads.current = scope;
    operation.current = null;
    shown.current = { runId: null, generation: shown.current.generation + 1, state: null };
    setRun(null); setOptions(null); setLoaded(false); setBusy(false); setToken("");
    setMessage(null); setCancelFailed(false); setReadError(null); setPlacement(null); setConfirmedFor(null); setAcceptSceneChanged(false);
    setPendingStart(null); setPendingResume(null); setReplaceExisting(false); setIdentityError(false);
    setOptionsError(false); setOptionsLoading(false); setScenesExist(false);
    try {
      const pending = readBreakdownPending(props.projectId, props.episodeId, "start");
      setPendingStart(pending); setReplaceExisting(pending?.body.replaceExisting ?? false);
      setPendingResume(readBreakdownPending(props.projectId, props.episodeId, "resume"));
    } catch { setIdentityError(true); setMessage("无法读取上次请求身份，为避免重复调用，不能开始新请求。"); }
    refresh();
    loadOptions();
    return () => {
      operation.current = null;
      reads.current = { inFlight: false, again: false };
      if (timer.current) clearTimeout(timer.current);
      timer.current = undefined;
    };
  }, [client, props.projectId, props.episodeId, refresh, loadOptions]);

  const parentEpoch = useRef(props.refreshEpoch);
  useEffect(() => {
    if (parentEpoch.current === props.refreshEpoch) return;
    parentEpoch.current = props.refreshEpoch;
    refresh();
  }, [props.refreshEpoch, refresh]);

  const running = run?.state === "running";
  const limits = options?.limits;
  const ready = options?.code === "SCRIPT_BREAKDOWN_READY";
  const needsReplace = props.sceneCount > 0 || scenesExist;
  // Confirming a start already sent replays its stored key and body: the current settings, defaults or a failed settings
  // read cannot block it (the server answers it from the run that key created). Only a new start must pass every gate.
  const startBlocked = identityError ? "无法恢复请求身份，请先解决浏览器会话存储问题。"
    : pendingStart ? (token.trim().length === 0 ? "请填写操作者令牌。" : null)
    : readError ? "请先重新读取本集任务状态。"
    : !props.scriptReady ? "剧本批准后才能拆解（剧本门槛不变）。"
    : !options ? optionsError ? "功能配置读取失败，请先“重新读取功能配置”。" : "正在读取拆解设置。"
      : !ready ? options.code === "TITLE_WRITING_DISABLED" ? "AI 写作没有开启。"
        : options.code === "SCRIPT_BREAKDOWN_STORAGE_UNAVAILABLE" ? "剧本拆解的数据库迁移还没有执行。"
          : options.code === "TITLE_WRITING_PROVIDER_UNCONFIGURED" ? "模型服务还没有配置完整。" : "服务端还不能开始拆解。"
        : running ? "这一集的拆解正在进行。"
          : needsReplace && !replaceExisting ? "这一集已有场景，勾选“用新结果取代”后才能开始。"
            : token.trim().length === 0 ? "请填写操作者令牌。" : null;

  async function act(runId: string | null, work: () => Promise<ScriptBreakdownRunView>, fallback: string,
    hooks: { accepted?: () => void; failed?: (caught: unknown) => void; changed?: boolean; cancel?: boolean } = {}) {
    if (operation.current || (runId && shown.current.runId !== runId)) return;
    const mine: Operation = { runId, snapshot: shown.current.generation, scope: reads.current };
    operation.current = mine;
    const current = () => operation.current === mine && reads.current === mine.scope;
    setBusy(true); setMessage(null); setCancelFailed(false);
    try {
      const next = await work();
      if (!current()) return;
      hooks.accepted?.();
      if (shown.current.generation !== mine.snapshot) refresh();
      else { show(next); if (reads.current.inFlight) refresh(); else schedule(next, refresh); }
      // The action was accepted and shown. A failing follow-up refresh of the page is reported as such, never as a failed
      // action (which would invite a second attempt).
      if (hooks.changed || next.save === "saved") {
        try { await onChanged.current(); }
        catch { if (current()) setMessage("操作已完成，但页面其他部分没有刷新成功。请稍后刷新查看最新的场景和镜头。"); }
      }
    } catch (caught) {
      if (!current()) return;
      hooks.failed?.(caught);
      setCancelFailed(hooks.cancel === true);
      setMessage(refused(caught) ? caught.detail : fallback);
    } finally {
      if (current()) { operation.current = null; setBusy(false); }
    }
  }

  function clearPending(pending: BreakdownPendingStart | BreakdownPendingResume) {
    try {
      clearBreakdownPending(props.projectId, props.episodeId, pending);
      if (pending.kind === "start") setPendingStart((current) => current?.key === pending.key ? null : current);
      else setPendingResume((current) => current?.key === pending.key ? null : current);
    } catch { setIdentityError(true); setMessage("请求已确认，但浏览器未能更新请求身份。请先解决会话存储问题。"); }
  }

  function start() {
    if (startBlocked || operation.current) return;
    const provider = options?.providers.find((item) => item.providerKey === options.defaultProvider && item.ready)
      ?? options?.providers.find((item) => item.ready);
    if (!pendingStart && !provider?.defaultModel) return;
    const pending: BreakdownPendingStart = pendingStart ?? { kind: "start", key: crypto.randomUUID(),
      body: { replaceExisting, providerKey: provider!.providerKey, model: provider!.defaultModel! } };
    try { writeBreakdownPending(props.projectId, props.episodeId, pending); }
    catch { setIdentityError(true); setMessage("无法保存请求身份，未发送请求。请先解决浏览器会话存储问题。"); return; }
    setPendingStart(pending); setPlacement(null);
    void act(null, () => client.start(props.projectId, props.episodeId, pending.body, { token: token.trim(), idempotencyKey: pending.key }),
      "服务端回应无法确认是否已开始。再次点击只会重放同一个请求，不会新建任务。", {
        accepted: () => clearPending(pending),
        failed: (caught) => {
          // EXISTING_SCENES comes after the server's key lookup: it proves no task exists for this key, and this body
          // (without consent) can never succeed. Release the identity, sent now or restored, and ask for consent; a new
          // start then takes a new key and a newly frozen body. Lost answers, 5xx and other refusals of a restored start
          // keep the identity for a replay.
          if (refused(caught) && caught.code === "SCRIPT_BREAKDOWN_EXISTING_SCENES") {
            clearPending(pending);
            setScenesExist(true);
            setReplaceExisting(false);
          } else if (refused(caught) && !pendingStart) clearPending(pending);
        },
      });
  }

  const uncertain = run ? currentUncertainCallIds([{ stepKey: "breakdown", state: run.step.state, attemptNo: run.step.attemptNo }],
    run.calls.map((call) => ({ callId: call.callId, stepKey: call.stepKey, attemptNo: call.attemptNo, state: call.state }))) : [];
  const uncertainKey = `${run?.runId ?? ""}:${uncertain.join(",")}`;
  const confirmUncertain = confirmedFor === uncertainKey;
  // The source is valid only while the frozen revision is still the episode's current one AND approved and fresh: the
  // same revision can go STALE (an upstream story change) or stop being the approved one without its id changing.
  const sourceReplaced = run !== null && run.episodeScript.currentRevisionId !== run.scriptRevisionId;
  const sourceInvalid = run !== null && !sourceReplaced && !run.episodeScript.approved;
  const sourceOutdated = sourceReplaced || sourceInvalid;
  const replayResume = pendingResume?.runId === run?.runId ? pendingResume : null;
  // Confirming an already sent resume is always possible (it only reads its receipt). A new resume is offered only where
  // the server accepts one, a stopped run with its result unsaved and a valid source, in the mode its step implies (the
  // server decides the same from the persisted steps): "save" when the answer was stored before the run stopped (no call,
  // no billing question); "resend" when the step was refused, unknown (confirmation needed), canceled or never reserved.
  const resumeMode = resumeModeOf(run, sourceOutdated);
  const resumable = run !== null && (replayResume !== null || resumeMode !== null);

  function resume() {
    if (!run || !resumable || identityError || operation.current || token.trim().length === 0 || (!replayResume && uncertain.length > 0 && !confirmUncertain)) return;
    const pending: BreakdownPendingResume = replayResume ?? { kind: "resume", runId: run.runId, confirmed: uncertain, key: crypto.randomUUID() };
    try { writeBreakdownPending(props.projectId, props.episodeId, pending); }
    catch { setIdentityError(true); setMessage("无法保存续跑身份，未发送请求。请先解决浏览器会话存储问题。"); return; }
    setPendingResume(pending);
    void act(run.runId, () => client.resume(props.projectId, props.episodeId, pending.runId,
      { confirmUncertainCallIds: pending.confirmed, token: token.trim(), idempotencyKey: pending.key }),
      "请求没有得到回应。再次点击只会重放同一个续跑请求。", {
        accepted: () => { clearPending(pending); setConfirmedFor(null); },
        failed: (caught) => {
          // A new resume refused is settled. A restored one is released only by refusals the server gives after finding no
          // receipt for its key that this body can never pass (its confirmation is stale or missing, the source changed,
          // nothing is left to resume); lost answers, 5xx, a busy run or a refused token keep it for a replay.
          if (refused(caught) && (!replayResume || RESUME_RELEASED_BY.has(caught.code))) { clearPending(pending); setConfirmedFor(null); refresh(); }
        },
      });
  }

  function cancel() {
    if (run) void act(run.runId, () => client.cancel(props.projectId, props.episodeId, run.runId), "取消请求失败，请读取最新状态后再试。", { cancel: true });
  }

  function placeShots() {
    if (!run) return;
    let result: ScriptBreakdownPlacementOutcome | null = null;
    void act(run.runId, async () => {
      const placed = await client.placeShots(props.projectId, props.episodeId, run.runId, acceptSceneChanged);
      result = placed.placement;
      return placed.run;
    }, "写入镜头失败，请稍后重试", { accepted: () => setPlacement(result), changed: true });
  }

  // Only a confirmed stop/terminal snapshot makes a cancel failure irrelevant; an ordinary poll does not.
  const visibleMessage = cancelFailed && run && (run.cancelRequested || run.state !== "running") ? null : message;
  const pendingShots = run?.save === "saved" && run.scenes.some((scene) => scene.shotSave === "pending");

  return (
    <section className="creator-section rounded-lg bg-white p-4" aria-labelledby={`breakdown-${props.episodeId}`}>
      <h2 id={`breakdown-${props.episodeId}`} className="font-medium">AI 拆解场景与分镜</h2>
      <p className="mt-1 text-sm text-neutral-600 [overflow-wrap:anywhere]">
        根据第 {props.episodeNo} 集当前已批准的剧本版本，由 AI 拆出场景和镜头文字稿（景别、镜头描述、动作、对白、预计时长）。
        只生成文字，不生成图片、视频或配音。预计时长是写作计划，不是成片时长。
      </p>
      {limits ? (
        <p className="mt-1 text-sm text-neutral-600 [overflow-wrap:anywhere]" data-testid="breakdown-limits">
          范围：剧本正文最多 {limits.scriptMaxChars} 字；每集 {limits.minScenes}–{limits.maxScenes} 场、{limits.minShots}–{limits.maxShots} 镜，每场最多 {limits.maxShotsPerScene} 镜；
          单镜预计 {limits.minShotSeconds}–{limits.maxShotSeconds} 秒，合计 {limits.minTotalSeconds}–{limits.maxTotalSeconds} 秒；角色最多 {limits.maxCharacters} 个。
          超出范围、无效 JSON、错误集号、缺引用、重复标识、对白不在剧本中或输出被截断时，结果一律不用，也不会改用固定模板。
        </p>
      ) : null}
      {options ? (
        <p className="mt-1 text-sm text-neutral-600">每次拆解调用上限 {options.callCapPerRun} 次（计入最近 24 小时 {options.maxCallsPerDay} 次的共同额度，不是自动重试次数），费用未知。结果未知的调用不会自动重发。</p>
      ) : null}
      {visibleMessage || readError ? <div className="mt-2 text-sm text-red-700 [overflow-wrap:anywhere]" role="alert">
        <p>{visibleMessage ?? readError}</p>{readError ? <button type="button" onClick={refresh}>重新读取</button> : null}
      </div> : null}
      {optionsError ? <div className="mt-2 text-sm text-red-700 [overflow-wrap:anywhere]" role="status" data-testid="breakdown-options-error">
        <p>功能配置暂时无法读取。已有任务、结果和未确认的请求不受影响；重新读取只读取配置，不会创建任务或调用模型。</p>
        <button type="button" className="underline disabled:opacity-50" disabled={optionsLoading} onClick={loadOptions}>重新读取功能配置</button>
      </div> : null}

      <div className="mt-3 grid gap-2">
        {needsReplace ? (
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={replaceExisting} disabled={busy || pendingStart !== null} onChange={(event) => setReplaceExisting(event.target.checked)} />
            <span>用新结果取代这一集现有的场景及其镜头（旧版本保留为历史，不删除；依赖它们的图片和视频会标为过期）</span>
          </label>
        ) : null}
        <label className="text-sm" htmlFor={`breakdown-token-${props.episodeId}`}>操作者令牌</label>
        <input id={`breakdown-token-${props.episodeId}`} className="rounded border px-2 py-1" type="password" autoComplete="off" value={token}
          disabled={busy} onChange={(event) => setToken(event.target.value)} />
        <div className="flex flex-wrap gap-2">
          <button className="rounded bg-neutral-900 px-3 py-2 text-white disabled:opacity-50" type="button" disabled={busy || !loaded || startBlocked !== null}
            onClick={() => void start()}>
            {pendingStart ? "确认上次启动结果" : run && !running ? "重新生成场景与分镜" : "生成场景与分镜"}
          </button>
          {running ? (
            <button className="rounded border px-3 py-2" type="button" disabled={busy || run?.cancelRequested} onClick={() => void cancel()}>
              {run?.cancelRequested ? "已请求取消" : "取消"}
            </button>
          ) : null}
        </div>
        {pendingStart ? (
          <p className="text-sm text-neutral-600 [overflow-wrap:anywhere]" data-testid="breakdown-pending-start">
            上次启动请求的结果还没有确认。确认只会重放上次的同一个请求（原模型、原“取代”选项和原请求标识），不会新建任务；要发起新的生成，请先确认这次结果。
          </p>
        ) : null}
        {startBlocked && loaded ? <p className="text-sm text-neutral-600" data-testid="breakdown-blocked">{startBlocked}</p> : null}
      </div>

      {run ? (
        <div className="mt-4 space-y-3" data-testid="breakdown-run">
          <p className="text-sm [overflow-wrap:anywhere]">
            状态：{STATE_TEXT[run.state] ?? run.state}
            {" · "}来源：第 {run.scriptRevisionNo} 版剧本{sourceReplaced ? `（当前已是第 ${run.episodeScript.currentRevisionNo ?? "?"} 版）` : sourceInvalid ? "（已过期或未批准）" : "（当前版本）"}
            {" · "}模型 {run.model}{" · "}调用 {run.callsUsed}/{run.callCap}
          </p>
          {breakdownErrorText(run.errorCode ?? run.step.errorCode) ? (
            <p className="text-sm text-amber-800 [overflow-wrap:anywhere]" role="status">{breakdownErrorText(run.errorCode ?? run.step.errorCode)}</p>
          ) : null}
          {sourceOutdated ? (
            <p className="rounded bg-amber-50 p-2 text-sm text-amber-900 [overflow-wrap:anywhere]" role="status" data-testid="breakdown-outdated">
              {sourceReplaced
                ? `来源剧本已更新到第 ${run.episodeScript.currentRevisionNo ?? "?"} 版，下面的场景与分镜来自第 ${run.scriptRevisionNo} 版，需要重新生成。`
                : `第 ${run.scriptRevisionNo} 版剧本已过期或不再是已批准版本，下面的场景与分镜不能再写入镜头，需要在有新的已批准剧本后重新生成。`}
              旧结果保留，不会自动重新生成。
            </p>
          ) : null}
          {resumable && !replayResume && resumeMode === "save" ? (
            <div className="grid gap-2 rounded border border-neutral-200 p-2">
              <p className="text-sm [overflow-wrap:anywhere]" data-testid="breakdown-save-only">
                模型答案已经生成并通过校验，但在写入场景前停止了。保存已有结果不会再次调用模型，也不增加调用次数；来源剧本仍须是本集当前已批准的版本。
              </p>
              <button className="rounded border px-3 py-2" type="button" disabled={busy || identityError || token.trim().length === 0} onClick={() => void resume()}>
                保存已有结果（不再调用模型）
              </button>
            </div>
          ) : resumable ? (
            <div className="grid gap-2 rounded border border-neutral-200 p-2">
              {uncertain.length > 0 && !replayResume ? (
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" checked={confirmUncertain} disabled={busy} onChange={(event) => setConfirmedFor(event.target.checked ? uncertainKey : null)} />
                  <span>我知道上一次调用结果未知、可能已经计费，确认重新发送</span>
                </label>
              ) : null}
              <button className="rounded border px-3 py-2" type="button"
                disabled={busy || identityError || token.trim().length === 0 || (!replayResume && uncertain.length > 0 && !confirmUncertain)} onClick={() => void resume()}>
                {replayResume ? "确认上次续跑结果" : "续跑（重新发送一次调用）"}
              </button>
            </div>
          ) : null}
          {run.output ? <BreakdownResult run={run} output={run.output} onOpenScene={props.onOpenScene} /> : null}
          {pendingShots ? (
            <div className="grid gap-2 rounded border border-neutral-200 p-2">
              <p className="text-sm">镜头方案在场景审核通过后才写入为镜头草稿（现有门槛：镜头只能挂在已批准的场景下）。</p>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" checked={acceptSceneChanged} disabled={busy} onChange={(event) => setAcceptSceneChanged(event.target.checked)} />
                <span>场景被人工修改过时，仍按修改后的已批准版本写入这些镜头</span>
              </label>
              <button className="rounded border px-3 py-2" type="button" disabled={busy || sourceOutdated} onClick={() => void placeShots()}>
                写入已批准场景的镜头
              </button>
            </div>
          ) : null}
          {placement ? <PlacementSummary outcome={placement} /> : null}
        </div>
      ) : loaded ? <p className="mt-3 text-sm text-neutral-600">这一集还没有拆解过。</p> : null}
    </section>
  );
}

/** What a new resume of this run would do, or null when none is offered (running, finished, saved or settled, invalid source). */
function resumeModeOf(run: ScriptBreakdownRunView | null, sourceOutdated: boolean): "save" | "resend" | null {
  if (!run || run.state === "running" || run.state === "completed" || run.save !== "pending" || sourceOutdated) return null;
  if (run.step.state === "completed") return "save";
  return run.step.state === "rejected" || run.step.state === "unknown" || run.step.state === "canceled" || run.step.state === "pending" ? "resend" : null;
}

function PlacementSummary({ outcome }: { outcome: ScriptBreakdownPlacementOutcome }) {
  const lines = [
    outcome.placed.length > 0 ? `已写入：${outcome.placed.join("、")}` : null,
    outcome.awaitingApproval.length > 0 ? `等待场景审核：${outcome.awaitingApproval.join("、")}` : null,
    outcome.sceneChanged.length > 0 ? `场景已被人工修改，需确认后写入：${outcome.sceneChanged.join("、")}` : null,
    outcome.charactersChanged.length > 0 ? `引用的角色已更新，没有写入：${outcome.charactersChanged.join("、")}` : null,
    outcome.unavailable.length > 0 ? `场景不可用（已被取代、已过期或已有镜头），没有写入：${outcome.unavailable.join("、")}` : null,
  ].filter((line): line is string => line !== null);
  return <ul className="list-disc pl-5 text-sm" role="status">{lines.map((line) => <li key={line}>{line}</li>)}</ul>;
}

function BreakdownResult(props: { run: ScriptBreakdownRunView; output: ScriptBreakdownOutput; onOpenScene: (sceneId: string) => void }) {
  const names = new Map(props.run.characters.map((item) => [item.key, item.name] as const));
  return (
    <div className="space-y-3">
      <p className="text-sm">
        共 {props.output.scenes.length} 场、{props.output.shots.length} 镜；预计合计 {props.run.plannedTotalSeconds ?? 0} 秒（计划，不是成片时长）
        {props.run.targetEpisodeSeconds !== null ? `；作品目标约 ${props.run.targetEpisodeSeconds} 秒` : ""}。
      </p>
      <ol className="space-y-3">
        {props.output.scenes.map((scene) => {
          const saved = props.run.scenes.find((item) => item.key === scene.key) ?? null;
          const shots = props.output.shots.filter((shot) => shot.sceneKey === scene.key);
          return (
            <li key={scene.key} className="rounded border border-neutral-200 p-3" data-testid={`breakdown-scene-${scene.key}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="font-medium [overflow-wrap:anywhere]">{scene.key} · {scene.heading}{scene.timeOfDay.trim() ? `（${scene.timeOfDay}）` : ""}</h3>
                {saved ? (
                  <button className="text-sm underline" type="button" onClick={() => props.onOpenScene(saved.sceneId)}>打开场景（修改或审核）</button>
                ) : null}
              </div>
              <p className="mt-1 text-sm [overflow-wrap:anywhere]">场景描述：{scene.description}</p>
              <p className="mt-1 text-xs text-neutral-600">
                {saved ? `场景：${sceneStatus(saved)}${saved.shotSave === "saved" ? " · 镜头已写入" : " · 镜头未写入"}` : "未写入场景"}
              </p>
              <ol className="mt-2 space-y-2">
                {shots.map((shot) => (
                  <li key={shot.key} className="rounded bg-neutral-50 p-2 text-sm [overflow-wrap:anywhere]">
                    <p className="font-medium">{shot.key} · {shot.shotType} · 预计 {shot.plannedSeconds} 秒</p>
                    <p>镜头描述：{shot.camera}</p>
                    <p>动作：{shot.action}</p>
                    {shot.dialogue.length > 0 ? (
                      <div>对白：{shot.dialogue.map((line, index) => <p key={`${shot.key}-${String(index)}`} className="pl-3">{line.speaker}：{line.line}</p>)}</div>
                    ) : <p>对白：无</p>}
                    {shot.characterKeys.length > 0 ? <p>角色：{shot.characterKeys.map((key) => names.get(key) ?? key).join("、")}</p> : null}
                  </li>
                ))}
              </ol>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
