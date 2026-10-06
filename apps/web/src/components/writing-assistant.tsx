"use client";

import { useEffect, useRef, useState } from "react";
import {
  DomainError,
  WRITING_NOTE_MAX_CHARS,
  buildEpisodeDraftInstruction,
  buildStoryPlanInstruction,
  canAdopt,
  formatWritingImport,
  freezeWritingContext,
  parseWritingImport,
  writingInputFingerprint,
  type FrozenWritingContext,
  type WritingImport,
  type WritingTargetSnapshot,
} from "@ai-drama/domain/writing-assistant";
import { lineDiff } from "../lib/studio-model";
import type { QwenWebClient, QwenWebOutcome, QwenWebStatus } from "../lib/qwen-web-client";
import { appendOnce, assistantNote, readProjectDirection } from "../lib/creative-direction-link";
import type { DirectionDraft } from "../lib/creative-taxonomy";

const QWEN_STATUS_TEXT: Record<string, string> = {
  QWEN_WEB_READY: "工作区调用可用",
  QWEN_WEB_DISABLED: "工作区调用未开启（生产环境始终关闭）",
  QWEN_WEB_FORBIDDEN: "操作者令牌不正确",
  QWEN_WEB_PROVIDER_UNCONFIGURED: "服务端没有可用的千问配置",
  QWEN_WEB_STORAGE_UNAVAILABLE: "请求存储尚未就绪，服务端拒绝调用",
  QWEN_WEB_REQUEST_CAP: "已达到本工作区的请求数量上限",
  QWEN_WEB_CONCURRENCY_CAP: "已有请求正在进行，请稍后再试",
  IDEMPOTENCY_KEY_REUSED: "同一请求标识对应了不同输入，服务端拒绝",
  invalid_input: "输入没有通过校验",
};

function qwenText(code: string): string {
  return QWEN_STATUS_TEXT[code] ?? `请求没有完成（${code}）`;
}

interface WorkspaceRequest {
  fingerprint: string;
  key: string;
  requestId: string | null;
}

interface AssistantDraft {
  genre: string;
  audience: string;
  characters: string;
  mustKeep: string;
  mustNotChange: string;
  revisionRequest: string;
  mustKeepDialogue: string;
  mustKeepEnding: string;
  confirmed: boolean;
  instruction: string;
  frozen: FrozenWritingContext | null;
  imported: WritingImport | null;
}

interface ReadPermit {
  readGeneration: number;
  objectKey: string;
  prepareGeneration: number;
  inputFingerprint: string | null;
}

const EMPTY: AssistantDraft = {
  genre: "",
  audience: "",
  characters: "",
  mustKeep: "",
  mustNotChange: "",
  revisionRequest: "",
  mustKeepDialogue: "",
  mustKeepEnding: "",
  confirmed: false,
  instruction: "",
  frozen: null,
  imported: null,
};

function storageKey(projectId: string, entityKey: string): string {
  return `ads-writing:${projectId}:${entityKey}`;
}

function readAssistant(projectId: string, entityKey: string): AssistantDraft {
  try {
    const raw = window.sessionStorage.getItem(storageKey(projectId, entityKey));
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<AssistantDraft>;
    return { ...EMPTY, ...parsed, frozen: parsed.frozen ?? null, imported: parsed.imported ?? null };
  } catch {
    return EMPTY;
  }
}

export function WritingAssistant(props: {
  mode: "story" | "episode";
  projectId: string;
  entityKey: string;
  episodeNo: number | null;
  premise: string;
  confirmedMaterials: string;
  loaded: boolean;
  capture: () => WritingTargetSnapshot;
  onAdopt: (text: string, frozen: FrozenWritingContext) => boolean;
  readFile?: (file: File) => Promise<ArrayBuffer>;
  /** Server-side Qwen calls. The button stays disabled until the server reports the route ready. */
  workspaceQwen?: QwenWebClient;
}) {
  const key = storageKey(props.projectId, props.entityKey);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<AssistantDraft>(() => readAssistant(props.projectId, props.entityKey));
  const [boundKey, setBoundKey] = useState(key);
  const [error, setError] = useState<string | null>(null);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const [differences, setDifferences] = useState<string[]>([]);
  const [adoptNote, setAdoptNote] = useState<string | null>(null);
  const generation = useRef(0);
  const prepareGeneration = useRef(0);
  const draftRef = useRef(draft);
  const identityRef = useRef({ projectId: props.projectId, entityKey: props.entityKey });
  const importRef = useRef<HTMLTextAreaElement>(null);
  const workspaceRequest = useRef<WorkspaceRequest | null>(null);
  const [requestNote, setRequestNote] = useState<string | null>(null);
  // The operator token stays in this component's memory only; it is never written to storage.
  const [qwenToken, setQwenToken] = useState("");
  const [qwenStatus, setQwenStatus] = useState<QwenWebStatus | null>(null);
  const [qwenBusy, setQwenBusy] = useState(false);
  const [qwenFollowUp, setQwenFollowUp] = useState<"none" | "query" | "new">("none");
  const [confirmNewCall, setConfirmNewCall] = useState(false);
  const [projectDirection, setProjectDirection] = useState<DirectionDraft | null>(null);
  const [directionNote, setDirectionNote] = useState<string | null>(null);
  draftRef.current = draft;
  identityRef.current = { projectId: props.projectId, entityKey: props.entityKey };

  if (boundKey !== key) {
    setBoundKey(key);
    setDraft(readAssistant(props.projectId, props.entityKey));
    setError(null);
    setDifferences([]);
    setAdoptNote(null);
    setCopyNote(null);
  }

  useEffect(() => {
    generation.current += 1;
    return () => {
      generation.current += 1;
    };
  }, [props.projectId, props.entityKey, props.episodeNo, props.mode]);

  useEffect(() => {
    setDirectionNote(null);
    try {
      setProjectDirection(props.mode === "story" ? readProjectDirection(window.localStorage, props.projectId) : null);
    } catch {
      setProjectDirection(null);
    }
  }, [props.projectId, props.mode]);

  function applyProjectDirection() {
    if (!projectDirection) return;
    const result = appendOnce(draft.genre, assistantNote(projectDirection), WRITING_NOTE_MAX_CHARS);
    if (!result.ok) {
      setDirectionNote("加入后会超过题材字段长度上限，原内容没有改动。");
      return;
    }
    if (!result.changed) {
      setDirectionNote("题材里已经有这条分类方向，没有重复加入。");
      return;
    }
    update({ genre: result.text });
    setDirectionNote(draft.frozen
      ? "已带入分类方向。输入已变化，之前准备的指令和候选不能直接采纳，请重新准备创作指令。"
      : "已带入分类方向，原有题材内容保留。");
  }

  function persist(next: AssistantDraft) {
    draftRef.current = next;
    setDraft(next);
    try {
      window.sessionStorage.setItem(key, JSON.stringify(next));
      setStorageError(null);
    } catch {
      setStorageError("助手记录没有写入。已有编辑草稿未改动。");
    }
  }

  function update(patch: Partial<AssistantDraft>) {
    persist({ ...draft, ...patch });
    setAdoptNote(null);
  }

  function prepare() {
    generation.current += 1;
    setError(null);
    setDifferences([]);
    setAdoptNote(null);
    if (!props.loaded) {
      setError("目标数据尚未加载成功");
      return;
    }
    if (props.mode === "episode" && !draft.confirmed) {
      setError("请先确认使用当前已加载的故事与分集材料");
      return;
    }
    const live = props.capture();
    try {
      const instruction = props.mode === "story"
        ? buildStoryPlanInstruction(storyRequest(props, draft))
        : buildEpisodeDraftInstruction(episodeRequest(props, draft));
      const fingerprint = inputFingerprint(props, draft);
      const frozen = freezeWritingContext({ ...live, loaded: true }, fingerprint);
      prepareGeneration.current += 1;
      persist({ ...draft, instruction, frozen, imported: null });
    } catch (caught) {
      setError(caught instanceof DomainError ? caught.message : "创作指令没有准备好");
    }
  }

  async function copyInstruction() {
    if (!draft.instruction) return;
    try {
      await navigator.clipboard.writeText(draft.instruction);
      setCopyNote("指令已复制");
    } catch {
      setCopyNote("复制没有完成，请从下面的指令正文手动复制");
    }
  }

  function acceptImport(bytes: Uint8Array, permit: ReadPermit) {
    try {
      const imported = parseWritingImport(bytes, { mode: props.mode, episodeNo: props.episodeNo });
      if (!permitCurrent(permit)) return;
      formatWritingImport(imported);
      if (!permitCurrent(permit)) return;
      persist({ ...draftRef.current, imported });
      if (!permitCurrent(permit)) return;
      setError(null);
      setDifferences([]);
    } catch (caught) {
      if (!permitCurrent(permit)) return;
      setError(caught instanceof DomainError ? caught.message : "候选没有通过校验");
    }
  }

  function importText(value: string) {
    acceptImport(new TextEncoder().encode(value), takePermit());
  }

  async function importFile(file: File) {
    const permit = takePermit();
    try {
      const buffer = props.readFile ? await props.readFile(file) : await file.arrayBuffer();
      if (!permitCurrent(permit)) return;
      acceptImport(new Uint8Array(buffer), permit);
    } catch {
      if (!permitCurrent(permit)) return;
      setError("文件没有读完");
    }
  }

  function takePermit(): ReadPermit {
    generation.current += 1;
    const identity = identityRef.current;
    return {
      readGeneration: generation.current,
      objectKey: storageKey(identity.projectId, identity.entityKey),
      prepareGeneration: prepareGeneration.current,
      inputFingerprint: draftRef.current.frozen?.inputFingerprint ?? null,
    };
  }

  function permitCurrent(permit: ReadPermit): boolean {
    const identity = identityRef.current;
    return permit.readGeneration === generation.current
      && permit.objectKey === storageKey(identity.projectId, identity.entityKey)
      && permit.prepareGeneration === prepareGeneration.current
      && permit.inputFingerprint === (draftRef.current.frozen?.inputFingerprint ?? null);
  }

  async function checkWorkspace() {
    if (!props.workspaceQwen) return;
    if (!qwenToken) {
      setQwenStatus({ code: "QWEN_WEB_FORBIDDEN", ready: false, model: null, retentionDays: null });
      return;
    }
    setQwenBusy(true);
    try {
      setQwenStatus(await props.workspaceQwen.status(qwenToken));
    } catch {
      setQwenStatus({ code: "NETWORK", ready: false, model: null, retentionDays: null });
    } finally {
      setQwenBusy(false);
    }
  }

  function workspaceInput(): unknown {
    return props.mode === "story"
      ? { schema: "qwen.writing.input.v1", mode: "story", ...storyRequest(props, draftRef.current) }
      : { schema: "qwen.writing.input.v1", mode: "episode", ...episodeRequest(props, draftRef.current) };
  }

  function handleOutcome(result: QwenWebOutcome, permit: ReadPermit) {
    if (!permitCurrent(permit)) return;
    if (!result.ok) {
      setRequestNote(qwenText(result.code));
      setQwenFollowUp(result.code === "IDEMPOTENCY_KEY_REUSED" ? "new" : "none");
      return;
    }
    const request = result.request;
    if (workspaceRequest.current) workspaceRequest.current.requestId = request.requestId;
    if (request.billingStatus !== "unknown") {
      setError("工作区回执的费用状态不正确");
      return;
    }
    if (request.state === "completed") {
      if (request.candidateJson) {
        acceptImport(new TextEncoder().encode(request.candidateJson), permit);
        setRequestNote("候选已放进预览。费用未知。还要人工比较、采纳到草稿，再手动保存。");
      } else {
        setRequestNote("候选正文已过期清除。请求记录保留；如需新的候选，请确认后发起新的调用。");
        setQwenFollowUp("new");
        return;
      }
      setQwenFollowUp("none");
    } else if (request.state === "reserved" || request.state === "submitted") {
      setRequestNote("请求仍在处理。可以稍后查询，不会重复调用。");
      setQwenFollowUp("query");
    } else if (request.state === "unknown") {
      setRequestNote("结果未知：服务商可能已经处理并产生费用。不会自动重发；如需新的调用，请确认后发起。");
      setQwenFollowUp("new");
    } else {
      setRequestNote(`请求被拒绝（${request.errorCode ?? "rejected"}），没有候选。如需新的调用，请确认后发起。`);
      setQwenFollowUp("new");
    }
  }

  async function requestWorkspaceCandidate(fresh: boolean) {
    if (!props.workspaceQwen || !qwenStatus?.ready) return;
    if (!draft.frozen) {
      setError("请先准备创作指令");
      return;
    }
    const fingerprint = inputFingerprint(props, draftRef.current);
    if (fingerprint !== draft.frozen.inputFingerprint) {
      setError("输入已变化，请重新准备创作指令");
      return;
    }
    if (fresh && !confirmNewCall) {
      setError("发起新的调用前，请先勾选确认");
      return;
    }
    // Same frozen input reuses its key, so a retry after a dropped connection reads the original request.
    if (fresh || !workspaceRequest.current || workspaceRequest.current.fingerprint !== fingerprint) {
      workspaceRequest.current = { fingerprint, key: crypto.randomUUID(), requestId: null };
    }
    setConfirmNewCall(false);
    setRequestNote(null);
    setError(null);
    const permit = takePermit();
    setQwenBusy(true);
    try {
      handleOutcome(await props.workspaceQwen.request(props.projectId, workspaceInput(), workspaceRequest.current.key, qwenToken), permit);
    } catch {
      if (!permitCurrent(permit)) return;
      setRequestNote("连接中断，结果未知。再次请求会用同一请求标识读取原结果，不会重复调用。");
      setQwenFollowUp("none");
    } finally {
      setQwenBusy(false);
    }
  }

  async function queryWorkspaceRequest() {
    const requestId = workspaceRequest.current?.requestId;
    if (!props.workspaceQwen || !requestId) return;
    const permit = takePermit();
    setQwenBusy(true);
    try {
      handleOutcome(await props.workspaceQwen.get(props.projectId, requestId, qwenToken), permit);
    } catch {
      if (!permitCurrent(permit)) return;
      setRequestNote("查询没有完成，请稍后再试");
    } finally {
      setQwenBusy(false);
    }
  }

  function adopt() {
    if (!draft.frozen || !draft.imported) return;
    let formatted: string;
    try {
      formatted = formatWritingImport(draft.imported);
    } catch (caught) {
      setError(caught instanceof DomainError ? caught.message : "候选不能整理成正文");
      return;
    }
    const decision = canAdopt(draft.frozen, props.capture(), inputFingerprint(props, draft));
    if (!decision.ok) {
      setDifferences(decision.differences);
      return;
    }
    const accepted = props.onAdopt(formatted, draft.frozen);
    if (!accepted) {
      setDifferences(["正文草稿已变化。候选仍保留，不能直接覆盖。"]);
      return;
    }
    setDifferences([]);
    setAdoptNote("已放入编辑草稿。还没有保存，请使用原来的保存新版本。");
  }

  const formatted = draft.imported ? safeFormat(draft.imported) : "";
  const current = props.capture().loaded || props.loaded ? readCurrent(props) : "";
  const diff = formatted ? lineDiff(current, formatted).filter((line) => line.kind !== "same") : [];

  return (
    <section className="mt-4 min-w-0 rounded border border-neutral-300 p-3" aria-label="编剧助手">
      <p className="text-sm">{props.workspaceQwen
        ? "可以通过外部 AI 创作后导入；服务端开启时，也可以由操作者向工作区千问请求候选。候选仍须比较、采纳到草稿，再手动保存。费用未知不会被写成 0。"
        : "本轮通过外部 AI 创作，网页不会自动调用模型。"}</p>
      <button className="mt-2 text-sm underline" type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? "收起编剧助手" : "编剧助手"}
      </button>
      {open ? (
        <div className="mt-3 space-y-3">
          <p className="text-sm text-neutral-600">题材、观众和人物设定只保存在这次助手草稿里，不会写成项目配置。</p>
          <label className="block text-sm">题材
            <input className="mt-1 w-full rounded border px-2 py-1" maxLength={WRITING_NOTE_MAX_CHARS} value={draft.genre} onChange={(event) => update({ genre: event.target.value })} />
          </label>
          {projectDirection ? (
            <div className="rounded border border-neutral-200 p-2">
              <p className="text-sm">这部作品在本浏览器里保存了分类中心的方向：{assistantNote(projectDirection)}</p>
              <button className="mt-1 rounded border px-3 py-1 text-sm" type="button" onClick={applyProjectDirection}>带入分类方向</button>
              {directionNote ? <p className="mt-1 text-sm" role="status">{directionNote}</p> : null}
            </div>
          ) : null}
          <label className="block text-sm">目标观众
            <input className="mt-1 w-full rounded border px-2 py-1" maxLength={WRITING_NOTE_MAX_CHARS} value={draft.audience} onChange={(event) => update({ audience: event.target.value })} />
          </label>
          <label className="block text-sm">人物设定
            <textarea className="mt-1 w-full rounded border px-2 py-1" maxLength={WRITING_NOTE_MAX_CHARS} rows={3} value={draft.characters} onChange={(event) => update({ characters: event.target.value })} />
          </label>
          <label className="block text-sm">必须保留
            <textarea className="mt-1 w-full rounded border px-2 py-1" maxLength={WRITING_NOTE_MAX_CHARS} rows={2} value={draft.mustKeep} onChange={(event) => update({ mustKeep: event.target.value })} />
          </label>
          {props.mode === "story" ? (
            <label className="block text-sm">禁止改动
              <textarea className="mt-1 w-full rounded border px-2 py-1" maxLength={WRITING_NOTE_MAX_CHARS} rows={2} value={draft.mustNotChange} onChange={(event) => update({ mustNotChange: event.target.value })} />
            </label>
          ) : (
            <>
              <p className="text-sm">当前集：第 {props.episodeNo} 集</p>
              <p className="text-sm [overflow-wrap:anywhere]">已加载的故事材料：{props.confirmedMaterials || "还没有可确认的故事正文"}</p>
              <label className="block text-sm">
                <input className="mr-2" type="checkbox" checked={draft.confirmed} onChange={(event) => update({ confirmed: event.target.checked })} />
                确认使用当前已加载的故事与分集材料
              </label>
              <label className="block text-sm">修改要求
                <textarea className="mt-1 w-full rounded border px-2 py-1" maxLength={WRITING_NOTE_MAX_CHARS} rows={2} value={draft.revisionRequest} onChange={(event) => update({ revisionRequest: event.target.value })} />
              </label>
              <label className="block text-sm">必须保留的对白
                <textarea className="mt-1 w-full rounded border px-2 py-1" maxLength={WRITING_NOTE_MAX_CHARS} rows={2} value={draft.mustKeepDialogue} onChange={(event) => update({ mustKeepDialogue: event.target.value })} />
              </label>
              <label className="block text-sm">必须保留的结局
                <textarea className="mt-1 w-full rounded border px-2 py-1" maxLength={WRITING_NOTE_MAX_CHARS} rows={2} value={draft.mustKeepEnding} onChange={(event) => update({ mustKeepEnding: event.target.value })} />
              </label>
            </>
          )}
          <button className="rounded border px-3 py-1 text-sm" type="button" onClick={prepare}>准备创作指令</button>
          {props.workspaceQwen ? (
            <fieldset className="min-w-0 rounded border border-neutral-200 p-2">
              <legend className="px-1 text-sm">工作区千问</legend>
              <p className="text-sm text-neutral-600">令牌只保存在本页内存中，刷新后需要重新输入。模型调用在服务端完成，网页不接触服务商密钥。</p>
              <label className="mt-1 block text-sm">操作者令牌
                <input className="mt-1 w-full rounded border px-2 py-1" type="password" autoComplete="off" value={qwenToken}
                  onChange={(event) => { setQwenToken(event.target.value); setQwenStatus(null); }} />
              </label>
              <button className="mt-2 rounded border px-3 py-1 text-sm" type="button" disabled={qwenBusy} onClick={() => void checkWorkspace()}>检查工作区调用</button>
              {qwenStatus ? <p className="text-sm" role="status">{qwenStatus.code === "NETWORK" ? "状态检查没有完成" : qwenText(qwenStatus.code)}{qwenStatus.ready && qwenStatus.model ? `，模型 ${qwenStatus.model}` : ""}</p> : null}
              <button className="mt-2 rounded border px-3 py-1 text-sm disabled:opacity-50" type="button"
                disabled={!qwenStatus?.ready || qwenBusy} onClick={() => void requestWorkspaceCandidate(false)}>向工作区请求候选</button>
              {qwenFollowUp === "query" ? (
                <button className="ml-2 mt-2 rounded border px-3 py-1 text-sm" type="button" disabled={qwenBusy} onClick={() => void queryWorkspaceRequest()}>查询请求状态</button>
              ) : null}
              {qwenFollowUp === "new" ? (
                <div className="mt-2">
                  <label className="block text-sm">
                    <input className="mr-2" type="checkbox" checked={confirmNewCall} onChange={(event) => setConfirmNewCall(event.target.checked)} />
                    我确认发起一次新的调用，可能另外产生费用
                  </label>
                  <button className="mt-1 rounded border px-3 py-1 text-sm disabled:opacity-50" type="button"
                    disabled={!confirmNewCall || !qwenStatus?.ready || qwenBusy} onClick={() => void requestWorkspaceCandidate(true)}>发起新的调用</button>
                </div>
              ) : null}
            </fieldset>
          ) : null}
          {requestNote ? <p className="text-sm" role="status">{requestNote}</p> : null}
          {draft.instruction ? (
            <>
              <button className="ml-2 rounded border px-3 py-1 text-sm" type="button" onClick={() => void copyInstruction()}>复制创作指令</button>
              {copyNote ? <p className="text-sm">{copyNote}</p> : null}
              <label className="block text-sm" htmlFor="writing-instruction">创作指令</label>
              <textarea id="writing-instruction" className="w-full rounded border px-2 py-1 font-mono text-sm [overflow-wrap:anywhere]" readOnly rows={8} value={draft.instruction} />
            </>
          ) : null}
          <label className="block text-sm" htmlFor="writing-import">粘贴 JSON 候选</label>
          <textarea id="writing-import" ref={importRef} className="w-full rounded border px-2 py-1 font-mono text-sm" rows={5} />
          <button className="rounded border px-3 py-1 text-sm" type="button" onClick={() => importText(importRef.current?.value ?? "")}>校验并预览</button>
          <label className="ml-2 text-sm">导入 UTF-8 JSON
            <input className="ml-2 text-sm" type="file" accept="application/json,.json" onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importFile(file);
              event.target.value = "";
            }} />
          </label>
          {formatted ? (
            <>
              <label className="block font-medium" htmlFor="writing-preview">候选正文</label>
              <textarea id="writing-preview" className="w-full rounded border px-2 py-1 text-sm [overflow-wrap:anywhere]" readOnly rows={8} value={formatted} />
              <h3 className="font-medium">与当前正文的差异</h3>
              {diff.length === 0 ? <p className="text-sm">与当前正文没有差异</p> : (
                <ul className="max-h-40 space-y-1 overflow-auto text-sm [overflow-wrap:anywhere]">
                  {diff.slice(0, 40).map((line, index) => (
                    <li key={`${line.kind}-${index}`}>{line.kind === "add" ? "+ " : "- "}{line.text}</li>
                  ))}
                </ul>
              )}
              <button className="rounded bg-red-700 px-3 py-1 text-sm text-white" type="button" onClick={adopt}>采纳到草稿</button>
              {differences.length > 0 ? (
                <div role="alert">
                  {differences.map((item) => <p key={item} className="text-sm">{item}</p>)}
                  <p className="text-sm">可以重新准备指令，或从候选正文复制需要的片段。</p>
                </div>
              ) : null}
              {adoptNote ? <p className="text-sm">{adoptNote}</p> : null}
            </>
          ) : null}
          {error ? <p className="text-sm" role="alert">{error}</p> : null}
          {storageError ? <p className="text-sm" role="alert">{storageError}</p> : null}
        </div>
      ) : null}
    </section>
  );
}

function liveText(props: { capture: () => WritingTargetSnapshot }): string {
  return props.capture().currentText;
}

function readCurrent(props: { capture: () => WritingTargetSnapshot }): string {
  return liveText(props);
}

function storyRequest(
  props: { premise: string; capture: () => WritingTargetSnapshot },
  draft: AssistantDraft,
) {
  return {
    premise: props.premise,
    genre: draft.genre,
    audience: draft.audience,
    characters: draft.characters,
    mustKeep: draft.mustKeep,
    mustNotChange: draft.mustNotChange,
    currentText: liveText(props),
  };
}

function episodeRequest(
  props: {
    episodeNo: number | null;
    premise: string;
    confirmedMaterials: string;
    capture: () => WritingTargetSnapshot;
  },
  draft: AssistantDraft,
) {
  return {
    episodeNo: props.episodeNo ?? 0,
    premise: props.premise,
    genre: draft.genre,
    audience: draft.audience,
    characters: draft.characters,
    confirmedStory: props.confirmedMaterials,
    currentText: liveText(props),
    revisionRequest: draft.revisionRequest,
    mustKeep: draft.mustKeep,
    mustKeepDialogue: draft.mustKeepDialogue,
    mustKeepEnding: draft.mustKeepEnding,
  };
}

function inputFingerprint(
  props: {
    mode: "story" | "episode";
    episodeNo: number | null;
    premise: string;
    confirmedMaterials: string;
    capture: () => WritingTargetSnapshot;
  },
  draft: AssistantDraft,
): string {
  return writingInputFingerprint(props.mode === "story" ? storyRequest(props, draft) : episodeRequest(props, draft));
}

function safeFormat(imported: WritingImport): string {
  try {
    return formatWritingImport(imported);
  } catch {
    return "";
  }
}
