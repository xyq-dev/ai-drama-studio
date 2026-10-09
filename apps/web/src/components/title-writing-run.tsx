"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { EpisodeOutline, TitleConcept } from "@ai-drama/contracts";
import {
  TitleWritingClient,
  TitleWritingError,
  canResume,
  errorText,
  hasUncertain,
  runHeadline,
  scriptsAwaitApproval,
  stepLabel,
  stepStateText,
  uncertainCallIds,
  type TitleWritingRunView,
} from "../lib/title-writing-client";
import { BeginnerShell } from "./beginner-shell";
import styles from "./title-writing.module.css";

export const TITLE_WRITING_POLL_MS = 2_000;
const defaultClient = new TitleWritingClient();

const PROVIDER_LABELS: Record<string, string> = { qwen: "千问", openai: "OpenAI", deepseek: "DeepSeek" };

function actionError(caught: unknown, fallback: string): string {
  if (caught instanceof TitleWritingError) {
    if (caught.code === "TITLE_WRITING_FORBIDDEN") return "操作者令牌不正确，没有发出任何调用。";
    if (caught.code === "TITLE_WRITING_CONFIRMATION_STALE") return "不确定的调用已经变化，之前的确认已作废，没有重新发送。请查看最新状态后重新确认。";
    return caught.detail;
  }
  return fallback;
}

/** A definite refusal: the server answered and applied nothing, so the action's key is not reused. */
function refused(caught: unknown): boolean {
  return caught instanceof TitleWritingError && caught.status >= 400 && caught.status < 500;
}

/**
 * One write action (cancel, resume, place scripts) of one run. It stays current until it settles, or until the work,
 * the shown run or the page changes; only the current action may write its answer, error, busy state or polling.
 * snapshot is the generation of what was on screen when it began: when a newer snapshot has been shown since, its
 * answer is not known to be newer, so the page reads again instead of showing it.
 */
interface Operation {
  runId: string;
  snapshot: number;
}

/**
 * A failed action's message. moot says when a snapshot shown later makes it untrue (a stop that failed to send, next to
 * a run whose stop the server already recorded); only such a snapshot hides it, not any read.
 */
interface ActionMessage {
  text: string;
  moot?: (run: TitleWritingRunView) => boolean;
}

/** A stop has nothing left to do once the server recorded one, or the run is no longer running. */
const stopSettled = (run: TitleWritingRunView) => run.cancelRequested || run.state !== "running";

/**
 * The reads of one page scope (one work while mounted). At most one GET is in flight; a read asked for meanwhile is
 * merged into a single follow-up that starts after it, and the in-flight answer, which may predate what asked, is
 * dropped. A scope replaced by a new work or by unmounting writes nothing and schedules nothing.
 */
interface Reads {
  inFlight: boolean;
  again: boolean;
}

/** One resume action: its key is reused only to retry the same, unanswered request for the same uncertain calls. */
interface ResumeAction {
  runId: string;
  confirmedFor: string;
  key: string;
}

function ConceptView({ concept }: { concept: TitleConcept }) {
  return (
    <dl className={styles.facts}>
      <dt>题材</dt><dd>{concept.genre}</dd>
      <dt>一句话故事</dt><dd>{concept.logline}</dd>
      <dt>故事梗概</dt><dd>{concept.synopsis}</dd>
      <dt>核心冲突</dt><dd>{concept.coreConflict}</dd>
      <dt>人物</dt><dd><ul>{concept.characters.map((item) => <li key={item.name}>{item.name}（{item.role}）：{item.profile}</li>)}</ul></dd>
      <dt>人物关系</dt><dd><ul>{concept.relationships.map((item) => <li key={item.name}>{item.name}：{item.pressure}</li>)}</ul></dd>
      <dt>故事走向</dt><dd>{concept.direction}</dd>
    </dl>
  );
}

function OutlineView({ outline }: { outline: EpisodeOutline }) {
  return (
    <ol className={styles.outline}>
      {outline.episodes.map((episode) => (
        <li key={episode.episodeNo}>
          <p className={styles.outlineTitle}>第 {episode.episodeNo} 集 {episode.title}</p>
          <p>目标：{episode.goal}</p>
          <p>转折：{episode.turn}</p>
          <p>结果：{episode.result}</p>
          <p>交给下一集：{episode.handoff}</p>
        </li>
      ))}
    </ol>
  );
}

/**
 * Progress and results of the latest title-driven run of one work. Everything shown comes from the server: the page
 * polls while the run is running, survives a reload, and never claims a step finished before the server says so.
 */
export function TitleWritingRun({ projectId, client = defaultClient }: { projectId: string; client?: TitleWritingClient }) {
  const [run, setRun] = useState<TitleWritingRunView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<ActionMessage | null>(null);
  const [token, setToken] = useState("");
  // The uncertain calls the person confirmed, as a sorted id list. It only counts while it equals what is shown now.
  const [confirmedFor, setConfirmedFor] = useState<string | null>(null);
  const resumeAction = useRef<ResumeAction | null>(null);
  const [acceptStoryChanged, setAcceptStoryChanged] = useState(false);
  const [storyChanged, setStoryChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const operation = useRef<Operation | null>(null);
  const reads = useRef<Reads>({ inFlight: false, again: false });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // What is on screen: its run and a generation that grows with every snapshot shown. Changing the work, the run or
  // unmounting the page ends the current action, so a late answer to it (cancel, resume, place scripts) can no longer
  // change content, errors, busy, confirmations or polling, and nothing is scheduled after unmount.
  const shown = useRef<{ runId: string | null; generation: number }>({ runId: null, generation: 0 });

  const show = useCallback((next: TitleWritingRunView | null) => {
    const runId = next?.runId ?? null;
    if (runId !== shown.current.runId) {
      // Another run of this work: nothing pending, typed into a confirmation or refused for the previous run carries over.
      operation.current = null;
      resumeAction.current = null;
      setBusy(false);
      setActionMessage(null);
      setConfirmedFor(null);
      setStoryChanged(false);
      setAcceptStoryChanged(false);
    }
    shown.current = { runId, generation: shown.current.generation + 1 };
    setRun(next);
  }, []);

  const schedule = useCallback((next: TitleWritingRunView | null, poll: () => void) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = next?.state === "running" ? setTimeout(poll, TITLE_WRITING_POLL_MS) : undefined;
  }, []);

  const read = useCallback(() => {
    const scope = reads.current;
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
    if (scope.inFlight) {
      scope.again = true;
      return;
    }
    scope.inFlight = true;
    void (async () => {
      try {
        for (;;) {
          scope.again = false;
          let latest: TitleWritingRunView | null = null;
          let failure: unknown = null;
          try {
            latest = await client.latest(projectId);
          } catch (caught) {
            failure = caught ?? new Error("read failed");
          }
          if (reads.current !== scope) return;
          // Asked for while this GET was in flight: its answer may predate what asked, so read once more instead.
          if (scope.again) continue;
          setLoaded(true);
          if (failure) {
            setReadError(failure instanceof TitleWritingError && failure.code === "TITLE_WRITING_STORAGE_UNAVAILABLE"
              ? "创作任务存储还没有就绪，读不到创作记录。"
              : "暂时读不到创作进度。已显示的内容仍是上次读到的结果。");
            return;
          }
          show(latest);
          setReadError(null);
          schedule(latest, read);
          return;
        }
      } finally {
        scope.inFlight = false;
      }
    })();
  }, [client, projectId, show, schedule]);

  useEffect(() => {
    // A new work starts clean: nothing shown, typed or confirmed for the previous one carries over.
    operation.current = null;
    shown.current = { runId: null, generation: shown.current.generation + 1 };
    resumeAction.current = null;
    setRun(null);
    setLoaded(false);
    setReadError(null);
    setActionMessage(null);
    setConfirmedFor(null);
    setStoryChanged(false);
    setAcceptStoryChanged(false);
    setBusy(false);
    reads.current = { inFlight: false, again: false };
    read();
    return () => {
      operation.current = null;
      // A new scope: the old one's in-flight answer is dropped and schedules nothing.
      reads.current = { inFlight: false, again: false };
      if (timer.current) clearTimeout(timer.current);
      timer.current = undefined;
    };
  }, [read]);

  async function act(runId: string, work: () => Promise<TitleWritingRunView>, fallback: string,
    hooks: { accepted?: () => void; failed?: (caught: unknown) => void; settled?: (run: TitleWritingRunView) => boolean } = {}) {
    if (operation.current || shown.current.runId !== runId) return;
    const mine: Operation = { runId, snapshot: shown.current.generation };
    operation.current = mine;
    const current = () => operation.current === mine;
    setBusy(true);
    setActionMessage(null);
    try {
      const next = await work();
      if (!current()) return;
      if (next?.projectId !== projectId || next.runId !== mine.runId) {
        read();
        return;
      }
      hooks.accepted?.();
      if (shown.current.generation !== mine.snapshot) {
        // A read was shown while this action was on its way, and either may be the later state: ask the server.
        read();
        return;
      }
      show(next);
      // A GET in flight may have been answered from before this action: drop it and read once more after it.
      if (reads.current.inFlight) read();
      else schedule(next, read);
    } catch (caught) {
      if (!current()) return;
      if (caught instanceof TitleWritingError && caught.code === "TITLE_WRITING_STORY_CHANGED") setStoryChanged(true);
      setActionMessage({ text: actionError(caught, fallback), moot: hooks.settled });
      hooks.failed?.(caught);
    } finally {
      if (current()) {
        operation.current = null;
        setBusy(false);
      }
    }
  }

  const concept = run?.steps.find((step) => step.stepKey === "concept")?.output as TitleConcept | null | undefined;
  const outline = run?.steps.find((step) => step.stepKey === "outline")?.output as EpisodeOutline | null | undefined;
  const episodes = run?.steps.filter((step) => step.stepKey.startsWith("episode:")) ?? [];
  const uncertain = run ? hasUncertain(run) : false;
  const uncertainIds = run ? uncertainCallIds(run) : [];
  const uncertainKey = uncertainIds.join(",");
  const confirmUncertain = uncertain && confirmedFor === uncertainKey;
  // The run on screen is always the run of the action that failed: another run or work clears the message.
  const message = actionMessage && !(run && actionMessage.moot?.(run)) ? actionMessage.text : null;

  function resume(current: TitleWritingRunView) {
    const confirmed = uncertain ? uncertainIds : [];
    const previous = resumeAction.current;
    const action = previous && previous.runId === current.runId && previous.confirmedFor === uncertainKey
      ? previous : { runId: current.runId, confirmedFor: uncertainKey, key: crypto.randomUUID() };
    resumeAction.current = action;
    void act(current.runId, () => client.resume(projectId, current.runId, { confirmUncertainCallIds: confirmed, token: token.trim(), idempotencyKey: action.key }),
      "没有确认续跑是否已被受理（网络或服务异常）。再次点击会重放同一个续跑请求。", {
        accepted: () => { resumeAction.current = null; setConfirmedFor(null); },
        failed: (caught) => {
          if (!refused(caught)) return;
          resumeAction.current = null;
          setConfirmedFor(null);
          if (caught instanceof TitleWritingError && caught.code === "TITLE_WRITING_CONFIRMATION_STALE") read();
        },
      });
  }

  return (
    <BeginnerShell>
      <main className={styles.page}>
        <p className={styles.eyebrow}>AI 一键创作</p>
        {!loaded ? <p className={styles.helper} role="status">正在读取创作进度…</p> : null}
        {readError ? (
          <div className={styles.error} role="alert">
            <p>{readError}</p>
            <button className={styles.secondary} type="button" onClick={() => read()}>重新读取</button>
          </div>
        ) : null}
        {loaded && !run && !readError ? (
          <section className={styles.card}>
            <h1 className={styles.heading}>这部作品还没有 AI 创作记录</h1>
            <p className={styles.helper}>可以回到开始页用剧名一键创作，或直接手动创作。</p>
            <p className={styles.actions}>
              <a className={styles.primary} href="/create">回到开始页</a>
              <a className={styles.textLink} href={`/projects/${projectId}/create`}>手动创作</a>
            </p>
          </section>
        ) : null}
        {run ? (
          <>
            <header className={styles.runHeader}>
              <h1 className={styles.heading}>《{run.title}》</h1>
              <p className={styles.headline} role="status" aria-live="polite">{runHeadline(run)}</p>
              <p className={styles.helper}>
                模型：{PROVIDER_LABELS[run.providerKey] ?? run.providerKey} · {run.model} · 已调用 {run.callsUsed} 次（本次上限 {run.callCap} 次）。
                费用以服务商账单为准，本页不估算金额。
              </p>
              {errorText(run.errorCode) ? <p className={styles.warning}>{errorText(run.errorCode)}</p> : null}
            </header>

            <section className={styles.card} aria-labelledby="progress-title">
              <h2 id="progress-title" className={styles.sectionTitle}>进度</h2>
              <ol className={styles.steps}>
                {run.steps.map((step) => (
                  <li key={step.stepKey} className={styles.step} data-state={step.state}>
                    <span className={styles.stepName}>{stepLabel(step.stepKey)}</span>
                    <span className={styles.stepState}>{stepStateText(step.state)}</span>
                    {step.errorCode ? <span className={styles.stepError}>{errorText(step.errorCode)}</span> : null}
                  </li>
                ))}
                <li className={styles.step} data-state={run.storySave === "saved" ? "completed" : run.storySave === "conflict" ? "rejected" : "pending"}>
                  <span className={styles.stepName}>保存故事草稿</span>
                  <span className={styles.stepState}>{run.storySave === "saved" ? "已保存" : run.storySave === "conflict" ? "没有覆盖已有故事" : "等待中"}</span>
                </li>
              </ol>
              <div className={styles.actions}>
                {run.state === "running" && !run.cancelRequested ? (
                  <button className={styles.secondary} type="button" disabled={busy}
                    onClick={() => void act(run.runId, () => client.cancel(projectId, run.runId), "没能提交停止请求，请重试。", { settled: stopSettled })}>停止创作</button>
                ) : null}
                {run.state === "running" && run.cancelRequested ? (
                  <p className={styles.helper}>已请求停止。已经发出的那一步会如实记录结果，之后不再开始新的步骤。</p>
                ) : null}
              </div>
              {canResume(run) ? (
                <div className={styles.resume}>
                  <p className={styles.helper}>继续创作会复用已完成的内容，只重新进行没有完成的步骤，使用同一个模型服务。</p>
                  {uncertain ? (
                    <label className={styles.check}>
                      <input type="checkbox" checked={confirmUncertain}
                        onChange={(event) => setConfirmedFor(event.target.checked ? uncertainKey : null)} />
                      我知道「结果不确定」的那一步可能已经产生费用，确认重新发送。
                    </label>
                  ) : null}
                  <label className={styles.label} htmlFor="resume-token">操作者令牌</label>
                  <input id="resume-token" className={styles.input} type="password" autoComplete="off" value={token}
                    onChange={(event) => setToken(event.target.value)} />
                  <button className={styles.primary} type="button" disabled={busy || token.trim().length === 0 || (uncertain && !confirmUncertain)}
                    onClick={() => resume(run)}>
                    继续创作
                  </button>
                </div>
              ) : null}
              {message ? <p className={styles.error} role="alert">{message}</p> : null}
            </section>

            {concept ? (
              <section className={styles.card} aria-labelledby="concept-title">
                <h2 id="concept-title" className={styles.sectionTitle}>故事策划</h2>
                <ConceptView concept={concept} />
                {run.storySave === "saved" ? (
                  <p className={styles.actions}>
                    <a className={styles.secondary} href={`/projects/${projectId}/create?step=story`}>查看和修改故事草稿</a>
                  </p>
                ) : null}
                {run.storySave === "conflict" ? (
                  <p className={styles.warning}>作品里已经有你保存的故事，AI 没有覆盖它。需要的话，可以从下方复制内容到故事编辑器。</p>
                ) : null}
              </section>
            ) : null}

            {outline ? (
              <section className={styles.card} aria-labelledby="outline-title">
                <h2 id="outline-title" className={styles.sectionTitle}>分集大纲</h2>
                <OutlineView outline={outline} />
              </section>
            ) : null}

            {episodes.some((step) => step.text) ? (
              <section className={styles.card} aria-labelledby="scripts-title">
                <h2 id="scripts-title" className={styles.sectionTitle}>分集剧本</h2>
                {scriptsAwaitApproval(run) ? (
                  <div className={styles.notice}>
                    <p>剧本已经生成并保存在这次创作里。按审核规则，故事通过审核后才能把剧本写入各集草稿；写入时不会覆盖已有剧本。</p>
                    {storyChanged ? (
                      <label className={styles.check}>
                        <input type="checkbox" checked={acceptStoryChanged} onChange={(event) => setAcceptStoryChanged(event.target.checked)} />
                        审核通过的故事改过，我仍要写入这些剧本。
                      </label>
                    ) : null}
                    <button className={styles.secondary} type="button" disabled={busy || (storyChanged && !acceptStoryChanged)}
                      onClick={() => void act(run.runId, () => client.placeScripts(projectId, run.runId, acceptStoryChanged), "没能写入剧本，请重试。")}>
                      写入剧本草稿
                    </button>
                  </div>
                ) : null}
                {episodes.map((step, index) => step.text ? (
                  <details key={step.stepKey} className={styles.script} open={index === 0}>
                    <summary>
                      {stepLabel(step.stepKey)}
                      {step.scriptSave === "saved" ? " · 已写入剧本草稿" : step.scriptSave === "conflict" ? " · 该集已有剧本，没有覆盖" : ""}
                    </summary>
                    <div className={styles.scriptText}>{step.text}</div>
                    {step.scriptSave === "saved" ? <a className={styles.textLink} href={`/projects/${projectId}?focus=script&episode=${step.stepKey.slice(-1)}`}>去修改这一集剧本</a> : null}
                  </details>
                ) : null)}
              </section>
            ) : null}
          </>
        ) : null}
      </main>
    </BeginnerShell>
  );
}
