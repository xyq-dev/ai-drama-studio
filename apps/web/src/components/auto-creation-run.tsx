"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  TITLE_WRITING_PROVIDER_LABELS,
  autoNoticeText,
  autoResearchHasServerRecord,
  autoResearchMarketEvidence,
  autoStructureViews,
  autoUnverifiedHeading,
  autoUnverifiedOf,
  type AutoBible,
  type AutoDirectionsOutput,
  type AutoEpisode,
  type AutoOutline,
  type AutoStoredResearch,
  type AutoReviewOutput,
  type AutoRevision,
  type AutoSourcesOutput,
} from "@ai-drama/contracts";
import { TitleWritingError, tokenRequired } from "../lib/title-writing-client";
import {
  AUTO_REVIEW_DIMENSION_LABELS,
  AutoCreationClient,
  autoCanResume,
  autoErrorText,
  autoOutputRefused,
  autoResumeRefused,
  clearPendingResume,
  readPendingResume,
  savePendingResume,
  autoHeadline,
  autoStageLabel,
  autoStageStateText,
  autoUncertainIds,
  normalizeAutoOptions,
  stageOf,
  type AutoCreationRunView,
  type PendingAutoResume,
} from "../lib/auto-creation-client";
import { BeginnerShell } from "./beginner-shell";
import styles from "./title-writing.module.css";
import autoStyles from "./auto-creation.module.css";

export const AUTO_CREATION_POLL_MS = 2_000;
const defaultClient = new AutoCreationClient();
const PROVIDER_LABELS: Readonly<Record<string, string>> = TITLE_WRITING_PROVIDER_LABELS;

function name(bible: AutoBible | undefined, id: string): string {
  return bible?.characters.find((item) => item.id === id)?.name ?? id;
}

function EpisodeView({ episode, bible }: { episode: AutoEpisode; bible: AutoBible | undefined }) {
  return (
    <div className={styles.script}>
      {episode.scenes.map((scene) => {
        const location = bible?.locations.find((item) => item.id === scene.locationId);
        return (
          <div key={scene.sceneNo} className={styles.scriptText}>
            <p><strong>场 {scene.sceneNo}</strong> {location?.intExt === "EXT" ? "外景" : "内景"} {location?.name ?? scene.locationId} {scene.timeOfDay}</p>
            <p>出场：{scene.characterIds.map((id) => name(bible, id)).join("、")}</p>
            <p>△ {scene.action}</p>
            {scene.dialogue.map((line, index) => <p key={index}>{name(bible, line.characterId)}{line.delivery ? `（${line.delivery}）` : ""}：{line.line}</p>)}
            {scene.sound ? <p>【声音】{scene.sound}</p> : null}
            <p className={styles.helper}>镜头设计：{scene.shots.map((shot) => `${String(shot.shotNo)}. ${shot.framing}·${shot.description}（约 ${String(shot.seconds)} 秒）`).join("；")}</p>
            {scene.assetNeeds.length > 0 ? <p className={styles.helper}>素材需求：{scene.assetNeeds.join("、")}</p> : null}
          </div>
        );
      })}
      <p className={styles.helper}>交接事实：{episode.handoffFacts.join("；")}</p>
    </div>
  );
}

/** Progress and results of the latest automatic creation run of a work. Everything shown comes from stored state. */
export function AutoCreationRun({ projectId, client = defaultClient }: { projectId: string; client?: AutoCreationClient }) {
  const [run, setRun] = useState<AutoCreationRunView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  // The approved story differs from the one the scripts were written from (a person edited it in review).
  const [storyChanged, setStoryChanged] = useState(false);
  const [acceptStoryChanged, setAcceptStoryChanged] = useState(false);
  const [needsToken, setNeedsToken] = useState(false);
  const [token, setToken] = useState("");
  const reading = useRef(false);
  const acting = useRef(false);
  // The resume whose answer has not arrived, for this work and run only (restored after a reload).
  const [pendingResume, setPendingResume] = useState<PendingAutoResume | null>(null);
  const runId = run?.runId ?? null;
  const runState = run?.state ?? null;

  useEffect(() => {
    setPendingResume(runId ? readPendingResume(projectId, runId) : null);
  }, [projectId, runId]);

  useEffect(() => {
    // A completed run has nothing left to resume; a remembered request for it is moot.
    if (runState === "completed" && pendingResume) {
      clearPendingResume(pendingResume);
      setPendingResume(null);
    }
  }, [runState, pendingResume]);

  const read = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    try {
      const latest = await client.latest(projectId);
      setRun(latest);
      setReadError(null);
    } catch (caught) {
      setReadError(caught instanceof TitleWritingError ? caught.detail : "暂时读取不到进度，会自动重试。");
    } finally {
      reading.current = false;
      setLoaded(true);
    }
  }, [client, projectId]);

  useEffect(() => {
    void read();
    void client.options().then((value) => setNeedsToken(tokenRequired(normalizeAutoOptions(value)))).catch(() => undefined);
  }, [client, read]);

  useEffect(() => {
    if (run?.state !== "running") return;
    const timer = setInterval(() => { void read(); }, AUTO_CREATION_POLL_MS);
    return () => clearInterval(timer);
  }, [run?.state, read]);

  async function act(work: () => Promise<AutoCreationRunView>, fallback: string) {
    if (acting.current) return;
    acting.current = true;
    setBusy(true);
    setActionError(null);
    try {
      setRun(await work());
      setConfirmed(false);
    } catch (caught) {
      if (caught instanceof TitleWritingError && caught.code === "AUTO_CREATION_STORY_CHANGED") setStoryChanged(true);
      setActionError(caught instanceof TitleWritingError ? caught.detail : fallback);
      // An unanswered resume keeps its identity (key and confirmations) so that a retry is the same action.
      await read();
    } finally {
      acting.current = false;
      setBusy(false);
    }
  }

  if (!loaded) return <BeginnerShell active={undefined}><main className={styles.page}><p role="status">正在读取…</p></main></BeginnerShell>;
  if (!run) {
    return (
      <BeginnerShell active={undefined}>
        <main className={styles.page}>
          <p>这部作品还没有 AI 自动创作任务。</p>
          {readError ? <p className={styles.error} role="alert">{readError}</p> : null}
          <a className={styles.textLink} href="/create">返回开始页</a>
        </main>
      </BeginnerShell>
    );
  }

  const sources = stageOf(run, "sources")?.output as AutoSourcesOutput | null | undefined;
  const research = stageOf(run, "research")?.output as AutoStoredResearch | null | undefined;
  const directions = stageOf(run, "directions")?.output as AutoDirectionsOutput | null | undefined;
  const bible = (stageOf(run, "bible")?.output as AutoBible | null | undefined) ?? undefined;
  const outline = stageOf(run, "outline")?.output as AutoOutline | null | undefined;
  const reviews = run.stages.filter((stage) => stage.kind === "review" && stage.output);
  const revisions = run.stages.filter((stage) => stage.kind === "revise" && stage.output);
  const uncertain = autoUncertainIds(run);
  const chosen = directions?.candidates.find((item) => item.id === directions.selection.chosenId);
  // Server notices (checks v5): a number the checks could not place, kept as written and marked unverified where it stands.
  const researchNotices = autoUnverifiedOf(research);
  // research v4: whether market evidence was available, as the server recorded it; null for older research.
  const market = research ? autoResearchMarketEvidence(research) : null;
  const noticeMark = (prefix: string) => researchNotices.some((item) => item.field.startsWith(prefix))
    ? <span className={styles.warning} data-testid="auto-unverified-mark">（含未核实数字）</span> : null;
  const chosenIndex = directions && chosen ? directions.candidates.indexOf(chosen) : -1;
  const directionNotices = autoUnverifiedOf(directions).filter((item) => item.field.startsWith(`candidates[${String(chosenIndex)}].`));
  const runError = autoErrorText(run.errorCode);
  const rejected = run.stages.find((stage) => stage.state === "rejected" || stage.state === "unknown");

  function resume() {
    if (acting.current) return;
    const identity: PendingAutoResume = pendingResume
      ?? { version: 1, projectId, runId: run!.runId, key: crypto.randomUUID(), confirmUncertainCallIds: [...uncertain] };
    if (!pendingResume) {
      // Best effort across reloads; within this page the identity is kept either way.
      savePendingResume(identity);
      setPendingResume(identity);
    }
    void act(async () => {
      try {
        const next = await client.resume(projectId, identity.runId, { confirmUncertainCallIds: identity.confirmUncertainCallIds,
          token: needsToken ? token.trim() : "", idempotencyKey: identity.key });
        clearPendingResume(identity);
        setPendingResume(null);
        return next;
      } catch (caught) {
        if (autoResumeRefused(caught)) {
          clearPendingResume(identity);
          setPendingResume(null);
        }
        throw caught;
      }
    }, "没有确认是否已继续。重试会原样发送同一个请求（同一个请求标识和同一组确认）。");
  }

  return (
    <BeginnerShell active={undefined}>
      <main className={styles.page} data-testid="auto-creation-run">
        <header className={styles.runHeader}>
          <p className={styles.eyebrow}>AI 自动创作</p>
          <h1 className={styles.heading} data-testid="auto-headline">{autoHeadline(run)}</h1>
          <ul className={autoStyles.list}>
            <li>模型：{PROVIDER_LABELS[run.providerKey] ?? run.providerKey} · {run.model}（冻结，不会改用其他服务）</li>
            <li data-testid="auto-call-count">调用：已用 {run.callsUsed} / 预算 {run.callCap} 次（正常 {run.budget.normalCalls}，最坏 {run.budget.worstCalls}）；修改轮次 {run.revisionRoundsUsed} / {run.budget.revisionRounds}；费用未知</li>
            <li>规模：{run.episodeCount} 集 · 每集目标约 {run.episodeSeconds} 秒（写作目标，不是成片实测）</li>
            <li data-testid="auto-research">研究：{run.researchMode === "limited" ? "AI 创作策划（受众待验证，市场证据不可用；不是实时市场验证）" : run.researchMode === "sourced" ? "有可读取的市场资料" : "尚未整理"}</li>
            {run.idea ? <li>你的想法：{run.idea}</li> : <li>你没有提供想法，由 AI 自主策划。</li>}
          </ul>
        </header>

        <section className={autoStyles.section} aria-labelledby="auto-status-title" data-testid="auto-status">
          <h2 id="auto-status-title" className={styles.sectionTitle}>状态</h2>
          <ul className={autoStyles.list}>
            <li data-testid="auto-package-status">剧本包：{run.packageStatus === "ready" ? "已完成，可下载" : run.packageStatus === "in_progress" ? "进行中" : "未完成"}</li>
            <li data-testid="auto-quality">机器质量检查（内部参考，不是人工审核）：{run.quality === "passed" ? "通过" : run.quality === "needs_work" ? "待完善" : "未完成"}</li>
            <li>人工审核：{run.storySave === "saved" ? "故事已存为「AI 自动生成草稿」，请在作品中由人审核" : run.storySave === "conflict" ? "作品已有故事，未覆盖" : "尚未保存"}</li>
            <li data-testid="auto-video-status">视频成片：未开始（本功能不生成图片、语音或视频；当前没有接入真实媒体服务）</li>
          </ul>
          {runError ? <p className={run.state === "completed" ? styles.warning : styles.error} role="status">{runError}</p> : null}
          {run.openIssues.length > 0 ? (
            <ul className={autoStyles.list} data-testid="auto-open-issues">
              {run.openIssues.map((item) => <li key={item.id}>待解决 {item.id}（{item.target}）：{item.detail}</li>)}
            </ul>
          ) : null}
          {readError ? <p className={styles.warning} role="status">{readError}</p> : null}
        </section>

        <div className={styles.actions}>
          {run.state === "running" && !run.cancelRequested ? (
            <button className={styles.secondary} type="button" disabled={busy} onClick={() => void act(() => client.cancel(projectId, run.runId), "停止请求没有确认。")}>停止</button>
          ) : null}
          {run.packageStatus === "ready" || run.state !== "running" ? (
            <>
              <a className={styles.primary} href={client.packageUrl(projectId, run.runId, "markdown")} download data-testid="auto-download-md">下载剧本包（Markdown）</a>
              <a className={styles.secondary} href={client.packageUrl(projectId, run.runId, "json")} download data-testid="auto-download-json">下载结构化数据（JSON）</a>
            </>
          ) : null}
          {run.storySave === "saved" ? <a className={styles.textLink} href={`/projects/${projectId}/create?step=story`}>去作品中人工审核故事</a> : null}
        </div>

        {autoCanResume(run) ? (
          <section className={styles.resume} aria-labelledby="auto-resume-title">
            <h2 id="auto-resume-title" className={styles.sectionTitle}>继续</h2>
            {rejected ? <p>停在「{autoStageLabel(rejected.stageKey)}」：{autoErrorText(rejected.errorCode)}</p> : null}
            {rejected && autoOutputRefused(rejected.errorCode) ? (
              <p className={styles.helper} data-testid="auto-output-refused">
                这是模型回答没有通过程序检查，不是密钥或账户问题，不需要更换密钥。继续会重新发送这一步，是一次新的计费调用，模型仍可能给出不合格的回答；程序不会自动重发或修格式。
              </p>
            ) : null}
            {pendingResume ? (
              <p className={styles.warning} data-testid="auto-resume-pending">
                上一次继续请求没有收到确认{pendingResume.confirmUncertainCallIds.length > 0 ? `（确认重发的调用：${pendingResume.confirmUncertainCallIds.join("、")}）` : ""}。
                重试会原样发送同一个请求，不会换成新的确认；收到结果后才能发起新的继续。
              </p>
            ) : uncertain.length > 0 ? (
              <label className={styles.check}>
                <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
                有 {uncertain.length} 次调用结果不确定（{uncertain.join("、")}），可能已经计费。我确认可能重复计费，重新发送这一步。
              </label>
            ) : null}
            {needsToken ? <input className={styles.input} aria-label="操作者令牌" type="password" value={token} onChange={(event) => setToken(event.target.value)} /> : null}
            <button className={styles.primary} type="button" disabled={busy || (!pendingResume && uncertain.length > 0 && !confirmed)} onClick={resume}>
              {pendingResume ? "重试上次继续请求" : "从已保存的阶段继续"}
            </button>
          </section>
        ) : null}
        {run.storySave === "saved" && run.state !== "running" ? (
          <p className={styles.helper}>
            故事经人工审核通过后，可以把各集剧本一次写入作品：
            <button className={styles.textLink} type="button" disabled={busy || (storyChanged && !acceptStoryChanged)}
              onClick={() => void act(() => client.placeScripts(projectId, run.runId, storyChanged && acceptStoryChanged), "写入没有确认。")}>写入分集剧本草稿</button>
          </p>
        ) : null}
        {storyChanged && run.storySave === "saved" ? (
          <label className={styles.check} data-testid="auto-accept-story-changed">
            <input type="checkbox" checked={acceptStoryChanged} onChange={(event) => setAcceptStoryChanged(event.target.checked)} />
            审核通过的故事和生成剧本时用的故事不同（审核时改过）。我确认仍按 AI 生成的分集剧本写入草稿，之后再自行修改。
          </label>
        ) : null}
        {actionError ? <p className={styles.error} role="alert">{actionError}</p> : null}

        <section className={autoStyles.section} aria-labelledby="auto-stages-title">
          <h2 id="auto-stages-title" className={styles.sectionTitle}>阶段</h2>
          <ol className={styles.steps} data-testid="auto-stages">
            {run.stages.map((stage) => (
              <li key={stage.stageKey} className={styles.step} data-stage={stage.stageKey} data-state={stage.state}>
                <span className={styles.stepName}>{autoStageLabel(stage.stageKey)}</span>
                <span className={styles.stepState}>{autoStageStateText(stage.state)}{stage.attemptNo > 1 ? `（第 ${String(stage.attemptNo)} 次）` : ""}</span>
                {stage.supersededBy ? <span className={styles.helper}>已被 {autoStageLabel(stage.supersededBy)} 取代</span> : null}
                {stage.upstreamChanged ? <span className={styles.warning}>上游内容已修改，这一版需要复核</span> : null}
                {stage.scriptSave === "saved" ? <span className={styles.helper} data-testid={`auto-script-save-${stage.stageKey}`}>已写入作品分集草稿</span> : null}
                {stage.scriptSave === "conflict" ? (
                  <span className={styles.warning} data-testid={`auto-script-save-${stage.stageKey}`}>这一集作品里已有剧本，没有覆盖（AI 版本保留在剧本包中）</span>
                ) : null}
                {stage.errorCode && stage.state !== "completed" ? <span className={styles.stepError}>{autoErrorText(stage.errorCode)}</span> : null}
              </li>
            ))}
          </ol>
        </section>

        {sources ? (
          <section className={autoStyles.section} aria-labelledby="auto-sources-title" data-testid="auto-sources">
            <h2 id="auto-sources-title" className={styles.sectionTitle}>资料来源与限制</h2>
            <ul className={autoStyles.list}>
              {sources.sources.map((source) => (
                <li key={source.sourceId}>
                  {source.sourceId}｜{source.title}｜{source.status === "read" ? `已读取（${source.readScope}）` : `未读取（${source.status}）`}｜获取 {source.fetchedAt.slice(0, 10)}
                  {source.publishedAt ? `｜发布 ${source.publishedAt.slice(0, 10)}` : "｜发布日期未知"}｜{source.limitations}
                </li>
              ))}
            </ul>
            {sources.notes.map((note) => <p key={note} className={styles.warning}>{note}</p>)}
          </section>
        ) : null}

        {research ? (
          <section className={autoStyles.section} aria-labelledby="auto-research-title" data-testid="auto-research-detail">
            <h2 id="auto-research-title" className={styles.sectionTitle}>{market?.status === "unavailable" ? "AI 创作策划" : "研究与受众分析"}</h2>
            {run.researchMode === "limited" ? (
              <p className={styles.warning} data-testid="auto-research-limited">
                AI 创作策划：没有符合条件的近期市场资料，市场证据不可用。下面的受众和题材判断都是待验证的创作假设，验证计划尚未执行；方法引用只是写作方法，不是市场证据。这不是实时市场验证，也不是平台真实用户画像；文本剧本包完成不代表做过市场验证。
              </p>
            ) : null}
            {market?.status === "unavailable" ? (
              <p className={styles.helper} data-testid="auto-market-evidence">市场证据：不可用（服务端记录）。{market.note}</p>
            ) : (
              <>
                <p className={styles.helper}>有来源的事实</p>
                <ul className={autoStyles.list} data-testid="auto-facts">{research.facts.length > 0 ? research.facts.map((item) => <li key={item.id}>{item.statement}（{item.sourceIds.join("、")}：「{item.evidence}」）</li>) : <li>无（没有可引用的资料）</li>}</ul>
                <p className={styles.helper}>基于样本的观察</p>
                <ul className={autoStyles.list}>{research.observations.length > 0 ? research.observations.map((item) => <li key={item.id}>{item.statement}（{item.sourceIds.join("、")}）</li>) : <li>无</li>}</ul>
              </>
            )}
            <p className={styles.helper}>AI 创作假设与验证计划（假设未经验证；验证计划尚未执行，不是调查结果）</p>
            <ul className={autoStyles.list} data-testid="auto-hypotheses">
              {research.hypotheses.map((item, index) => (
                <li key={item.id}>
                  {item.id} 假设：{item.statement}{noticeMark(`hypotheses[${String(index)}].statement`)}
                  <br />验证计划：{item.howToVerify}{noticeMark(`hypotheses[${String(index)}].howToVerify`)}
                </li>
              ))}
            </ul>
            <p data-testid="auto-audience">
              目标观众（{research.audience.basis === "sourced" ? "有来源" : "受众待验证：拟定人群，不是平台真实用户画像"}）：{research.audience.primary}；观看需求：{research.audience.viewingNeeds.join("、")}；情绪诉求：{research.audience.emotionalAppeals.join("、")}
            </p>
            <ul className={autoStyles.list} data-testid="auto-opportunities">
              {research.opportunities.map((item, index) => <li key={index}>机会（AI 创作判断）：{item}{noticeMark(`opportunities[${String(index)}]`)}</li>)}
              {autoResearchHasServerRecord(research) ? null : (
                <>
                  <li data-testid="auto-legacy-limitations">局限（AI 填写，历史版本）：{research.limitations.join("；")}</li>
                  {research.appliedConstraints.length > 0 ? <li>采用的约束（AI 复述，历史版本）：{research.appliedConstraints.join("；")}</li> : null}
                </>
              )}
            </ul>
            <p className={styles.helper}>内容结构（参考方法原文是资料原文；本剧应用设计是本作品的创作设计，不是资料或市场结论）</p>
            <ol className={autoStyles.list} data-testid="auto-structure">
              {autoStructureViews(research).map((item, index) => item.version === "v1" ? (
                <li key={index} data-testid="auto-structure-legacy">
                  历史版本（未区分参考原文与本剧应用）：{item.pattern}：{item.why}{item.sourceIds.length > 0 ? `（${item.sourceIds.join("、")}）` : ""}
                </li>
              ) : (
                <li key={index}>
                  <span data-testid="auto-structure-reference">参考方法原文：{item.reference ? `${item.reference.sourceId}「${item.reference.quote}」` : "无（自主创作设计）"}</span>
                  <br />
                  <span data-testid="auto-structure-application">本剧应用设计：{item.application.pattern}：{item.application.why}</span>
                  {noticeMark(`contentStructure[${String(index)}].`)}
                </li>
              ))}
            </ol>
            {autoResearchHasServerRecord(research) ? (
              <>
                <p className={styles.helper}>用户设定与资料记录（来自用户设定和服务端记录，不是 AI 调研结论）</p>
                <ul className={autoStyles.list} data-testid="auto-server-record">
                  {research.serverRecord.settings.items.map((item) => <li key={item.key}>用户设定｜{item.label}：{item.value}</li>)}
                  <li>资料模式：{research.serverRecord.material.researchMode === "limited" ? "AI 创作策划（市场证据不可用，不是实时市场验证）" : "有可读取的市场资料"}</li>
                  {market ? <li data-testid="auto-server-market">市场证据：{market.status === "unavailable" ? "不可用" : "可用"}（{market.note}）</li> : null}
                  {research.serverRecord.material.read.map((item) => <li key={item.sourceId}>已读取：{item.sourceId}「{item.title}」（{item.readScope}）</li>)}
                  {research.serverRecord.material.unread.map((item) => <li key={item.sourceId}>未读取：{item.sourceId}「{item.title}」（{item.status}）</li>)}
                  {research.serverRecord.material.gaps.map((gap) => <li key={gap}>缺失说明：{gap}</li>)}
                </ul>
                <p className={styles.helper}>未核实提示（{autoUnverifiedHeading(researchNotices)}；相关文字只属于创作假设或设计，不是有来源的事实、平台用户画像或已验证的市场结论）</p>
                <ul className={autoStyles.list} data-testid="auto-unverified">
                  {researchNotices.length > 0 ? researchNotices.map((item) => <li key={`${item.field}:${item.token}`} className={styles.warning}>{autoNoticeText(item, research)}</li>) : <li>无</li>}
                </ul>
              </>
            ) : null}
          </section>
        ) : null}

        {directions && chosen ? (
          <section className={autoStyles.section} aria-labelledby="auto-direction-title" data-testid="auto-direction">
            <h2 id="auto-direction-title" className={styles.sectionTitle}>已选方向：{chosen.title}</h2>
            <p>{chosen.logline}</p>
            <ul className={autoStyles.list}>{directions.selection.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
            {directionNotices.length > 0 ? (
              <ul className={autoStyles.list} data-testid="auto-direction-unverified">
                {directionNotices.map((item) => <li key={`${item.field}:${item.token}`} className={styles.warning}>未核实提示：{autoNoticeText(item)}</li>)}
              </ul>
            ) : null}
            <details className={styles.more}>
              <summary>查看全部 {directions.candidates.length} 个方向</summary>
              <ul className={autoStyles.list}>
                {directions.candidates.map((item) => {
                  const score = directions.selection.scores.find((entry) => entry.id === item.id);
                  return <li key={item.id}>{item.id} {item.title}：{item.logline}（难度 {item.productionDifficulty}；内部得分 {score?.score.toFixed(2)}{score?.excluded ? `；排除：${score.excluded}` : ""}）</li>;
                })}
              </ul>
            </details>
          </section>
        ) : null}

        {bible ? (
          <section className={autoStyles.section} aria-labelledby="auto-bible-title">
            <h2 id="auto-bible-title" className={styles.sectionTitle}>故事设定：{bible.title}</h2>
            <p>{bible.logline}</p>
            <p>{bible.synopsis}</p>
            <ul className={autoStyles.list}>
              <li>结局：{bible.story.ending}</li>
              <li>反转：{bible.story.twist.reveal}（伏笔：{bible.story.twist.setups.join("；")}）</li>
              {bible.characters.map((item) => <li key={item.id}>{item.id} {item.name}（{item.presence === "on_screen" ? "出场" : "仅被提及"}）：{item.identity}；目标 {item.goal}；弱点 {item.weakness}</li>)}
              {bible.locations.map((item) => <li key={item.id}>{item.id} {item.name}（{item.intExt === "INT" ? "内景" : "外景"}·{item.timeOfDay}）：{item.layout}</li>)}
            </ul>
          </section>
        ) : null}

        {outline ? (
          <section className={autoStyles.section} aria-labelledby="auto-outline-title">
            <h2 id="auto-outline-title" className={styles.sectionTitle}>分集大纲</h2>
            <ol className={autoStyles.list}>{outline.episodes.map((item) => <li key={item.episodeNo}>第 {item.episodeNo} 集 {item.title}：{item.goal} → {item.turn} → {item.result}</li>)}</ol>
          </section>
        ) : null}

        {Object.entries(run.currentEpisodes).length > 0 ? (
          <section className={autoStyles.section} aria-labelledby="auto-episodes-title" data-testid="auto-episodes">
            <h2 id="auto-episodes-title" className={styles.sectionTitle}>逐集剧本（当前版本）</h2>
            {Object.entries(run.currentEpisodes).sort(([a], [b]) => a.localeCompare(b)).map(([episodeKey, versionKey]) => {
              const stage = stageOf(run, versionKey);
              const episode = stage?.output as AutoEpisode | AutoRevision | undefined;
              return episode ? (
                <article key={episodeKey}>
                  <h3 className={styles.outlineTitle}>第 {episode.episodeNo} 集 {episode.title}{versionKey !== episodeKey ? `（${autoStageLabel(versionKey)}后的版本）` : ""}</h3>
                  <EpisodeView episode={episode} bible={bible} />
                </article>
              ) : null;
            })}
          </section>
        ) : null}

        {reviews.length > 0 ? (
          <section className={autoStyles.section} aria-labelledby="auto-reviews-title" data-testid="auto-reviews">
            <h2 id="auto-reviews-title" className={styles.sectionTitle}>质量检查与修改记录</h2>
            <p className={styles.helper}>检查由程序规则和独立的 AI 审阅完成，分数只是内部参考，不是质量认证，也不是人工审核。</p>
            {reviews.map((stage) => {
              const review = stage.output as AutoReviewOutput;
              return (
                <article key={stage.stageKey}>
                  <h3 className={styles.outlineTitle}>{autoStageLabel(stage.stageKey)}：{review.passed ? "通过" : "未通过"}</h3>
                  <ul className={autoStyles.list}>
                    {review.deterministic.map((item) => <li key={item.id}>[程序检查 {item.id}·{item.severity}] {item.target}：{item.detail}</li>)}
                    {review.issues.map((item) => <li key={item.id}>[AI 审阅 {item.id}·{item.severity}{item.evidenceVerified ? "" : "·原文未找到，未采用"}] {item.target}：{item.problem}（原文「{item.evidence}」；建议：{item.suggestion}）</li>)}
                    {review.deterministic.length + review.issues.length === 0 ? <li>没有发现需要修改的问题。</li> : null}
                  </ul>
                  <details className={styles.more}>
                    <summary>各项评价</summary>
                    <ul className={autoStyles.list}>{review.dimensions.map((item) => <li key={item.key}>{AUTO_REVIEW_DIMENSION_LABELS[item.key]}：{item.assessment}（内部参考 {item.internalScore}/5）</li>)}</ul>
                  </details>
                </article>
              );
            })}
            {revisions.map((stage) => (
              <p key={stage.stageKey}>{autoStageLabel(stage.stageKey)}：{(stage.output as AutoRevision).changes.map((item) => `${item.issueId} ${item.change}`).join("；")}</p>
            ))}
          </section>
        ) : null}

        <details className={styles.more} data-testid="auto-calls">
          <summary>调用记录（{run.calls.length} 次）</summary>
          <ul className={autoStyles.list}>
            {run.calls.map((call) => (
              <li key={call.callId}>{autoStageLabel(call.stageKey)} 第 {call.attemptNo} 次：{autoStageStateText(call.state)}{call.errorCode ? `（${call.errorCode}）` : ""}；
                用量 {call.usage.status === "present" ? `${String(call.usage.totalTokens)} tokens` : "未知"}；费用未知</li>
            ))}
          </ul>
        </details>
      </main>
    </BeginnerShell>
  );
}
