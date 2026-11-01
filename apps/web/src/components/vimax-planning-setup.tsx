"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { type VimaxCandidateCreate, type VimaxCandidateTargets, type VimaxPlanningStart, type VimaxPlatformSourceSnapshot } from "@ai-drama/contracts";
import { VimaxCandidateClient } from "../lib/vimax-candidate-client";
import type { VimaxPlanningClient } from "../lib/vimax-planning-client";
import { buildPlanningSourceDraft, planningSceneBoundaries, planningSceneDialogue } from "../lib/vimax-planning-source";
import { VimaxPlanningPanel } from "./vimax-planning-panel";
import styles from "./vimax-preview-panel.module.css";
const defaultTargets = new VimaxCandidateClient();
export interface VimaxPlanningSetupProps {
  source: VimaxPlatformSourceSnapshot;
  targetsClient?: Pick<VimaxCandidateClient, "targets">;
  planningClient?: Pick<VimaxPlanningClient, "options" | "list" | "get" | "start" | "cancel">;
  onCandidate: (candidate: VimaxCandidateCreate) => void;
}
export function VimaxPlanningSetup(props: VimaxPlanningSetupProps) {
  const [opened, setOpened] = useState(false), [busy, setBusy] = useState(false), [targets, setTargets] = useState<VimaxCandidateTargets | null>(null);
  const [error, setError] = useState<string | null>(null), [targetId, setTargetId] = useState("");
  const [mappings, setMappings] = useState<Record<string,string>>({}), [confirmed, setConfirmed] = useState(false);
  const [style, setStyle] = useState("写实竖屏短剧"), [seconds, setSeconds] = useState(13);
  const serial = useRef(0), mounted = useRef(true);
  const client = props.targetsClient ?? defaultTargets;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; serial.current++; }; }, []);
  const loadTargets = async () => {
    const sequence = ++serial.current; setBusy(true); setError(null); setConfirmed(false); setTargets(null); setTargetId(""); setMappings({});
    try {
      const value = await client.targets(props.source.projectId, props.source.episodeId);
      if (!mounted.current || sequence !== serial.current) return;
      if (JSON.stringify(value.source) !== JSON.stringify(props.source)) throw new Error("目标列表的剧本或角色来源已变化，请先重新读取上方来源。");
      setTargets(value);
    } catch (e) { if (mounted.current && sequence === serial.current) setError(e instanceof Error ? e.message : "无法读取可规划的目标场景，请稍后重试。"); }
    finally { if (mounted.current && sequence === serial.current) setBusy(false); }
  };
  const target = targets?.targets.find(t => t.sceneId === targetId);
  const prepared = useMemo(() => {
    if (!target || !target.eligible) return { draft: null, dialogue: [], scene: null, problem: null };
    try {
      const scenes = planningSceneBoundaries(props.source.scriptText), scene = scenes[target.ordinal - 1];
      if (!scene || scene.heading !== target.heading) throw new Error("场景标题或序号与原文不一致，请重新读取并核对场景。");
      const dialogue = planningSceneDialogue(props.source.scriptText, scene);
      let draft: VimaxPlanningStart | null = null, problem: string | null = null;
      try { draft = buildPlanningSourceDraft(props.source, target, mappings, style, seconds); }
      catch (e) { problem = e instanceof Error ? e.message : "规划输入仍需补全。"; }
      return { draft, dialogue, scene, problem };
    } catch (e) { return { draft: null, dialogue: [], scene: null, problem: e instanceof Error ? e.message : "原文格式尚不支持。" }; }
  }, [props.source, target, mappings, style, seconds]);
  return <section aria-label="从原文准备在线规划" className={styles.card}>
    <button type="button" className={styles.button} aria-expanded={opened} onClick={() => {
      setOpened(!opened); if (!opened) void loadTargets();
    }}>准备在线单场景规划</button>
    {opened && <div>
      <p>无需先导入分镜。选择当前剧本中的空场景，核对原文范围和角色身份后，才可预约一次模型规划。</p>
      <button type="button" className={styles.button} disabled={busy} onClick={() => void loadTargets()}>刷新可规划场景</button>
      {busy && <p role="status">正在读取场景…</p>}{error && <p role="alert" className={styles.error}>{error}</p>}
      <label className={styles.label}>选择空场景及原文范围<select value={targetId} disabled={busy || !targets} onChange={e => { setTargetId(e.target.value); setMappings({}); setConfirmed(false); }}>
        <option value="">请选择一个场景</option>
        {targets?.targets.map(t => <option key={t.sceneId} value={t.sceneId} disabled={!t.eligible}>{t.ordinal}. {t.heading}{t.eligible ? "" : `（不可规划：${t.reasons.join("、")}）`}</option>)}
      </select></label>
      {targets && !targets.targets.some(t => t.eligible) && <p role="status">当前没有可规划的空场景；已有镜头、来源过期或活动任务会阻断预约。</p>}
      {prepared.scene && <div><p>原文范围 [{prepared.scene.start}, {prepared.scene.end})，UTF-16；目标场景版本 {target?.rowVersion}。</p>
        <pre className={styles.pre}>{props.source.scriptText.slice(prepared.scene.start, prepared.scene.end)}</pre>
        {prepared.dialogue.map(line => {
          const matches = props.source.characters.filter(c => c.name === line.speaker);
          const choice = mappings[line.id] ?? (matches.length === 1 ? matches[0]!.key : "");
          return <div className={styles.card} key={line.id}><pre className={styles.pre}>{line.id} · {line.speaker}：{line.line}</pre>
            <label className={styles.label}>对白 {line.id} 的角色身份<select value={choice} onChange={e => { setMappings(old => ({ ...old, [line.id]: e.target.value })); setConfirmed(false); }}>
              <option value="">请明确角色身份</option>{matches.map(c => <option key={c.key} value={c.key}>{c.key} · {c.name} · {c.characterId}</option>)}
            </select></label>
            {matches.length === 0 && <p role="alert">这个说话人尚未登记，先补齐角色资料再重新读取来源。</p>}
          </div>;
        })}
      </div>}
      <label className={styles.label}>规划风格<input value={style} maxLength={300} onChange={e => { setStyle(e.target.value); setConfirmed(false); }} /></label>
      <label className={styles.label}>目标场景秒数<input type="number" min={2} max={80} value={seconds} onChange={e => { setSeconds(Number(e.target.value)); setConfirmed(false); }} /></label>
      {prepared.problem && <p role="alert" className={styles.notice}>{prepared.problem}</p>}
      <label className={styles.label}><input type="checkbox" checked={confirmed} disabled={!prepared.draft || busy} onChange={e => setConfirmed(e.target.checked)} />我已核对选中原文范围、每句对白与具体角色身份</label>
      <VimaxPlanningPanel projectId={props.source.projectId} episodeId={props.source.episodeId} draftRequest={confirmed ? prepared.draft : null}
        onCandidate={props.onCandidate} client={props.planningClient} />
    </div>}
  </section>;
}
