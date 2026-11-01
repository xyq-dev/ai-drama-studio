"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SpeechBatchInventory, SpeechBatchView } from "@ai-drama/contracts";
import { ApiError } from "../lib/studio-client";
import { clearSpeechBatchPending, createSpeechBatchClient, readSpeechBatchPending, rememberSpeechBatchPending,
  clearSpeechBatchStop, readSpeechBatchStop, rememberSpeechBatchStop,
  speechBatchJournalKey, type SpeechBatchClient, type SpeechBatchPending } from "../lib/speech-batch-client";
import styles from "./real-media-panel.module.css";
const LINE = { selected: "已选用", awaiting_selection: "已有音频，待试听选用", in_progress: "原任务进行中", uncertain: "原结果未知", missing: "缺少音频" };
const STATE = { quoted: "等待费用确认", dispatching: "逐句提交中", needs_attention: "有请求需要核查", dispatched: "逐句任务已创建", canceled: "已停止后续提交" };
const OP = { pending: "尚未提交", working: "正在核查提交", job_created: "原任务已受理", unknown: "回执未知", blocked: "已阻断", canceled: "已取消未提交项" };
const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELED"]);
interface Props { projectId: string; episodeId: string; refreshEpoch?: number; onChanged?: () => void; client?: SpeechBatchClient }
const detail = (e: unknown) => e instanceof ApiError ? e.detail : e instanceof Error ? e.message : "批次请求暂未完成，请保留原请求。";
export function SpeechBatchPanel(props: Props) { return <BatchScope key={props.projectId + ":" + props.episodeId} {...props} />; }
function BatchScope(props: Props) {
  const fallback = useRef<SpeechBatchClient | null>(null); if (!fallback.current) fallback.current = createSpeechBatchClient();
  const api = props.client ?? fallback.current;
  const mounted = useRef(true), inventoryRead = useRef(0), batchRead = useRef(0), busyRef = useRef(false), changed = useRef(props.onChanged); changed.current = props.onChanged;
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [tick, setTick] = useState(0);
  const [inventory, setInventory] = useState<SpeechBatchInventory | null>(null), [selected, setSelected] = useState<string[]>([]);
  const [recent, setRecent] = useState<SpeechBatchView[]>([]), [batch, setBatch] = useState<SpeechBatchView | null>(null);
  const [pending, setPending] = useState<SpeechBatchPending | null>(null), [storageError, setStorageError] = useState<string | null>(null);
  const [stopPending, setStopPending] = useState<SpeechBatchPending | null>(null), [stopping, setStopping] = useState(false);
  const stoppingRef = useRef(false), canceledViews = useRef(new Map<string, SpeechBatchView>());
  const [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null), [rejected, setRejected] = useState(false);
  const [confirmed, setConfirmed] = useState(false), [uncertainConfirmed, setUncertainConfirmed] = useState(false);
  const currentBatch = useRef<SpeechBatchView | null>(null), lastId = useRef<string | null>(null);
  const lastKey = speechBatchJournalKey(props.projectId, props.episodeId) + ":last";
  const showBatch = useCallback((v: SpeechBatchView) => {
    const canceled = canceledViews.current.get(v.id); if (canceled && !v.cancelRequested) v = canceled;
    batchRead.current++; currentBatch.current = v; setBatch(v); setConfirmed(false); setUncertainConfirmed(false);
  }, []);
  useEffect(() => {
    mounted.current = true;
    try {
      setPending(readSpeechBatchPending(props.projectId, props.episodeId));
      setStopPending(readSpeechBatchStop(props.projectId, props.episodeId));
      const raw = sessionStorage.getItem(lastKey);
      if (raw) {
        const v = JSON.parse(raw) as { projectId: string; episodeId: string; batchId: string };
        if (v.projectId !== props.projectId || v.episodeId !== props.episodeId || !/^[a-f0-9-]{36}$/.test(v.batchId)) throw new Error("原批次记录无法核对。");
        lastId.current = v.batchId;
      }
    } catch (e) { setStorageError(detail(e)); }
    return () => { mounted.current = false; inventoryRead.current++; batchRead.current++; };
  }, [props.projectId, props.episodeId, lastKey]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController(), sequence = ++inventoryRead.current;
    void (async () => {
      try {
        const [plan, list] = await Promise.all([api.inventory(props.projectId, props.episodeId, controller.signal), api.recent(props.projectId, props.episodeId, controller.signal)]);
        const original = lastId.current ? list.find(b => b.id === lastId.current) ?? await api.read(props.projectId, props.episodeId, lastId.current, controller.signal) : null;
        if (!mounted.current || controller.signal.aborted || sequence !== inventoryRead.current) return;
        setInventory(plan); setRecent(list); setError(null);
        setSelected(previous => previous.filter(id => plan.lines.some(l => l.lineInputRevisionId === id && ["missing", "uncertain"].includes(l.status))));
        if (original && !currentBatch.current) showBatch(original);
      } catch (e) { if (mounted.current && !controller.signal.aborted && sequence === inventoryRead.current) setError(detail(e)); }
    })();
    return () => controller.abort();
  }, [api, open, props.projectId, props.episodeId, props.refreshEpoch, tick, showBatch]);
  useEffect(() => {
    if (!open || !batch || !(batch.state === "dispatching" || batch.operations.some(o => o.jobId && o.jobState && !TERMINAL.has(o.jobState) && o.errorCode !== "REAL_MEDIA_SUBMISSION_UNKNOWN"))) return;
    const controller = new AbortController(), id = batch.id, sequence = ++batchRead.current;
    const timer = setTimeout(() => { void api.read(props.projectId, props.episodeId, id, controller.signal).then(value => {
      if (!mounted.current || controller.signal.aborted || sequence !== batchRead.current || currentBatch.current?.id !== id) return;
      const before = JSON.stringify(currentBatch.current.operations);
      currentBatch.current = value; setBatch(value);
      if (before !== JSON.stringify(value.operations)) changed.current?.();
    }).catch(e => { if (mounted.current && !controller.signal.aborted && sequence === batchRead.current) setError(detail(e)); }); }, 1500);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, open, batch, props.projectId, props.episodeId]);
  function request(kind: SpeechBatchPending["kind"], body: Record<string, unknown>, batchId: string | null): SpeechBatchPending {
    return { schema: "ads.speech-batch.pending.v1", projectId: props.projectId, episodeId: props.episodeId,
      kind, body, batchId, key: crypto.randomUUID() };
  }
  async function send(value: SpeechBatchPending) {
    if (busyRef.current || storageError || stopPending || stoppingRef.current) return;
    busyRef.current = true; setBusy(true); setError(null); setRejected(false); batchRead.current++;
    try {
      rememberSpeechBatchPending(value); setPending(value);
      const result = await api.write(value);
      const owns = readSpeechBatchPending(value.projectId, value.episodeId)?.key === value.key;
      if (owns) sessionStorage.setItem(lastKey, JSON.stringify({ projectId: value.projectId, episodeId: value.episodeId, batchId: result.id }));
      clearSpeechBatchPending(value);
      const remaining = readSpeechBatchPending(value.projectId, value.episodeId);
      if (!mounted.current) return;
      setPending(remaining);
      if (owns) { lastId.current = result.id; showBatch(result); }
      setNotice(value.kind === "quote" ? "报价已冻结，尚未创建付费生成任务。请核对调用次数与费用上限。"
        : value.kind === "cancel" ? "已请求停止后续提交；已受理任务及可能产生的费用仍保留，请逐项核查。"
          : "批次已受理。每句仍是独立原任务，已有结果会保留，不会自动换请求重做。");
      setTick(t => t + 1); changed.current?.();
    } catch (e) {
      if (mounted.current) { setError(detail(e)); if (e instanceof ApiError && [409, 422].includes(e.status)) setRejected(true); }
    } finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  }
  async function stop() {
    if (stoppingRef.current || storageError || (!stopPending && !batch)) return;
    const value = stopPending ?? request("cancel", {}, batch!.id);
    stoppingRef.current = true; setStopping(true); setError(null); batchRead.current++;
    try {
      rememberSpeechBatchStop(value); setStopPending(value);
      const result = await api.write(value);
      if (result.cancelRequested) canceledViews.current.set(result.id, result);
      clearSpeechBatchStop(value);
      const remaining = readSpeechBatchStop(value.projectId, value.episodeId);
      if (!mounted.current) return;
      setStopPending(remaining);
      if (currentBatch.current?.id === result.id) showBatch(result);
      setNotice("已请求停止后续提交；已创建的原任务及可能费用仍保留。确认请求的原回执也会继续保留供核查。");
      setTick(v => v + 1); changed.current?.();
    } catch (e) { if (mounted.current) setError(detail(e)); }
    finally { stoppingRef.current = false; if (mounted.current) setStopping(false); }
  }
  const unknownIds = [...new Set(batch?.operations.flatMap(o => o.quote.uncertainJobIds ?? []) ?? [])];
  const limit = inventory?.operationLimit ?? 100;
  return <section className={styles.panel} aria-label="本集配音补齐">
    <button className={styles.toggle} type="button" aria-expanded={open} onClick={() => setOpen(v => !v)}>本集配音补齐 {open ? "收起" : "展开"}</button>
    {open ? <div className={styles.body}>
      <p>只补本集已确认台词中缺少音频的句子。已有音频先试听选用；先前结果未知的句子需单独确认重复收费风险。每批最多 {limit} 句。</p>
      {storageError ? <p role="alert">{storageError}</p> : null}
      <button type="button" disabled={busy} onClick={() => setTick(v => v + 1)}>刷新本集配音清单</button>
      {pending ? <div className={styles.warning}><p>原批次请求尚未确认，刷新不会重新提交。</p>
        <button type="button" disabled={busy || stopping || Boolean(stopPending) || Boolean(storageError)} onClick={() => void send(pending)}>继续确认原批次请求</button>
        {rejected ? <button type="button" onClick={() => { try { if (clearSpeechBatchPending(pending)) { setPending(null); setRejected(false); } } catch (e) { setStorageError(detail(e)); } }}>结束这个已拒绝批次请求</button> : null}
      </div> : null}
      {stopPending ? <div className={styles.warning}><p>原停止请求尚未确认，不会以新请求替换。</p><button type="button" disabled={stopping || Boolean(storageError)} onClick={() => void stop()}>继续确认原停止请求</button></div> : null}
      {inventory ? <>
        {inventory.blockers.length ? <div className={styles.warning}><p>本集仍有 {inventory.blockers.length} 项未准备好，不能据此认定整集完成。</p>
          <ul>{inventory.blockers.map((b, i) => <li key={i}>{b.message}</li>)}</ul></div> : null}
        {!inventory.lines.length ? <p>当前没有可核对的台词。请先保存、审核镜头并确认台词计划。</p> : <fieldset><legend>选择本批要补齐的句子（已选 {selected.length}）</legend>
          {inventory.lines.map(line => {
            const eligible = ["missing", "uncertain"].includes(line.status), id = line.lineInputRevisionId;
            return <label key={id}><input type="checkbox" checked={selected.includes(id)} disabled={busy || Boolean(pending) || !eligible || (!selected.includes(id) && selected.length >= limit)}
              onChange={e => setSelected(previous => e.target.checked ? [...previous, id] : previous.filter(v => v !== id))} />
              {line.displayText} · {line.voiceName} · {LINE[line.status]}</label>;
          })}
        </fieldset>}
        <button type="button" disabled={busy || stopping || Boolean(stopPending) || Boolean(pending) || Boolean(storageError) || selected.length < 1 || selected.length > limit}
          onClick={() => void send(request("quote", { sourceHash: inventory.sourceHash, lineInputRevisionIds: selected }, null))}>冻结所选句子的报价</button>
      </> : null}
      {recent.length ? <label>查看已有批次<select value={batch?.id ?? ""} disabled={busy} onChange={e => { const value = recent.find(b => b.id === e.target.value); if (value) showBatch(value); }}>
        <option value="">选择批次</option>{recent.map(b => <option key={b.id} value={b.id}>{b.createdAt} · {STATE[b.state]} · {b.operations.length} 句</option>)}
      </select></label> : null}
      {batch ? <div className={styles.quote}>
        <p>批次 {batch.id.slice(0, 8)} · {STATE[batch.state]}</p>
        <p>固定 {batch.operations.length} 次单句操作；报价有效至 {batch.frozen.expiresAt}。实际账单尚未核实，应用预约不替代云账号限额。</p>
        {batch.frozen.budgets.map(b => <p key={b.currency}>{b.currency}：估算 {b.estimatedAmount ?? "未知"}，本批授权上限 {b.maximumAmount}</p>)}
        <ul>{batch.operations.map(o => <li key={o.id}>{o.displayText} · {o.errorCode === "REAL_MEDIA_SUBMISSION_UNKNOWN"
          ? "结果未知，可能已产生费用；仅查询原任务，不会自动再次生成" : `${OP[o.state]}${o.jobState ? ` · ${o.jobState}` : ""}${o.errorCode ? ` · ${o.errorCode}` : ""}`}{o.jobId ? ` · 原任务 ${o.jobId}` : ""}</li>)}</ul>
        {batch.state === "quoted" && !batch.cancelRequested ? <>
          {unknownIds.length ? <div className={styles.warning}><label><input type="checkbox" checked={uncertainConfirmed} onChange={e => setUncertainConfirmed(e.target.checked)} />
            我已核查先前 {unknownIds.length} 个结果未知的原任务，确认本批可能重复收费，原费用仍待核实。</label><details><summary>原任务编号</summary>{unknownIds.map(id => <p key={id}><code>{id}</code></p>)}</details></div> : null}
          <label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />我确认固定调用次数及每币种费用上限，本批可能产生费用。</label>
          <button type="button" disabled={busy || stopping || Boolean(stopPending) || Boolean(pending) || Boolean(storageError) || !confirmed || (unknownIds.length > 0 && !uncertainConfirmed)} onClick={() => void send(request("confirm", {
            frozenHash: batch.frozenHash, maximumJobs: batch.operations.length,
            budgets: batch.frozen.budgets.map(b => ({ currency: b.currency, maximumAmount: b.maximumAmount })),
            confirmPossibleCharges: true, confirmedUncertainJobIds: unknownIds,
          }, batch.id))}>确认本批配音补齐</button>
        </> : null}
        {["needs_attention", "dispatching"].includes(batch.state) && !batch.cancelRequested ? <button type="button" disabled={busy || stopping || Boolean(stopPending) || Boolean(pending) || Boolean(storageError)}
          onClick={() => void send(request("resume", {}, batch.id))}>用原请求继续核查本批</button> : null}
        {!["canceled", "dispatched"].includes(batch.state) && !batch.cancelRequested ? <button type="button" disabled={stopping || Boolean(stopPending) || Boolean(storageError)}
          onClick={() => void stop()}>停止本批后续提交</button> : null}
        <button type="button" disabled={busy} onClick={() => { const sequence = ++batchRead.current, id = batch.id;
          void api.read(props.projectId, props.episodeId, id).then(v => { if (mounted.current && sequence === batchRead.current && currentBatch.current?.id === id) showBatch(v); })
            .catch(e => { if (mounted.current && sequence === batchRead.current) setError(detail(e)); }); }}>只读核查本批状态</button>
        <p>成功音频仍需逐句试听并选用，再检查字幕与时长、合成和审核。已创建的原任务可在任务面板独立查看或取消；停止批次不撤销已发给服务商的调用。</p>
      </div> : null}
      {notice ? <p role="status">{notice}</p> : null}{error ? <p role="alert" className={styles.error}>{error}</p> : null}
    </div> : null}
  </section>;
}
