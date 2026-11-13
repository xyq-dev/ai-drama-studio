"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { RealMediaQuote } from "@ai-drama/contracts";
import { useModalKeyboard } from "../lib/modal-keyboard";
import {
  clearRealMediaPending,
  COMFYUI_PROMPT_LIMIT,
  createRealMediaClient,
  readRealMediaPending,
  rememberRealMediaPending,
  type ComfyUiWorkflow,
  type RealMediaClient,
  type RealMediaPending,
} from "../lib/real-media-client";
import { ApiError } from "../lib/studio-client";
import {
  STORYBOARD_IMAGE_BATCH_PREFIX,
  WORKBENCH_DRAFTS_CLEARED_EVENT,
} from "../lib/script-workbench-drafts";
import { comfyUiAvailability } from "./comfyui-image-fields";
import styles from "./storyboard-image-batch.module.css";

const LIMIT = 10;
const SCALE = 100_000_000n;
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const statuses = {
  unsent: "未发送",
  unavailable: "未取得报价",
  pending: "回执待确认",
  refused: "提交已拒绝",
  accepted: "任务已受理",
};
const refusalCodes = new Set([
  "REAL_MEDIA_QUOTE_EXPIRED",
  "REAL_MEDIA_INPUT_CHANGED",
  "REAL_MEDIA_CONFIGURATION_CHANGED",
  "REAL_MEDIA_UNCERTAIN_CHANGED",
  "REAL_MEDIA_AUTHORIZATION_INVALID",
  "REAL_MEDIA_BUDGET_MISMATCH",
  "REAL_MEDIA_AUTHORIZATION_USED",
]);

interface BatchShot {
  shotRevisionId: string;
  label: string;
  promptText: string;
}
interface Props {
  projectId: string;
  shots: readonly BatchShot[];
  onDispatched?: () => void;
  client?: Pick<RealMediaClient, "capabilities" | "quote" | "authorize" | "generate">;
}
type ReportRow = Pick<BatchShot, "shotRevisionId" | "label"> & {
  status: keyof typeof statuses;
  requestKey?: string;
  jobId?: string;
  detail?: string;
};
type QuoteRow = Pick<BatchShot, "shotRevisionId" | "label"> & {
  quote?: RealMediaQuote;
  detail?: string;
};
type Phase = "input" | "quoted" | "report";

function units(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(8, "0"));
}
function amount(value: bigint): string {
  const remainder = (value % SCALE).toString().padStart(8, "0").replace(/0+$/, "");
  return (value / SCALE).toString() + (remainder ? "." + remainder : "");
}
function sizeValue(size: { width: number; height: number }): string {
  return size.width + "×" + size.height;
}

function reportKey(projectId: string): string {
  return STORYBOARD_IMAGE_BATCH_PREFIX + projectId;
}
function readReport(projectId: string): ReportRow[] {
  const saved = sessionStorage.getItem(reportKey(projectId));
  if (!saved) return [];
  const value: unknown = JSON.parse(saved);
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > LIMIT ||
    !value.every(
      (row) =>
        row &&
        UUID.test(row.shotRevisionId) &&
        typeof row.label === "string" &&
        Object.hasOwn(statuses, row.status) &&
        (row.requestKey === undefined || UUID.test(row.requestKey)) &&
        (row.jobId === undefined || UUID.test(row.jobId)) &&
        (row.detail === undefined || typeof row.detail === "string"),
    )
  ) {
    throw new Error("上次批量记录无法核对，请在单镜任务中查看原请求。");
  }
  return value;
}
function saveReport(projectId: string, rows: ReportRow[]): void {
  const text = JSON.stringify(rows);
  const key = reportKey(projectId);
  sessionStorage.setItem(key, text);
  if (sessionStorage.getItem(key) !== text) throw new Error("浏览器无法保留本次提交记录。");
}

export function StoryboardImageBatch(props: Props) {
  return <BatchScope key={props.projectId} {...props} />;
}

function BatchScope({ projectId, shots, onDispatched, client }: Props) {
  const fallback = useRef<RealMediaClient | null>(null);
  if (!fallback.current) fallback.current = createRealMediaClient();
  const api = client ?? fallback.current;
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("input");
  const [frozen, setFrozen] = useState<BatchShot[]>([]);
  const [workflows, setWorkflows] = useState<ComfyUiWorkflow[]>([]);
  const [workflowId, setWorkflowId] = useState("");
  const [size, setSize] = useState("");
  const [quotes, setQuotes] = useState<QuoteRow[]>([]);
  const [report, setReport] = useState<ReportRow[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [unknownConfirmed, setUnknownConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const live = useRef(true);
  const signedOut = useRef(false);
  const busyRef = useRef(false);
  const opener = useRef<HTMLElement | null>(null);
  const modal = useRef<HTMLDivElement>(null);
  const title = useId();
  const workflow = workflows.find((item) => item.id === workflowId);
  const dimensions = workflow?.dimensions.find((item) => sizeValue(item) === size);
  const quoted = quotes.flatMap((row) => (row.quote ? [{ ...row, quote: row.quote }] : []));
  const total = amount(quoted.reduce((sum, row) => sum + units(row.quote.estimatedAmount), 0n));
  const hasUnknown = quoted.some((row) => row.quote.uncertainJobIds?.length);
  const hasUnsettled = report.some((row) => row.status === "pending" || row.status === "refused");

  useEffect(() => {
    live.current = true;
    try {
      setReport(readReport(projectId));
    } catch {
      setMessage("上次批量记录无法核对，请在单镜任务中查看原请求。");
    }
    function clear() {
      signedOut.current = true;
      live.current = false;
      setReport([]);
      setOpen(false);
    }
    window.addEventListener(WORKBENCH_DRAFTS_CLEARED_EVENT, clear);
    return () => {
      live.current = false;
      window.removeEventListener(WORKBENCH_DRAFTS_CLEARED_EVENT, clear);
    };
  }, [projectId]);

  function close() {
    if (!busyRef.current) setOpen(false);
  }
  useModalKeyboard(open, modal, close);
  useEffect(() => {
    if (!open) return;
    modal.current?.focus();
    const trigger = opener.current;
    return () => {
      if (trigger?.isConnected) trigger.focus();
    };
  }, [open]);

  function updateReport(next: ReportRow[]) {
    if (signedOut.current) return;
    saveReport(projectId, next);
    if (live.current) setReport(next);
  }

  function updateRow(id: string, change: Partial<ReportRow>, requestKey?: string) {
    if (signedOut.current) return;
    const current = readReport(projectId);
    updateReport(
      current.map((row) =>
        row.shotRevisionId === id &&
        (!requestKey || (row.requestKey === requestKey && row.status !== "accepted"))
          ? { ...row, ...change }
          : row,
      ),
    );
  }

  function begin() {
    busyRef.current = true;
    setBusy(true);
    setMessage(undefined);
  }
  function end() {
    busyRef.current = false;
    if (live.current) setBusy(false);
  }

  async function start(trigger: HTMLElement) {
    if (busyRef.current || !shots.length || shots.length > LIMIT || hasUnsettled) return;
    const unique = [...new Map(shots.map((shot) => [shot.shotRevisionId, shot])).values()];
    if (unique.length !== shots.length || unique.some((shot) => !UUID.test(shot.shotRevisionId)))
      return;
    opener.current = trigger;
    setOpen(true);
    setPhase("input");
    setFrozen(unique);
    setQuotes([]);
    setWorkflows([]);
    setWorkflowId("");
    setSize("");
    setConfirmed(false);
    setUnknownConfirmed(false);
    begin();
    try {
      const capabilities = await api.capabilities(projectId);
      if (!live.current) return;
      const comfy = capabilities.comfyui;
      if (comfy?.status !== "available") {
        setMessage(comfyUiAvailability[comfy?.status ?? "unconfigured"]);
        return;
      }
      const options = comfy.workflows.filter(
        (item) => !item.requiresReference && item.dimensions.length > 0,
      );
      if (!options[0]) {
        setMessage("当前实例没有可用于批量生成的文生图工作流。");
        return;
      }
      setWorkflows(options);
      setWorkflowId(options[0].id);
      setSize(sizeValue(options[0].dimensions[0]!));
    } catch {
      if (live.current) setMessage("无法读取 ComfyUI 工作流，请关闭窗口后重试。");
    } finally {
      end();
    }
  }

  async function prepareQuotes() {
    if (!workflow || !dimensions || busyRef.current) return;
    begin();
    try {
      const rows: QuoteRow[] = [];
      for (const shot of frozen) {
        if (!live.current) return;
        const { shotRevisionId, label } = shot;
        const prompt = shot.promptText.trim();
        if (
          !prompt ||
          prompt.length > COMFYUI_PROMPT_LIMIT ||
          /embedding:/i.test(prompt) ||
          prompt.includes("\0")
        ) {
          rows.push({ shotRevisionId, label, detail: "请在单镜中补充合法的图片提示词。" });
          continue;
        }
        try {
          if (readRealMediaPending(projectId, shotRevisionId)) {
            rows.push({ shotRevisionId, label, detail: "该镜头已有请求待确认，请到单镜处理。" });
            continue;
          }
          const quote = await api.quote(projectId, shotRevisionId, "image.generate", undefined, {
            workflowId: workflow.id,
            ...dimensions,
            prompt,
          });
          if (quote.currency !== "CNY" || quote.estimateBasis !== "self-hosted-resource-estimate") {
            rows.push({ shotRevisionId, label, detail: "报价类型不符合 ComfyUI 资源估算。" });
          } else rows.push({ shotRevisionId, label, quote });
        } catch {
          rows.push({ shotRevisionId, label, detail: "报价未取得，请检查镜头状态或资源配置。" });
        }
      }
      if (!live.current) return;
      setQuotes(rows);
      setConfirmed(false);
      setUnknownConfirmed(false);
      setPhase("quoted");
    } finally {
      end();
    }
  }

  async function dispatch(initial: RealMediaPending): Promise<void> {
    let request = initial;
    rememberRealMediaPending(request);
    try {
      if (!request.authorizationId) {
        const authorizationId = await api.authorize(
          projectId,
          request.quote,
          request.maximumAmount,
          request.key,
        );
        if (signedOut.current) return;
        request = { ...request, authorizationId };
        rememberRealMediaPending(request);
      }
      if (!live.current) return;
      const accepted = await api.generate(
        projectId,
        request.shotRevisionId,
        request.quote.quoteId,
        request.authorizationId!,
        request.key,
      );
      updateRow(
        request.shotRevisionId,
        {
          status: "accepted",
          jobId: accepted.jobId,
          detail: undefined,
        },
        request.key,
      );
      clearRealMediaPending(request);
      if (live.current) onDispatched?.();
    } catch (error) {
      if (signedOut.current) return;
      if (
        error instanceof ApiError &&
        [409, 422].includes(error.status) &&
        refusalCodes.has(error.code)
      ) {
        updateRow(
          request.shotRevisionId,
          {
            status: "refused",
            detail: "服务端拒绝了原请求。结束它后可重新报价。",
          },
          request.key,
        );
      } else {
        updateRow(
          request.shotRevisionId,
          {
            status: "pending",
            detail: "保留原请求，可继续核对同一提交。",
          },
          request.key,
        );
      }
    }
  }

  async function sendBatch() {
    if (
      busyRef.current ||
      phase !== "quoted" ||
      !confirmed ||
      (hasUnknown && !unknownConfirmed) ||
      !quoted.length
    )
      return;
    begin();
    try {
      updateReport(
        quotes.map((row) => ({
          shotRevisionId: row.shotRevisionId,
          label: row.label,
          status: row.quote ? "unsent" : "unavailable",
          detail: row.detail,
        })),
      );
      setPhase("report");
      for (const row of quoted) {
        if (!live.current) return;
        if (Date.parse(row.quote.expiresAt) <= Date.now()) {
          updateRow(row.shotRevisionId, { detail: "本镜头报价已过期，可重新报价。" });
          continue;
        }
        if (readRealMediaPending(projectId, row.shotRevisionId)) {
          updateRow(row.shotRevisionId, { detail: "该镜头已有请求，请在单镜中继续确认。" });
          continue;
        }
        const request: RealMediaPending = {
          schema: "ads.real-media.pending.v1",
          projectId,
          shotRevisionId: row.shotRevisionId,
          key: crypto.randomUUID(),
          quote: row.quote,
          maximumAmount: row.quote.estimatedAmount,
          authorizationId: null,
        };
        try {
          rememberRealMediaPending(request);
        } catch {
          updateRow(row.shotRevisionId, { detail: "无法保留原请求身份，未发送。" });
          continue;
        }
        try {
          updateRow(row.shotRevisionId, { status: "pending", requestKey: request.key });
        } catch (error) {
          clearRealMediaPending(request);
          throw error;
        }
        await dispatch(request);
      }
    } catch {
      if (live.current) setMessage("批量提交已暂停。请根据逐镜结果查看已受理和未发送的镜头。");
    } finally {
      end();
    }
  }

  async function reconcile(row: ReportRow) {
    if (busyRef.current || !row.requestKey) return;
    begin();
    try {
      const latest = readReport(projectId);
      const current = latest.find((item) => item.shotRevisionId === row.shotRevisionId);
      if (!current || current.requestKey !== row.requestKey || current.status === "accepted") {
        setReport(latest);
        return;
      }
      const request = readRealMediaPending(projectId, row.shotRevisionId);
      if (!request) {
        updateRow(row.shotRevisionId, {
          status: "unavailable",
          requestKey: undefined,
          detail: "本地原请求已处理，请在单镜中查看服务端结果。",
        });
        return;
      }
      if (
        request.key !== row.requestKey ||
        request.quote.estimateBasis !== "self-hosted-resource-estimate"
      ) {
        setMessage("当前标签页无法核对原请求，请在单镜中查看服务端任务。");
        return;
      }
      if (row.status === "refused") {
        if (!clearRealMediaPending(request)) throw new Error("Pending request changed");
        updateRow(row.shotRevisionId, {
          status: "unsent",
          requestKey: undefined,
          detail: "原请求已结束，可重新报价。",
        });
      } else await dispatch(request);
    } catch {
      if (live.current) setMessage("原请求记录无法核对，请到单镜查看任务。");
    } finally {
      end();
    }
  }

  return (
    <>
      <button
        className={styles.primary}
        type="button"
        disabled={!shots.length || shots.length > LIMIT || hasUnsettled}
        onClick={(event) => void start(event.currentTarget)}
      >
        批量生成图片
      </button>
      {shots.length > LIMIT ? <span className={styles.hint}>一次最多 {LIMIT} 个镜头</span> : null}
      {report.length ? (
        <button
          className={styles.secondary}
          type="button"
          onClick={(event) => {
            opener.current = event.currentTarget;
            setMessage(undefined);
            setPhase("report");
            setOpen(true);
          }}
        >
          查看上次批量结果
        </button>
      ) : null}
      {open
        ? createPortal(
            <div
              className={styles.scrim}
              onClick={(event) => {
                if (event.target === event.currentTarget) close();
              }}
            >
              <div
                className={styles.dialog}
                ref={modal}
                role="dialog"
                aria-modal="true"
                aria-labelledby={title}
                aria-busy={busy}
              >
                <header>
                  <h3 id={title}>ComfyUI 批量生图</h3>
                  <button
                    className={styles.secondary}
                    type="button"
                    onClick={close}
                    disabled={busy}
                  >
                    关闭
                  </button>
                </header>
                {message ? (
                  <p className={styles.error} role="alert">
                    {message}
                  </p>
                ) : null}
                {phase === "input" ? (
                  <>
                    <p>已选 {frozen.length} 个镜头，使用各自已保存的图片提示词。</p>
                    {busy ? (
                      <p role="status">{workflow ? "正在逐镜取得报价…" : "正在读取工作流…"}</p>
                    ) : null}
                    {workflow ? (
                      <div className={styles.fields}>
                        <label>
                          批量工作流
                          <select
                            value={workflowId}
                            disabled={busy}
                            onChange={(event) => {
                              const next = workflows.find((item) => item.id === event.target.value);
                              if (next?.dimensions[0]) {
                                setWorkflowId(next.id);
                                setSize(sizeValue(next.dimensions[0]));
                              }
                            }}
                          >
                            {workflows.map((item) => (
                              <option key={item.id} value={item.id}>
                                {item.label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          批量图片尺寸
                          <select
                            value={size}
                            disabled={busy}
                            onChange={(event) => setSize(event.target.value)}
                          >
                            {workflow.dimensions.map((item) => (
                              <option key={sizeValue(item)}>{sizeValue(item)}</option>
                            ))}
                          </select>
                        </label>
                      </div>
                    ) : null}
                    {workflow ? (
                      <footer>
                        <button
                          className={styles.primary}
                          type="button"
                          disabled={busy || !dimensions}
                          onClick={() => void prepareQuotes()}
                        >
                          查看批量报价
                        </button>
                      </footer>
                    ) : null}
                  </>
                ) : null}
                {phase === "quoted" ? (
                  <>
                    <p>
                      可提交 {quoted.length} 个镜头，合计授权额度 <strong>{total} CNY</strong>
                      。这是自托管资源估算，实际成本未知。
                    </p>
                    <ul className={styles.rows}>
                      {quotes.map((row) => (
                        <li key={row.shotRevisionId}>
                          <strong>{row.label}</strong>
                          <span>{row.quote ? row.quote.estimatedAmount + " CNY" : row.detail}</span>
                          {row.quote?.uncertainJobIds?.length ? (
                            <ul className={styles.unknownIds}>
                              {row.quote.uncertainJobIds.map((id) => (
                                <li key={id}>
                                  <code>{id}</code>
                                </li>
                              ))}
                            </ul>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                    {quoted.length ? (
                      <label className={styles.check}>
                        <input
                          type="checkbox"
                          checked={confirmed}
                          disabled={busy}
                          onChange={(event) => setConfirmed(event.target.checked)}
                        />
                        我确认按上述额度逐镜提交。
                      </label>
                    ) : null}
                    {hasUnknown ? (
                      <label className={styles.check}>
                        <input
                          type="checkbox"
                          checked={unknownConfirmed}
                          disabled={busy}
                          onChange={(event) => setUnknownConfirmed(event.target.checked)}
                        />
                        我已核对列出的结果未知任务，仍确认提交，可能重复消耗额度。
                      </label>
                    ) : null}
                    <footer>
                      <button
                        className={styles.secondary}
                        type="button"
                        disabled={busy}
                        onClick={() => setPhase("input")}
                      >
                        返回修改
                      </button>
                      <button
                        className={styles.primary}
                        type="button"
                        disabled={
                          busy || !quoted.length || !confirmed || (hasUnknown && !unknownConfirmed)
                        }
                        onClick={() => void sendBatch()}
                      >
                        确认提交 {quoted.length} 个镜头
                      </button>
                    </footer>
                  </>
                ) : null}
                {phase === "report" ? (
                  <>
                    <p>已受理的任务由后台继续执行。未发送的镜头可重新报价。</p>
                    {busy ? <p role="status">正在逐镜提交或核对原请求…</p> : null}
                    <ul className={styles.rows}>
                      {report.map((row) => (
                        <li key={row.shotRevisionId}>
                          <strong>{row.label}</strong>
                          <span>{statuses[row.status]}</span>
                          {row.jobId ? <code className={styles.jobId}>{row.jobId}</code> : null}
                          {row.detail ? <span className={styles.detail}>{row.detail}</span> : null}
                          {row.requestKey &&
                          (row.status === "pending" || row.status === "refused") ? (
                            <button
                              className={styles.secondary}
                              type="button"
                              disabled={busy}
                              onClick={() => void reconcile(row)}
                            >
                              {row.status === "pending" ? "继续确认原请求" : "结束已拒绝请求"}
                            </button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
