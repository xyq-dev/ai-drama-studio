"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  VIMAX_PLATFORM_PREVIEW_MAX_BYTES,
  VIMAX_PLATFORM_PREVIEW_REQUEST_SCHEMA,
  type VimaxPlatformPreviewResponse,
  type VimaxPlatformSourceSnapshot,
} from "@ai-drama/contracts";
import { parseVimaxPreviewImport, VimaxPreviewClient, VimaxPreviewError } from "../lib/vimax-preview-client";
import styles from "./vimax-preview-panel.module.css";

const defaultClient = new VimaxPreviewClient();
const errorText = (error: unknown) => error instanceof VimaxPreviewError ? error.message : "暂时无法读取或校验方案，请稍后重试。";
const DIAGNOSTICS: Record<string, string> = {
  source_hash_mismatch: "来源正文与方案记录不一致。", scene_scope_invalid: "场景范围不完整或跨越了多个场景。",
  source_format_unsupported: "当前剧本格式尚不支持逐句核对，请先明确场景标题、动作与说话人。",
  source_dialogue_invalid: "对白来源目录与原文不一致。", duplicate_character: "角色标识重复。",
  character_mapping_invalid: "角色身份对应不明确。", unknown_character: "方案引用了未登记的角色。",
  shot_sequence_invalid: "镜头编号或顺序不连续。", shot_detail_mismatch: "镜头简述与详细描述不一致。",
  camera_membership_invalid: "镜头的机位归属不一致。", camera_reference_invalid: "机位参考指向不存在的镜头或机位。",
  camera_root_invalid: "机位参考的起点不明确。", camera_cycle: "机位视觉参考形成了循环。",
  supplement_mapping_invalid: "镜头或角色补充字段不对应。", missing_duration: "镜头缺少有效预计时长。",
  dialogue_changed: "方案改变了对白、说话人或原文顺序。", dialogue_coverage_invalid: "方案遗漏或重复了原剧本对白。",
  unsafe_content: "方案包含不能使用的内容。", invalid_input: "场景输入格式不符合要求。",
  invalid_candidate: "分镜候选格式不符合要求。", invalid_supplements: "补充字段不符合要求。",
  input_too_large: "方案超出了支持的大小或层级。", non_json_value: "方案不是完整的 JSON 数据。",
};

export interface VimaxPreviewPanelProps {
  projectId: string;
  episodeId: string;
  scriptReady: boolean;
  refreshEpoch?: number;
  client?: Pick<VimaxPreviewClient, "source" | "preview">;
}

/** A keyed session prevents even a single render of one episode's imported prose inside another episode. */
export function VimaxPreviewPanel(props: VimaxPreviewPanelProps) {
  return <PreviewSession key={`${props.projectId}:${props.episodeId}`} {...props} />;
}

function PreviewSession(props: VimaxPreviewPanelProps) {
  const client = props.client ?? defaultClient;
  const epoch = props.refreshEpoch ?? 0;
  const current = useRef({ epoch, scriptReady: props.scriptReady, generation: 0 });
  // A true→false→true approval transition must not revive an earlier preview, even at the same refresh epoch.
  if (current.current.epoch !== epoch || current.current.scriptReady !== props.scriptReady) {
    current.current = { epoch, scriptReady: props.scriptReady, generation: current.current.generation + 1 };
  }
  const generation = current.current.generation;
  const [opened, setOpened] = useState(false);
  const [source, setSource] = useState<{ value: VimaxPlatformSourceSnapshot; generation: number } | null>(null);
  const [result, setResult] = useState<{ value: VimaxPlatformPreviewResponse; generation: number } | null>(null);
  const [text, setText] = useState("");
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [fileBusy, setFileBusy] = useState(false);
  const sourceRequest = useRef(0);
  const previewRequest = useRef(0);
  const fileRequest = useRef(0);
  const sourceAbort = useRef<AbortController | null>(null);
  const previewAbort = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sourceRequest.current += 1; previewRequest.current += 1; fileRequest.current += 1;
      sourceAbort.current?.abort(); previewAbort.current?.abort();
    };
  }, []);

  const invalidatePreview = useCallback(() => {
    previewRequest.current += 1;
    previewAbort.current?.abort();
    setPreviewBusy(false);
  }, []);

  const loadSource = useCallback(async () => {
    if (!current.current.scriptReady) return;
    const request = ++sourceRequest.current;
    const requestGeneration = current.current.generation;
    sourceAbort.current?.abort();
    const controller = new AbortController();
    sourceAbort.current = controller;
    invalidatePreview();
    setSourceBusy(true); setSourceError(null);
    // A retained result is historical until the person explicitly rechecks it against the new source.
    setResult((previous) => previous ? { ...previous, generation: -1 } : null);
    try {
      const value = await client.source(props.projectId, props.episodeId, controller.signal);
      if (mounted.current && request === sourceRequest.current && requestGeneration === current.current.generation && current.current.scriptReady) {
        setSource({ value, generation: requestGeneration });
      }
    } catch (caught) {
      if (mounted.current && request === sourceRequest.current && requestGeneration === current.current.generation && !controller.signal.aborted) setSourceError(errorText(caught));
    } finally {
      if (mounted.current && request === sourceRequest.current) setSourceBusy(false);
    }
  }, [client, props.projectId, props.episodeId, invalidatePreview]);

  useEffect(() => {
    sourceRequest.current += 1;
    sourceAbort.current?.abort();
    invalidatePreview();
    setSourceBusy(false);
  }, [epoch, props.scriptReady, invalidatePreview]);

  const open = () => {
    if (!opened) {
      setOpened(true);
      void loadSource();
    } else {
      sourceRequest.current += 1; fileRequest.current += 1;
      sourceAbort.current?.abort(); invalidatePreview();
      setSourceBusy(false); setFileBusy(false); setOpened(false);
    }
  };
  const changeText = (value: string) => {
    fileRequest.current += 1;
    invalidatePreview();
    setFileBusy(false); setText(value); setResult(null); setError(null);
  };
  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    const request = ++fileRequest.current;
    invalidatePreview(); setResult(null); setError(null); setFileBusy(true);
    if (file.size > VIMAX_PLATFORM_PREVIEW_MAX_BYTES) {
      setText(""); setError("分镜方案不能超过 300 KB。"); setFileBusy(false); return;
    }
    try {
      const value = await file.text();
      if (!mounted.current || request !== fileRequest.current) return;
      parseVimaxPreviewImport(value);
      setText(value);
    } catch (caught) {
      if (mounted.current && request === fileRequest.current) { setText(""); setError(errorText(caught)); }
    } finally {
      if (mounted.current && request === fileRequest.current) setFileBusy(false);
    }
  };
  const preview = async () => {
    if (previewBusy || fileBusy || sourceBusy || !source || source.generation !== generation || !props.scriptReady || sourceError) return;
    let request;
    try { request = parseVimaxPreviewImport(text); } catch (caught) { setResult(null); setError(errorText(caught)); return; }
    const sequence = ++previewRequest.current;
    const requestGeneration = generation;
    const controller = new AbortController();
    previewAbort.current?.abort(); previewAbort.current = controller;
    setPreviewBusy(true); setError(null); setResult(null);
    try {
      const value = await client.preview(props.projectId, props.episodeId, request, controller.signal);
      if (mounted.current && sequence === previewRequest.current && requestGeneration === current.current.generation && current.current.scriptReady) {
        setSource({ value: value.source, generation: requestGeneration });
        setResult({ value, generation: requestGeneration });
      }
    } catch (caught) {
      if (mounted.current && sequence === previewRequest.current && requestGeneration === current.current.generation && !controller.signal.aborted) {
        setError(errorText(caught));
        if (caught instanceof VimaxPreviewError && caught.status === 409) {
          setSource((previous) => previous ? { ...previous, generation: -1 } : null);
        }
      }
    } finally {
      if (mounted.current && sequence === previewRequest.current) setPreviewBusy(false);
    }
  };
  const downloadTemplate = () => {
    if (!source || source.generation !== generation || !props.scriptReady) return;
    const value = source.value;
    const template = { schema: VIMAX_PLATFORM_PREVIEW_REQUEST_SCHEMA,
      source: { scriptRevisionId: value.scriptRevisionId, scriptContentHash: value.scriptContentHash, characters: value.characters },
      sceneSpans: [], selectedSceneKeys: [], sourceDialogue: [],
      requirements: { aspectRatio: "9:16", targetSceneSeconds: 13, style: "请填写风格要求" }, candidate: null, supplements: null,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(template, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = `vimax-scene-source-template-${String(value.episodeNo)}.json`;
    anchor.click(); URL.revokeObjectURL(url);
  };
  const sourceReady = source !== null && source.generation === generation && props.scriptReady && !sourceError && !sourceBusy;
  const stale = result !== null && (result.generation !== generation || !props.scriptReady || !sourceReady);

  return <section className={styles.panel} aria-label="单场景分镜预览">
    <h3 className={styles.heading}><button type="button" className={styles.toggle} aria-expanded={opened} onClick={open}>
      <span>单场景分镜预览</span><span aria-hidden="true">{opened ? "收起" : "展开"}</span>
    </button></h3>
    {opened ? <div className={styles.body}>
      <p className={styles.muted}>导入一个场景的分镜方案，对照当前已批准的剧本和角色。这里只做预览，不调用模型，也不保存场景或镜头。</p>
      {!props.scriptReady ? <p className={styles.notice} role="status">请先批准本集当前剧本，再读取来源和预览方案。</p> : null}
      <div className={styles.controls}>
        <button className={styles.button} type="button" disabled={!props.scriptReady || sourceBusy} onClick={() => { void loadSource(); }}>{sourceBusy ? "正在读取来源…" : "重新读取来源"}</button>
        <button className={styles.button} type="button" disabled={!sourceReady} onClick={downloadTemplate}>下载来源模板（待补全）</button>
      </div>
      {sourceError ? <p className={styles.error} role="alert">{sourceError}</p> : null}
      {source ? <div className={styles.card}>
        <p>当前来源：第 {source.value.episodeNo} 集 · 剧本第 {source.value.scriptRevisionNo} 版</p>
        <p className={styles.muted}>角色：{source.value.characters.map((character) => `${character.key} ${character.name}`).join("、") || "未登记角色"}</p>
        <details className={styles.details}><summary>查看已读取的剧本原文</summary><pre className={styles.pre}>{source.value.scriptText}</pre></details>
        {!sourceReady ? <p className={styles.notice}>来源可能已变化，请重新读取后再校验；不会自动替换导入方案记录的来源。</p> : null}
      </div> : null}
      <p className={styles.muted}>来源模板尚未包含场景边界、对白目录、分镜候选及补充字段，填完整后再导入。方案须为平台格式，最大 300 KB；离线评估报告不能直接导入。</p>
      <label className={styles.label}>导入分镜方案 JSON
        <input className={styles.file} type="file" accept=".json,application/json" onChange={(event) => { void importFile(event); }} />
      </label>
      <label className={styles.label}>或粘贴分镜方案 JSON
        <textarea className={styles.json} value={text} onChange={(event) => changeText(event.currentTarget.value)} spellCheck={false} />
      </label>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
      <div className={styles.controls}><button className={`${styles.button} ${styles.primary}`} type="button"
        disabled={!sourceReady || previewBusy || fileBusy || text.trim().length === 0} onClick={() => { void preview(); }}>
        {fileBusy ? "正在读取文件…" : previewBusy ? "正在校验…" : "校验并预览"}
      </button><span className={styles.muted}>模型调用 0 次 · 不保存</span></div>
      {stale ? <p className={styles.notice} role="status">来源可能已变化，以下是此前的预览。请重新读取来源并再次校验。</p> : null}
      {result ? <PreviewResult response={result.value} stale={stale} /> : null}
    </div> : null}
  </section>;
}

function PreviewResult({ response, stale }: { response: VimaxPlatformPreviewResponse; stale: boolean }) {
  const report = response.report;
  if (report.status === "blocked") return <div className={styles.error} role="status">
    <p><strong>方案未通过校验</strong></p>
    {report.diagnostics.map((issue, index) => <p key={index}>{DIAGNOSTICS[issue.code] ?? "方案未通过完整性检查，请修正后再导入。"}<small>（{issue.path}）</small></p>)}
  </div>;
  const review = report.review;
  const names = new Map(response.source.characters.map((character) => [character.key, character.name]));
  return <div>
    <p className={stale ? styles.notice : styles.success}><strong>{stale ? "此前的结构校验结果" : "结构校验通过，可以人工对照"}</strong> · 尚未保存或批准。</p>
    <p className={styles.muted}>预计 {review.plannedTotalSeconds} 秒 / 目标 {review.targetSceneSeconds} 秒。预计时长不是成片实测时长；动作语义、对白音轨描述、竖屏构图和风格仍需人工核对。</p>
    <p className={styles.muted}>画幅 {review.requirements.aspectRatio} · 风格要求：{review.requirements.style}</p>
    <div className={styles.columns}>
      <div className={styles.card}><h4>原场景：{review.scene.heading}</h4><pre className={styles.pre}>{review.sourceSceneText}</pre></div>
      <div className={styles.shots}>{review.shots.map((shot) => {
        const detail = review.candidate.shot_descriptions[shot.vimaxShotIndex];
        return <article className={styles.card} key={shot.vimaxShotIndex} aria-label={`镜头 ${String(shot.vimaxShotIndex + 1)}`}>
          <h4>镜头 {shot.vimaxShotIndex + 1} · {shot.shotType} · 预计 {shot.plannedSeconds} 秒</h4>
          <dl className={styles.fields}>
            <dt>构图运镜</dt><dd>{shot.camera}</dd><dt>动作</dt><dd>{shot.action}</dd>
            <dt>角色</dt><dd>{shot.characterKeys.map((key) => names.get(key) ?? key).join("、") || "无"}</dd>
            <dt>原文对白</dt><dd>{shot.dialogue.length > 0 ? shot.dialogue.map((line) => `${line.speaker}：${line.line}`).join("\n") : "无对白"}</dd>
          </dl>
          {detail ? <details className={styles.details}><summary>首尾帧、运动与音轨文字</summary>
            <dl className={styles.fields}><dt>首帧文字</dt><dd>{detail.ff_desc || "未填写"}</dd><dt>尾帧文字</dt><dd>{detail.lf_desc || "未填写"}</dd>
              <dt>运动文字</dt><dd>{detail.motion_desc || "未填写"}</dd><dt>音轨描述</dt><dd>{detail.audio_desc || "未填写"}</dd></dl>
            <p className={styles.muted}>这些是规划文字。音轨描述仅供对照，不替代上方逐句原文对白。</p>
          </details> : null}
        </article>;
      })}</div>
    </div>
    <p className={styles.muted}>机位视觉参考顺序：{review.cameraGenerationOrder.map((camera) => `机位 ${String(camera + 1)}`).join(" → ")}。这是参考依赖顺序，镜头播放仍按上方顺序。</p>
  </div>;
}
