"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  TITLE_WRITING_PROVIDER_LABELS,
  type AutoBible,
  type AutoDirectionsOutput,
  type AutoEpisode,
  type AutoOutline,
  type AutoResearch,
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
  autoHeadline,
  autoStageLabel,
  autoStageStateText,
  autoUncertainIds,
  normalizeAutoOptions,
  stageOf,
  type AutoCreationRunView,
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
  const resumeKey = useRef<string | null>(null);

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
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      setRun(await work());
      setConfirmed(false);
    } catch (caught) {
      if (caught instanceof TitleWritingError && caught.code === "AUTO_CREATION_STORY_CHANGED") setStoryChanged(true);
      setActionError(caught instanceof TitleWritingError ? caught.detail : fallback);
      // An unanswered resume keeps its key so that a retry is the same action.
      await read();
    } finally {
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
  const research = stageOf(run, "research")?.output as AutoResearch | null | undefined;
  const directions = stageOf(run, "directions")?.output as AutoDirectionsOutput | null | undefined;
  const bible = (stageOf(run, "bible")?.output as AutoBible | null | undefined) ?? undefined;
  const outline = stageOf(run, "outline")?.output as AutoOutline | null | undefined;
  const reviews = run.stages.filter((stage) => stage.kind === "review" && stage.output);
  const revisions = run.stages.filter((stage) => stage.kind === "revise" && stage.output);
  const uncertain = autoUncertainIds(run);
  const chosen = directions?.candidates.find((item) => item.id === directions.selection.chosenId);
  const runError = autoErrorText(run.errorCode);
  const rejected = run.stages.find((stage) => stage.state === "rejected" || stage.state === "unknown");

  function resume() {
    resumeKey.current ??= crypto.randomUUID();
    const key = resumeKey.current;
    void act(async () => {
      const next = await client.resume(projectId, run!.runId, { confirmUncertainCallIds: uncertain, token: needsToken ? token.trim() : "", idempotencyKey: key });
      resumeKey.current = null;
      return next;
    }, "没有确认是否已续跑。重试会使用同一个请求标识。");
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
            <li data-testid="auto-research">研究：{run.researchMode === "limited" ? "资料有限策划模式（不是实时市场验证）" : run.researchMode === "sourced" ? "有近期市场资料" : "尚未整理"}</li>
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
          {run.storySave === "saved" ? <a className={styles.textLink} href={`/projects/${projectId}/create`}>去作品中人工审核故事</a> : null}
        </div>

        {autoCanResume(run) ? (
          <section className={styles.resume} aria-labelledby="auto-resume-title">
            <h2 id="auto-resume-title" className={styles.sectionTitle}>继续</h2>
            {rejected ? <p>停在「{autoStageLabel(rejected.stageKey)}」：{autoErrorText(rejected.errorCode)}</p> : null}
            {uncertain.length > 0 ? (
              <label className={styles.check}>
                <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
                有 {uncertain.length} 次调用结果不确定（{uncertain.join("、")}），可能已经计费。我确认可能重复计费，重新发送这一步。
              </label>
            ) : null}
            {needsToken ? <input className={styles.input} aria-label="操作者令牌" type="password" value={token} onChange={(event) => setToken(event.target.value)} /> : null}
            <button className={styles.primary} type="button" disabled={busy || (uncertain.length > 0 && !confirmed)} onClick={resume}>从已保存的阶段继续</button>
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
          <section className={autoStyles.section} aria-labelledby="auto-research-title">
            <h2 id="auto-research-title" className={styles.sectionTitle}>研究与受众分析</h2>
            <p className={styles.helper}>有来源的事实</p>
            <ul className={autoStyles.list}>{research.facts.length > 0 ? research.facts.map((item) => <li key={item.id}>{item.statement}（{item.sourceIds.join("、")}：「{item.evidence}」）</li>) : <li>无</li>}</ul>
            <p className={styles.helper}>基于样本的观察</p>
            <ul className={autoStyles.list}>{research.observations.length > 0 ? research.observations.map((item) => <li key={item.id}>{item.statement}（{item.sourceIds.join("、")}）</li>) : <li>无</li>}</ul>
            <p className={styles.helper}>待验证的假设</p>
            <ul className={autoStyles.list}>{research.hypotheses.map((item) => <li key={item.id}>{item.statement}（验证：{item.howToVerify}）</li>)}</ul>
            <p>目标观众（{research.audience.basis === "sourced" ? "有来源" : "假设"}）：{research.audience.primary}；观看需求：{research.audience.viewingNeeds.join("、")}；情绪诉求：{research.audience.emotionalAppeals.join("、")}</p>
          </section>
        ) : null}

        {directions && chosen ? (
          <section className={autoStyles.section} aria-labelledby="auto-direction-title" data-testid="auto-direction">
            <h2 id="auto-direction-title" className={styles.sectionTitle}>已选方向：{chosen.title}</h2>
            <p>{chosen.logline}</p>
            <ul className={autoStyles.list}>{directions.selection.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
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
