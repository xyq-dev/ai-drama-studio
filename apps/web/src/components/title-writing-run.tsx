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
    return caught.detail;
  }
  return fallback;
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
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [confirmUncertain, setConfirmUncertain] = useState(false);
  const [acceptStoryChanged, setAcceptStoryChanged] = useState(false);
  const [storyChanged, setStoryChanged] = useState(false);
  const [busy, setBusy] = useState(false);
  const readToken = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const read = useCallback(async () => {
    const request = ++readToken.current;
    if (timer.current) clearTimeout(timer.current);
    try {
      const latest = await client.latest(projectId);
      if (request !== readToken.current) return;
      setRun(latest);
      setReadError(null);
      setLoaded(true);
      if (latest?.state === "running") timer.current = setTimeout(() => { void read(); }, TITLE_WRITING_POLL_MS);
    } catch (caught) {
      if (request !== readToken.current) return;
      setLoaded(true);
      setReadError(caught instanceof TitleWritingError && caught.code === "TITLE_WRITING_STORAGE_UNAVAILABLE"
        ? "创作任务存储还没有就绪，读不到创作记录。"
        : "暂时读不到创作进度。已显示的内容仍是上次读到的结果。");
    }
  }, [client, projectId]);

  useEffect(() => {
    void read();
    return () => {
      readToken.current += 1;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [read]);

  async function act(work: () => Promise<TitleWritingRunView>, fallback: string) {
    if (busy) return;
    setBusy(true);
    setActionMessage(null);
    try {
      const next = await work();
      readToken.current += 1;
      setRun(next);
      if (next.state === "running") timer.current = setTimeout(() => { void read(); }, TITLE_WRITING_POLL_MS);
    } catch (caught) {
      if (caught instanceof TitleWritingError && caught.code === "TITLE_WRITING_STORY_CHANGED") setStoryChanged(true);
      setActionMessage(actionError(caught, fallback));
    } finally {
      setBusy(false);
    }
  }

  const concept = run?.steps.find((step) => step.stepKey === "concept")?.output as TitleConcept | null | undefined;
  const outline = run?.steps.find((step) => step.stepKey === "outline")?.output as EpisodeOutline | null | undefined;
  const episodes = run?.steps.filter((step) => step.stepKey.startsWith("episode:")) ?? [];
  const uncertain = run ? hasUncertain(run) : false;

  return (
    <BeginnerShell>
      <main className={styles.page}>
        <p className={styles.eyebrow}>AI 一键创作</p>
        {!loaded ? <p className={styles.helper} role="status">正在读取创作进度…</p> : null}
        {readError ? (
          <div className={styles.error} role="alert">
            <p>{readError}</p>
            <button className={styles.secondary} type="button" onClick={() => void read()}>重新读取</button>
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
                    onClick={() => void act(() => client.cancel(projectId, run.runId), "没能提交停止请求，请重试。")}>停止创作</button>
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
                      <input type="checkbox" checked={confirmUncertain} onChange={(event) => setConfirmUncertain(event.target.checked)} />
                      我知道「结果不确定」的那一步可能已经产生费用，确认重新发送。
                    </label>
                  ) : null}
                  <label className={styles.label} htmlFor="resume-token">操作者令牌</label>
                  <input id="resume-token" className={styles.input} type="password" autoComplete="off" value={token}
                    onChange={(event) => setToken(event.target.value)} />
                  <button className={styles.primary} type="button" disabled={busy || token.trim().length === 0 || (uncertain && !confirmUncertain)}
                    onClick={() => void act(() => client.resume(projectId, run.runId, confirmUncertain, token.trim()), "没能继续创作，请重试。")}>
                    继续创作
                  </button>
                </div>
              ) : null}
              {actionMessage ? <p className={styles.error} role="alert">{actionMessage}</p> : null}
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
                      onClick={() => void act(() => client.placeScripts(projectId, run.runId, acceptStoryChanged), "没能写入剧本，请重试。")}>
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
