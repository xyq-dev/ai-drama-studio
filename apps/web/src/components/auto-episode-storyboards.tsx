"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { RealMediaQuote } from "@ai-drama/contracts";
import {
  createAutoEpisodeStoryboardsClient,
  storyboardGate,
  storyboardShotStatus,
  type AutoStoryboardEpisode,
  type AutoStoryboardShot,
  type AutoStoryboardView,
} from "../lib/auto-episode-storyboards-client";
import {
  clearRealMediaPending,
  readRealMediaPending,
  rememberRealMediaPending,
  type RealMediaPending,
} from "../lib/real-media-client";
import { ScriptBreakdownClient } from "../lib/script-breakdown-client";
import { WORKBENCH_DRAFTS_CLEARED_EVENT } from "../lib/script-workbench-drafts";
import { ApiError } from "../lib/studio-client";
import { HoverMediaPreview } from "./hover-media-preview";
import styles from "./auto-creation.module.css";
import writing from "./title-writing.module.css";

const client = createAutoEpisodeStoryboardsClient();
const breakdown = new ScriptBreakdownClient();
const SCALE = 100_000_000n;
const storageWarning = "原请求记录无法核对，当前暂停生成。";
const safeRefusal = new Set([
  "REAL_MEDIA_QUOTE_EXPIRED", "REAL_MEDIA_INPUT_CHANGED", "REAL_MEDIA_CONFIGURATION_CHANGED",
  "REAL_MEDIA_UNCERTAIN_CHANGED", "REAL_MEDIA_AUTHORIZATION_INVALID", "REAL_MEDIA_BUDGET_MISMATCH",
  "AUTO_STORYBOARD_SOURCE_NOT_READY", "AUTO_STORYBOARD_SHOT_BUSY", "AUTO_STORYBOARD_SELECTION_UNAVAILABLE",
]);

export interface AutoEpisodeStoryboardActions {
  episodeAction: (episodeNo: number) => ReactNode;
  allAction: ReactNode;
}
interface Props {
  projectId: string;
  runId: string;
  autoQuote: boolean;
  refreshKey?: string | number;
  scopeEpisodeNo?: number;
  children?: (actions: AutoEpisodeStoryboardActions) => ReactNode;
}
interface QuoteRow {
  episodeNo: number;
  shot: AutoStoryboardShot;
  quote: RealMediaQuote | null;
  detail?: string;
}
type Target = { episode: AutoStoryboardEpisode; shot: AutoStoryboardShot };

function units(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(8, "0"));
}

function format(value: bigint): string {
  const fractional = (value % SCALE).toString().padStart(8, "0").replace(/0+$/, "");
  return (value / SCALE).toString() + (fractional ? `.${fractional}` : "");
}

function paidQuote(quote: RealMediaQuote): boolean {
  const estimate = units(quote.estimatedAmount);
  return quote.currency === "USD" && quote.estimateBasis === undefined && !quote.uncertainJobIds?.length
    && estimate > 0n && estimate <= units(quote.maximumAmount) && Date.parse(quote.expiresAt) > Date.now();
}

function episodesIn(view: AutoStoryboardView, scopeEpisodeNo: number | undefined): AutoStoryboardEpisode[] {
  return scopeEpisodeNo === undefined ? view.episodes : view.episodes.filter((ep) => ep.episodeNo === scopeEpisodeNo);
}

function reasonText(caught: unknown, fallback: string): string {
  return caught instanceof ApiError ? caught.detail : fallback;
}

function awaitingAuthorization(request: RealMediaPending | null | undefined, runId: string): request is RealMediaPending {
  // The authorization ID is saved before generate is called, so only this stage can be replayed here.
  return request?.autoStoryboard?.runId === runId && request.authorizationId === null;
}

export function AutoEpisodeStoryboards(props: Props) {
  return <StoryboardScope key={`${props.projectId}:${props.runId}:${props.scopeEpisodeNo ?? ""}`} {...props} />;
}

function StoryboardScope({ projectId, runId, autoQuote, scopeEpisodeNo, refreshKey, children }: Props) {
  const [view, setView] = useState<AutoStoryboardView | null>(null);
  const [failure, setFailure] = useState("");
  const [readFailure, setReadFailure] = useState("");
  const [readTick, setReadTick] = useState(0);
  const [quoteReview, setQuoteReview] = useState<{ rows: QuoteRow[]; allEpisodes: boolean } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(new Map<string, RealMediaPending | null>());
  const [accepted, setAccepted] = useState(new Map<string, string>());
  const [breakdownStatus, setBreakdownStatus] = useState("");
  const autoStarted = useRef(false);
  const inAction = useRef<object | null>(null);
  const active = useRef(true);
  const currentView = useRef<AutoStoryboardView | null>(null);
  const acceptedRef = useRef(new Map<string, string>());
  const quoteHeading = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  const quoteId = useId();

  useEffect(() => {
    active.current = true;
    function signOut() {
      active.current = false;
      inAction.current = null;
      currentView.current = null;
      setView(null);
      setQuoteReview(null);
    }
    window.addEventListener(WORKBENCH_DRAFTS_CLEARED_EVENT, signOut);
    return () => {
      active.current = false;
      inAction.current = null;
      window.removeEventListener(WORKBENCH_DRAFTS_CLEARED_EVENT, signOut);
    };
  }, []);

  const reread = useCallback(() => setReadTick((current) => current + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let follow = autoQuote;
    function live() { return active.current && !controller.signal.aborted; }
    async function load() {
      try {
        const result = await client.read(projectId, runId, controller.signal);
        if (!live()) return;
        const local = new Map<string, RealMediaPending | null>();
        const tracked = new Map(acceptedRef.current);
        for (const episode of episodesIn(result, scopeEpisodeNo)) {
          for (const shot of episode.shots) {
            const key = shot.shotRevisionId;
            if (shot.jobId && tracked.get(key) === shot.jobId) tracked.delete(key);
            try {
              const record = readRealMediaPending(projectId, key);
              if (!record) continue;
              const owner = record.autoStoryboard;
              if (owner?.runId === runId && shot.jobId && shot.quoteId === record.quote.quoteId
                && clearRealMediaPending(record)) continue;
              local.set(key, record);
            } catch { local.set(key, null); }
          }
        }
        acceptedRef.current = tracked;
        currentView.current = result;
        setAccepted(tracked);
        setPending(local);
        setView(result);
        setReadFailure("");
        const waiting = autoQuote && !autoStarted.current && result.imageAvailable && result.selectionAvailable;
        const working = episodesIn(result, scopeEpisodeNo).some((episode) => episode.shots.some((shot) => shot.state === "queued"));
        follow = waiting || working || local.size > 0 || tracked.size > 0;
        if (follow) timer = setTimeout(() => void load(), 3_000);
      } catch (caught) {
        if (live()) {
          setReadFailure(reasonText(caught, "暂时无法读取分镜图状态。"));
          if (follow || acceptedRef.current.size) timer = setTimeout(() => void load(), 5_000);
        }
      }
    }
    void load();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [projectId, runId, scopeEpisodeNo, autoQuote, readTick, refreshKey]);

  const episodes = view ? episodesIn(view, scopeEpisodeNo) : [];
  const hasUndecomposed = episodes.some((episode) => episode.blocked === "shots_not_ready");
  useEffect(() => {
    if (!hasUndecomposed) return;
    let live = true;
    void breakdown.options().then((options) => {
      if (!live) return;
      if (options.code === "TITLE_WRITING_DISABLED") setBreakdownStatus("当前未开启 AI 剧本拆解。");
      else if (options.code === "SCRIPT_BREAKDOWN_STORAGE_UNAVAILABLE") setBreakdownStatus("剧本拆解的数据存储还没有就绪。");
      else if (options.code === "TITLE_WRITING_PROVIDER_UNCONFIGURED") setBreakdownStatus("当前没有可用的文本模型，暂不能拆解。");
      else if (options.code === "TITLE_WRITING_FORBIDDEN") setBreakdownStatus("请由有权限的人在工作台确认拆解。");
      else if (!options.enabled) setBreakdownStatus("请在工作台检查 AI 剧本拆解的配置。");
      else setBreakdownStatus("");
    }).catch(() => {
      if (live) setBreakdownStatus("暂时无法读取剧本拆解配置。");
    });
    return () => { live = false; };
  }, [hasUndecomposed]);

  const available = !!(view?.imageAvailable && view.selectionAvailable && !readFailure);
  const ready = episodes.filter((episode) => !episode.blocked).flatMap((episode) => episode.shots
    .filter((shot) => shot.state === "ready" && !pending.has(shot.shotRevisionId) && !accepted.has(shot.shotRevisionId))
    .map((shot) => ({ episode, shot })));

  function begin() {
    if (!active.current || inAction.current) return null;
    const operation = {};
    inAction.current = operation;
    setBusy(true);
    setFailure("");
    return operation;
  }
  function end(operation: object) {
    if (inAction.current !== operation) return;
    inAction.current = null;
    setBusy(false);
  }

  async function requestQuotes(targets: Target[], allEpisodes = false) {
    if (!available || targets.length === 0) return;
    const operation = begin();
    if (!operation) return;
    setQuoteReview(null);
    setConfirm(false);
    const rows: QuoteRow[] = [];
    try {
      for (const { episode, shot } of targets) {
        if (inAction.current !== operation) return;
        if (episode.blocked || !["ready", "failed"].includes(shot.state)) continue;
        const label = { episodeNo: episode.episodeNo, shot };
        try {
          if (readRealMediaPending(projectId, shot.shotRevisionId)) {
            rows.push({ ...label, quote: null, detail: "有未确认的原请求，已跳过。" });
            continue;
          }
        } catch {
          rows.push({ ...label, quote: null, detail: storageWarning });
          continue;
        }
        try {
          const quote = await client.quote(projectId, runId, shot.shotRevisionId);
          rows.push(paidQuote(quote) ? { ...label, quote } : {
            ...label, quote: null, detail: "报价不可核实或存在结果未知任务，已跳过。",
          });
        } catch (caught) {
          rows.push({ ...label, quote: null, detail: reasonText(caught, "暂时无法取得报价，已跳过。") });
        }
      }
      if (inAction.current === operation) setQuoteReview({ rows, allEpisodes });
    } finally { end(operation); }
  }

  useEffect(() => {
    if (!autoQuote || autoStarted.current || inAction.current || !available || !ready.length
      || view?.episodes.some((episode) => episode.blocked || episode.shots.some((shot) =>
        shot.state === "queued" || shot.state === "unknown" || pending.has(shot.shotRevisionId)))) return;
    autoStarted.current = true;
    void requestQuotes(ready);
  });

  useEffect(() => {
    if (quoteReview) quoteHeading.current?.focus();
  }, [quoteReview]);

  const payable = quoteReview?.rows.flatMap((row) => row.quote ? [{ ...row, quote: row.quote }] : []) ?? [];
  const total = format(payable.reduce((sum, row) => sum + units(row.quote.estimatedAmount), 0n));

  async function submitConfirmedShot(original: RealMediaPending, operation: object) {
    let request = original;
    try {
      const authorizationId = await client.authorize(projectId, request.quote, request.maximumAmount, request.key);
      if (inAction.current !== operation) return;
      const authorized = { ...request, authorizationId };
      rememberRealMediaPending(authorized);
      request = authorized;
      const receipt = await client.generate(projectId, request.shotRevisionId, request.quote.quoteId, authorizationId, request.key);
      if (!active.current) return;
      const tracked = new Map(acceptedRef.current).set(request.shotRevisionId, receipt.jobId);
      acceptedRef.current = tracked;
      setAccepted(tracked);
      clearRealMediaPending(request);
    } catch (caught) {
      if (!active.current) return;
      if (caught instanceof ApiError && [409, 422].includes(caught.status) && safeRefusal.has(caught.code)) {
        try { clearRealMediaPending(request); } catch { /* Retain the existing request to avoid duplicate dispatch. */ }
        setFailure(caught.detail);
        return;
      }
      setPending((current) => new Map(current).set(request.shotRevisionId, request));
      setFailure(request.authorizationId === null ? "费用授权尚未核实。可以继续上次授权。" : "部分镜头提交结果待核实。可刷新查看原任务。");
    }
  }

  async function submit() {
    if (!available || !confirm || !payable.length) return;
    const operation = begin();
    if (!operation) return;
    setQuoteReview(null);
    setConfirm(false);
    try {
      for (const row of payable) {
        if (inAction.current !== operation) return;
        const latest = currentView.current;
        const current = latest?.episodes.find((episode) => episode.episodeNo === row.episodeNo);
        const shot = current?.shots.find((item) => item.shotRevisionId === row.shot.shotRevisionId);
        if (!latest?.imageAvailable || !latest.selectionAvailable || !current || current.blocked
          || !shot || shot.state !== row.shot.state || shot.jobId !== row.shot.jobId
          || !paidQuote(row.quote)) {
          setFailure("镜头状态或报价已变化，请刷新后重新报价。");
          continue;
        }
        const request: RealMediaPending = {
          schema: "ads.real-media.pending.v1", projectId, shotRevisionId: shot.shotRevisionId,
          key: crypto.randomUUID(), quote: row.quote, maximumAmount: row.quote.estimatedAmount, authorizationId: null,
          autoStoryboard: { runId },
        };
        try {
          if (readRealMediaPending(projectId, shot.shotRevisionId)) throw new Error(storageWarning);
          rememberRealMediaPending(request);
        } catch {
          setFailure(storageWarning);
          continue;
        }
        await submitConfirmedShot(request, operation);
      }
    } finally {
      if (inAction.current === operation) reread();
      end(operation);
    }
  }

  async function recoverAuthorization(episodeNo: number, original: RealMediaPending) {
    const operation = begin();
    if (!operation) return;
    autoStarted.current = true;
    try {
      const latest = await client.read(projectId, runId, new AbortController().signal);
      if (inAction.current !== operation) return;
      const saved = readRealMediaPending(projectId, original.shotRevisionId);
      if (!awaitingAuthorization(saved, runId) || saved.key !== original.key || saved.quote.quoteId !== original.quote.quoteId) return;
      const episode = latest.episodes.find((item) => item.episodeNo === episodeNo);
      const shot = episode?.shots.find((item) => item.shotRevisionId === saved.shotRevisionId);
      if (shot?.jobId && shot.quoteId === saved.quote.quoteId) return;
      if (Date.parse(saved.quote.expiresAt) <= Date.now()) {
        setFailure(clearRealMediaPending(saved) ? "上次报价已过期，尚未提交出图。请重新报价。" : storageWarning);
        return;
      }
      if (!latest.imageAvailable || !latest.selectionAvailable || !episode || episode.blocked || !shot
        || (shot.state !== "ready" && shot.state !== "failed") || !paidQuote(saved.quote)
        || saved.maximumAmount !== saved.quote.estimatedAmount) {
        setFailure("当前镜头状态或原报价无法核对，暂时不能继续上次授权。");
        return;
      }
      await submitConfirmedShot(saved, operation);
    } catch (caught) {
      if (inAction.current === operation) setFailure(reasonText(caught, "暂时无法核对上次授权。"));
    } finally {
      if (inAction.current === operation) reread();
      end(operation);
    }
  }

  async function keep(episode: AutoStoryboardEpisode, shot: AutoStoryboardShot) {
    const assetId = shot.previewAssetId;
    if (!view?.selectionAvailable || readFailure || episode.blocked || !assetId || assetId === shot.keptAssetId
      || (shot.state !== "generated" && shot.state !== "kept")) return;
    const operation = begin();
    if (!operation) return;
    try {
      await client.keep(projectId, runId, shot, assetId, crypto.randomUUID());
      if (inAction.current === operation) setView((previous) => previous && ({
        ...previous, episodes: previous.episodes.map((item) => item.episodeNo !== episode.episodeNo ? item : {
          ...item, shots: item.shots.map((candidate) => candidate.shotRevisionId !== shot.shotRevisionId
            ? candidate : { ...candidate, keptAssetId: assetId, state: "kept" }),
        }),
      }));
    } catch (caught) {
      if (inAction.current === operation) setFailure(reasonText(caught, "选用结果待核实，请刷新查看。"));
    } finally {
      if (inAction.current === operation) reread();
      end(operation);
    }
  }

  const openQuote = (targets: Target[], allEpisodes = false) => {
    autoStarted.current = true;
    void requestQuotes(targets, allEpisodes);
  };
  const allAction = <button className={writing.secondary} type="button" disabled={busy || !available || !ready.length}
    onClick={() => openQuote(ready, true)}>为全部集生成分镜头</button>;
  const episodeAction = (episodeNo: number) => {
    const targets = ready.filter((row) => row.episode.episodeNo === episodeNo);
    return <button className={writing.secondary} type="button" disabled={busy || !available || !targets.length}
      onClick={() => openQuote(targets)}>生成这一集的分镜头</button>;
  };

  return <>
    {children?.({ episodeAction, allAction })}
    <section className={styles.section} aria-labelledby={headingId} aria-busy={busy} data-testid="auto-episode-storyboards">
      <h2 id={headingId} className={writing.sectionTitle}>分镜图</h2>
      {!view && !readFailure ? <p role="status">正在读取分镜图状态…</p> : null}
      {busy ? <p role="status">正在处理当前分镜图操作…</p> : null}
      {readFailure ? <p className={writing.warning} role="alert">{readFailure}</p> : null}
      {failure ? <p className={writing.warning} role="alert">{failure}</p> : null}
      {view && !view.imageAvailable ? <p>还没有接通 OpenAI 生图，不能生成分镜头</p> : null}
      {view && !view.selectionAvailable ? <p>当前未启用分镜图选用，生成暂停。</p> : null}
      {view ? <p className={writing.helper}>{view.characterReferencesAvailable
        ? "建议先定好角色外形，出图时会带入人物设定文字。"
        : "定妆图暂不可用，将按人物设定文字保持一致。"}</p> : null}
      {view ? <p className={writing.helper}>实际费用尚未核实</p> : null}
      <div className={writing.actions}>
        {!children ? allAction : null}
        {(view || readFailure) ? <button className={writing.textLink} type="button" disabled={busy} onClick={reread}>刷新分镜图状态</button> : null}
      </div>
      {quoteReview ? (
        <section className={writing.config} aria-labelledby={quoteId}>
          <h3 id={quoteId} ref={quoteHeading} tabIndex={-1}>确认分镜图报价</h3>
          {payable.length
            ? <p>预计生成 {payable.length} 张图，每镜一张。合计估算 <strong>{total} USD</strong>。实际费用尚未核实。</p>
            : <p>当前没有可确认的报价，尚未提交生成。</p>}
          <ul className={styles.list}>
            {quoteReview.rows.map((row) => <li key={row.shot.shotRevisionId}>
              第 {row.episodeNo} 集 · {row.shot.caption} · {row.quote ? `${row.quote.estimatedAmount} USD` : row.detail}
            </li>)}
            {quoteReview.allEpisodes ? episodes.filter((episode) => episode.blocked).map((episode) => <li key={episode.episodeNo}>
              第 {episode.episodeNo} 集已跳过。{storyboardGate[episode.blocked!]}
            </li>) : null}
          </ul>
          {payable.length ? <label className={writing.check}>
            <input type="checkbox" checked={confirm} disabled={busy} onChange={(event) => setConfirm(event.target.checked)} />
            确认按上述额度生成分镜图
          </label> : null}
          <div className={writing.actions}>
            <button type="button" className={writing.secondary} disabled={busy} onClick={() => setQuoteReview(null)}>返回</button>
            {payable.length ? <button type="button" className={writing.primary} disabled={busy || !available || !confirm}
              onClick={() => void submit()}>确认生成 {payable.length} 镜</button> : null}
          </div>
        </section>
      ) : null}
      {episodes.map((episode) => (
        <section className={styles.episodePanel} key={episode.episodeNo}>
          <h3>第 {episode.episodeNo} 集分镜图</h3>
          {!children ? episodeAction(episode.episodeNo) : null}
          {episode.blocked ? <p>{storyboardGate[episode.blocked]}</p> : null}
          {episode.blocked === "shots_not_ready" || episode.blocked === "shot_source_stale" || episode.blocked === "script_review_required" ? (
            <>
              <a className={writing.textLink} href={`/projects/${projectId}?focus=script&episode=${episode.episodeNo}#script-breakdown`}>打开第 {episode.episodeNo} 集工作台</a>
              {episode.blocked === "shots_not_ready" ? <p className={writing.helper}>
                {breakdownStatus || "AI 拆解会发出一次文本模型调用，需在工作台手动确认。"}
              </p> : null}
            </>
          ) : null}
          <ol className={styles.episodeFacts}>
            {episode.shots.map((shot, index) => {
              const waiting = pending.has(shot.shotRevisionId);
              const request = pending.get(shot.shotRevisionId);
              const canRecover = awaitingAuthorization(request, runId);
              const submitted = accepted.has(shot.shotRevisionId);
              const eligible = available && !episode.blocked && !waiting && !submitted;
              return <li className={styles.episodePanel} key={shot.shotRevisionId}>
                <p className={writing.helper}>第 {episode.episodeNo} 集 · 第 {index + 1} 镜，共 {episode.shots.length} 镜</p>
                <h4>{shot.caption}</h4>
                <p>{canRecover ? "费用授权待核实，尚未提交出图。" : waiting ? "提交结果待核实" : submitted ? "任务已受理，等待核实状态" : storyboardShotStatus[shot.state]}</p>
                {canRecover ? <>
                  <p className={writing.helper}>继续后使用原报价 {request.maximumAmount} USD，确认授权后才提交这一镜。</p>
                  <button className={writing.textLink} disabled={busy || !!readFailure} type="button"
                    onClick={() => void recoverAuthorization(episode.episodeNo, request)}>继续上次授权 {shot.caption}</button>
                </> : null}
                {shot.keptAssetId && shot.state !== "kept" ? <p>已保留上一张图</p> : null}
                {shot.keptAssetId && shot.keptAssetId !== shot.previewAssetId ? <HoverMediaPreview kind="image"
                  src={`/api/v1/real-media/assets/${shot.keptAssetId}/content`} label={`已保留 · ${shot.caption}`} /> : null}
                {shot.previewAssetId ? <HoverMediaPreview kind="image"
                  src={`/api/v1/real-media/assets/${shot.previewAssetId}/content`} label={`分镜图 · ${shot.caption}`} /> : null}
                {eligible && shot.state === "ready" ? <button className={writing.textLink} disabled={busy} type="button"
                  onClick={() => openQuote([{ episode, shot }])}>生成本镜 {shot.caption}</button> : null}
                {eligible && shot.state === "failed" ? <button className={writing.textLink} disabled={busy} type="button"
                  onClick={() => openQuote([{ episode, shot }])}>重试本镜 {shot.caption}</button> : null}
                {view?.selectionAvailable && !readFailure && !episode.blocked && (shot.state === "generated" || shot.state === "kept")
                  && shot.previewAssetId !== null && shot.previewAssetId !== shot.keptAssetId ? <button className={writing.textLink} disabled={busy}
                    type="button" aria-label={`保留本图 ${shot.caption}`} onClick={() => void keep(episode, shot)}>保留</button> : null}
              </li>;
            })}
          </ol>
        </section>
      ))}
    </section>
  </>;
}
