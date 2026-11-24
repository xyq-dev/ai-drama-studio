"use client";

import { useRef, useState } from "react";
import { CREATOR_SKILL_RELEASES, type CreatorSkillId, type SkillRunView, type SkillSettingsView } from "@ai-drama/contracts";
import { createFeatureConfigClient, featureErrorCopy } from "../lib/feature-config-client";
import styles from "./feature-config.module.css";

const STATUS: Record<SkillRunView["status"], string> = {
  running: "执行中", succeeded: "已完成", failed: "执行失败", unknown: "待核对", issues: "发现问题",
};
const REASON: Record<string, string> = {
  BLACK: "黑屏", SILENCE: "静音", NO_AUDIO: "缺少音轨", NO_VIDEO: "缺少画面",
  CHECK_UNAVAILABLE: "质检暂不可用", INCOMPLETE: "部分检查未完成",
};

function shortVersion(version: string) {
  return version.replace(/^([0-9a-f]{7})[0-9a-f]{33}(\+hg\.\d+)$/, "$1$2");
}

export function AdminCreatorSkills({ client, onUpdated }: {
  client: Pick<ReturnType<typeof createFeatureConfigClient>, "skills" | "setSkill" | "skillRuns">;
  onUpdated: () => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [settings, setSettings] = useState<SkillSettingsView | null>(null);
  const [runs, setRuns] = useState<SkillRunView[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const locked = useRef(false);

  async function act(work: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try { await work(); } catch (cause) { setError(featureErrorCopy(cause)); }
    finally { locked.current = false; setBusy(false); }
  }

  function load() {
    return act(async () => { setSettings(await client.skills()); setRuns(null); });
  }

  function toggle(id: CreatorSkillId, enabled: boolean) {
    if (!settings?.canManage) return;
    return act(async () => {
      setSettings(await client.setSkill(id, enabled, settings.revision));
      await onUpdated();
    });
  }

  return (
    <section className={styles.editor} aria-label="创作助手技能">
      <div className={styles.editorHead}>
        <h2><button type="button" className={styles.secondary} aria-expanded={expanded} aria-controls="creator-skill-settings"
          onClick={() => {
            setExpanded(!expanded);
            if (!expanded && !settings) void load();
          }}>创作助手技能</button></h2>
      </div>
      {expanded ? <div id="creator-skill-settings" aria-busy={busy}>
        {busy && !settings && <p role="status">正在读取技能配置…</p>}
        {error && <p role="alert">{error} <button className={styles.secondary} onClick={load} disabled={busy}>重读配置</button></p>}
        {settings?.skills.map(skill => <div key={skill.id} className={styles.skillRow}>
          <div><strong>{skill.label}</strong><span className={styles.scope} title={skill.version}>版本 {shortVersion(skill.version)}</span></div>
          <span>{skill.enabled ? "已启用" : "已停用"}</span>
          {settings.canManage && <button type="button" className={styles.secondary} disabled={busy}
            aria-label={`${skill.enabled ? "停用" : "启用"}${skill.label}`} onClick={() => void toggle(skill.id, !skill.enabled)}>
            {skill.enabled ? "停用" : "启用"}</button>}
        </div>)}
        {settings?.canViewRuns && <button type="button" className={styles.secondary} disabled={busy}
          onClick={() => void act(async () => { setRuns(await client.skillRuns()); })}>
          {runs === null ? "查看执行记录" : "刷新执行记录"}</button>}
        {runs && <div aria-live="polite" className={styles.skillRuns}>
          {runs.length === 0 ? <p className={styles.empty}>暂无技能执行记录。</p> : <ul>{runs.map(run => <li key={`${run.skill}/${run.id}`}>
            <strong>{CREATOR_SKILL_RELEASES[run.skill].label}</strong> · {run.project} · {STATUS[run.status]}
            {run.reasons.length ? `（${run.reasons.map(code => REASON[code] ?? code).join("、")}）` : null}
            <small title={run.version}>{new Date(run.at).toLocaleString("zh-CN")} · {shortVersion(run.version)}</small>
          </li>)}</ul>}
        </div>}
      </div> : null}
    </section>
  );
}
