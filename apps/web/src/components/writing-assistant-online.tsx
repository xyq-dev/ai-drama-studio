"use client";

import { useEffect, useRef, useState } from "react";
import type {
  TitleWritingProviderKey,
  WritingCandidateEpisodeRequest,
  WritingCandidateOptionsView,
  WritingCandidateStart,
  WritingCandidateState,
  WritingCandidateStoryRequest,
  WritingCandidateView,
} from "@ai-drama/contracts";
import {
  DomainError,
  formatWritingImport,
  parseWritingImport,
  type FrozenWritingContext,
  type WritingImport,
} from "@ai-drama/domain/writing-assistant";
import { TitleWritingError, tokenRequired } from "../lib/title-writing-client";
import {
  WritingCandidateClient,
  candidateErrorText,
  candidateStateText,
  candidateTerminal,
} from "../lib/writing-candidate-client";

const POLL_MS = 1_500;
const defaultClient = new WritingCandidateClient();

/**
 * The request this tab asked for on one target (sessionStorage, this tab only), saved before it is sent so that a
 * reload, a lost answer or a page switch can only confirm or replay that same request (same key, same body).
 */
interface OnlineRecord {
  version: 1;
  projectId: string;
  entityKey: string;
  key: string;
  body: WritingCandidateStart;
  frozen: FrozenWritingContext;
  requestId: string | null;
  state: WritingCandidateState | "sending";
  errorCode: string | null;
  /** The completed candidate was handed to the assistant once; it is never handed over again on its own. */
  delivered: boolean;
}

function recordKey(projectId: string, entityKey: string): string {
  return `ads-writing-online:${projectId}:${entityKey}`;
}

function readRecord(projectId: string, entityKey: string): OnlineRecord | null {
  try {
    const raw = window.sessionStorage.getItem(recordKey(projectId, entityKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<OnlineRecord> | null;
    if (!parsed || parsed.version !== 1 || parsed.projectId !== projectId || parsed.entityKey !== entityKey
      || typeof parsed.key !== "string" || !parsed.body || !parsed.frozen) return null;
    return parsed as OnlineRecord;
  } catch {
    return null;
  }
}

function writeRecord(record: OnlineRecord): boolean {
  try {
    window.sessionStorage.setItem(recordKey(record.projectId, record.entityKey), JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/**
 * Only refusals the server makes after looking the key up end a request (it then knows no request was stored under it,
 * or refused this input). A lost answer, a 5xx, or a refusal of the access gate (401 login, 403 operator, 404 switched
 * off) keep the record: those come before the key lookup, so an earlier send of the same key may still exist.
 */
const AFTER_KEY_LOOKUP = new Set(["WRITING_CANDIDATE_ACTIVE", "WRITING_CANDIDATE_NEEDS_CONFIRMATION", "WRITING_CANDIDATE_TARGET_INVALID",
  "WRITING_CANDIDATE_DAILY_CAP", "WRITING_CANDIDATE_MODEL_UNAVAILABLE", "IDEMPOTENCY_KEY_REUSED", "VALIDATION_ERROR"]);
function decided(error: unknown): error is TitleWritingError {
  return error instanceof TitleWritingError && AFTER_KEY_LOOKUP.has(error.code);
}

export function candidateImport(view: WritingCandidateView): WritingImport | null {
  if (!view.candidate) return null;
  try {
    const value = view.candidate.mode === "story" ? view.candidate.plan : view.candidate.draft;
    const imported = parseWritingImport(new TextEncoder().encode(JSON.stringify(value)), { mode: view.mode, episodeNo: view.episodeNo });
    formatWritingImport(imported);
    return imported;
  } catch {
    return null;
  }
}

function unavailableText(options: WritingCandidateOptionsView | null, failed: boolean): string | null {
  if (failed) return "没能读取在线创作的服务端配置。仍可使用下方的复制指令与导入。";
  if (!options) return null;
  switch (options.code) {
    case "WRITING_CANDIDATE_READY":
      return null;
    case "WRITING_CANDIDATE_DISABLED":
      return "在线创作没有在服务端开启。仍可使用下方的复制指令与导入。";
    case "WRITING_CANDIDATE_FORBIDDEN":
      return "服务端没有可用的调用授权（未启用站点登录，也没有设置操作者令牌）。";
    case "WRITING_CANDIDATE_STORAGE_UNAVAILABLE":
      return "在线候选的数据库迁移（20261016000200_writing_candidate）尚未执行，暂时不能在线生成。";
    case "WRITING_CANDIDATE_PROVIDER_UNCONFIGURED":
      return "尚未配置 Claude API Key。请管理员在模型后台填写后，由服务器重启 API 生效。";
    default:
      return "在线创作暂时不可用。";
  }
}

const SHORT_STATE: Record<WritingCandidateState, string> = {
  reserved: "请求中",
  submitted: "请求中",
  completed: "已生成",
  rejected: "未得到候选",
  unknown: "结果不确定",
};

export function OnlineCandidatePanel(props: {
  mode: "story" | "episode";
  projectId: string;
  entityKey: string;
  episodeId: string | null;
  client?: WritingCandidateClient;
  /** The request and its frozen context from the inputs as they are now, or why it cannot be asked for. */
  prepare: () => { request: WritingCandidateStoryRequest | WritingCandidateEpisodeRequest; frozen: FrozenWritingContext } | { error: string };
  /** A validated candidate with the context it was asked for. It is only shown; adopting stays the person's action. */
  onCandidate: (imported: WritingImport, frozen: FrozenWritingContext) => void;
}) {
  const client = props.client ?? defaultClient;
  const identity = `${props.projectId}:${props.entityKey}`;
  const [boundIdentity, setBoundIdentity] = useState(identity);
  const [options, setOptions] = useState<WritingCandidateOptionsView | null>(null);
  const [optionsFailed, setOptionsFailed] = useState(false);
  const [record, setRecord] = useState<OnlineRecord | null>(() => readRecord(props.projectId, props.entityKey));
  const [history, setHistory] = useState<WritingCandidateView[]>([]);
  const [historyError, setHistoryError] = useState(false);
  const [viewing, setViewing] = useState<string | null>(null);
  const [providerKey, setProviderKey] = useState<TitleWritingProviderKey | "">("");
  const [model, setModel] = useState("");
  const [token, setToken] = useState("");
  const [uncertainId, setUncertainId] = useState<string | null>(null);
  const [confirmUncertain, setConfirmUncertain] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  // Grows with every target change and unmount: an answer for an earlier target or mount changes nothing.
  const epoch = useRef(0);
  const identityRef = useRef(identity);
  identityRef.current = identity;

  if (boundIdentity !== identity) {
    setBoundIdentity(identity);
    setRecord(readRecord(props.projectId, props.entityKey));
    setHistory([]);
    setViewing(null);
    setUncertainId(null);
    setConfirmUncertain(false);
    setMessage(null);
    setSending(false);
    sendingRef.current = false;
  }

  function current(mine: number, forIdentity: string): boolean {
    return epoch.current === mine && identityRef.current === forIdentity;
  }

  function save(next: OnlineRecord | null, mine: number, forIdentity: string): void {
    if (!current(mine, forIdentity)) return;
    if (next && !writeRecord(next)) setMessage("本页请求记录没有写入浏览器存储。刷新后可能无法确认这次请求。");
    setRecord(next);
  }

  async function loadHistory(mine: number, forIdentity: string): Promise<WritingCandidateView[] | null> {
    try {
      const items = await client.list(props.projectId, { mode: props.mode, episodeId: props.episodeId });
      if (!current(mine, forIdentity)) return null;
      setHistory(items);
      setHistoryError(false);
      const latest = items[0];
      setUncertainId(latest?.state === "unknown" ? latest.requestId : null);
      return items;
    } catch {
      if (current(mine, forIdentity)) setHistoryError(true);
      return null;
    }
  }

  /** Reads the request until it ends. Each read belongs to this target and mount only. */
  async function follow(requestId: string, base: OnlineRecord, mine: number, forIdentity: string): Promise<void> {
    let latest = base;
    for (;;) {
      if (!current(mine, forIdentity)) return;
      let view: WritingCandidateView;
      try {
        view = await client.get(props.projectId, requestId);
      } catch (caught) {
        if (!current(mine, forIdentity)) return;
        if (caught instanceof TitleWritingError && caught.status === 401) {
          // The login ended: stop reading. The request stays recorded and is read again after logging in and reopening.
          setMessage("登录已过期，暂停读取请求结果。请求本身不会因此重发；重新登录后打开编剧助手会继续读取。");
          setSending(false);
          sendingRef.current = false;
          return;
        }
        setMessage(caught instanceof TitleWritingError && caught.status === 404
          ? "服务端没有找到这次请求。"
          : "暂时没能读取请求结果。请求本身不会因此重发，稍后会再次读取。");
        await new Promise((resolve) => setTimeout(resolve, POLL_MS * 2));
        continue;
      }
      if (!current(mine, forIdentity)) return;
      latest = { ...latest, requestId, state: view.state, errorCode: view.errorCode };
      if (candidateTerminal(view)) {
        if (view.state === "completed" && !latest.delivered) {
          const imported = candidateImport(view);
          if (imported) {
            props.onCandidate(imported, latest.frozen);
            latest = { ...latest, delivered: true };
            setMessage("候选已生成，已放进下面的预览。请比较差异后再决定是否采纳；采纳前正文不会改变。");
          } else {
            setMessage("服务端返回的候选没有通过本页校验，没有放进预览。");
          }
        } else {
          setMessage(candidateStateText(view));
        }
        save(latest, mine, forIdentity);
        setSending(false);
        sendingRef.current = false;
        await loadHistory(mine, forIdentity);
        return;
      }
      save(latest, mine, forIdentity);
      setMessage(candidateStateText(view));
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }

  useEffect(() => {
    epoch.current += 1;
    const mine = epoch.current;
    const forIdentity = identity;
    setOptions(null);
    setOptionsFailed(false);
    void client.options().then((value) => {
      if (!current(mine, forIdentity)) return;
      setOptions(value);
      const chosen = value.defaultProvider;
      setProviderKey(chosen ?? "");
      setModel(value.providers.find((item) => item.providerKey === chosen)?.defaultModel ?? "");
    }).catch(() => { if (current(mine, forIdentity)) setOptionsFailed(true); });
    void loadHistory(mine, forIdentity);
    // A request this tab sent earlier and whose end it has not seen: only read it again, never send anything.
    const stored = readRecord(props.projectId, props.entityKey);
    if (stored?.requestId && (stored.state === "reserved" || stored.state === "submitted" || (stored.state === "completed" && !stored.delivered))) {
      setSending(true);
      sendingRef.current = true;
      void follow(stored.requestId, stored, mine, forIdentity);
    }
    return () => { epoch.current += 1; };
    // One effect per target; the helpers read the latest props through refs and the epoch.
  }, [identity]);

  const readyProviders = options?.providers.filter((item) => item.ready) ?? [];
  const chosen = readyProviders.find((item) => item.providerKey === providerKey) ?? null;
  const needsToken = tokenRequired(options);
  const unavailable = unavailableText(options, optionsFailed);
  const unconfirmed = record !== null && record.requestId === null;
  const open = record?.requestId && (record.state === "reserved" || record.state === "submitted");
  const blocked = !options || unavailable !== null || sending || Boolean(open)
    || (needsToken && token.trim().length === 0) || (!unconfirmed && uncertainId !== null && !confirmUncertain);

  async function send(next: OnlineRecord, mine: number, forIdentity: string): Promise<void> {
    try {
      const view = await client.start(props.projectId, next.body, { token: needsToken ? token.trim() : "", idempotencyKey: next.key });
      if (!current(mine, forIdentity)) return;
      const accepted = { ...next, requestId: view.requestId, state: view.state, errorCode: view.errorCode };
      save(accepted, mine, forIdentity);
      setConfirmUncertain(false);
      await follow(view.requestId, accepted, mine, forIdentity);
    } catch (caught) {
      if (!current(mine, forIdentity)) return;
      setSending(false);
      sendingRef.current = false;
      if (decided(caught)) {
        // The server refused before sending anything: this request is over and the form is free again.
        if (caught.code === "WRITING_CANDIDATE_NEEDS_CONFIRMATION" && typeof caught.details?.requestId === "string") {
          setUncertainId(caught.details.requestId);
          setConfirmUncertain(false);
        }
        save(null, mine, forIdentity);
        try { window.sessionStorage.removeItem(recordKey(props.projectId, props.entityKey)); } catch { /* storage unavailable */ }
        setMessage(`${caught.detail}${caught.code === "WRITING_CANDIDATE_ACTIVE" ? "可以在下面的记录里查看它。" : ""}`);
        void loadHistory(mine, forIdentity);
        return;
      }
      setMessage(caught instanceof TitleWritingError && caught.status < 500 && caught.code !== "REQUEST_FAILED"
        ? `${caught.detail}请求记录已保留：恢复登录或权限后，再次点击会用同一个请求标识确认，不会重复发送。`
        : "没有确认这次请求是否已被受理（网络或服务异常）。再次点击会用同一个请求标识确认，不会重复发送。");
    }
  }

  async function generate(): Promise<void> {
    if (sendingRef.current) return;
    const mine = epoch.current;
    const forIdentity = identity;
    if (unconfirmed && record) {
      sendingRef.current = true;
      setSending(true);
      setMessage("正在确认上次请求…");
      await send(record, mine, forIdentity);
      return;
    }
    if (blocked || !chosen) return;
    const prepared = props.prepare();
    if ("error" in prepared) {
      setMessage(prepared.error);
      return;
    }
    const body: WritingCandidateStart = props.mode === "story"
      ? { mode: "story", providerKey: chosen.providerKey, model: model || chosen.defaultModel!, request: prepared.request as WritingCandidateStoryRequest,
        base: { sourceRevisionId: prepared.frozen.sourceRevisionId, ifMatch: prepared.frozen.ifMatch! },
        ...(uncertainId ? { confirmUncertainRequestId: uncertainId } : {}) }
      : { mode: "episode", episodeId: props.episodeId!, providerKey: chosen.providerKey, model: model || chosen.defaultModel!,
        request: prepared.request as WritingCandidateEpisodeRequest,
        base: { sourceRevisionId: prepared.frozen.sourceRevisionId, ifMatch: prepared.frozen.ifMatch! },
        ...(uncertainId ? { confirmUncertainRequestId: uncertainId } : {}) };
    const next: OnlineRecord = { version: 1, projectId: props.projectId, entityKey: props.entityKey, key: crypto.randomUUID(),
      body, frozen: prepared.frozen, requestId: null, state: "sending", errorCode: null, delivered: false };
    // Saved before the request that uses the key; without it a lost answer could not be confirmed.
    if (!writeRecord(next)) {
      setMessage("本页请求记录没有写入浏览器存储，没有发出请求。");
      return;
    }
    sendingRef.current = true;
    setSending(true);
    setRecord(next);
    setMessage("正在请求模型…");
    await send(next, mine, forIdentity);
  }

  function abandon(): void {
    if (sendingRef.current || !record || record.requestId !== null) return;
    try { window.sessionStorage.removeItem(recordKey(props.projectId, props.entityKey)); } catch { /* storage unavailable */ }
    setRecord(null);
    setMessage("已放弃上次未确认的请求。它如果已被服务端受理，结果仍会出现在下面的记录里，可能已经产生费用。");
  }

  const viewed = history.find((item) => item.requestId === viewing) ?? null;
  const viewedImport = viewed ? candidateImport(viewed) : null;
  let viewedText = "";
  if (viewedImport) {
    try {
      viewedText = formatWritingImport(viewedImport);
    } catch (caught) {
      viewedText = caught instanceof DomainError ? caught.message : "";
    }
  }

  return (
    <section className="rounded border border-neutral-200 p-3" aria-label="在线生成候选" data-testid="online-candidate">
      <h3 className="font-medium">在线生成候选</h3>
      <p className="text-sm text-neutral-600">由网站服务端调用模型，只生成候选。候选放进下面的预览后，由你比较、采纳到草稿，再用「保存新版本」保存。</p>
      {!options && !optionsFailed ? <p className="text-sm" role="status">正在读取在线创作配置…</p> : null}
      {unavailable ? (
        <p className="text-sm" role="status" data-testid="online-unavailable">
          {unavailable}
          {options?.code === "WRITING_CANDIDATE_PROVIDER_UNCONFIGURED" ? <> <a className="underline" href="/admin/models">打开模型后台</a></> : null}
        </p>
      ) : null}
      {options && !unavailable && chosen ? (
        <p className="text-sm" data-testid="online-provider">使用 {chosen.label} · {model || chosen.defaultModel}。费用以服务商账单为准，本页不估算金额。</p>
      ) : null}
      {options && !unavailable && readyProviders.length > 0 ? (
        <details className="text-sm">
          <summary>高级设置（可不填）</summary>
          <label className="mt-1 block">模型服务
            <select className="mt-1 w-full rounded border px-2 py-1" value={providerKey} disabled={sending}
              onChange={(event) => {
                const next = event.target.value as TitleWritingProviderKey;
                setProviderKey(next);
                setModel(readyProviders.find((item) => item.providerKey === next)?.defaultModel ?? "");
              }}>
              {readyProviders.map((item) => <option key={item.providerKey} value={item.providerKey}>{item.label}</option>)}
            </select>
          </label>
          <label className="mt-1 block">模型
            <select className="mt-1 w-full rounded border px-2 py-1" value={model} disabled={sending} onChange={(event) => setModel(event.target.value)}>
              {(chosen?.models ?? []).map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
          <p className="mt-1 text-neutral-600">失败时不会自动换模型或模型服务。</p>
        </details>
      ) : null}
      {options && !unavailable && needsToken ? (
        <label className="mt-2 block text-sm">操作者令牌
          <input className="mt-1 w-full rounded border px-2 py-1" type="password" autoComplete="off" value={token} disabled={sending}
            onChange={(event) => setToken(event.target.value)} />
        </label>
      ) : null}
      {uncertainId && !unconfirmed ? (
        <label className="mt-2 block text-sm">
          <input className="mr-2" type="checkbox" checked={confirmUncertain} disabled={sending} onChange={(event) => setConfirmUncertain(event.target.checked)} />
          我知道上一次结果不确定的请求可能已经产生费用，确认发起新的生成。
        </label>
      ) : null}
      {unconfirmed ? (
        <div className="mt-2 text-sm" role="status">
          <p>上次的在线生成请求还没有确认是否被受理。再次点击会原样重放它（同一个请求标识），服务端不会重复发送。</p>
          <button className="underline" type="button" disabled={sending} onClick={abandon}>放弃上次请求</button>
        </div>
      ) : null}
      <button className="mt-2 rounded bg-neutral-900 px-3 py-1 text-sm text-white disabled:opacity-50" type="button"
        disabled={unconfirmed ? sending || (needsToken && token.trim().length === 0) : blocked} onClick={() => void generate()}>
        {sending ? "正在生成…" : unconfirmed ? "确认上次请求" : props.mode === "story" ? "在线生成故事候选" : "在线生成本集候选"}
      </button>
      {message ? <p className="mt-2 text-sm [overflow-wrap:anywhere]" role="status" data-testid="online-message">{message}</p> : null}
      <div className="mt-3">
        <h4 className="text-sm font-medium">在线生成记录</h4>
        {historyError ? <p className="text-sm" role="status">暂时没能读取记录。</p> : null}
        {history.length === 0 && !historyError ? <p className="text-sm text-neutral-600">这个编辑对象还没有在线生成记录。</p> : null}
        <ul className="space-y-1 text-sm">
          {history.map((item) => (
            <li key={item.requestId} className="[overflow-wrap:anywhere]">
              {new Date(item.createdAt).toLocaleString("zh-CN", { hour12: false })} · {item.providerLabel} {item.model} · {SHORT_STATE[item.state]}
              {item.state === "rejected" ? `（${candidateErrorText(item.errorCode)}）` : ""}
              {item.state === "unknown" ? "（可能已产生费用）" : ""}
              {item.state === "completed" ? (
                <button className="ml-2 underline" type="button" onClick={() => setViewing(viewing === item.requestId ? null : item.requestId)}>
                  {viewing === item.requestId ? "收起" : "查看"}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        {viewed ? (
          <label className="mt-2 block text-sm">历史候选（只读，不能从这里采纳）
            <textarea className="mt-1 w-full rounded border px-2 py-1 text-sm [overflow-wrap:anywhere]" readOnly rows={6} value={viewedText || "这条候选没有通过本页校验，不显示。"} />
          </label>
        ) : null}
      </div>
    </section>
  );
}
