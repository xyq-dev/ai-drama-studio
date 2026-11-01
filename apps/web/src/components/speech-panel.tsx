"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  SpeechBinding, SpeechCapabilities, SpeechMixPreflight, SpeechPlanLineInput, SpeechPlanView,
  SpeechQuote, SpeechTakesPage,
} from "@ai-drama/contracts";
import { ApiError } from "../lib/studio-client";
import { clearSpeechPending, createSpeechClient, readSpeechPending, SpeechJournalError, writeSpeechPending,
  type SpeechClient, type SpeechPendingSubmission, type SpeechVoiceImpact } from "../lib/speech-api";

export interface SpeechCharacter { id: string; name: string }
export interface SpeechPanelProps {
  projectId: string;
  shotRevisionId: string;
  dialogue?: string | null;
  characters?: SpeechCharacter[];
  videoAssetId?: string | null;
  musicAssetId?: string | null;
  budgetAuthorizationId?: string;
  refreshEpoch?: number;
  client?: SpeechClient;
  onJobAccepted?: (projectId: string) => void;
  onChanged?: () => void;
  onPreflight?: (value: SpeechMixPreflight | null) => void;
}

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELED"]);
const JOB_LABEL: Record<string, string> = { PENDING: "等待开始", QUEUED: "等待配音", RUNNING: "正在生成本句", WAITING_EXTERNAL: "正在核实服务商结果", SUCCEEDED: "生成完成，请试听后选用", FAILED: "本句生成失败", CANCELED: "本次任务已取消" };
const EMPTY_TAKES: SpeechTakesPage = { items: [], selected: [], hasMore: false, rowVersion: 0 };
const AMOUNT = /^(0|[1-9]\d{0,7})(\.\d{1,8})?$/;
interface SpeechCostConfirmation { lineId: string; quoteId: string; inputHash: string; maximumAmount: string; confirmed: boolean; confirmedUncertain: boolean }

/** A scope key makes an A → B → A switch discard every previous read and operation. */
export function SpeechPanel(props: SpeechPanelProps) {
  const submissions = useRef(new Map<string, SpeechPendingSubmission>());
  return <SpeechPanelScope key={`${props.projectId}:${props.shotRevisionId}`} {...props} submissions={submissions.current} />;
}

function SpeechPanelScope(props: SpeechPanelProps & { submissions: Map<string, SpeechPendingSubmission> }) {
  const fallback = useRef<SpeechClient | null>(null);
  if (!fallback.current) fallback.current = createSpeechClient();
  const client = props.client ?? fallback.current;
  const mounted = useRef(true);
  const read = useRef(0);
  const scope = useRef(0);
  const latestPlan = useRef<SpeechPlanView | null>(null);
  const operation = useRef(0);
  const mixGeneration = useRef(0);
  const auxiliaryReads = useRef(new Set<AbortController>());
  const keys = useRef(new Map<string, string>());
  const player = useRef<HTMLAudioElement | null>(null);
  const preflightChanged = useRef(props.onPreflight);
  preflightChanged.current = props.onPreflight;
  const accepted = useRef(props.onJobAccepted);
  accepted.current = props.onJobAccepted;
  const [capabilities, setCapabilities] = useState<SpeechCapabilities | null>(null);
  const [bindings, setBindings] = useState<SpeechBinding[]>([]);
  const [plan, setPlan] = useState<SpeechPlanView | null>(null);
  const [lines, setLines] = useState<SpeechPlanLineInput[]>([]);
  const [dirty, setDirty] = useState(false);
  const [takes, setTakes] = useState<SpeechTakesPage>(EMPTY_TAKES);
  const [voiceDrafts, setVoiceDrafts] = useState<Record<string, string>>({});
  const [impact, setImpact] = useState<{ speakerId: string; voiceId: string; value: SpeechVoiceImpact } | null>(null);
  const scopeKey = `${props.projectId}:${props.shotRevisionId}`;
  const remembered = props.submissions.get(scopeKey);
  const [quotes, setQuotes] = useState<Record<string, SpeechQuote>>(remembered ? { [remembered.lineId]: remembered.quote } : {});
  const [costConfirmation, setCostConfirmation] = useState<SpeechCostConfirmation | null>(remembered ? {
    lineId: remembered.lineId, quoteId: remembered.quote.quoteId, inputHash: remembered.quote.inputHash,
    maximumAmount: remembered.maximumAmount, confirmed: true, confirmedUncertain: true,
  } : null);
  const [pendingSubmission, setPendingSubmission] = useState<SpeechPendingSubmission | null>(remembered ?? null);
  const [journalReady, setJournalReady] = useState(false);
  const [journalError, setJournalError] = useState<string | null>(null);
  const [job, setJob] = useState<{ id: string; lineId: string; state: string; errorMessage?: string | null } | null>(null);
  const [listening, setListening] = useState<string | null>(null);
  const [mix, setMix] = useState<SpeechMixPreflight | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  latestPlan.current = plan;
  const source = plan?.sourceDialogue ?? props.dialogue ?? "";

  const load = useCallback(async (signal?: AbortSignal) => {
    const token = ++read.current;
    try {
      const catalogRead = client.capabilities(props.projectId, signal).then((catalog) => {
        if (mounted.current && token === read.current && !signal?.aborted) setCapabilities(catalog);
        return catalog;
      });
      const [catalog, bindingPage, currentPlan] = await Promise.all([
        catalogRead, client.bindings(props.projectId, signal), client.plan(props.shotRevisionId, signal),
      ]);
      const candidates = currentPlan.currentRevision ? await client.takes(currentPlan.currentRevision.id, signal) : EMPTY_TAKES;
      if (!mounted.current || token !== read.current || signal?.aborted) return;
      setCapabilities(catalog);
      setBindings(bindingPage.items);
      setPlan(currentPlan);
      setTakes(candidates);
      setLines(currentPlan.currentRevision?.lines.map(lineInput) ?? []);
      setVoiceDrafts(Object.fromEntries(bindingPage.items.map((item) => [item.speakerId, item.currentRevision.catalogVoiceId])));
      setDirty(false);
      if (!props.submissions.has(scopeKey)) { setQuotes({}); setCostConfirmation(null); }
      mixGeneration.current += 1;
      setMix(null);
      preflightChanged.current?.(null);
      setError(null);
      setLoading(false);
    } catch (caught) {
      if (!mounted.current || token !== read.current || signal?.aborted) return;
      setError(message(caught, "配音信息读取失败，请重新读取"));
      setLoading(false);
    }
  }, [client, props.projectId, props.shotRevisionId, props.submissions, scopeKey]);

  useEffect(() => {
    mounted.current = true;
    setBusy(false);
    const abort = new AbortController();
    void load(abort.signal);
    return () => {
      mounted.current = false;
      read.current += 1;
      operation.current += 1;
      scope.current += 1;
      abort.abort();
      for (const pending of auxiliaryReads.current) pending.abort();
      auxiliaryReads.current.clear();
      player.current?.pause();
    };
  }, [load, props.refreshEpoch]);

  useEffect(() => {
    try {
      const stored = readSpeechPending(props.projectId, props.shotRevisionId);
      if (stored) {
        const restored = { ...stored, unknown: true };
        props.submissions.set(scopeKey, restored);
        setPendingSubmission(restored);
        setQuotes({ [stored.lineId]: stored.quote });
        setCostConfirmation({ lineId: stored.lineId, quoteId: stored.quote.quoteId, inputHash: stored.quote.inputHash,
          maximumAmount: stored.maximumAmount, confirmed: true, confirmedUncertain: true });
      } else { props.submissions.delete(scopeKey); setPendingSubmission(null); clearQuotes(); }
      setJournalError(null); setJournalReady(true);
    } catch (caught) { setJournalError(message(caught, "无法读取本次配音请求记录")); setJournalReady(false); }
  }, [props.projectId, props.shotRevisionId, props.submissions, scopeKey]);

  useEffect(() => {
    if (!pendingSubmission?.jobId) return;
    const owner = scope.current;
    void recoverKnownJob(pendingSubmission).catch((caught: unknown) => {
      if (isCurrent(owner)) setError(message(caught, "原任务暂时无法确认，请继续读取原任务"));
    });
    // A known acknowledged Job is always recovered by reading it, never by sending another generation.
  }, [pendingSubmission?.jobId, client]);

  useEffect(() => {
    mixGeneration.current += 1;
    setMix(null);
    preflightChanged.current?.(null);
  }, [props.videoAssetId, props.musicAssetId]);

  useEffect(() => {
    if (!job || TERMINAL.has(job.state)) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      if (document.visibilityState === "hidden") { timer = setTimeout(() => void poll(), 1500); return; }
      try {
        const next = await client.job(job!.id, abort.signal);
        if (!mounted.current || abort.signal.aborted) return;
        setJob((current) => current?.id === job!.id ? { ...current, ...next } : current);
        if (TERMINAL.has(next.state)) {
          if (next.state === "SUCCEEDED") {
            const revisionId = latestPlan.current?.currentRevision?.id;
            if (revisionId) {
              const nextTakes = await client.takes(revisionId, abort.signal);
              if (mounted.current && !abort.signal.aborted && latestPlan.current?.currentRevision?.id === revisionId) setTakes(nextTakes);
            }
            if (mounted.current && !abort.signal.aborted) props.onChanged?.();
          }
          return;
        }
      } catch (caught) {
        if (!mounted.current || abort.signal.aborted) return;
        setError(message(caught, "任务读取失败；不会重新生成，请刷新任务"));
        return;
      }
      timer = setTimeout(() => void poll(), 1500);
    }
    timer = setTimeout(() => void poll(), 1000);
    return () => { abort.abort(); if (timer) clearTimeout(timer); };
  }, [client, job?.id, job?.state, load, props.onChanged]);

  function invalidateMix() { mixGeneration.current += 1; setMix(null); preflightChanged.current?.(null); }

  function clearQuotes() { setQuotes({}); setCostConfirmation(null); }

  function rememberSubmission(value: SpeechPendingSubmission) {
    writeSpeechPending(value);
    props.submissions.set(scopeKey, value);
    if (mounted.current) { setPendingSubmission(value); setJournalError(null); setJournalReady(true); }
  }

  function acknowledgeSubmission(value: SpeechPendingSubmission) {
    if (!clearSpeechPending(value)) return false;
    if (props.submissions.get(scopeKey)?.key === value.key) props.submissions.delete(scopeKey);
    if (mounted.current) setPendingSubmission((current) => current?.key === value.key ? null : current);
    return true;
  }

  async function recoverKnownJob(submission: SpeechPendingSubmission) {
    if (!submission.jobId) return;
    const owner = scope.current;
    const result = await auxiliaryRead((signal) => client.job(submission.jobId!, signal));
    if (result.id !== submission.jobId || !JOB_LABEL[result.state]) throw new ApiError(502, "INVALID_RESPONSE", "原配音任务回执无法核对，请继续读取原任务");
    const acknowledged = { ...submission, unknown: false };
    rememberSubmission(acknowledged);
    const cleared = acknowledgeSubmission(acknowledged);
    if (!isCurrent(owner)) return;
    setJob({ ...result, lineId: submission.lineId });
    if (cleared) clearQuotes();
    accepted.current?.(props.projectId);
  }

  function isCurrent(owner: number) { return mounted.current && owner === scope.current; }

  async function auxiliaryRead<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const abort = new AbortController();
    auxiliaryReads.current.add(abort);
    try { return await work(abort.signal); } finally { auxiliaryReads.current.delete(abort); }
  }

  function key(identity: string) {
    const existing = keys.current.get(identity);
    if (existing) return existing;
    const next = crypto.randomUUID();
    keys.current.set(identity, next);
    return next;
  }

  async function act(work: () => Promise<void>) {
    const token = ++operation.current;
    setBusy(true); setError(null); setNotice(null);
    try { await work(); } catch (caught) {
      if (mounted.current && token === operation.current) {
        setError(message(caught, "配音操作没有完成"));
        if (caught instanceof SpeechJournalError) { setJournalError(caught.message); setJournalReady(false); }
      }
    } finally { if (mounted.current && token === operation.current) setBusy(false); }
  }

  function editLine(lineId: string, patch: Partial<SpeechPlanLineInput>) {
    operation.current += 1;
    setLines((current) => current.map((line) => {
      if (line.lineId !== lineId) return line;
      const next = { ...line, ...patch };
      if (patch.speakerBindingRevisionId) {
        const voice = bindings.find((binding) => binding.currentRevision.id === patch.speakerBindingRevisionId)?.currentRevision;
        if (voice) {
          if (!voice.capabilities.emotions.includes(next.emotion)) next.emotion = voice.capabilities.emotions[0]!;
          next.speed = Math.min(voice.capabilities.speedMax, Math.max(voice.capabilities.speedMin, next.speed));
        }
      }
      return { ...next, displayText: source.slice(next.sourceStart, next.sourceEnd) };
    }));
    setDirty(true); clearQuotes(); invalidateMix(); setNotice(null); setError(null);
  }

  async function saveVoice(speakerId: string, confirmed = false) {
    const owner = scope.current;
    const catalogVoiceId = voiceDrafts[speakerId];
    if (!capabilities || !catalogVoiceId) return;
    const binding = bindings.find((item) => item.speakerId === speakerId);
    if (binding && !confirmed) {
      const value = await auxiliaryRead((signal) => client.voiceImpact(props.projectId, speakerId, signal));
      if (isCurrent(owner)) setImpact({ speakerId, voiceId: catalogVoiceId, value });
      return;
    }
    if (confirmed && (!impact || impact.speakerId !== speakerId || impact.voiceId !== catalogVoiceId)) return;
    const body = { catalogVersion: capabilities.catalogVersion, catalogVoiceId,
      ...(confirmed && impact ? { expectedImpactHash: impact.value.inputHash } : {}) };
    await client.saveBinding(props.projectId, speakerId, body, { key: key(`voice:${speakerId}:${binding?.rowVersion ?? 0}:${JSON.stringify(body)}`), ifMatch: binding?.rowVersion ?? 0 });
    if (!isCurrent(owner)) return;
    setImpact(null); clearQuotes(); invalidateMix();
    await load();
    if (isCurrent(owner)) { setNotice("角色声音已保存；请确认受影响的台词计划"); props.onChanged?.(); }
  }

  async function savePlan() {
    const owner = scope.current;
    if (!plan) return;
    const body = { sourceDialogueHash: plan.sourceDialogueHash, lines: lines.map(lineInput), timingPolicy: "sequential-reject-overflow" as const };
    const next = await client.savePlan(props.shotRevisionId, body, { key: key(`plan:${plan.rowVersion}:${JSON.stringify(body)}`), ifMatch: plan.rowVersion });
    if (!isCurrent(owner)) return;
    setPlan(next); setLines(next.currentRevision?.lines.map(lineInput) ?? []); setDirty(false); invalidateMix(); clearQuotes();
    const nextTakes = next.currentRevision ? await auxiliaryRead((signal) => client.takes(next.currentRevision!.id, signal)) : EMPTY_TAKES;
    if (!isCurrent(owner)) return;
    setTakes(nextTakes);
    if (isCurrent(owner)) { setNotice("台词计划已确认"); props.onChanged?.(); }
  }

  async function quoteLine(lineId: string) {
    const owner = scope.current;
    if (!plan?.currentRevision || dirty) return;
    const value = await client.quote(plan.currentRevision.id, lineId);
    if (isCurrent(owner)) {
      setQuotes({ [lineId]: value });
      setCostConfirmation({ lineId, quoteId: value.quoteId, inputHash: value.inputHash, maximumAmount: value.maximumAmount, confirmed: false, confirmedUncertain: false });
    }
  }

  async function generateLine(lineId: string) {
    const owner = scope.current;
    const quote = quotes[lineId];
    let submission = pendingSubmission;
    if (submission && submission.lineId !== lineId) return;
    if (submission?.jobId) { await recoverKnownJob(submission); return; }
    if (!submission) {
      if (!plan?.currentRevision || !quote || dirty || Date.parse(quote.expiresAt) <= Date.now()
        || !costConfirmation?.confirmed || costConfirmation.lineId !== lineId || costConfirmation.quoteId !== quote.quoteId
        || costConfirmation.inputHash !== quote.inputHash || !AMOUNT.test(costConfirmation.maximumAmount)
        || (quote.uncertainJobIds?.length ?? 0) > 0 && !costConfirmation.confirmedUncertain) return;
      const identity = `generate:${plan.currentRevision.id}:${lineId}:${quote.quoteId}:${quote.inputHash}:${costConfirmation.maximumAmount}`;
      submission = { schema: "speech.browser-submission.v1", projectId: props.projectId, shotRevisionId: props.shotRevisionId,
        planRevisionId: plan.currentRevision.id, lineId, quote, maximumAmount: costConfirmation.maximumAmount,
        key: key(identity), authorizationId: null, jobId: null,
        confirmedUncertainJobIds: [...new Set(quote.uncertainJobIds ?? [])].sort(), unknown: false };
    }
    try {
      const durable = readSpeechPending(props.projectId, props.shotRevisionId);
      if (durable?.key === submission.key) submission = { ...submission,
        authorizationId: durable.authorizationId ?? submission.authorizationId, jobId: durable.jobId ?? submission.jobId };
      if (submission.jobId) { await recoverKnownJob(submission); return; }
      // Persist and verify the exact frozen identity before either operation can create a paid Job.
      rememberSubmission(submission);
      if (!submission.authorizationId) {
        const authorization = await client.authorize(props.projectId, { quoteId: submission.quote.quoteId,
          maximumAmount: submission.maximumAmount, confirmSinglePaidOperation: true,
          confirmedUncertainJobIds: submission.confirmedUncertainJobIds }, { key: submission.key });
        if (authorization.quoteId !== submission.quote.quoteId || !authorization.budgetAuthorizationId) throw new ApiError(502, "INVALID_RESPONSE", "费用确认回执无法核对，请继续确认原请求");
        submission = { ...submission, authorizationId: authorization.budgetAuthorizationId };
        rememberSubmission(submission);
      }
      rememberSubmission(submission);
      const result = await client.generate(submission.planRevisionId, submission.lineId,
        { quoteId: submission.quote.quoteId, budgetAuthorizationId: submission.authorizationId! }, { key: submission.key });
      submission = { ...submission, jobId: result.jobId, unknown: false };
      rememberSubmission(submission);
      accepted.current?.(props.projectId);
      const cleared = acknowledgeSubmission(submission);
      if (!isCurrent(owner)) return;
      if (cleared) clearQuotes();
      setJob({ id: result.jobId, lineId, state: "QUEUED" });
      setNotice("已受理，等待配音；完成后请试听并选用");
    } catch (caught) {
      if (caught instanceof SpeechJournalError) {
        const current = props.submissions.get(scopeKey);
        const retained = { ...submission, unknown: true };
        if (!current || current.key === retained.key) props.submissions.set(scopeKey, retained);
        if (isCurrent(owner)) {
          setPendingSubmission((current) => !current || current.key === retained.key ? retained : current);
          setJournalError(caught.message); setJournalReady(false);
        }
        throw caught;
      }
      const uncertain = !(caught instanceof ApiError) || caught.status >= 500 || caught.status === 0 || caught.code === "INVALID_RESPONSE" || caught.code === "IDEMPOTENCY_IN_PROGRESS";
      if (uncertain) {
        const unknown = { ...submission, unknown: true };
        try { rememberSubmission(unknown); } catch (storageFailure) {
          if (isCurrent(owner)) { setPendingSubmission(unknown); setJournalError(message(storageFailure, "无法保存原配音请求")); setJournalReady(false); }
        }
      } else {
        // A definite rejection acknowledges this exact operation; it must never remove another pending identity.
        acknowledgeSubmission(submission);
        if (caught instanceof ApiError && caught.code === "REAL_MEDIA_UNCERTAIN_CHANGED" && isCurrent(owner)) clearQuotes();
      }
      throw caught;
    }
  }

  async function selectTake(lineId: string, assetId: string, checksum: string) {
    const owner = scope.current;
    if (!plan?.currentRevision || dirty) return;
    const body = { takeAssetId: assetId, expectedTakeChecksumSha256: checksum };
    const expectedVersion = takes.rowVersion || plan.rowVersion;
    const result = await client.select(plan.currentRevision.id, lineId, body, { key: key(`select:${plan.currentRevision.id}:${lineId}:${expectedVersion}:${assetId}:${checksum}`), ifMatch: expectedVersion });
    if (!isCurrent(owner)) return;
    const revisionId = plan.currentRevision.id;
    const next = await auxiliaryRead((signal) => client.takes(revisionId, signal));
    if (!isCurrent(owner)) return;
    setPlan((current) => current ? { ...current, rowVersion: result.rowVersion } : current); setTakes(next); invalidateMix();
    setNotice("已使用这一版；字幕和混音将按所选音频重新检查"); props.onChanged?.();
  }

  async function loadMoreTakes() {
    const owner = scope.current;
    const revisionId = plan?.currentRevision?.id;
    if (!revisionId || !takes.hasMore || !takes.nextCursor) return;
    const next = await auxiliaryRead((signal) => client.takes(revisionId, signal, takes.nextCursor ?? undefined));
    if (!isCurrent(owner) || latestPlan.current?.currentRevision?.id !== revisionId) return;
    setTakes((current) => {
      const ids = new Set(current.items.map((take) => take.assetId));
      return { ...next, items: [...current.items, ...next.items.filter((take) => !ids.has(take.assetId))] };
    });
  }

  async function preflight() {
    const owner = scope.current;
    if (!plan?.currentRevision || !props.videoAssetId || dirty) return;
    const token = ++mixGeneration.current;
    setMix(null); preflightChanged.current?.(null);
    const result = await client.mixPreflight(plan.currentRevision.id, { videoAssetId: props.videoAssetId, musicAssetId: props.musicAssetId ?? null, originalAudio: "mute", musicGain: 0.25, ducking: true });
    if (!isCurrent(owner)) return;
    if (token !== mixGeneration.current) return;
    setMix(result); preflightChanged.current?.(result);
  }

  function audition(assetId: string) {
    const audio = player.current;
    if (!audio) return;
    audio.pause();
    audio.src = `/api/v1/assets/${encodeURIComponent(assetId)}/content`;
    setListening(assetId);
    void audio.play().catch(() => { if (mounted.current) setError("声音暂时无法播放，请重试试听"); });
  }

  const speakers = [...(props.characters ?? []), { id: "narrator", name: "旁白" }];
  for (const binding of bindings) if (!speakers.some((speaker) => speaker.id === binding.speakerId)) speakers.push({ id: binding.speakerId, name: "已配置角色" });
  const activeJob = Boolean(job && !TERMINAL.has(job.state));
  const saved = Boolean(plan?.currentRevision) && !dirty;

  return <section className="mt-5 min-w-0 rounded-xl border border-[#E7E5E0] bg-white p-4 text-[#24232A]" aria-label="角色配音与声音导演">
    <h3 className="text-lg font-medium">角色配音</h3>
    <p className="mt-1 text-sm">给角色选声音，逐句试听后选用，再检查字幕与时长。</p>
    {loading ? <p className="mt-3" role="status">正在读取配音信息</p> : null}
    {capabilities && !capabilities.available ? <p className="mt-3 rounded border p-3" role="status">配音服务尚未开启，可先整理台词。{capabilities.reasonCode ? `（${capabilities.reasonCode}）` : ""}</p> : null}
    {error ? <p className="mt-3 text-sm text-red-700" role="alert">{error}</p> : null}
    {journalError && journalError !== error ? <p className="mt-3 text-sm text-red-700" role="alert">{journalError}</p> : null}
    {notice ? <p className="mt-3 text-sm" role="status">{notice}</p> : null}
    <button className="mt-2 rounded border px-3 py-2 disabled:opacity-50" disabled={busy} type="button" onClick={() => { setLoading(true); void load(); }}>重新读取配音</button>

    <fieldset className="mt-5 space-y-3" disabled={busy || loading || Boolean(pendingSubmission)}>
      <legend className="font-medium">1. 为角色选声音</legend>
      {speakers.map((speaker) => {
        const binding = bindings.find((item) => item.speakerId === speaker.id);
        return <div key={speaker.id} className="rounded-lg border p-3">
          <label className="block text-sm" htmlFor={`voice-${speaker.id}`}>{speaker.name}的声音</label>
          <select id={`voice-${speaker.id}`} className="mt-1 w-full rounded border p-2" value={voiceDrafts[speaker.id] ?? ""} onChange={(event) => { setVoiceDrafts((current) => ({ ...current, [speaker.id]: event.target.value })); setImpact(null); clearQuotes(); }}>
            <option value="">请选择声音</option>
            {(capabilities?.voices ?? []).map((voice) => <option key={voice.catalogVoiceId} value={voice.catalogVoiceId}>{voice.name} · {voice.locale}</option>)}
          </select>
          {binding ? <p className="mt-1 text-sm">已保存：{binding.currentRevision.name}</p> : <p className="mt-1 text-sm">尚未保存声音</p>}
          <button className="mt-2 rounded border px-3 py-2 disabled:opacity-50" type="button" disabled={!voiceDrafts[speaker.id] || voiceDrafts[speaker.id] === binding?.currentRevision.catalogVoiceId || capabilities?.reasonCode === "SPEECH_STORAGE_UNAVAILABLE"} onClick={() => void act(() => saveVoice(speaker.id))}>{binding ? "查看换声影响" : "保存角色声音"}</button>
          {impact?.speakerId === speaker.id ? <div className="mt-2 rounded border p-3" role="status">
            <p>更换声音将影响 {impact.value.affectedLines} 句台词、{impact.value.affectedShots} 个镜头、{impact.value.affectedAssets} 个下游作品。</p>
            <p className="text-sm">确认后需要重新检查这些作品，不会自动生成配音。</p>
            <button className="mt-2 rounded border px-3 py-2" type="button" onClick={() => void act(() => saveVoice(speaker.id, true))}>确认更换声音</button>
            <button className="ml-2 rounded border px-3 py-2" type="button" onClick={() => setImpact(null)}>取消换声</button>
          </div> : null}
        </div>;
      })}
    </fieldset>

    <fieldset className="mt-5 space-y-3" disabled={busy || loading || Boolean(pendingSubmission)}>
      <legend className="font-medium">2. 确认谁说哪句话</legend>
      <p className="whitespace-pre-wrap rounded-lg bg-[#F7F6F2] p-3 text-sm" aria-label="已保存的对白原文">{source || "此镜头没有对白，可保留静音或环境声。"}</p>
      <p className="text-sm">台词取自已保存原文。需要改台词正文时，请先回到剧本保存并审核。</p>
      {!lines.length && source.trim() ? <button className="rounded border px-3 py-2 disabled:opacity-50" type="button" disabled={!plan} onClick={() => { setLines(createSpeechDraft(source, props.characters ?? [], bindings)); setDirty(true); invalidateMix(); clearQuotes(); }}>按原文建立待确认草稿</button> : null}
      {lines.map((line, index) => {
        const voice = bindings.find((binding) => binding.currentRevision.id === line.speakerBindingRevisionId)?.currentRevision;
        return <div key={line.lineId} className="rounded-lg border p-3">
          <label className="block text-sm" htmlFor={`speaker-${line.lineId}`}>第 {index + 1} 句说话人</label>
          <select id={`speaker-${line.lineId}`} className="mt-1 w-full rounded border p-2" value={line.speakerBindingRevisionId} onChange={(event) => editLine(line.lineId, { speakerBindingRevisionId: event.target.value })}>
            <option value="">请选择已保存声音的角色</option>
            {bindings.map((binding) => <option key={binding.currentRevision.id} value={binding.currentRevision.id}>{speakers.find((speaker) => speaker.id === binding.speakerId)?.name ?? "角色"} · {binding.currentRevision.name}</option>)}
          </select>
          <p className="mt-2 whitespace-pre-wrap" aria-label={`第 ${index + 1} 句台词`}>{line.displayText || "请选择原文范围"}</p>
          <details className="mt-2 text-sm"><summary>调整原文范围与表演</summary>
            <div className="mt-2 flex flex-wrap gap-3">
              <label>原文开始位置<input aria-label={`第 ${index + 1} 句原文开始位置`} className="ml-2 w-20 rounded border p-1" type="number" min={0} max={source.length} value={line.sourceStart} onChange={(event) => editLine(line.lineId, { sourceStart: number(event.target.value, 0) })} /></label>
              <label>原文结束位置<input aria-label={`第 ${index + 1} 句原文结束位置`} className="ml-2 w-20 rounded border p-1" type="number" min={1} max={source.length} value={line.sourceEnd} onChange={(event) => editLine(line.lineId, { sourceEnd: number(event.target.value, 1) })} /></label>
              <label>语气<select aria-label={`第 ${index + 1} 句语气`} className="ml-2 rounded border p-1" value={line.emotion} onChange={(event) => editLine(line.lineId, { emotion: event.target.value })}>{(voice?.capabilities.emotions ?? ["neutral"]).map((emotion) => <option key={emotion} value={emotion}>{emotion === "neutral" ? "自然" : emotion}</option>)}</select></label>
              <label>语速<input aria-label={`第 ${index + 1} 句语速`} className="ml-2 w-20 rounded border p-1" type="number" min={voice?.capabilities.speedMin ?? 1} max={voice?.capabilities.speedMax ?? 1} step={0.05} value={line.speed} onChange={(event) => editLine(line.lineId, { speed: number(event.target.value, 1) })} /></label>
              <label>句后停顿（毫秒）<input aria-label={`第 ${index + 1} 句句后停顿`} className="ml-2 w-24 rounded border p-1" type="number" min={0} max={5000} step={100} value={line.pauseAfterMs} onChange={(event) => editLine(line.lineId, { pauseAfterMs: number(event.target.value, 0) })} /></label>
            </div>
          </details>
          <div className="mt-2 flex flex-wrap gap-2 text-sm">
            <button className="rounded border px-2 py-1 disabled:opacity-50" disabled={index === 0} type="button" aria-label={`将第 ${index + 1} 句前移`} onClick={() => { setLines((current) => { const next = [...current]; [next[index - 1], next[index]] = [next[index]!, next[index - 1]!]; return next; }); setDirty(true); clearQuotes(); invalidateMix(); }}>前移</button>
            <button className="rounded border px-2 py-1 disabled:opacity-50" disabled={index === lines.length - 1} type="button" aria-label={`将第 ${index + 1} 句后移`} onClick={() => { setLines((current) => { const next = [...current]; [next[index], next[index + 1]] = [next[index + 1]!, next[index]!]; return next; }); setDirty(true); clearQuotes(); invalidateMix(); }}>后移</button>
            <button className="rounded border px-2 py-1" type="button" aria-label={`移除第 ${index + 1} 句片段`} onClick={() => { setLines((current) => current.filter((item) => item.lineId !== line.lineId)); setDirty(true); clearQuotes(); invalidateMix(); }}>移除片段</button>
          </div>
        </div>;
      })}
      {lines.length ? <button className="rounded border px-3 py-2" type="button" onClick={() => { setLines((current) => [...current, { lineId: crypto.randomUUID(), speakerBindingRevisionId: "", sourceStart: source.length, sourceEnd: source.length, displayText: "", emotion: "neutral", speed: 1, pauseAfterMs: 0 }]); setDirty(true); clearQuotes(); invalidateMix(); }}>添加一句原文片段</button> : null}
      <button className="ml-2 rounded border px-3 py-2 disabled:opacity-50" disabled={!plan || !dirty || lines.some((line) => !line.speakerBindingRevisionId || !line.displayText || line.sourceEnd <= line.sourceStart)} type="button" onClick={() => void act(savePlan)}>保存并确认台词计划</button>
      {dirty ? <p className="text-sm" role="status">台词计划尚未确认；已选配音仍保留，保存后再检查是否适用。</p> : null}
    </fieldset>

    <fieldset className="mt-5 space-y-3" disabled={busy || loading}>
      <legend className="font-medium">3. 逐句试听并选用</legend>
      {pendingSubmission?.unknown ? <div className="rounded border p-3 text-sm" role="status"><p>提交结果尚未确认。请继续确认原配音任务；本次会保留原费用确认和请求标识，不新建报价。</p><p className="mt-1">原确认上限 {pendingSubmission.maximumAmount} {pendingSubmission.quote.currency}，仅限原来的一次生成。</p><button className="mt-2 rounded border px-3 py-2 disabled:opacity-50" disabled={activeJob && !pendingSubmission.jobId} type="button" onClick={() => void act(() => generateLine(pendingSubmission.lineId))}>{pendingSubmission.jobId ? "读取原配音任务" : "继续确认原配音任务"}</button></div> : null}
      {job ? <p role="status">{JOB_LABEL[job.state] ?? job.state}{job.errorMessage ? `：${job.errorMessage}` : ""}</p> : null}
      {saved ? lines.map((line, index) => {
        const selected = takes.selected.find((item) => item.lineId === line.lineId);
        const candidates = takes.items.filter((item) => item.lineId === line.lineId);
        const quote = quotes[line.lineId];
        const usableQuote = quote && Date.parse(quote.expiresAt) > Date.now();
        const confirmation = quote && costConfirmation?.lineId === line.lineId && costConfirmation.quoteId === quote.quoteId
          && costConfirmation.inputHash === quote.inputHash ? costConfirmation : null;
        const pending = pendingSubmission?.lineId === line.lineId && pendingSubmission.quote.quoteId === quote?.quoteId ? pendingSubmission : null;
        const maximumAmount = pending?.maximumAmount ?? confirmation?.maximumAmount ?? quote?.maximumAmount ?? "";
        const currentInputHash = plan?.currentRevision?.lines.find((item) => item.lineId === line.lineId)?.inputHash;
        const uncertainCount = quote?.uncertainJobIds?.length ?? 0;
        const mayConfirm = Boolean(usableQuote && confirmation?.confirmed && AMOUNT.test(maximumAmount) && quote?.inputHash === currentInputHash
          && (!uncertainCount || confirmation.confirmedUncertain));
        return <div key={line.lineId} className="rounded-lg border p-3">
          <p className="font-medium">第 {index + 1} 句</p><p className="mt-1 whitespace-pre-wrap">{line.displayText}</p>
          {selected ? <div className="mt-2 text-sm"><p>{selected.usable === false ? "历史选用已失效，请重新确认" : "已选用此句配音"}{selected.durationMs !== undefined ? ` · ${(selected.durationMs / 1000).toFixed(2)} 秒` : ""}</p><button className="mt-1 rounded border px-3 py-2" type="button" aria-label={`试听第 ${index + 1} 句已选配音`} onClick={() => audition(selected.takeAssetId)}>试听已选配音</button></div> : <p className="mt-2 text-sm">尚未选用配音</p>}
          <button className="mt-2 rounded border px-3 py-2 disabled:opacity-50" disabled={!capabilities?.available || activeJob || Boolean(pendingSubmission) || !journalReady} type="button" onClick={() => void act(() => quoteLine(line.lineId))}>{selected ? "再试一版：先查看费用" : "生成本句：先查看费用"}</button>
          {quote ? <div className="mt-2 rounded bg-[#F7F6F2] p-3 text-sm">
            <p>{quote.estimatedAmount === null ? `预计费用尚不明确（${quote.currency}）` : `预计费用 ${quote.estimatedAmount} ${quote.currency}`}</p>
            <label className="mt-2 block">本句费用上限（{quote.currency}）<input aria-label={`第 ${index + 1} 句费用上限`} className="ml-2 w-28 rounded border p-1" inputMode="decimal" value={maximumAmount} disabled={Boolean(pendingSubmission)} onChange={(event) => setCostConfirmation({ lineId: line.lineId, quoteId: quote.quoteId, inputHash: quote.inputHash, maximumAmount: event.target.value.trim(), confirmed: false, confirmedUncertain: false })} /></label>
            <p className="mt-1">费用确认只授权本句的一次生成；实际费用可能需要稍后核实。</p>
            <label className="mt-2 flex items-start gap-2"><input aria-label={`确认第 ${index + 1} 句可能产生一次费用`} type="checkbox" checked={Boolean(confirmation?.confirmed)} disabled={Boolean(pendingSubmission) || !AMOUNT.test(maximumAmount)} onChange={(event) => setCostConfirmation({ lineId: line.lineId, quoteId: quote.quoteId, inputHash: quote.inputHash, maximumAmount, confirmed: event.target.checked, confirmedUncertain: confirmation?.confirmedUncertain ?? false })} />确认本句可能产生一次费用</label>
            {uncertainCount ? <div className="mt-2 rounded border p-2"><p>发现 {uncertainCount} 个历史待核实任务。新请求可能重复收费，旧预算仍占用。</p><label className="mt-2 flex items-start gap-2"><input aria-label={`确认第 ${index + 1} 句历史待核实任务费用风险`} type="checkbox" checked={Boolean(confirmation?.confirmedUncertain)} disabled={Boolean(pendingSubmission)} onChange={(event) => setCostConfirmation({ lineId: line.lineId, quoteId: quote.quoteId, inputHash: quote.inputHash, maximumAmount, confirmed: confirmation?.confirmed ?? false, confirmedUncertain: event.target.checked })} />我已知晓新请求可能重复收费，旧预算仍占用</label></div> : null}
            {!usableQuote && !pending ? <p className="mt-2">报价已过期，请重新查看费用。</p> : null}
            {!pending?.unknown ? <button className="mt-2 rounded bg-[#D34846] px-3 py-2 text-white disabled:opacity-50" disabled={activeJob || !pending && (!mayConfirm || !capabilities?.available || !journalReady)} type="button" onClick={() => void act(() => generateLine(line.lineId))}>确认费用并生成本句</button> : null}
          </div> : null}
          {candidates.length ? <ul className="mt-3 space-y-2">{candidates.map((take, takeIndex) => <li className="rounded border p-2 text-sm" key={take.assetId}><p>候选 {takeIndex + 1} · {(take.durationMs / 1000).toFixed(2)} 秒{selected?.takeAssetId === take.assetId ? selected.usable === false ? " · 历史选用" : " · 当前选用" : ""}</p><button className="mt-1 rounded border px-3 py-2" aria-label={`试听第 ${index + 1} 句候选 ${takeIndex + 1}`} type="button" onClick={() => audition(take.assetId)}>试听</button><button className="ml-2 mt-1 rounded border px-3 py-2 disabled:opacity-50" disabled={!take.selectable || selected?.takeAssetId === take.assetId && selected.usable !== false} type="button" aria-label={`使用第 ${index + 1} 句候选 ${takeIndex + 1}`} onClick={() => void act(() => selectTake(line.lineId, take.assetId, take.checksumSha256))}>使用这一版</button></li>)}</ul> : <p className="mt-2 text-sm">还没有当前计划的候选配音。</p>}
        </div>;
      }) : <p className="text-sm">先保存并确认台词计划。</p>}
      {takes.hasMore ? <div className="text-sm"><p>当前仅显示部分候选，已选用配音始终单独显示。</p><button className="mt-2 rounded border px-3 py-2 disabled:opacity-50" disabled={!takes.nextCursor} type="button" onClick={() => void act(loadMoreTakes)}>加载更多候选</button></div> : null}
    </fieldset>
    <audio ref={player} className="mt-3 w-full" controls aria-label="配音试听播放器" onEnded={() => setListening(null)} onError={() => { if (listening) setError("声音暂时无法读取；不会新增生成任务"); }} />
    <fieldset className="mt-5" disabled={busy || loading}>
      <legend className="font-medium">4. 检查字幕与声音时长</legend>
      <p className="mt-2 text-sm">按已选音频的实际时长排列逐句字幕。人声超过视频时会阻断，不裁掉句尾。</p>
      {!props.videoAssetId ? <p className="mt-2 text-sm">选择当前镜头的视频后即可预检。</p> : null}
      <button className="mt-3 rounded border px-3 py-2 disabled:opacity-50" disabled={!saved || !props.videoAssetId} type="button" onClick={() => void act(preflight)}>检查声音与字幕</button>
      {mix ? <div className="mt-3 text-sm" role="status"><p>预检通过 · 配音 {(mix.manifest.totalSpeechMs / 1000).toFixed(2)} 秒 · 视频 {(mix.manifest.videoDurationMs / 1000).toFixed(2)} 秒</p><p>逐句字幕 {mix.manifest.subtitles.cues.length} 条，已绑定所选音频。</p><details className="mt-2"><summary>查看字幕</summary><pre className="mt-2 overflow-x-auto whitespace-pre-wrap">{mix.subtitleVtt}</pre></details></div> : null}
    </fieldset>
  </section>;
}

function message(caught: unknown, fallback: string) { return caught instanceof ApiError ? caught.detail : caught instanceof SpeechJournalError ? caught.message : fallback; }
function number(value: string, fallback: number) { const next = Number(value); return Number.isFinite(next) ? next : fallback; }
function lineInput(line: SpeechPlanLineInput): SpeechPlanLineInput {
  return { lineId: line.lineId, speakerBindingRevisionId: line.speakerBindingRevisionId, sourceStart: line.sourceStart,
    sourceEnd: line.sourceEnd, displayText: line.displayText, emotion: line.emotion, speed: line.speed, pauseAfterMs: line.pauseAfterMs };
}

/** Only an editable draft. The explicit save and server source-span validation establish the plan. */
export function createSpeechDraft(source: string, characters: SpeechCharacter[], bindings: SpeechBinding[]): SpeechPlanLineInput[] {
  const result: SpeechPlanLineInput[] = [];
  for (const match of source.matchAll(/[^\r\n]+/g)) {
    const raw = match[0];
    if (!raw.trim()) continue;
    let start = (match.index ?? 0) + raw.indexOf(raw.trim());
    const end = start + raw.trim().length;
    let bindingRevisionId = "";
    for (const character of characters) {
      const head = source.slice(start, end);
      const prefix = [`${character.name}：`, `${character.name}:`].find((item) => head.startsWith(item));
      if (!prefix) continue;
      start += prefix.length;
      while (start < end && /\s/.test(source[start] ?? "")) start += 1;
      bindingRevisionId = bindings.find((binding) => binding.speakerId === character.id)?.currentRevision.id ?? "";
      break;
    }
    const voice = bindings.find((binding) => binding.currentRevision.id === bindingRevisionId)?.currentRevision;
    if (start < end) result.push({ lineId: crypto.randomUUID(), speakerBindingRevisionId: bindingRevisionId,
      sourceStart: start, sourceEnd: end, displayText: source.slice(start, end),
      emotion: voice && !voice.capabilities.emotions.includes("neutral") ? voice.capabilities.emotions[0]! : "neutral",
      speed: voice ? Math.min(voice.capabilities.speedMax, Math.max(voice.capabilities.speedMin, 1)) : 1, pauseAfterMs: 0 });
  }
  return result;
}
