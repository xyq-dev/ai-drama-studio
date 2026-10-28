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
import { OnlineCandidatePanel } from "./writing-assistant-online";
import type { WritingCandidateClient } from "../lib/writing-candidate-client";
import { appendOnce, assistantNote, readProjectDirection } from "../lib/creative-direction-link";
import type { DirectionDraft } from "../lib/creative-taxonomy";

type WorkspaceRequestState = "sending" | "reserved" | "submitted" | "completed" | "rejected" | "unknown";

/**
 * A request this tab once sent to the retired workspace Qwen route (sessionStorage, this tab only). The route and its
 * client are gone: such a record is only read to tell the person what became of it. It is never sent, replayed,
 * queried or deleted here.
 */
interface RetiredWorkspaceRequest {
  version: 1;
  projectId: string;
  entityKey: string;
  key: string;
  requestId: string | null;
  state: WorkspaceRequestState;
}

function workspaceRequestKey(projectId: string, entityKey: string): string {
  return `ads-writing-qwen:${projectId}:${entityKey}`;
}

function readRetiredWorkspaceRequest(projectId: string, entityKey: string): RetiredWorkspaceRequest | null {
  try {
    const raw = window.sessionStorage.getItem(workspaceRequestKey(projectId, entityKey));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RetiredWorkspaceRequest> | null;
    if (!parsed || parsed.version !== 1 || parsed.projectId !== projectId || parsed.entityKey !== entityKey
      || typeof parsed.key !== "string" || typeof parsed.state !== "string") {
      return null;
    }
    return parsed as RetiredWorkspaceRequest;
  } catch {
    return null;
  }
}

/** What the person is told about a request to the retired route. A charge that may exist is never written as none. */
function retiredWorkspaceNote(record: RetiredWorkspaceRequest): string {
  const base = "工作区千问调用已经退役，网页不会再发送、重放或查询这条请求。";
  if (record.state === "completed") return `${base}它当时已经完成；费用未知。`;
  if (record.state === "rejected") return `${base}它当时被拒绝，没有候选。`;
  return `${base}它的结果没有确认：服务商可能已经处理并产生费用，费用未知。`;
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
  /** The episode an episode-mode assistant writes for; online candidates are bound to it. Null for the story. */
  episodeId?: string | null;
  candidateClient?: WritingCandidateClient;
  premise: string;
  confirmedMaterials: string;
  loaded: boolean;
  capture: () => WritingTargetSnapshot;
  onAdopt: (text: string, frozen: FrozenWritingContext) => boolean;
  readFile?: (file: File) => Promise<ArrayBuffer>;
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
  const [retiredRequest, setRetiredRequest] = useState<RetiredWorkspaceRequest | null>(() => readRetiredWorkspaceRequest(props.projectId, props.entityKey));
  const [projectDirection, setProjectDirection] = useState<DirectionDraft | null>(null);
  const [directionNote, setDirectionNote] = useState<string | null>(null);
  draftRef.current = draft;
  identityRef.current = { projectId: props.projectId, entityKey: props.entityKey };

  if (boundKey !== key) {
    setBoundKey(key);
    setDraft(readAssistant(props.projectId, props.entityKey));
    setRetiredRequest(readRetiredWorkspaceRequest(props.projectId, props.entityKey));
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

  /** The online request from the inputs as they are now: the same checks and frozen context as preparing an instruction. */
  function prepareOnline() {
    if (!props.loaded) return { error: "目标数据尚未加载成功" };
    if (props.mode === "episode" && !draftRef.current.confirmed) return { error: "请先确认使用当前已加载的故事与分集材料" };
    const current = draftRef.current;
    try {
      const request = props.mode === "story" ? storyRequest(props, current) : episodeRequest(props, current);
      // The same builder as the manual instruction validates every field before anything is sent.
      if (props.mode === "story") buildStoryPlanInstruction(request as ReturnType<typeof storyRequest>);
      else buildEpisodeDraftInstruction(request as ReturnType<typeof episodeRequest>);
      const frozen = freezeWritingContext({ ...props.capture(), loaded: true }, inputFingerprint(props, current));
      return { request, frozen };
    } catch (caught) {
      return { error: caught instanceof DomainError ? caught.message : "在线请求没有准备好" };
    }
  }

  /** A validated online candidate: shown with the context it was asked for, never adopted here. */
  function acceptOnline(imported: WritingImport, frozen: FrozenWritingContext) {
    generation.current += 1;
    prepareGeneration.current += 1;
    persist({ ...draftRef.current, frozen, imported });
    setError(null);
    setDifferences([]);
    setAdoptNote(null);
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
    <section className="creator-writing-assistant mt-4 min-w-0 rounded border border-neutral-300 p-3" aria-label="编剧助手">
      <p className="text-sm">可以在线生成候选，也可以复制指令到外部 AI 后导入。网页不会自动生成、采纳或保存。</p>
      <button className="creator-assistant-toggle mt-2 text-sm underline" type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? "收起编剧助手" : "编剧助手"}
      </button>
      {open ? (
        <div className="creator-assistant-content mt-3 space-y-3">
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
            <>
              <label className="block text-sm">禁止改动
                <textarea className="mt-1 w-full rounded border px-2 py-1" maxLength={WRITING_NOTE_MAX_CHARS} rows={2} value={draft.mustNotChange} onChange={(event) => update({ mustNotChange: event.target.value })} />
              </label>
              <label className="block text-sm">修改要求（可不填）
                <textarea className="mt-1 w-full rounded border px-2 py-1" maxLength={WRITING_NOTE_MAX_CHARS} rows={2} value={draft.revisionRequest} onChange={(event) => update({ revisionRequest: event.target.value })} />
              </label>
            </>
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
          <OnlineCandidatePanel
            mode={props.mode}
            projectId={props.projectId}
            entityKey={props.entityKey}
            episodeId={props.episodeId ?? null}
            {...(props.candidateClient ? { client: props.candidateClient } : {})}
            prepare={prepareOnline}
            onCandidate={acceptOnline}
          />
          <h3 className="font-medium">或者：复制指令到外部 AI，再导入候选</h3>
          <button className="rounded border px-3 py-1 text-sm" type="button" onClick={prepare}>准备创作指令</button>
          {retiredRequest ? <p className="text-sm" role="status">{retiredWorkspaceNote(retiredRequest)}</p> : null}
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
    // Only when written, so that a story request without one keeps its earlier fingerprint.
    ...(draft.revisionRequest.length > 0 ? { revisionRequest: draft.revisionRequest } : {}),
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
