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
  requestCandidate?: (input: { idempotencyKey: string }) => Promise<{ candidateJson: string; billingStatus: "unknown" }>;
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
  const requestKey = useRef<string | null>(null);
  const [requestNote, setRequestNote] = useState<string | null>(null);
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

  async function requestWorkspaceCandidate() {
    if (!props.requestCandidate) return;
    if (!draft.frozen) {
      setError("请先准备创作指令");
      return;
    }
    if (!requestKey.current) requestKey.current = crypto.randomUUID();
    setRequestNote(null);
    try {
      const result = await props.requestCandidate({ idempotencyKey: requestKey.current });
      if (result.billingStatus !== "unknown") {
        setError("工作区回执的费用状态不正确");
        return;
      }
      importText(result.candidateJson);
      setRequestNote("候选已放进预览。费用未知。还要人工比较、采纳到草稿，再手动保存。");
    } catch {
      setError("工作区没有返回候选");
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
      <p className="text-sm">{props.requestCandidate
        ? "工作区调用由服务端开关控制。候选仍须比较、采纳到草稿，再手动保存。费用未知不会被写成 0。"
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
          {props.requestCandidate ? (
            <button className="ml-2 rounded border px-3 py-1 text-sm" type="button" onClick={() => void requestWorkspaceCandidate()}>向工作区请求候选</button>
          ) : null}
          {requestNote ? <p className="text-sm">{requestNote}</p> : null}
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
