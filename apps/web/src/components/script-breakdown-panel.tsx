"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { currentUncertainCallIds, type ScriptBreakdownOutput } from "@ai-drama/contracts";
import {
  ScriptBreakdownClient,
  type ScriptBreakdownOptionsView,
  type ScriptBreakdownPlacementOutcome,
  type ScriptBreakdownRunView,
} from "../lib/script-breakdown-client";
import { TitleWritingError, TitleWritingUnconfirmedError } from "../lib/title-writing-client";

const defaultClient = new ScriptBreakdownClient();
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
  const [confirmUncertain, setConfirmUncertain] = useState(false);
  const [acceptSceneChanged, setAcceptSceneChanged] = useState(false);
  const [placement, setPlacement] = useState<ScriptBreakdownPlacementOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // A start or resume whose answer was not seen keeps its key: pressing again replays the same request, never a new one.
  const startKey = useRef<{ key: string; replaceExisting: boolean } | null>(null);
  const resumeKey = useRef<{ runId: string; confirmed: string; key: string } | null>(null);
  const alive = useRef(true);
  const onChanged = useRef(props.onChanged);
  onChanged.current = props.onChanged;

  const refresh = useCallback(async () => {
    const latest = await client.latest(props.projectId, props.episodeId);
    if (alive.current) setRun(latest);
    return latest;
  }, [client, props.projectId, props.episodeId]);

  useEffect(() => {
    alive.current = true;
    setRun(null);
    setLoaded(false);
    setMessage(null);
    setPlacement(null);
    setReplaceExisting(false);
    startKey.current = null;
    resumeKey.current = null;
    void Promise.all([client.options(), refresh()]).then(([view]) => {
      if (!alive.current) return;
      setOptions(view);
      setLoaded(true);
    }).catch((caught: unknown) => {
      if (!alive.current) return;
      setLoaded(true);
      setMessage(caught instanceof TitleWritingError ? caught.detail : "拆解状态暂时无法读取，稍后刷新再试。");
    });
    return () => { alive.current = false; };
  }, [client, refresh]);

  const running = run?.state === "running";
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => {
      void refresh().then((latest) => {
        if (latest && latest.state !== "running") void onChanged.current();
      }).catch(() => undefined);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [running, refresh]);

  const limits = options?.limits;
  const ready = options?.code === "SCRIPT_BREAKDOWN_READY";
  const needsReplace = props.sceneCount > 0;
  const startBlocked = !props.scriptReady ? "剧本批准后才能拆解（剧本门槛不变）。"
    : !options ? "正在读取拆解设置。"
      : !ready ? options.code === "TITLE_WRITING_DISABLED" ? "AI 写作没有开启。"
        : options.code === "SCRIPT_BREAKDOWN_STORAGE_UNAVAILABLE" ? "剧本拆解的数据库迁移还没有执行。"
          : options.code === "TITLE_WRITING_PROVIDER_UNCONFIGURED" ? "模型服务还没有配置完整。" : "服务端还不能开始拆解。"
        : running ? "这一集的拆解正在进行。"
          : needsReplace && !replaceExisting ? "这一集已有场景，勾选“用新结果取代”后才能开始。"
            : token.trim().length === 0 ? "请填写操作者令牌。" : null;

  async function start() {
    if (startBlocked) return;
    const pending = startKey.current?.replaceExisting === replaceExisting ? startKey.current : { key: crypto.randomUUID(), replaceExisting };
    startKey.current = pending;
    setBusy(true);
    setMessage(null);
    setPlacement(null);
    try {
      const view = await client.start(props.projectId, props.episodeId, { replaceExisting }, { token: token.trim(), idempotencyKey: pending.key });
      startKey.current = null;
      if (alive.current) setRun(view);
    } catch (caught) {
      // A refusal is final for this key; an unanswered request keeps the key so pressing again only replays it.
      if (caught instanceof TitleWritingError) {
        startKey.current = null;
        setMessage(caught.detail);
      } else {
        setMessage(caught instanceof TitleWritingUnconfirmedError
          ? "服务端回应无法确认是否已开始。再次点击只会重放同一个请求，不会新建任务。"
          : "请求没有得到回应。再次点击只会重放同一个请求，不会新建任务。");
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  const uncertain = run ? currentUncertainCallIds([{ stepKey: "breakdown", state: run.step.state, attemptNo: run.step.attemptNo }],
    run.calls.map((call) => ({ callId: call.callId, stepKey: call.stepKey, attemptNo: call.attemptNo, state: call.state }))) : [];
  const resumable = run !== null && run.state !== "running" && run.state !== "completed" && run.save === "pending"
    && (run.step.state === "rejected" || run.step.state === "unknown" || run.step.state === "canceled");

  async function resume() {
    if (!run || !resumable || token.trim().length === 0 || (uncertain.length > 0 && !confirmUncertain)) return;
    const confirmed = uncertain.join(",");
    const previous = resumeKey.current;
    const action = previous && previous.runId === run.runId && previous.confirmed === confirmed ? previous : { runId: run.runId, confirmed, key: crypto.randomUUID() };
    resumeKey.current = action;
    setBusy(true);
    setMessage(null);
    try {
      const view = await client.resume(props.projectId, props.episodeId, run.runId, { confirmUncertainCallIds: uncertain, token: token.trim(), idempotencyKey: action.key });
      resumeKey.current = null;
      setConfirmUncertain(false);
      if (alive.current) setRun(view);
    } catch (caught) {
      if (caught instanceof TitleWritingError) {
        resumeKey.current = null;
        setMessage(caught.detail);
      } else {
        setMessage("请求没有得到回应。再次点击只会重放同一个续跑请求。");
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function cancel() {
    if (!run) return;
    setBusy(true);
    try {
      setRun(await client.cancel(props.projectId, props.episodeId, run.runId));
    } catch (caught) {
      setMessage(caught instanceof TitleWritingError ? caught.detail : "取消请求失败");
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function placeShots() {
    if (!run) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await client.placeShots(props.projectId, props.episodeId, run.runId, acceptSceneChanged);
      if (!alive.current) return;
      setRun(result.run);
      setPlacement(result.placement);
      await onChanged.current();
    } catch (caught) {
      setMessage(caught instanceof TitleWritingError ? caught.detail : "写入镜头失败，请稍后重试");
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  const sourceOutdated = run !== null && run.episodeScript.currentRevisionId !== run.scriptRevisionId;
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
        <p className="mt-1 text-sm text-neutral-600">每次拆解调用上限 {options.callCapPerRun} 次（计入每天 {options.maxCallsPerDay} 次的共同额度），费用未知。结果未知的调用不会自动重发。</p>
      ) : null}
      {message ? <p className="mt-2 text-sm text-red-700 [overflow-wrap:anywhere]" role="alert">{message}</p> : null}

      <div className="mt-3 grid gap-2">
        {needsReplace ? (
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" checked={replaceExisting} disabled={busy} onChange={(event) => setReplaceExisting(event.target.checked)} />
            <span>用新结果取代这一集现有的场景及其镜头（旧版本保留为历史，不删除；依赖它们的图片和视频会标为过期）</span>
          </label>
        ) : null}
        <label className="text-sm" htmlFor={`breakdown-token-${props.episodeId}`}>操作者令牌</label>
        <input id={`breakdown-token-${props.episodeId}`} className="rounded border px-2 py-1" type="password" autoComplete="off" value={token}
          disabled={busy} onChange={(event) => setToken(event.target.value)} />
        <div className="flex flex-wrap gap-2">
          <button className="rounded bg-neutral-900 px-3 py-2 text-white disabled:opacity-50" type="button" disabled={busy || !loaded || startBlocked !== null}
            onClick={() => void start()}>
            {run && !running ? "重新生成场景与分镜" : "生成场景与分镜"}
          </button>
          {running ? (
            <button className="rounded border px-3 py-2" type="button" disabled={busy || run?.cancelRequested} onClick={() => void cancel()}>
              {run?.cancelRequested ? "已请求取消" : "取消"}
            </button>
          ) : null}
        </div>
        {startBlocked && loaded ? <p className="text-sm text-neutral-600" data-testid="breakdown-blocked">{startBlocked}</p> : null}
      </div>

      {run ? (
        <div className="mt-4 space-y-3" data-testid="breakdown-run">
          <p className="text-sm [overflow-wrap:anywhere]">
            状态：{STATE_TEXT[run.state] ?? run.state}
            {" · "}来源：第 {run.scriptRevisionNo} 版剧本{sourceOutdated ? `（当前已是第 ${run.episodeScript.currentRevisionNo ?? "?"} 版）` : "（当前版本）"}
            {" · "}模型 {run.model}{" · "}调用 {run.callsUsed}/{run.callCap}
          </p>
          {breakdownErrorText(run.errorCode ?? run.step.errorCode) ? (
            <p className="text-sm text-amber-800 [overflow-wrap:anywhere]" role="status">{breakdownErrorText(run.errorCode ?? run.step.errorCode)}</p>
          ) : null}
          {sourceOutdated ? (
            <p className="rounded bg-amber-50 p-2 text-sm text-amber-900 [overflow-wrap:anywhere]" role="status" data-testid="breakdown-outdated">
              来源剧本已更新到第 {run.episodeScript.currentRevisionNo ?? "?"} 版，下面的场景与分镜来自第 {run.scriptRevisionNo} 版，需要重新生成。旧结果保留，不会自动重新生成。
            </p>
          ) : null}
          {resumable ? (
            <div className="grid gap-2 rounded border border-neutral-200 p-2">
              {uncertain.length > 0 ? (
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" checked={confirmUncertain} onChange={(event) => setConfirmUncertain(event.target.checked)} />
                  <span>我知道上一次调用结果未知、可能已经计费，确认重新发送</span>
                </label>
              ) : null}
              <button className="rounded border px-3 py-2" type="button"
                disabled={busy || token.trim().length === 0 || (uncertain.length > 0 && !confirmUncertain)} onClick={() => void resume()}>
                续跑（重新发送一次调用）
              </button>
            </div>
          ) : null}
          {run.output ? <BreakdownResult run={run} output={run.output} onOpenScene={props.onOpenScene} /> : null}
          {pendingShots ? (
            <div className="grid gap-2 rounded border border-neutral-200 p-2">
              <p className="text-sm">镜头方案在场景审核通过后才写入为镜头草稿（现有门槛：镜头只能挂在已批准的场景下）。</p>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" checked={acceptSceneChanged} onChange={(event) => setAcceptSceneChanged(event.target.checked)} />
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
