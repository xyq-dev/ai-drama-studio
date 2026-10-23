"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { TITLE_WRITING_PROVIDER_LABELS, seriesBatchCount, seriesBatchRange, type SeriesScope } from "@ai-drama/contracts";
import { TitleWritingError, tokenRequired } from "../lib/title-writing-client";
import {
  EPISODE_STATES,
  LEDGER_LABELS,
  MAX_RESEND,
  PLAN_LABELS,
  REVIEW_LABELS,
  SeriesWritingClient,
  blockerText,
  clearPendingSeries,
  presetScope,
  readPendingSeries,
  savePendingSeries,
  scopeSummary,
  seriesRefused,
  seriesScopeText,
  stopText,
  type SeriesGrantBody,
  type SeriesOptionsView,
  type SeriesPreset,
  type SeriesView,
} from "../lib/series-writing-client";
import { BeginnerShell } from "./beginner-shell";
import styles from "./title-writing.module.css";
import series from "./series-writing.module.css";

export const SERIES_POLL_MS = 2_000;

function sameBasis(a: Record<string, string> | null, b: Record<string, string>): boolean {
  return a !== null && Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) => b[key] === value);
}
const defaultClient = new SeriesWritingClient();
const PROVIDERS: Readonly<Record<string, string>> = TITLE_WRITING_PROVIDER_LABELS;

const PRESETS: Array<{ value: SeriesPreset; label: string }> = [
  { value: "plan", label: "只生成全剧规划" },
  { value: "plan_first", label: "全剧规划 + 前 3 集正文" },
  { value: "continue", label: "继续写后续集数" },
  { value: "final", label: "全剧结构与连续性总检" },
];

function errorText(caught: unknown): string {
  if (caught instanceof TitleWritingError) {
    const blockers = caught.details?.blockers;
    const extra = Array.isArray(blockers) ? `（${blockers.map((item) => blockerText(String(item))).join("；")}）` : "";
    if (caught.code === "SERIES_DAILY_QUOTA_LOW") {
      return `最近 24 小时还剩 ${String(caught.details?.remainingCalls ?? "?")} 次调用，当前这一步需要 ${String(caught.details?.requiredCalls ?? "?")} 次。没有创建任务，也没有发出调用。`;
    }
    return `${caught.detail}${extra}`;
  }
  return "没有确认结果（网络或服务异常）。重试会原样发送同一个请求，不会重复执行。";
}

interface CardState {
  preset: SeriesPreset;
  lastBatch: number;
  includeFinal: boolean;
  providerKey: string;
  model: string;
  resend: number;
}

/** Everything about one series work, read from the server. Paid actions show what they authorize before anything is sent. */
export function SeriesWritingPage({ projectId, client = defaultClient }: { projectId: string; client?: SeriesWritingClient }) {
  const [view, setView] = useState<SeriesView | null>(null);
  const [options, setOptions] = useState<SeriesOptionsView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState("");
  const [card, setCard] = useState<CardState>({ preset: "plan_first", lastBatch: 1, includeFinal: false, providerKey: "", model: "", resend: 0 });
  const [confirmed, setConfirmed] = useState(false);
  // The ledger editor keeps what it was opened on: polling never swaps the versions its summaries are bound to.
  const [ledgerForm, setLedgerForm] = useState<{ batchNo: number; baseLedgerRevisionId: string | null; basis: Record<string, string> } | null>(null);
  const ledgerBatch = ledgerForm?.batchNo ?? null;
  const [ledgerText, setLedgerText] = useState("");
  const [planText, setPlanText] = useState("");
  const [note, setNote] = useState("");
  const [finalNote, setFinalNote] = useState("");
  const reading = useRef(false);
  const acting = useRef(false);
  const grantScope = `grant:${projectId}`;
  const [pendingGrant, setPendingGrant] = useState(() => (typeof window === "undefined" ? null : readPendingSeries<SeriesGrantBody>(grantScope)));

  const read = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    try {
      setView(await client.get(projectId));
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
    void client.options().then((value) => {
      setOptions(value);
      const provider = value.providers.find((item) => item.providerKey === value.defaultProvider && item.ready) ?? value.providers.find((item) => item.ready);
      if (provider) setCard((current) => current.providerKey ? current : { ...current, providerKey: provider.providerKey, model: provider.defaultModel ?? "" });
    }).catch(() => setOptions(null));
  }, [client, read]);

  const active = view?.activeGrantId ?? null;
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => { void read(); }, SERIES_POLL_MS);
    return () => clearInterval(timer);
  }, [active, read]);

  /** One action at a time; resolves true only when the server accepted it (a refusal keeps what the person typed). */
  async function act(work: () => Promise<SeriesView | void>, success?: string): Promise<boolean> {
    if (acting.current) return false;
    acting.current = true;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const next = await work();
      if (next) setView(next);
      if (success) setNotice(success);
      return true;
    } catch (caught) {
      setActionError(errorText(caught));
      return false;
    } finally {
      acting.current = false;
      setBusy(false);
    }
  }

  if (!loaded) return <BeginnerShell active={undefined}><main className={styles.page}><p role="status">正在读取…</p></main></BeginnerShell>;
  if (!view) {
    return (
      <BeginnerShell active={undefined}>
        <main className={styles.page}>
          <p>{readError ?? "这部作品不是系列编剧作品。"}</p>
          <a className={styles.textLink} href="/create">返回开始页</a>
        </main>
      </BeginnerShell>
    );
  }

  const batches = seriesBatchCount(view.episodeCount);
  // A request whose answer did not arrive is shown and retried exactly as it was frozen: every figure on the card is its own.
  const frozen = pendingGrant?.body ?? null;
  const scope: SeriesScope = frozen?.scope ?? presetScope(view, card.preset, card.lastBatch, card.includeFinal);
  const summary = scopeSummary(view.episodeCount, scope);
  const normalCalls = frozen?.normalCalls ?? summary.normal;
  const resend = frozen?.resendAllowance ?? card.resend;
  const callBudget = frozen?.callBudget ?? summary.normal + card.resend;
  const provider = options?.providers.find((item) => item.providerKey === (frozen?.providerKey ?? card.providerKey));
  const frozenAvailable = frozen === null || (provider !== undefined && provider.ready && provider.models.includes(frozen.model));
  const needsToken = tokenRequired(options);
  const stopped = [...view.grants].reverse().find((item) => item.state === "stopped") ?? null;
  const running = view.grants.find((item) => item.state === "running") ?? null;
  const plan = view.plan;
  const setting = plan?.content.setting;
  const arc = plan?.content.arc;

  function grant() {
    if (!confirmed && !frozen) return setActionError("请先勾选确认授权范围、调用次数和模型服务。");
    const request = pendingGrant ?? { version: 1 as const, scope: grantScope, key: crypto.randomUUID(), body: {
      scope, normalCalls: summary.normal, resendAllowance: card.resend, callBudget: summary.normal + card.resend,
      providerKey: card.providerKey, model: card.model, basePlanRevisionId: view!.plan?.revisionId ?? null } };
    if (!pendingGrant) {
      if (!savePendingSeries(request)) return setActionError("浏览器没能保存这次请求的标识，为避免重复授权，没有继续。");
      setPendingGrant(request);
    }
    void act(async () => {
      try {
        const next = await client.grant(projectId, request.body, { token: needsToken ? token.trim() : "", idempotencyKey: request.key });
        clearPendingSeries(grantScope, request.key);
        setPendingGrant(null);
        setConfirmed(false);
        return next;
      } catch (caught) {
        if (seriesRefused(caught)) {
          clearPendingSeries(grantScope, request.key);
          setPendingGrant(null);
        }
        throw caught;
      }
    }, "已确认授权，服务端开始执行；离开或刷新页面不会重复发送。");
  }

  function resume(grantId: string, uncertain: string[]) {
    const scopeKey = `resume:${projectId}:${grantId}`;
    const request = readPendingSeries<{ confirmUncertainCallIds: string[] }>(scopeKey)
      ?? { version: 1 as const, scope: scopeKey, key: crypto.randomUUID(), body: { confirmUncertainCallIds: uncertain } };
    savePendingSeries(request);
    void act(async () => {
      try {
        const next = await client.resume(projectId, grantId, { confirmUncertainCallIds: request.body.confirmUncertainCallIds, token: needsToken ? token.trim() : "",
          idempotencyKey: request.key });
        clearPendingSeries(scopeKey, request.key);
        return next;
      } catch (caught) {
        if (seriesRefused(caught)) clearPendingSeries(scopeKey, request.key);
        throw caught;
      }
    });
  }

  function openLedger(batchNo: number) {
    const state = view!.batches[batchNo - 1]!;
    const current = state.ledger.revision;
    const { first, last } = seriesBatchRange(view!.episodeCount, batchNo);
    // A person's edit has no summary of its own yet: start from the last one recorded for the episode, to be updated.
    const summaries = Array.from({ length: last - first + 1 }, (_, index) => {
      const episode = view!.episodes[first + index - 1]!;
      const recorded = current?.summaries.find((item) => item.episodeNo === first + index)?.summary;
      return { episodeNo: first + index, summary: episode.summary ?? recorded ?? "" };
    });
    if (!state.ledgerBasis) return setActionError("这一批的台账现在不能确认（见待办）。");
    setLedgerForm({ batchNo, baseLedgerRevisionId: current?.id ?? null, basis: state.ledgerBasis });
    setLedgerText(JSON.stringify({ content: current?.content ?? null, summaries }, null, 2));
  }

  function saveLedger() {
    if (ledgerForm === null) return;
    let parsed: { content: unknown; summaries: Array<{ episodeNo: number; summary: string }> };
    try {
      parsed = JSON.parse(ledgerText) as typeof parsed;
    } catch {
      return setActionError("台账不是有效的 JSON，没有保存。");
    }
    const form = ledgerForm;
    void act(() => client.saveLedger(projectId, { batchNo: form.batchNo, baseLedgerRevisionId: form.baseLedgerRevisionId, content: parsed.content,
      summaries: parsed.summaries, expectedBasis: form.basis }), `第 ${String(form.batchNo)} 批的连续性台账已人工确认（新修订，旧修订保留；没有调用模型）。`)
      // A refusal keeps the editor and what was typed in it; the person reads the work again and checks.
      .then((accepted) => { if (accepted) setLedgerForm(null); });
  }

  /** Records a person's review of exactly the versions this page shows; a newer version is refused and the note is kept. */
  function decide(target: string, basis: Record<string, string> | null, text: string, clear: () => void) {
    if (text.trim().length === 0) return setActionError("请写一句人工复核说明。");
    if (!basis) return setActionError("现在还没有可复核的完整版本。");
    void act(() => client.decide(projectId, { target, note: text.trim(), expectedBasis: basis }), "已记录人工复核（绑定你看到的版本；之后再修改需要重新复核）。")
      .then((accepted) => { if (accepted) clear(); });
  }

  function savePlan(content: unknown, story: "from_plan" | "adopt_current", success: string) {
    void act(() => client.savePlan(projectId, { basePlanRevisionId: plan!.revisionId, baseStoryRevisionId: view!.story.current?.revisionId ?? null, story, content }), success);
  }

  function saveEditedPlan() {
    let content: unknown;
    try {
      content = JSON.parse(planText);
    } catch {
      return setActionError("规划不是有效的 JSON，没有保存。");
    }
    savePlan(content, "from_plan", "规划已另存为新修订，并形成对应的故事新草稿（需要重新审核）；基于旧规划的批次需要确认台账并复核。");
  }

  return (
    <BeginnerShell active={undefined}>
      <main className={`${styles.page} ${series.page}`} data-testid="series-page">
        <header className={styles.runHeader}>
          <p className={styles.eyebrow}>系列编剧</p>
          <h1 className={styles.heading} data-testid="series-title">{view.title}</h1>
          <p className={series.completion} data-testid="series-completion">{view.completionLabel}</p>
          <ul className={series.facts}>
            <li>规模：全剧 {view.episodeCount} 集 · 每集计划篇幅约 {view.episodeSeconds} 秒（写作计划，不是真人读演或成片的实测时长）</li>
            <li>版本：{view.versions.prompt} · {view.versions.checks}；研究沿用 {view.versions.research.promptVersion} / {view.versions.research.researchSchema}</li>
            {view.idea ? <li>你的想法：{view.idea}</li> : <li>你没有提供想法，由 AI 自主策划。</li>}
          </ul>
        </header>

        <section className={series.section} aria-labelledby="series-status-title" data-testid="series-status">
          <h2 id="series-status-title" className={styles.sectionTitle}>状态</h2>
          <div className={series.statusGrid}>
            <p><span className={series.key}>文本</span>{view.completionLabel}</p>
            <p><span className={series.key}>待写</span>{view.ranges.toWrite}</p>
            <p><span className={series.key}>待修改</span>{view.ranges.toRevise.length > 0 ? view.ranges.toRevise.map((item) => `第 ${String(item)} 批`).join("、") : "无"}</p>
            <p><span className={series.key}>待确认台账</span>{view.ranges.toConfirm.length > 0 ? view.ranges.toConfirm.map((item) => `第 ${String(item)} 批`).join("、") : "无"}</p>
            <p><span className={series.key}>待复核</span>{view.ranges.toReview.length > 0 ? view.ranges.toReview.map((item) => `第 ${String(item)} 批`).join("、") : "无"}</p>
            <p data-testid="series-attention"><span className={series.key}>待办</span>{view.attention.length > 0 ? view.attention.map(blockerText).join("；") : "无"}</p>
            <p><span className={series.key}>人工审核</span>{view.human.scriptReview === "complete" ? "全部通过" : view.human.scriptReview === "partial" ? "部分进行中" : "未开始"}</p>
            <p><span className={series.key}>真人读演</span>未记录</p>
            <p><span className={series.key}>实拍计时</span>未记录</p>
            <p><span className={series.key}>媒体生产</span>未开始（不生成图片、语音或视频）</p>
          </div>
          {readError ? <p className={styles.warning} role="status">{readError}</p> : null}
        </section>

        <section className={series.section} aria-labelledby="series-budget-title" data-testid="series-budget">
          <h2 id="series-budget-title" className={styles.sectionTitle}>预算与调用</h2>
          <ul className={series.facts}>
            <li>正常调用（每步首次成功、零修改、零重发）：全剧 {view.budget.normalCalls} 次；只做规划 {view.budget.planCalls} 次；规划加前 3 集及该批审阅 {view.budget.planAndFirstBatchCalls} 次。</li>
            <li data-testid="series-calls-used">已用调用：{view.budget.callsUsed} 次（含所有授权）；费用未知。</li>
          </ul>
          {view.grants.length > 0 ? (
            <div className={series.tableWrap}>
              <table className={series.table} data-testid="series-grants">
                <thead><tr><th>授权范围</th><th>模型</th><th>已用 / 预算</th><th>状态</th></tr></thead>
                <tbody>
                  {view.grants.map((item) => (
                    <tr key={item.grantId}>
                      <td data-label="授权范围">{item.scopeLabel}</td>
                      <td data-label="模型">{PROVIDERS[item.providerKey] ?? item.providerKey} · {item.model}</td>
                      <td data-label="已用 / 预算">{item.callsUsed} / {item.callBudget}（正常 {item.normalCalls}，重发 {item.resendAllowance}）</td>
                      <td data-label="状态">{item.state === "running" ? (item.cancelRequested ? "正在停止" : "执行中") : item.state === "completed" ? "已完成" : item.state === "canceled" ? "已取消" : "已停止"}
                        {item.state === "stopped" ? <span className={series.stop}>{stopText(item.stopReason)}</span> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {running ? (
            <div className={styles.actions}>
              <button className={styles.secondary} type="button" disabled={busy || running.cancelRequested} onClick={() => { void act(() => client.cancel(projectId, running.grantId), "已请求取消：正在进行的这一次调用结束后停止，之后不再发送。"); }}>取消</button>
            </div>
          ) : null}
          {stopped && !running ? (
            <div className={styles.resume} data-testid="series-resume">
              <p>{stopText(stopped.stopReason)}</p>
              {stopped.uncertainCallIds.length > 0 ? <p className={styles.warning}>有 {stopped.uncertainCallIds.length} 次调用结果未知，可能已经计费；继续会重新发送这一步，并计入这次授权的预算。</p> : null}
              <button className={styles.secondary} type="button" disabled={busy} onClick={() => resume(stopped.grantId, stopped.uncertainCallIds)}>
                {stopped.uncertainCallIds.length > 0 ? "确认并继续" : "继续这次授权"}
              </button>
            </div>
          ) : null}
        </section>

        {!running ? (
          <section className={`${styles.startCard} ${series.section}`} aria-labelledby="series-card-title" data-testid="series-card">
            <h2 id="series-card-title" className={styles.cardTitle}>确认授权</h2>
            {frozen ? <p className={styles.notice} role="status">上次的授权请求没有确认结果：重试会原样发送同一个请求（同一个请求标识）。</p> : null}
            {frozen ? (
              <ul className={series.facts} data-testid="series-card-frozen">
                <li>范围：{seriesScopeText(view.episodeCount, frozen.scope)}</li>
                <li>模型服务：{PROVIDERS[frozen.providerKey] ?? frozen.providerKey} · 模型 {frozen.model}</li>
                <li>允许人工确认的重发：{frozen.resendAllowance} 次</li>
              </ul>
            ) : null}
            {frozen && !frozenAvailable ? (
              <p className={styles.warning} role="status" data-testid="series-card-config-changed">
                配置已变化：这次请求冻结的服务或模型现在不可用。重试仍按原请求发送，服务端会拒绝，不会改用其他服务或模型；也可以放弃这次请求后按当前配置重新确认。
              </p>
            ) : null}
            {frozen ? null : (<>
            <div className={series.formGrid}>
              <label className={styles.label}>范围
                <select className={styles.input} value={card.preset} disabled={busy} data-testid="series-preset"
                  onChange={(event) => setCard({ ...card, preset: event.target.value as SeriesPreset })}>
                  {PRESETS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </select>
              </label>
              {card.preset === "continue" ? (
                <label className={styles.label}>写到第几批
                  <select className={styles.input} value={card.lastBatch} disabled={busy} onChange={(event) => setCard({ ...card, lastBatch: Number(event.target.value) })}>
                    {Array.from({ length: batches - (view.next.batchNo ?? batches) + 1 }, (_, index) => (view.next.batchNo ?? batches) + index).map((batchNo) => (
                      <option key={batchNo} value={batchNo}>第 {batchNo} 批（到第 {seriesBatchRange(view.episodeCount, batchNo).last} 集）</option>
                    ))}
                  </select>
                </label>
              ) : null}
              <label className={styles.label}>模型服务
                <select className={styles.input} value={card.providerKey} disabled={busy}
                  onChange={(event) => { const next = options?.providers.find((item) => item.providerKey === event.target.value); setCard({ ...card, providerKey: event.target.value, model: next?.defaultModel ?? "" }); }}>
                  {(options?.providers ?? []).filter((item) => item.ready).map((item) => <option key={item.providerKey} value={item.providerKey}>{item.label}</option>)}
                </select>
              </label>
              <label className={styles.label}>模型
                <select className={styles.input} value={card.model} disabled={busy} onChange={(event) => setCard({ ...card, model: event.target.value })}>
                  {(provider?.models ?? []).map((model) => <option key={model} value={model}>{model}</option>)}
                </select>
              </label>
              <label className={styles.label}>允许人工确认的重发次数
                <select className={styles.input} value={card.resend} disabled={busy} onChange={(event) => setCard({ ...card, resend: Number(event.target.value) })}>
                  {Array.from({ length: MAX_RESEND + 1 }, (_, index) => <option key={index} value={index}>{index} 次</option>)}
                </select>
              </label>
            </div>
            {card.preset === "continue" && scope.batchTo === batches ? (
              <label className={styles.check}><input type="checkbox" checked={card.includeFinal} disabled={busy} onChange={(event) => setCard({ ...card, includeFinal: event.target.checked })} /> 写完后做全剧结构与连续性总检（+1 次）</label>
            ) : null}
            </>)}
            <ul className={series.facts} data-testid="series-card-summary">
              <li>授权：{summary.jobs.join("；") || "无"}</li>
              <li>正常调用 {normalCalls} 次 + 重发 {resend} 次 = 预算 {callBudget} 次；每个子任务最多 {options?.maxCallsPerJob ?? 60} 次。</li>
              <li>每次输出上限 {options?.maxOutputTokensPerCall ?? 4096} tokens；输入上限 {options?.maxPromptChars ?? 40000} 字符。默认不自动修改、不自动重试；机器发现问题时标为待修改，停止后续调度。</li>
              <li>日限额按当前这一步准入（最近 24 小时上限 {options?.maxCallsPerDay ?? "?"} 次，与其他 AI 创作共用）；额度不足会停在两步之间，不会换任务、换服务或追加预算。</li>
              <li>研究：{options?.research.expectedMode === "sourced" ? "有可读取的市场资料" : "AI 创作策划（受众待验证，市场证据不可用）"}。</li>
            </ul>
            {view.next.blockers.length > 0 && card.preset === "continue" ? (
              <ul className={series.blockers} data-testid="series-blockers">{view.next.blockers.map((item) => <li key={item}>{blockerText(item)}</li>)}</ul>
            ) : null}
            {needsToken ? (
              <label className={styles.label} htmlFor="series-grant-token">操作者令牌
                <input id="series-grant-token" className={styles.input} type="password" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} />
              </label>
            ) : null}
            <label className={styles.check}><input type="checkbox" checked={confirmed || frozen !== null} disabled={busy || frozen !== null} onChange={(event) => setConfirmed(event.target.checked)} data-testid="series-confirm" /> 我确认上面的范围、调用次数、预算和模型服务</label>
            <div className={styles.actions}>
              <button className={styles.primary} type="button" disabled={busy} onClick={grant} data-testid="series-grant">{frozen ? "重试授权" : "确认并开始"}</button>
              {frozen ? <button className={styles.secondary} type="button" disabled={busy} onClick={() => { clearPendingSeries(grantScope, pendingGrant!.key); setPendingGrant(null); }}>放弃这次请求</button> : null}
            </div>
          </section>
        ) : null}

        {actionError ? <p className={styles.error} role="alert" data-testid="series-error">{actionError}</p> : null}
        {notice ? <p className={styles.notice} role="status">{notice}</p> : null}

        <section className={series.section} aria-labelledby="series-plan-title" data-testid="series-plan">
          <h2 id="series-plan-title" className={styles.sectionTitle}>全剧规划与人物设定</h2>
          {!plan || !setting || !arc ? <p className={styles.helper}>还没有全剧规划。</p> : (
            <>
              <ul className={series.facts}>
                <li data-testid="series-plan-status">规划：修订 {plan.revisionNo}（{plan.origin === "model" ? "模型稿" : "人工修改"}）· {PLAN_LABELS[plan.status]}</li>
                <li>剧名：{setting.title}；一句话故事：{setting.logline}</li>
                <li>核心冲突：{setting.core.coreConflict}；失败代价：{setting.core.failureCost}</li>
                <li>结局（只在第 {arc.finale.episodeNo} 集）：{arc.finale.resolution}</li>
                <li>故事：{plan.storySave === "saved" ? "这一规划修订对应一份作品故事（需人工审核）" : plan.storySave === "conflict" ? "作品已有故事，未覆盖" : "未保存"}</li>
                <li data-testid="series-story-status">作品当前故事：{view.story.current ? `${view.story.current.reviewStatus === "APPROVED" ? "已批准" : view.story.current.reviewStatus === "IN_REVIEW" ? "审核中" : "草稿"}${view.story.status === "changed" ? "，不是规划对应的故事" : "，是规划对应的故事"}` : "还没有"}</li>
              </ul>
              {view.story.status === "changed" ? (
                <div className={styles.resume} data-testid="series-story-sync">
                  <p className={styles.warning}>工作台另存了故事，和当前规划对应的故事不同。续写、续跑和写入分集都已停止，先选择如何同步（都会形成新的规划修订，之后需要复核规划、重新确认各批台账并复核）：</p>
                  <div className={styles.actions}>
                    <button className={styles.secondary} type="button" disabled={busy || running !== null}
                      onClick={() => savePlan(plan.content, "adopt_current", "已以工作台当前故事为准另存规划修订；请复核规划、确认台账并复核各批。")}>以工作台当前故事为准</button>
                    <button className={styles.secondary} type="button" disabled={busy || running !== null}
                      onClick={() => savePlan(plan.content, "from_plan", "已按规划另存故事新草稿（需要重新审核）；请复核规划、确认台账并复核各批。")}>按规划重新形成故事草稿</button>
                  </div>
                </div>
              ) : null}
              <div className={series.tableWrap}>
                <table className={series.table} data-testid="series-characters">
                  <thead><tr><th>编号</th><th>人物</th><th>身份</th><th>目标</th><th>弧线</th></tr></thead>
                  <tbody>{setting.characters.map((item) => <tr key={item.id}><td data-label="编号">{item.id}</td><td data-label="人物">{item.name}</td><td data-label="身份">{item.identity}</td><td data-label="目标">{item.goal}</td><td data-label="弧线">{item.arc}</td></tr>)}</tbody>
                </table>
              </div>
              {setting.relationships.length > 0 ? <ul className={series.facts}>{setting.relationships.map((item, index) => <li key={index}>关系 {item.from}—{item.to}：{item.relation}（{item.arc}）</li>)}</ul> : null}
              {setting.secrets.length > 0 ? <ul className={series.facts}>{setting.secrets.map((item) => <li key={item.id}>秘密 {item.id}（{item.holderId}）：{item.content}；计划揭露：{item.revealEpisode === null ? "未定" : `第 ${String(item.revealEpisode)} 集`}</li>)}</ul> : null}
              <div className={series.tableWrap}>
                <table className={series.table}>
                  <thead><tr><th>分幕</th><th>集数</th><th>目标</th><th>转折</th></tr></thead>
                  <tbody>{arc.phases.map((item) => <tr key={item.phaseNo}><td data-label="分幕">{item.title}</td><td data-label="集数">{item.episodeFrom}–{item.episodeTo}</td><td data-label="目标">{item.goal}</td><td data-label="转折">{item.turningPoint}</td></tr>)}</tbody>
                </table>
              </div>
              {arc.foreshadowing.length > 0 ? (
                <div className={series.tableWrap}>
                  <table className={series.table}>
                    <thead><tr><th>伏笔</th><th>内容</th><th>埋设</th><th>兑现</th></tr></thead>
                    <tbody>{arc.foreshadowing.map((item) => <tr key={item.id}><td data-label="伏笔">{item.id}</td><td data-label="内容">{item.content}</td><td data-label="埋设">第 {item.plantEpisode} 集</td><td data-label="兑现">第 {item.payoffEpisode} 集</td></tr>)}</tbody>
                  </table>
                </div>
              ) : null}
              {plan.review ? (
                <ul className={series.facts} data-testid="series-plan-review">
                  {plan.review.issues.filter((item) => item.evidenceVerified).map((item) => <li key={item.id}>{item.severity === "high" ? "必须修改" : "建议"} {item.id}（{item.target}）：{item.problem}</li>)}
                  {plan.review.deterministic.map((item) => <li key={item.id}>程序检查 {item.id}（{item.target}）：{item.detail}</li>)}
                </ul>
              ) : null}
              <details className={styles.more}>
                <summary>人工修改规划（另存为新修订）</summary>
                <p className={styles.helper}>保存规划会同时形成对应的故事新草稿，需要重新人工审核；原规划、原故事和审核记录都保留。若作品故事在你打开页面后被另存，保存会被拒绝，不会覆盖。</p>
                <textarea className={`${styles.input} ${series.code}`} rows={10} value={planText} onFocus={() => { if (!planText) setPlanText(JSON.stringify(plan.content, null, 2)); }}
                  onChange={(event) => setPlanText(event.target.value)} aria-label="规划 JSON" />
                <div className={styles.actions}><button className={styles.secondary} type="button" disabled={busy || running !== null} onClick={saveEditedPlan}>保存为新修订</button></div>
              </details>
            </>
          )}
        </section>

        <section className={series.section} aria-labelledby="series-batches-title" data-testid="series-batches">
          <h2 id="series-batches-title" className={styles.sectionTitle}>各批进度</h2>
          <div className={series.tableWrap}>
            <table className={series.table}>
              <thead><tr><th>批次</th><th>集数</th><th>已写</th><th>全文审阅</th><th>连续性台账</th><th>写入工作台</th><th>操作</th></tr></thead>
              <tbody>
                {view.batches.map((item) => (
                  <tr key={item.batchNo} data-testid={`series-batch-${String(item.batchNo)}`}>
                    <td data-label="批次">第 {item.batchNo} 批</td>
                    <td data-label="集数">{item.first}–{item.last}</td>
                    <td data-label="已写">{item.written}/{item.size}</td>
                    <td data-label="全文审阅">{REVIEW_LABELS[item.review.status]}</td>
                    <td data-label="连续性台账">{LEDGER_LABELS[item.ledger.status]}{item.changedEpisodes.length > 0 ? `（第 ${item.changedEpisodes.join("、")} 集有改动）` : ""}</td>
                    <td data-label="写入工作台">{item.placed}/{item.size}{item.conflicts > 0 ? `，${String(item.conflicts)} 集已有剧本未覆盖` : ""}</td>
                    <td className={series.rowActions}>
                      {item.written === item.size && item.review.status !== "none" && item.placed < item.size ? (
                        <button className={styles.secondary} type="button" disabled={busy || running !== null}
                          onClick={() => { void act(async () => (await client.place(projectId, item.batchNo)).series, `第 ${String(item.batchNo)} 批已写入正式分集（草稿，需人工审核；已有剧本的分集不覆盖）。`); }}>写入正式分集</button>
                      ) : null}
                      {item.written === item.size && item.ledger.status !== "valid" && item.ledger.status !== "confirmed" && item.ledger.status !== "none" ? (
                        <button className={styles.secondary} type="button" disabled={busy || running !== null} onClick={() => openLedger(item.batchNo)}>确认台账</button>
                      ) : null}
                      {(item.review.status === "needs_revision" || item.review.status === "stale") && item.decisionBasis ? (
                        <button className={styles.secondary} type="button" disabled={busy || running !== null}
                          onClick={() => decide(`batch:${String(item.batchNo)}`, item.decisionBasis, note, () => setNote(""))}>记录人工复核</button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <label className={styles.label}>人工复核说明（记录人工复核时必填）
            <input className={styles.input} maxLength={300} value={note} onChange={(event) => setNote(event.target.value)} data-testid="series-note" />
          </label>
          {plan && (plan.status === "needs_revision" || plan.status === "unreviewed") ? (
            <div className={styles.actions}><button className={styles.secondary} type="button" disabled={busy || running !== null}
              onClick={() => decide("plan", plan.decisionBasis, note, () => setNote(""))}>记录规划人工复核</button></div>
          ) : null}
          {ledgerBatch !== null ? (
            <div className={series.editor} data-testid="series-ledger-editor">
              <p className={styles.helper}>第 {ledgerBatch} 批：按打开编辑时的正文更新台账和每集概要（每集一句，绑定打开时看到的版本）后保存。旧的交接事实不再代表人工修改后的正文；保存不会调用模型。</p>
              {!sameBasis(view.batches[ledgerForm!.batchNo - 1]?.ledgerBasis ?? null, ledgerForm!.basis) ? (
                <p className={styles.warning} role="status" data-testid="series-ledger-changed">打开编辑后，规划、故事、台账或某集正文已经变化：这份编辑仍按打开时的版本提交，服务端会拒绝。请取消后重新打开、核对再确认。</p>
              ) : null}
              <textarea className={`${styles.input} ${series.code}`} rows={12} value={ledgerText} onChange={(event) => setLedgerText(event.target.value)} aria-label="台账 JSON" />
              <div className={styles.actions}>
                <button className={styles.primary} type="button" disabled={busy} onClick={saveLedger}>保存并确认台账</button>
                <button className={styles.secondary} type="button" disabled={busy} onClick={() => setLedgerForm(null)}>取消</button>
              </div>
            </div>
          ) : null}
        </section>

        <section className={series.section} aria-labelledby="series-episodes-title" data-testid="series-episodes">
          <h2 id="series-episodes-title" className={styles.sectionTitle}>1–{view.episodeCount} 集</h2>
          <div className={series.tableWrap}>
            <table className={series.table}>
              <thead><tr><th>集</th><th>标题</th><th>状态</th><th>当前稿</th><th>工作台审核</th></tr></thead>
              <tbody>
                {view.episodes.map((item) => (
                  <tr key={item.episodeNo} data-testid={`series-episode-${String(item.episodeNo)}`}>
                    <td data-label="集">{item.episodeNo}</td>
                    <td data-label="标题">{item.title}{item.summary ? <span className={series.summary}>{item.summary}</span> : null}</td>
                    <td data-label="状态">{EPISODE_STATES[item.state]}</td>
                    <td data-label="当前稿">{item.version?.source ?? "—"}{item.unadoptedModelDraft ? <span className={series.summary}>另有未采纳的模型稿</span> : null}</td>
                    <td data-label="工作台审核">{item.formalReview ? `${item.formalReview === "APPROVED" ? "已批准" : item.formalReview === "IN_REVIEW" ? "审核中" : item.formalReview === "REJECTED" ? "已退回" : "草稿"}${item.formalFreshness === "STALE" ? "（需更新）" : ""}` : "未写入"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className={series.section} aria-labelledby="series-diagnostics-title" data-testid="series-diagnostics">
          <h2 id="series-diagnostics-title" className={styles.sectionTitle}>诊断</h2>
          <div className={series.editor} data-testid="series-final-review">
            <p data-testid="series-final">全剧结构与连续性总检：{REVIEW_LABELS[view.final.status] ?? view.final.status}</p>
            <p className={styles.helper}>范围：读取全剧规划、最后的连续性台账、各集独立概要和各批审阅摘要；不逐字读取各集正文（正文由各批全文审阅检查）。机器检查和人工复核都不会批准故事或剧本。</p>
            {view.final.blockers.length > 0 ? <p className={styles.warning}>需要先处理：{view.final.blockers.map(blockerText).join("；")}</p> : null}
            {view.final.status === "stale" ? <p className={styles.warning}>总检读取的规划、故事、台账或某集版本已经变化，原结论只对旧版本有效。{view.final.previousPassed ? "旧版本曾通过总检，不代表当前依赖有效。" : ""}</p> : null}
            {view.story.status === "changed" ? <p className={styles.warning}>工作台的故事和规划绑定的故事不同：先同步规划与故事，之后才能确认台账并复核，现在不能记录总检复核。</p> : null}
            {view.final.output ? (
              <ul className={series.facts}>
                {view.final.output.deterministic.map((item) => <li key={item.id}>程序检查 {item.id}（{item.target}）{item.severity === "high" ? "必须修改" : "建议"}：{item.detail}</li>)}
                {view.final.output.issues.map((item) => (
                  <li key={item.id}>{item.evidenceVerified ? (item.severity === "high" ? "必须修改" : "建议") : "未核实（引文没有在原文中找到，不作为阻断）"} {item.id}（{item.target}）：{item.problem}</li>
                ))}
                {view.final.output.deterministic.length === 0 && view.final.output.issues.length === 0 ? <li>没有发现问题。</li> : null}
              </ul>
            ) : <p className={styles.helper}>总检还没有执行。</p>}
            {(view.final.status === "needs_revision" || view.final.status === "stale") && view.final.decisionBasis ? (
              <>
                <label className={styles.label}>总检人工复核说明（只记录对当前版本的复核，不会自动批准）
                  <input className={styles.input} maxLength={300} value={finalNote} onChange={(event) => setFinalNote(event.target.value)} data-testid="series-final-note" />
                </label>
                <div className={styles.actions}>
                  <button className={styles.secondary} type="button" disabled={busy || running !== null} data-testid="series-final-decide"
                    onClick={() => decide("final", view.final.decisionBasis, finalNote, () => setFinalNote(""))}>记录总检人工复核</button>
                </div>
              </>
            ) : null}
          </div>
          <ul className={series.facts}>
            {view.batches.flatMap((item) => (item.review.output?.deterministic ?? []).filter((finding) => finding.severity === "high").map((finding) => (
              <li key={`${String(item.batchNo)}-${finding.id}`} data-testid="series-finding">第 {item.batchNo} 批 · 程序检查 {finding.id}（{finding.target}）：{finding.detail}</li>
            )))}
            {view.batches.flatMap((item) => (item.review.output?.issues ?? []).filter((issue) => issue.evidenceVerified && issue.severity === "high").map((issue) => (
              <li key={`${String(item.batchNo)}-${issue.id}`}>第 {item.batchNo} 批 · 审阅 {issue.id}（{issue.target}）：{issue.problem}（原文：{issue.evidence}）</li>
            )))}
          </ul>
        </section>

        <section className={series.section} aria-labelledby="series-download-title" data-testid="series-download">
          <h2 id="series-download-title" className={styles.sectionTitle}>当前编剧交付包</h2>
          <p className={styles.helper}>读取实际当前的规划、故事和各集修订（包含工作台人工修改），已批准稿与当前待审稿分别标明。原自动任务包是历史快照。</p>
          <div className={styles.actions}>
            <a className={styles.secondary} href={client.packageUrl(projectId, "markdown")} data-testid="series-download-markdown">下载 Markdown</a>
            <a className={styles.secondary} href={client.packageUrl(projectId, "json")} data-testid="series-download-json">下载 JSON</a>
            <a className={styles.textLink} href={`/projects/${projectId}/create`}>打开作品工作台（审核故事与剧本）</a>
          </div>
        </section>
      </main>
    </BeginnerShell>
  );
}
