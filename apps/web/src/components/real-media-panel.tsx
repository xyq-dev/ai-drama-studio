"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RealMediaCapability, RealMediaQuote, SpeechMixPreflight } from "@ai-drama/contracts";
import { ApiError } from "../lib/studio-client";
import { COMFYUI_PROMPT_LIMIT, clearRealMediaPending, createRealMediaClient, readRealMediaPending, realMediaPendingKey, rememberRealMediaPending,
  clearRealMediaComposePending, readRealMediaComposePending, rememberRealMediaComposePending,
  type ComfyUiQuoteInput, type ComfyUiShot, type RealMediaComposePending, type RealMediaAsset, type RealMediaCapabilities, type RealMediaClient, type RealMediaPending } from "../lib/real-media-client";
import { ComfyUiImageFields, comfyUiAvailability, comfyUiJobLabel, comfyUiJobSettled } from "./comfyui-image-fields";
import { HoverMediaPreview } from "./hover-media-preview";
import { SpeechPanel } from "./speech-panel";
import styles from "./real-media-panel.module.css";

const LABEL: Record<RealMediaCapability, string> = { "image.generate": "图片", "video.generate": "视频", "audio.tts": "配音", "audio.music": "背景音乐" };
const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELED"]);
const REFUSED = new Set(["REAL_MEDIA_QUOTE_EXPIRED", "REAL_MEDIA_INPUT_CHANGED", "REAL_MEDIA_CONFIGURATION_CHANGED",
  "REAL_MEDIA_UNCERTAIN_CHANGED", "REAL_MEDIA_AUTHORIZATION_INVALID", "REAL_MEDIA_BUDGET_MISMATCH", "REAL_MEDIA_AUTHORIZATION_USED"]);
const COMFY_ERRORS: Record<string, string> = {
  COMFYUI_UNAVAILABLE: "ComfyUI 当前不可用，请重新检测连接与依赖。",
  COMFYUI_UNREACHABLE: comfyUiAvailability.unreachable,
  COMFYUI_DEPENDENCY_MISSING: comfyUiAvailability.missing_dependencies,
  COMFYUI_DEPENDENCIES_MISSING: comfyUiAvailability.missing_dependencies,
  COMFYUI_REFERENCE_INVALID: "所选参考图已不可用，请重新选择本作品的图片。",
  REAL_MEDIA_SOURCE_INVALID: "所选参考图已不可用，请重新选择本作品的图片。",
  REAL_MEDIA_INPUT_CHANGED: "镜头或参考图已更新，请核对后重新获取报价。",
};
type Job = { id: string; state: string; errorCode: string | null };
interface Props {
  projectId: string; shotRevisionId: string; dialogue?: string | null; promptText?: string; usable: boolean; approved?: boolean; reason?: string; refreshEpoch?: number;
  client?: RealMediaClient; onChanged?: () => void;
}
function detail(error: unknown): string { return error instanceof ApiError ? error.detail : error instanceof Error ? error.message : "操作暂未完成，请保留原请求。"; }
function amount(value: string): bigint | null {
  if (!/^(0|[1-9]\d{0,7})(\.\d{1,8})?$/.test(value)) return null;
  const [a = "0", b = ""] = value.split(".");
  return BigInt(a) * 100_000_000n + BigInt(b.padEnd(8, "0"));
}
export function RealMediaPanel(props: Props) {
  return <MediaScope key={props.projectId + ":" + props.shotRevisionId} {...props} />;
}
function MediaScope(props: Props) {
  const [open, setOpen] = useState(false);
  const fallback = useRef<RealMediaClient | null>(null);
  if (!fallback.current) fallback.current = createRealMediaClient();
  const api = props.client ?? fallback.current;
  const mounted = useRef(true), generation = useRef(0), writeBusy = useRef(false);
  const changed = useRef(props.onChanged); changed.current = props.onChanged;
  const [capabilities, setCapabilities] = useState<RealMediaCapabilities | null>(null);
  const [assets, setAssets] = useState<RealMediaAsset[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [characters, setCharacters] = useState<Array<{ id: string; name: string }>>([]);
  const [capability, setCapability] = useState<RealMediaCapability>("image.generate");
  const [imageProvider, setImageProvider] = useState<"default" | "comfyui" | null>(null);
  const [comfyInput, setComfyInput] = useState<ComfyUiQuoteInput | null>(null);
  const [comfyShot, setComfyShot] = useState<ComfyUiShot | null>(null);
  const [comfyReadError, setComfyReadError] = useState(false);
  const [comfyTick, setComfyTick] = useState(0);
  const [checkingComfy, setCheckingComfy] = useState(false);
  const [checkComfyError, setCheckComfyError] = useState(false);
  const previousComfySuccesses = useRef<Set<string> | null>(null);
  const previousComfySelection = useRef<string | null>(null);
  const comfyMutation = useRef(false);
  const comfyCancelKeys = useRef(new Map<string, string>());
  const [comfyBusy, setComfyBusy] = useState(false);
  const [imageChoice, setImageChoice] = useState<string | null>(null);
  const [videoId, setVideoId] = useState(""), [musicId, setMusicId] = useState("");
  const adoptedImageId = props.usable && props.approved !== false ? comfyShot?.selectedAssetId : null;
  const imageId = imageChoice ?? (assets.some(asset => asset.id === adoptedImageId && asset.status === "ACTIVE" && asset.kind === "IMAGE") ? adoptedImageId ?? "" : "");
  const selectedAssetIds = useRef<string[]>([]), loadedPages = useRef(1);
  selectedAssetIds.current = [imageChoice, adoptedImageId, videoId, musicId].filter((id): id is string => Boolean(id));
  const [quote, setQuote] = useState<RealMediaQuote | null>(null), [maximum, setMaximum] = useState("");
  const [confirmed, setConfirmed] = useState(false), [uncertainConfirmed, setUncertainConfirmed] = useState(false);
  const [pending, setPending] = useState<RealMediaPending | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const currentJob = useRef<Job | null>(null), jobRead = useRef(0);
  const showJob = useCallback((value: Job) => { jobRead.current++; currentJob.current = value; setJob(value); }, []);
  const [mix, setMix] = useState<SpeechMixPreflight | null>(null);
  const mixRef = useRef<SpeechMixPreflight | null>(null);
  const [composePending, setComposePending] = useState<RealMediaComposePending | null>(null);
  const [composeRefused, setComposeRefused] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null), [refused, setRefused] = useState(false), [readTick, setReadTick] = useState(0);
  const comfy = capabilities?.comfyui;
  const comfySupported = Boolean(comfy);
  const comfyAvailable = !checkComfyError && comfy?.status === "available" && comfy.workflows.length > 0;
  const defaultImageAvailable = capabilities?.capabilities.includes("image.generate") ?? false;
  const useComfy = capability === "image.generate" && (imageProvider === "comfyui" || (imageProvider === null && comfyAvailable && !defaultImageAvailable));
  const comfyWorkflow = comfy?.workflows.find(item => item.id === comfyInput?.workflowId) ?? comfy?.workflows[0];
  const comfySize = comfyWorkflow?.dimensions[0];
  const currentComfyInput = comfyInput && comfyWorkflow?.id === comfyInput.workflowId ? comfyInput
    : comfyWorkflow && comfySize ? { workflowId: comfyWorkflow.id, prompt: props.promptText ?? "", ...comfySize } : null;
  const comfyReady = !useComfy || Boolean(comfyAvailable && currentComfyInput?.prompt.trim() && currentComfyInput.prompt.trim().length <= COMFYUI_PROMPT_LIMIT
    && comfyWorkflow?.dimensions.some(size => size.width === currentComfyInput.width && size.height === currentComfyInput.height)
    && (!comfyWorkflow.requiresReference || comfyShot?.references.some(reference => reference.id === currentComfyInput.referenceAssetId)));
  const imageReady = capability !== "image.generate" || (useComfy ? comfyReady : defaultImageAvailable);
  const hasComfyJob = Boolean(job && comfyShot?.jobs.some(item => item.jobId === job.id));
  const jobStorage = realMediaPendingKey(props.projectId, props.shotRevisionId) + ":job";
  useEffect(() => {
    mounted.current = true;
    try {
      setPending(readRealMediaPending(props.projectId, props.shotRevisionId));
      setComposePending(readRealMediaComposePending(props.projectId, props.shotRevisionId));
      const raw = sessionStorage.getItem(jobStorage);
      if (raw) {
        const saved = JSON.parse(raw) as { projectId: string; shotRevisionId: string; jobId: string };
        if (saved.projectId === props.projectId && saved.shotRevisionId === props.shotRevisionId
          && /^[a-f0-9-]{36}$/.test(saved.jobId)) showJob({ id: saved.jobId, state: "QUEUED", errorCode: null });
        else throw new Error("原任务记录无法核对，请先核查任务。");
      }
    } catch (e) { setStorageError(detail(e)); }
    return () => { mounted.current = false; generation.current++; };
  }, [props.projectId, props.shotRevisionId, jobStorage, showJob]);
  useEffect(() => {
    if (!open) return;
    const sequence = ++generation.current, controller = new AbortController();
    setQuote(null); setConfirmed(false); setUncertainConfirmed(false); setMix(null); mixRef.current = null;
    void (async () => {
      try {
        const caps = await api.capabilities(props.projectId, controller.signal);
        if (!mounted.current || sequence !== generation.current) return;
        setCapabilities(caps);
        if (!caps.available && !caps.readAvailable) return;
        setImageProvider(previous => previous ?? (caps.capabilities.includes("image.generate") ? "default"
          : caps.comfyui?.status === "available" ? "comfyui" : null));
        const offered: RealMediaCapability[] = caps.comfyui?.status === "available" ? [...caps.capabilities, "image.generate"] : caps.capabilities;
        setCapability(previous => offered.includes(previous) && previous !== "audio.tts" ? previous
          : offered.find(c => c !== "audio.tts") ?? "image.generate");
        const loadAssets = async () => {
          const first = await api.assets(props.shotRevisionId, undefined, controller.signal);
          const items = [...first.items], seen = new Set<string>();
          let nextCursor = first.nextCursor, count = 1;
          while (nextCursor && (count < loadedPages.current || selectedAssetIds.current.some(id => !items.some(a => a.id === id)))) {
            if (seen.has(nextCursor) || count >= 100) throw new Error("素材分页无法完整核对，请稍后重新读取。");
            seen.add(nextCursor);
            const page = await api.assets(props.shotRevisionId, nextCursor, controller.signal);
            items.push(...page.items.filter(a => !items.some(previous => previous.id === a.id)));
            nextCursor = page.nextCursor; count++;
          }
          return { items, nextCursor, count };
        };
        const [page, cast] = await Promise.all([loadAssets(), api.characters(props.projectId, controller.signal)]);
        if (!mounted.current || sequence !== generation.current) return;
        loadedPages.current = page.count;
        setAssets(page.items); setCursor(page.nextCursor); setCharacters(cast); setError(null);
        setImageChoice(previous => !previous || page.items.some(a => a.id === previous && a.status === "ACTIVE" && a.kind === "IMAGE") ? previous : "");
        setVideoId(previous => page.items.some(a => a.id === previous && a.status === "ACTIVE" && a.kind === "VIDEO") ? previous : "");
        setMusicId(previous => page.items.some(a => a.id === previous && a.status === "ACTIVE" && a.kind === "MUSIC") ? previous : "");
      } catch (e) { if (!controller.signal.aborted && mounted.current && sequence === generation.current) setError(detail(e)); }
    })();
    return () => controller.abort();
  }, [api, open, props.projectId, props.shotRevisionId, props.refreshEpoch, readTick]);
  useEffect(() => {
    if (!open || !comfySupported) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function read() {
      try {
        const snapshot = await api.comfyuiShot(props.projectId, props.shotRevisionId, controller.signal);
        if (controller.signal.aborted) return;
        const successes = new Set(snapshot.jobs.filter(item => item.state === "SUCCEEDED").map(item => item.jobId));
        const previous = previousComfySuccesses.current;
        if ((previous && [...successes].some(id => !previous.has(id))) ||
          (snapshot.selectedAssetId && snapshot.selectedAssetId !== previousComfySelection.current)) setReadTick(value => value + 1);
        previousComfySuccesses.current = successes;
        previousComfySelection.current = snapshot.selectedAssetId;
        setComfyShot(snapshot); setComfyReadError(false);
        if (snapshot.jobs.some(item => !comfyUiJobSettled(item) && item.state !== "UNKNOWN"
          && item.errorCode !== "REAL_MEDIA_SUBMISSION_UNKNOWN")) timer = setTimeout(() => void read(), 2000);
      } catch {
        if (!controller.signal.aborted) { setComfyReadError(true); timer = setTimeout(() => void read(), 5000); }
      }
    }
    void read();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [api, comfySupported, comfyTick, open, props.projectId, props.shotRevisionId, props.refreshEpoch]);
  useEffect(() => {
    if (!open || !job || hasComfyJob || TERMINAL.has(job.state) || job.errorCode === "REAL_MEDIA_SUBMISSION_UNKNOWN") return;
    const controller = new AbortController();
    const read = ++jobRead.current;
    const timer = setTimeout(() => { void api.job(job.id, controller.signal).then(value => {
      if (!mounted.current || controller.signal.aborted || read !== jobRead.current || currentJob.current?.id !== job.id) return;
      showJob(value);
      if (TERMINAL.has(value.state)) { setReadTick(v => v + 1); changed.current?.(); }
    }).catch(e => { if (!controller.signal.aborted && mounted.current) setError(detail(e)); }); }, 1000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, open, job, hasComfyJob, showJob]);
  const receiveMix = useCallback((value: SpeechMixPreflight | null) => {
    mixRef.current = value; setMix(value);
  }, []);
  function resetQuote() {
    setQuote(null); setConfirmed(false); setUncertainConfirmed(false);
  }
  async function checkComfyConnection() {
    if (useComfy) setImageProvider("comfyui");
    setCheckingComfy(true); setCheckComfyError(false); resetQuote();
    try {
      const current = await api.capabilities(props.projectId);
      if (mounted.current) setCapabilities(current);
    } catch {
      if (mounted.current) setCheckComfyError(true);
    } finally { if (mounted.current) setCheckingComfy(false); }
  }
  async function getQuote() {
    if (!capabilities?.available || !props.usable || (capability !== "image.generate" && props.approved === false) || !imageReady || pending || writeBusy.current || (capability === "video.generate" && !imageId)) return;
    if (capability === "video.generate") setImageChoice(imageId);
    const sequence = generation.current;
    setBusy(true); setError(null); setQuote(null); setConfirmed(false); setUncertainConfirmed(false);
    try {
      const next = useComfy && currentComfyInput
        ? await api.quote(props.projectId, props.shotRevisionId, capability, undefined, { ...currentComfyInput, prompt: currentComfyInput.prompt.trim() })
        : await api.quote(props.projectId, props.shotRevisionId, capability, capability === "video.generate" ? imageId : undefined);
      if (mounted.current && sequence === generation.current) { setQuote(next); setMaximum(next.estimatedAmount); }
    } catch (e) { if (mounted.current && sequence === generation.current) setError(useComfy && e instanceof ApiError
      ? COMFY_ERRORS[e.code] ?? "无法获取 ComfyUI 报价，请检查工作流、参考图和资源额度。" : detail(e)); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function submit() {
    if (writeBusy.current || storageError) return;
    if (!pending && (!props.usable || !imageReady || (capability !== "image.generate" && props.approved === false))) return;
    const frozen = pending ?? (quote && confirmed && (!(quote.uncertainJobIds?.length) || uncertainConfirmed) ? {
      schema: "ads.real-media.pending.v1" as const, projectId: props.projectId, shotRevisionId: props.shotRevisionId,
      key: crypto.randomUUID(), quote, maximumAmount: maximum, authorizationId: null,
    } : null);
    if (!frozen) return;
    writeBusy.current = true; setBusy(true); setError(null); setRefused(false);
    let request = frozen;
    try {
      rememberRealMediaPending(request); setPending(request);
      if (!request.authorizationId) {
        const authorizationId = await api.authorize(request.projectId, request.quote, request.maximumAmount, request.key);
        request = { ...request, authorizationId };
        rememberRealMediaPending(request);
        if (mounted.current) setPending(request);
      }
      const receipt = await api.generate(request.projectId, request.shotRevisionId, request.quote.quoteId, request.authorizationId!, request.key);
      // Store an acknowledged Job before clearing its pending request, including when this view has unmounted.
      const identity = readRealMediaPending(request.projectId, request.shotRevisionId);
      const ownIdentity = identity?.key === request.key;
      if (ownIdentity) sessionStorage.setItem(jobStorage, JSON.stringify({ projectId: request.projectId, shotRevisionId: request.shotRevisionId, jobId: receipt.jobId, requestKey: request.key }));
      const cleared = clearRealMediaPending(request);
      const remaining = cleared ? null : readRealMediaPending(request.projectId, request.shotRevisionId);
      if (mounted.current) {
        setPending(remaining);
        setQuote(null); setConfirmed(false); setUncertainConfirmed(false); setMix(null); mixRef.current = null;
        if (ownIdentity) showJob({ id: receipt.jobId, state: "QUEUED", errorCode: null });
        if (request.quote.estimateBasis === "self-hosted-resource-estimate") setComfyTick(value => value + 1);
        setNotice(remaining && remaining.key !== request.key ? "原任务已受理；另一个请求仍需继续确认。" : "任务已受理。关闭页面后会继续执行，可稍后返回查看。");
        changed.current?.();
      }
    } catch (e) {
      if (mounted.current) {
        setPending(request); setError(detail(e));
        if (e instanceof ApiError && REFUSED.has(e.code) && [409, 422].includes(e.status)) setRefused(true);
        if (!(e instanceof ApiError)) {
          try { readRealMediaPending(props.projectId, props.shotRevisionId); }
          catch (storage) { setStorageError(detail(storage)); }
        }
      }
    } finally { writeBusy.current = false; if (mounted.current) setBusy(false); }
  }
  async function renderMix() {
    if (writeBusy.current || storageError || (!composePending && !mixRef.current)) return;
    const request: RealMediaComposePending = composePending ?? { schema: "ads.voice-compose.pending.v1", projectId: props.projectId,
      shotRevisionId: props.shotRevisionId, value: mixRef.current!, key: crypto.randomUUID() };
    writeBusy.current = true; setBusy(true); setError(null);
    try {
      rememberRealMediaComposePending(request); setComposePending(request); setComposeRefused(false);
      const receipt = await api.compose(props.shotRevisionId, request.value, request.key);
      const owns = readRealMediaComposePending(request.projectId, request.shotRevisionId)?.key === request.key;
      if (owns) sessionStorage.setItem(jobStorage, JSON.stringify({ projectId: request.projectId, shotRevisionId: request.shotRevisionId, jobId: receipt.jobId }));
      clearRealMediaComposePending(request);
      const remaining = readRealMediaComposePending(request.projectId, request.shotRevisionId);
      if (!mounted.current) return;
      setComposePending(remaining); mixRef.current = null; setMix(null);
      if (owns) showJob({ id: receipt.jobId, state: "QUEUED", errorCode: null });
      setNotice("合成任务已受理，完成后请到下方合成面板试听、审核，再编排整集。"); changed.current?.();
    } catch (e) { if (mounted.current) { setError(detail(e)); if (e instanceof ApiError && [409, 422].includes(e.status)) setComposeRefused(true); } }
    finally { writeBusy.current = false; if (mounted.current) setBusy(false); }
  }
  async function adoptImage(asset: RealMediaAsset) {
    if (!comfyShot || comfyShot.selectionAvailable !== true || comfyMutation.current || !props.usable || props.approved === false
      || asset.kind !== "IMAGE" || asset.status !== "ACTIVE" || !comfyShot.jobs.some(item => item.state === "SUCCEEDED" && item.jobId === asset.sourceGenerationJobId)) return;
    const expected = comfyShot.selectedAssetId;
    comfyMutation.current = true; setComfyBusy(true); setError(null);
    try {
      await api.adoptComfyUiImage(props.projectId, props.shotRevisionId, asset.id, expected, crypto.randomUUID());
      if (mounted.current) {
        setComfyShot(previous => previous && previous.selectedAssetId === expected ? { ...previous, selectedAssetId: asset.id } : previous);
        setNotice("此候选图已采用到当前镜头。");
        changed.current?.();
      }
    } catch (e) {
      if (mounted.current) setError(e instanceof ApiError && e.status === 409 ? "镜头或选用版本有变化，请核对当前状态后再操作。" : "未能确认选用，请重新查询当前镜头。");
    } finally {
      comfyMutation.current = false;
      if (mounted.current) { setComfyBusy(false); setComfyTick(value => value + 1); }
    }
  }
  async function cancelComfyJob(jobId: string) {
    if (comfyMutation.current || !comfyShot?.jobs.some(item => item.jobId === jobId && item.canCancel)) return;
    const key = comfyCancelKeys.current.get(jobId) ?? crypto.randomUUID();
    comfyCancelKeys.current.set(jobId, key);
    comfyMutation.current = true; setComfyBusy(true); setError(null);
    try {
      await api.cancelComfyUiJob(jobId, key);
      comfyCancelKeys.current.delete(jobId);
      if (mounted.current) setNotice("已提交取消请求，等待核对原任务状态。");
    } catch (e) {
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) comfyCancelKeys.current.delete(jobId);
      if (mounted.current) setError("取消暂未确认，请查看原任务状态。");
    } finally {
      comfyMutation.current = false;
      if (mounted.current) { setComfyBusy(false); setComfyTick(value => value + 1); }
    }
  }
  const active = assets.filter(a => a.status === "ACTIVE"), images = active.filter(a => a.kind === "IMAGE"), videos = active.filter(a => a.kind === "VIDEO");
  const usableComfyJobs = new Set(comfyShot?.jobs.filter(item => item.state === "SUCCEEDED").map(item => item.jobId));
  const offeredCapabilities = (["image.generate", "video.generate", "audio.music"] as const)
    .filter(item => capabilities?.capabilities.includes(item) || (item === "image.generate" && comfyAvailable));
  const estimated = quote ? amount(quote.estimatedAmount) : null, cap = amount(maximum), serverCap = quote ? amount(quote.maximumAmount) : null;
  const amountValid = estimated !== null && cap !== null && serverCap !== null && cap >= estimated && cap <= serverCap;
  return <section className={styles.panel}>
    <button className={styles.toggle} type="button" aria-expanded={open} onClick={() => setOpen(v => !v)}>图片、视频与角色配音 {open ? "收起" : "展开"}</button>
    {open ? <div className={styles.body}>
      <p>先生成首帧，再生成无声视频；角色配音与字幕逐句核对。每次生成单独确认费用，成功素材保留历史版本。</p>
      {storageError ? <p role="alert" className={styles.error}>{storageError}</p> : null}
      {capabilities && !capabilities.available ? <p role="status">媒体服务尚未配置完整，当前不会提交模型调用。请先完成服务端配置与数据库启用。{capabilities.readAvailable ? "已有素材仍可查看并本地合成。" : ""}</p> : null}
      {comfy || checkComfyError ? <div className={styles.comfyConnection}>
        <p role="status">{checkingComfy ? "正在检测 ComfyUI 连接与依赖。" : checkComfyError ? "暂时无法读取 ComfyUI 连接状态。" : comfy ? comfyUiAvailability[comfy.status] : null}</p>
        <button type="button" disabled={checkingComfy || busy} onClick={() => void checkComfyConnection()}>检测 ComfyUI 连接</button>
      </div> : null}
      {pending ? <div className={styles.warning}>
        <p>原{LABEL[pending.quote.capability]}请求尚未确认，请先用原请求查回任务。</p>
        <button type="button" disabled={busy || Boolean(storageError)} onClick={() => void submit()}>继续确认原媒体请求</button>
        {refused ? <button type="button" onClick={() => {
          try { if (clearRealMediaPending(pending)) { setPending(null); setRefused(false); setQuote(null); } }
          catch (e) { setStorageError(detail(e)); }
        }}>结束这个已拒绝请求</button> : null}
      </div> : null}
      {composePending ? <div className={styles.warning}>
        <p>原合成请求尚未确认，将使用原选用音频与原请求继续核查。</p>
        <button type="button" disabled={busy || Boolean(storageError)} onClick={() => void renderMix()}>继续确认原合成请求</button>
        {composeRefused ? <button type="button" onClick={() => {
          try { if (clearRealMediaComposePending(composePending)) { setComposePending(null); setComposeRefused(false); receiveMix(null); } }
          catch (e) { setStorageError(detail(e)); }
        }}>结束这个已拒绝合成请求</button> : null}
      </div> : null}
      {capabilities?.available || capabilities?.readAvailable ? <>
        {!props.usable ? <p role="status">{props.reason || "请先批准当前镜头及其来源，再开始生成。"}</p> : null}
        {capabilities.available && offeredCapabilities.length > 0 ? <>
        <div className={styles.fields}>
          <label>本次制作
            <select value={capability} disabled={Boolean(pending) || busy} onChange={e => { setCapability(e.target.value as RealMediaCapability); resetQuote(); }}>
              {offeredCapabilities.map(c => <option key={c} value={c}>{LABEL[c]}</option>)}
            </select>
          </label>
          {capability === "image.generate" && (comfyAvailable || imageProvider === "comfyui") ? <label>图片生成方式
            <select value={useComfy ? "comfyui" : "default"} disabled={Boolean(pending) || busy} onChange={e => {
              setImageProvider(e.target.value === "comfyui" ? "comfyui" : "default"); resetQuote();
            }}>
              {defaultImageAvailable || imageProvider === "default" ? <option value="default" disabled={!defaultImageAvailable}>现有图片供应商</option> : null}
              <option value="comfyui" disabled={!comfyAvailable}>ComfyUI</option>
            </select>
          </label> : null}
          {capability === "video.generate" ? <label>视频首帧
            <select value={imageId} disabled={Boolean(pending) || busy} onChange={e => { setImageChoice(e.target.value); resetQuote(); }}>
              <option value="">请选择本镜头已生成的图片</option>{images.map(a => <option key={a.id} value={a.id}>{a.id === adoptedImageId ? "已采用 · " : ""}图片 {a.id.slice(0, 8)}</option>)}
            </select>
          </label> : null}
        </div>
        {useComfy && comfyAvailable ? <ComfyUiImageFields workflows={comfy.workflows} input={currentComfyInput} references={comfyShot?.references ?? []}
          disabled={Boolean(pending) || busy} onChange={input => { setComfyInput(input); resetQuote(); }} /> : null}
        <button type="button" disabled={busy || checkingComfy || Boolean(pending) || !props.usable || !imageReady || (capability !== "image.generate" && props.approved === false) || (capability === "video.generate" && !imageId)} onClick={() => void getQuote()}>查看本次费用</button>
        {quote ? <div className={styles.quote}>
          {quote.estimateBasis === "self-hosted-resource-estimate"
            ? <p>自托管资源估算 {quote.estimatedAmount} {quote.currency}，实际成本未知。</p>
            : <p>本次{LABEL[quote.capability]}估算 {quote.estimatedAmount} {quote.currency}。实际账单待服务商核实。</p>}
          <label>本次费用上限（{quote.currency}）
            <input value={maximum} inputMode="decimal" disabled={busy || Boolean(pending)} onChange={e => { setMaximum(e.target.value); setConfirmed(false); }} />
          </label>
          <p>可确认范围：{quote.estimatedAmount} ～ {quote.maximumAmount} {quote.currency}。{quote.estimateBasis === "self-hosted-resource-estimate" ? "用于应用资源额度授权。" : "这是应用预约上限，不能替代云账号消费限额。"}</p>
          {quote.uncertainJobIds?.length ? <label className={styles.warning}>
            <input type="checkbox" checked={uncertainConfirmed} onChange={e => setUncertainConfirmed(e.target.checked)} />
            {quote.estimateBasis === "self-hosted-resource-estimate"
              ? `先前有 ${quote.uncertainJobIds.length} 个结果未知的请求；我已核查，确认新调用可能再次占用资源。`
              : `先前有 ${quote.uncertainJobIds.length} 个结果未知的请求；我已核查，确认新调用可能重复收费，原费用仍待核实。`}
          </label> : null}
          {quote.uncertainJobIds?.length ? <details><summary>核查先前结果未知的任务</summary>
            {quote.uncertainJobIds.map(id => <p key={id}><code>{id}</code> <button type="button" onClick={() => {
              const read = ++jobRead.current;
              void api.job(id).then(value => { if (mounted.current && read === jobRead.current) showJob(value); })
                .catch(e => { if (mounted.current && read === jobRead.current) setError(detail(e)); });
            }}>核查任务 {id.slice(0, 8)}</button></p>)}
          </details> : null}
          <label><input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />{quote.estimateBasis === "self-hosted-resource-estimate" ? "我确认本次资源额度，只提交一次生成。" : "我确认本次可能收费，只提交一次生成。"}</label>
          <button type="button" disabled={busy || !props.usable || !imageReady || (capability !== "image.generate" && props.approved === false) || !amountValid || !confirmed || Boolean(pending) || Boolean(storageError)
            || (Boolean(quote.uncertainJobIds?.length) && !uncertainConfirmed)} onClick={() => void submit()}>确认生成{LABEL[quote.capability]}</button>
        </div> : null}</> : null}
        <div className={styles.assets}>
          {assets.map(asset => <article key={asset.id}>
            <p>{({ IMAGE: "图片", VIDEO: "视频", AUDIO: "配音", MUSIC: "背景音乐" })[asset.kind]} · {asset.status === "ACTIVE" ? "当前可用" : "历史版本"}
              {asset.durationMs ? " · 实测 " + (asset.durationMs / 1000).toFixed(2) + " 秒" : ""}</p>
            {asset.kind === "IMAGE" && asset.sourceGenerationJobId && usableComfyJobs.has(asset.sourceGenerationJobId) ?
              <HoverMediaPreview kind="image" label={"已生成图片 " + asset.id.slice(0, 8)} src={"/api/v1/real-media/assets/" + asset.id + "/content"} />
              : asset.kind === "IMAGE" ? <img alt={"已生成图片 " + asset.id.slice(0, 8)} src={"/api/v1/real-media/assets/" + asset.id + "/content"} />
              : asset.kind === "VIDEO" ? <video controls playsInline preload="metadata" src={"/api/v1/real-media/assets/" + asset.id + "/content"} />
                : <audio controls preload="none" src={"/api/v1/real-media/assets/" + asset.id + "/content"} />}
            {asset.kind === "IMAGE" && asset.id === comfyShot?.selectedAssetId ? <p className={styles.adopted}>
              {asset.status === "ACTIVE" && props.usable && props.approved !== false ? "已采用到当前镜头" : "历史采用版本"}
            </p> : asset.kind === "IMAGE" && asset.status === "ACTIVE" && asset.sourceGenerationJobId && usableComfyJobs.has(asset.sourceGenerationJobId) ?
              <button type="button" disabled={comfyBusy || !props.usable || props.approved === false || comfyShot?.selectionAvailable !== true} onClick={() => void adoptImage(asset)}>采用此版</button> : null}
          </article>)}
        </div>
        {cursor ? <button type="button" disabled={busy} onClick={() => { const readGeneration = generation.current; void api.assets(props.shotRevisionId, cursor).then(page => {
          if (!mounted.current || readGeneration !== generation.current) return;
          loadedPages.current++;
          setAssets(previous => [...previous, ...page.items.filter(a => !previous.some(p => p.id === a.id))]); setCursor(page.nextCursor);
        }).catch(e => { if (mounted.current && readGeneration === generation.current) setError(detail(e)); }); }}>加载更多制作结果</button> : null}
        <div className={styles.fields}>
          <label>本段配音对应的视频<select value={videoId} onChange={e => { setVideoId(e.target.value); receiveMix(null); }}>
            <option value="">请选择已生成的视频</option>{videos.map(a => <option key={a.id} value={a.id}>视频 {a.id.slice(0, 8)} · 实测 {((a.durationMs ?? 0) / 1000).toFixed(2)} 秒</option>)}
          </select></label>
          <label>本段背景音乐<select value={musicId} onChange={e => { setMusicId(e.target.value); receiveMix(null); }}>
            <option value="">不加音乐</option>{active.filter(a => a.kind === "MUSIC").map(a => <option key={a.id} value={a.id}>背景音乐 {a.id.slice(0, 8)}</option>)}
          </select></label>
        </div>
        <SpeechPanel projectId={props.projectId} shotRevisionId={props.shotRevisionId} dialogue={props.dialogue}
          characters={characters} videoAssetId={videoId || null} musicAssetId={musicId || null} refreshEpoch={props.refreshEpoch}
          onJobAccepted={() => changed.current?.()} onChanged={() => setReadTick(v => v + 1)} onPreflight={receiveMix} />
        {mix ? <div className={styles.quote}>
          <p>对白、逐句选用音频、字幕和画面时长检查通过。合成使用原选用音频，超时会阻断。</p>
          <button type="button" disabled={busy || Boolean(pending) || Boolean(composePending) || Boolean(storageError)} onClick={() => void renderMix()}>合成本段画面、声音与字幕</button>
        </div> : null}
      </> : null}
      {comfySupported && (comfyReadError || comfyShot?.jobs.length || comfyShot?.selectionAvailable === false) ? <section aria-label="ComfyUI 生成任务" className={styles.comfyJobs}>
        <h3>ComfyUI 生成任务</h3>
        {comfyReadError ? <p role="status">暂时无法读取任务，原任务仍可从服务端查询。</p> : null}
        {comfyShot?.selectionAvailable === false ? <p role="status">当前环境尚未启用镜头图片选用。</p> : null}
        {comfyShot?.jobs.map(item => <div key={item.jobId} className={styles.comfyJob}>
          <p role="status"><code>{item.jobId.slice(0, 8)}</code> · {comfyUiJobLabel(item)}</p>
          {item.canCancel && !comfyUiJobSettled(item) ? <button type="button" disabled={comfyBusy} onClick={() => void cancelComfyJob(item.jobId)}>取消任务 {item.jobId.slice(0, 8)}</button>
            : !comfyUiJobSettled(item) && item.state !== "UNKNOWN" && item.errorCode !== "REAL_MEDIA_SUBMISSION_UNKNOWN" ? <p>当前阶段暂不支持定向取消。</p> : null}
        </div>)}
        <button type="button" onClick={() => setComfyTick(value => value + 1)}>刷新 ComfyUI 任务</button>
      </section> : null}
      {job && !hasComfyJob ? <p role="status">原任务：{job.errorCode === "REAL_MEDIA_SUBMISSION_UNKNOWN" ? "结果待核实，可能已产生费用，不会自动重新生成"
        : ({ QUEUED: "等待处理", RUNNING: "制作中", WAITING_EXTERNAL: "等待服务商结果", SUCCEEDED: "已完成，请试听或查看", FAILED: "未完成，请查看任务原因", CANCELED: "已停止本地处理；已发出的生成仍可能计费" } as Record<string, string>)[job.state] ?? "等待处理"}
        <button type="button" onClick={() => { setError(null); const read = ++jobRead.current; const id = job.id; void api.job(id).then(value => {
          if (mounted.current && read === jobRead.current && currentJob.current?.id === id) { showJob(value); if (TERMINAL.has(value.state)) setReadTick(v => v + 1); }
        }).catch(e => { if (mounted.current && read === jobRead.current) setError(detail(e)); }); }}>查询原任务</button></p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {error ? <p role="alert" className={styles.error}>{error}</p> : null}
    </div> : null}
  </section>;
}
