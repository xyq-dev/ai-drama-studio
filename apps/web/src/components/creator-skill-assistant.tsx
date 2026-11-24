"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";
import { creatorAgentResolveResponseSchema, type CreatorAgentStage, type CreatorSkillId } from "@ai-drama/contracts";
import { ApiError, StudioClient } from "../lib/studio-client";

const client = new StudioClient();
const actions = {
  "short-drama-write": "编写或修改剧本",
  "short-drama-storyboard": "拆分场景镜头",
  "qc-skill": "查看成片质检",
} satisfies Record<CreatorSkillId, string>;
const examples: Record<CreatorAgentStage, string> = {
  script: "例如：把司机这句对白改得自然一点",
  storyboard: "例如：把公交站这场拆成三个镜头",
  export: "例如：检查这集有没有黑屏或静音",
};

export type CreatorSkillLaunch = {
  projectId: string;
  episodeId: string;
  id: string;
  skill: CreatorSkillId;
  instruction: string;
};

export const CreatorSkillContext = createContext<CreatorSkillLaunch | null>(null);

export function useCreatorSkillLaunch(skill: CreatorSkillId, projectId: string, episodeId?: string | null) {
  const launch = useContext(CreatorSkillContext);
  return launch?.skill === skill && launch.projectId === projectId && launch.episodeId === episodeId ? launch : null;
}

export function CreatorSkillAssistant(props: {
  projectId: string;
  episodeId: string;
  episodeNo: number;
  stage: CreatorAgentStage;
  textOnly: boolean;
  onResolved: (launch: CreatorSkillLaunch) => void;
}) {
  const [command, setCommand] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const loading = useRef(false);
  useEffect(() => () => { generation.current++; }, []);

  async function resolve(skill?: CreatorSkillId) {
    if (loading.current) return;
    const instruction = command.trim() || (skill && actions[skill]);
    if (!instruction) { setNotice("请先写下想做的事，或直接选择下面的操作。"); return; }
    const current = ++generation.current;
    loading.current = true;
    setBusy(true);
    setNotice("");
    try {
      const reply = await client.postJson<unknown>(`/projects/${props.projectId}/assistant/resolve`, {
        command: instruction, stage: props.stage, episodeNo: props.episodeNo, ...(skill ? { skill } : {}),
      });
      if (current !== generation.current) return;
      const result = creatorAgentResolveResponseSchema.parse(reply);
      if (!result.skill) { setNotice("请选择要执行的操作。"); return; }
      if (props.textOnly && result.skill !== "short-drama-write") {
        setNotice("这部系列作品只开放编剧。");
        return;
      }
      props.onResolved({ id: crypto.randomUUID(), projectId: props.projectId, episodeId: props.episodeId,
        skill: result.skill, instruction: result.instruction });
    } catch (error) {
      if (current === generation.current) setNotice(error instanceof ApiError ? error.detail : "暂时无法识别这条要求，请重试。");
    } finally {
      if (current === generation.current) { setBusy(false); loading.current = false; }
    }
  }

  return <section aria-label="创作助手" className="min-w-0 rounded-[12px] border border-[#E7E5E0] bg-white p-4">
    <h3 className="font-semibold">创作助手 · 第 {props.episodeNo} 集</h3>
    <label className="mt-3 block text-sm" htmlFor="creator-assistant-command">想让助手做什么？</label>
    <textarea id="creator-assistant-command" className="mt-1 block w-full min-w-0 rounded-lg border px-3 py-2" rows={2}
      maxLength={1000} placeholder={examples[props.stage]} value={command} disabled={busy}
      onChange={event => { setCommand(event.target.value); setNotice(""); }} />
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <button type="button" className="min-h-11 rounded-[12px] bg-[var(--studio-accent)] px-4 py-2 text-white"
        disabled={busy || !command.trim()} onClick={() => void resolve()}>{busy ? "正在读取…" : "使用助手"}</button>
      {(Object.keys(actions) as CreatorSkillId[]).filter(id => !props.textOnly || id === "short-drama-write").map(id =>
        <button key={id} type="button" className="min-h-11 rounded-[12px] border px-3 py-2" disabled={busy}
          onClick={() => void resolve(id)}>{actions[id]}</button>)}
    </div>
    {notice && <p className="mt-2 text-sm" role="status">{notice}</p>}
  </section>;
}
