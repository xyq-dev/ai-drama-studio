"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { vimaxPlanningStartSchema, type VimaxCandidateCreate, type VimaxPlanningOptions, type VimaxPlanningStart, type VimaxPlanningView } from "@ai-drama/contracts";
import { VimaxPlanningClient, VimaxPlanningError } from "../lib/vimax-planning-client";
import styles from "./vimax-planning-panel.module.css";
const defaultClient = new VimaxPlanningClient();
interface Pending { key: string; body: VimaxPlanningStart }
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const message = (e: unknown) => e instanceof VimaxPlanningError ? e.message : "结果尚未确认，请保留原请求并稍后确认。";
const safeRefusal = (e: unknown) => e instanceof VimaxPlanningError && (
  [400, 413, 422, 429].includes(e.status) || ["VIMAX_PLANNING_ACTIVE", "VIMAX_PLANNING_NEEDS_CONFIRMATION", "VIMAX_PLANNING_SOURCE_CHANGED",
    "VIMAX_PLANNING_PROJECT_ACTIVE", "VIMAX_PLANNING_TARGET_CHANGED", "VIMAX_PLANNING_HAS_SHOTS", "VIMAX_PLANNING_ACTIVE_BREAKDOWN", "SOURCE_STALE", "SERIES_MEDIA_NOT_ENABLED"].includes(e.code));
export interface VimaxPlanningPanelProps {
  projectId: string; episodeId: string;
  draftRequest: VimaxPlanningStart | null;
  onCandidate: (candidate: VimaxCandidateCreate) => void;
  client?: Pick<VimaxPlanningClient, "options" | "list" | "get" | "start" | "cancel">;
}
export function VimaxPlanningPanel(props: VimaxPlanningPanelProps) {
  return <PlanningSession key={`${props.projectId}:${props.episodeId}`} {...props} />;
}
function PlanningSession(props: VimaxPlanningPanelProps) {
  const client = props.client ?? defaultClient;
  const storageKey = `ads.vimax-planning.pending.v1:${props.projectId}:${props.episodeId}`;
  const mounted = useRef(true), busyRef = useRef(false), sequence = useRef(0);
  const pendingRef = useRef<Pending | null>(null);
  const [opened, setOpened] = useState(false), [busy, setBusy] = useState(false), [reading, setReading] = useState(false);
  const [options, setOptions] = useState<VimaxPlanningOptions | null>(null), [items, setItems] = useState<VimaxPlanningView[]>([]);
  const [selected, setSelected] = useState<VimaxPlanningView | null>(null), [pending, setPending] = useState<Pending | null>(null);
  const [confirmed, setConfirmed] = useState(false), [uncertainConfirmed, setUncertainConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null), [storageError, setStorageError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null), [refused, setRefused] = useState(false);
  const remember = useCallback((p: Pending | null) => { pendingRef.current = p; setPending(p); }, []);
  useEffect(() => {
    mounted.current = true;
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (raw) {
        const value = JSON.parse(raw) as { key?: unknown; body?: unknown };
        const body = vimaxPlanningStartSchema.safeParse(value.body);
        if (typeof value.key !== "string" || !/^[\x21-\x7e]{1,200}$/.test(value.key) || !body.success) throw new Error("Invalid pending request");
        remember({ key: value.key, body: body.data });
      }
    } catch { setStorageError("无法读取本标签页的原请求记录，新的规划已暂停。请保留此标签页并修复存储。 "); }
    return () => { mounted.current = false; sequence.current += 1; };
  }, [storageKey, remember]);
  useEffect(() => { setConfirmed(false); setUncertainConfirmed(false); }, [props.draftRequest]);
  const reload = useCallback(async () => {
    const serial = ++sequence.current; setReading(true);
    try {
      const [o, page] = await Promise.all([client.options(props.projectId, props.episodeId), client.list(props.projectId, props.episodeId)]);
      if (!mounted.current || serial !== sequence.current) return;
      setOptions(o); setItems(page.items);
      setSelected((previous) => previous ? page.items.find((v) => v.requestId === previous.requestId) ?? previous : page.items[0] ?? null);
    } catch (e) { if (mounted.current && serial === sequence.current) setError(message(e)); }
    finally { if (mounted.current && serial === sequence.current) setReading(false); }
  }, [client, props.projectId, props.episodeId]);
  useEffect(() => { if (opened) void reload(); }, [opened, reload]);
  useEffect(() => {
    if (!opened || !selected || !["reserved", "submitted"].includes(selected.state)) return;
    let active = true;
    const timer = setInterval(() => {
      void client.get(props.projectId, props.episodeId, selected.requestId).then((r) => {
        if (active && mounted.current) { setSelected(r.request); setItems((old) => old.map((v) => v.requestId === r.request.requestId ? r.request : v)); }
      }).catch((e: unknown) => { if (active && mounted.current) setError(message(e)); });
    }, 2000);
    return () => { active = false; clearInterval(timer); };
  }, [opened, selected?.requestId, selected?.state, client, props.projectId, props.episodeId]);
  const clearOwnPending = (identity: Pending) => {
    const raw = sessionStorage.getItem(storageKey);
    if (raw !== null) {
      const stored = JSON.parse(raw) as { key?: unknown; body?: unknown };
      if (same(stored, identity)) {
        sessionStorage.removeItem(storageKey);
        if (same(pendingRef.current, identity)) remember(null);
      } else {
        const body = vimaxPlanningStartSchema.safeParse(stored.body);
        if (typeof stored.key !== "string" || !/^[\x21-\x7e]{1,200}$/.test(stored.key) || !body.success) throw new Error("Invalid newer pending request");
        remember({ key: stored.key, body: body.data });
      }
    } else if (same(pendingRef.current, identity)) remember(null);
  };
  const submit = async (identity: Pending) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setReading(false); setError(null); setNotice(null); setRefused(false); sequence.current += 1;
    try {
      const result = await client.start(props.projectId, props.episodeId, identity.body, identity.key);
      if (!mounted.current) return;
      // Test doubles and late responses must obey the same binding as the real HTTP client.
      if (result.request.projectId !== props.projectId || result.request.episodeId !== props.episodeId
        || result.request.requestKey !== identity.key || !same(result.request.input.request, identity.body)) throw new Error("Unconfirmed response");
      clearOwnPending(identity); setSelected(result.request);
      setItems((old) => [result.request, ...old.filter((v) => v.requestId !== result.request.requestId)]);
      setNotice("原请求回执已确认。结果可刷新找回；候选仍需人工核对与审核。");
    } catch (e) {
      if (mounted.current) { setError(message(e)); setRefused(safeRefusal(e)); }
      if (e instanceof VimaxPlanningError && e.code === "VIMAX_PLANNING_NEEDS_CONFIRMATION" && e.requestId) {
        try {
          const previous = await client.get(props.projectId, props.episodeId, e.requestId);
          if (mounted.current) { setSelected(previous.request); setItems((old) => [previous.request, ...old.filter((v) => v.requestId !== previous.request.requestId)]); }
        } catch { /* Original refusal and request identity remain visible; this read never sends. */ }
      }
    }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };
  const latestForTarget = props.draftRequest ? items.find((v) => v.input.target.sceneId === props.draftRequest!.target.sceneId) : undefined;
  const unknown = latestForTarget?.state === "unknown" ? latestForTarget : null;
  const active = latestForTarget && ["reserved", "submitted"].includes(latestForTarget.state);
  const start = () => {
    if (!props.draftRequest || !confirmed || (unknown && !uncertainConfirmed) || pendingRef.current || storageError || busyRef.current) return;
    const body = vimaxPlanningStartSchema.parse({ ...props.draftRequest,
      ...(unknown ? { confirmUncertainRequestId: unknown.requestId } : {}) });
    const identity = { key: crypto.randomUUID(), body };
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(identity));
      if (sessionStorage.getItem(storageKey) !== JSON.stringify(identity)) throw new Error("Pending request unavailable");
      remember(identity);
    } catch { setStorageError("无法保存原请求身份，未发送规划。请保留此标签页并修复存储。"); return; }
    setConfirmed(false); setUncertainConfirmed(false); void submit(identity);
  };
  const cancel = async () => {
    if (!selected || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(null);
    try {
      const r = await client.cancel(props.projectId, props.episodeId, selected.requestId);
      if (mounted.current) { setSelected(r.request); setItems((old) => old.map((v) => v.requestId === r.request.requestId ? r.request : v)); }
    } catch (e) { if (mounted.current) setError(message(e)); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };
  return <section className={styles.panel} aria-label="在线单场景规划">
    <button type="button" aria-expanded={opened} onClick={() => setOpened(!opened)}>在线单场景规划</button>
    {opened && <div className={styles.body}>
      <p>每个请求最多发送 1 次文本规划，费用未知。预约占用 24 小时名额，记录不代表实际发送或收费。</p>
      <p>使用服务端文本模型：{options?.providerKey ?? "尚未配置"} / {options?.model ?? "—"}。不自动重试或切换模型。</p>
      {options && <p>最近 24 小时共享额度上限：{options.maxCallsPerDay}。{options.code !== "VIMAX_PLANNING_READY" ? "在线规划尚未启用或配置不完整。" : ""}</p>}
      <button type="button" disabled={reading || busy} onClick={() => void reload()}>刷新规划记录</button>
      {error && <p role="alert">{error}</p>}{storageError && <p role="alert">{storageError}</p>}{notice && <p role="status">{notice}</p>}
      {pending && <aside className={styles.pending}>
        <p>有一次尚未确认的原请求。确认只重放原标识和原内容。</p>
        <button type="button" disabled={busy || Boolean(storageError)} onClick={() => void submit(pending)}>确认原规划请求</button>
        {refused && <button type="button" disabled={busy} onClick={() => {
          try { clearOwnPending(pending); setRefused(false); setError(null); } catch { setStorageError("原请求记录未能清除，请保留此标签页。"); }
        }}>结束被拒绝的原请求</button>}
      </aside>}
      {!props.draftRequest && <p>请先准备当前批准剧本的单场景来源与目标场景。</p>}
      {unknown && <label><input type="checkbox" checked={uncertainConfirmed} onChange={(e) => setUncertainConfirmed(e.target.checked)} />
        我已知晓请求 {unknown.requestId} 结果未知、可能已收费，本次将另预约一次新请求</label>}
      <label><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />我确认发送当前单场景文本，接受一次规划费用未知</label>
      <button type="button" disabled={!props.draftRequest || !confirmed || Boolean(unknown && !uncertainConfirmed) || Boolean(active)
        || Boolean(pending) || Boolean(storageError) || busy || options?.code !== "VIMAX_PLANNING_READY"} onClick={start}>预约并生成分镜规划</button>
      {items.length > 0 && <label>规划记录<select value={selected?.requestId ?? ""} disabled={busy} onChange={(e) => setSelected(items.find((v) => v.requestId === e.target.value) ?? null)}>
        {items.map((v) => <option value={v.requestId} key={v.requestId}>{v.createdAt} · {v.state} · {v.input.target.heading}</option>)}
      </select></label>}
      {selected && <article aria-label="当前规划" className={styles.result}>
        <p>状态：{selected.state}；费用：未知；{selected.submittedAt ? "已有提交记录" : "尚无提交记录"}。</p>
        {selected.state === "unknown" && <p>供应商可能已经处理并收费。系统不会自动重发；新请求需要明确确认。</p>}
        {selected.errorCode && <p>原因：{selected.errorCode}</p>}
        <p>Token 用量：{selected.usage.status === "present" ? `输入 ${selected.usage.inputTokens ?? "未知"} / 输出 ${selected.usage.outputTokens ?? "未知"}` : "未知"}。</p>
        {selected.state === "reserved" && <button type="button" disabled={busy} onClick={() => void cancel()}>取消尚未提交的规划</button>}
        {selected.output && <>
          <p>这是冻结来源的历史候选。请核对原文、逐句对白与分镜；保存时仍须校验当前来源并人工审核。</p>
          <div className={styles.review}>
            <div><h4>冻结原场景</h4><pre className={styles.preview}>{(() => {
              const scene = selected.input.request.sceneSpans.find((v) => v.key === selected.input.request.selectedSceneKeys[0]);
              return scene ? selected.input.source.scriptText.slice(scene.start, scene.end) : "原文范围不可用";
            })()}</pre></div>
            <div>{selected.output.request.supplements.shots.map((shot) => <article key={shot.vimaxShotIndex} aria-label={`规划镜头 ${shot.vimaxShotIndex + 1}`}>
              <h4>镜头 {shot.vimaxShotIndex + 1} · {shot.shotType} · 预计 {shot.plannedSeconds} 秒</h4>
              <p>构图与运镜：{shot.camera}</p><p>动作：{shot.action}</p>
              <pre className={styles.preview}>{shot.dialogue.map((line) => `${line.speaker}：${line.line}`).join("\n") || "无对白"}</pre>
            </article>)}</div>
          </div>
          <details><summary>完整分镜、首尾帧与机位树</summary><pre className={styles.preview}>{JSON.stringify(selected.output.request, null, 2)}</pre></details>
          <button type="button" onClick={() => props.onCandidate(selected.output!)}>导入候选供人工核对</button>
        </>}
      </article>}
    </div>}
  </section>;
}
