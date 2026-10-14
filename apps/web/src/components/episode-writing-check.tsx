"use client";

import { useId, useMemo, useState } from "react";
import type { EpisodeOutline, TitleConcept } from "@ai-drama/contracts";
import { EPISODE_WRITING_KIND_LABELS, checkEpisodePlan } from "../lib/episode-writing-check";
import styles from "./title-writing.module.css";

/** The anchor of one episode in the outline list, so a finding can point at the episode it is about. */
export function outlineEpisodeAnchor(episodeNo: number): string {
  return `outline-episode-${String(episodeNo)}`;
}

/**
 * The "编剧检查" entry of an episode plan. It only reads the loaded concept and outline: it sends no
 * request, calls no model and changes no content. Results are grouped by episode and never add up to a score.
 */
export function EpisodeWritingCheck({ concept, outline, episodeCount, finaleClosure }: {
  concept: TitleConcept | null;
  outline: EpisodeOutline | null;
  episodeCount: number;
  finaleClosure: boolean;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const result = useMemo(() => (open ? checkEpisodePlan(concept, outline, episodeCount, finaleClosure) : null), [open, concept, outline, episodeCount, finaleClosure]);

  return (
    <div className={styles.writingCheck}>
      <button className={styles.secondary} type="button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}>
        {open ? "收起编剧检查" : "编剧检查"}
      </button>
      {open && result ? (
        <div id={panelId} className={styles.checkPanel}>
          <p className={styles.helper}>
            只读取本次创作已加载的故事策划和分集大纲数据，包括页面未逐项展示的主角目标和阻力，不调用模型、不产生费用，也不修改内容。字段齐全不代表故事质量合格，结果也不预测播放效果。
          </p>
          <p className={styles.checkCounts} role="status">
            {EPISODE_WRITING_KIND_LABELS.missing} {result.counts.missing} 项 · {EPISODE_WRITING_KIND_LABELS.manual} {result.counts.manual} 项 ·{" "}
            {EPISODE_WRITING_KIND_LABELS.undetermined} {result.counts.undetermined} 项
          </p>
          {result.counts.missing === 0 ? (
            <p className={styles.helper}>
              没有发现明确缺项，这不代表故事合格。
              {result.counts.undetermined > 0 ? `另有 ${String(result.counts.undetermined)} 项因相关内容为空或只是占位文字，当前无法判断。` : ""}
              {result.counts.manual > 0 ? "待人工判断的项仍需要你判断。" : ""}
            </p>
          ) : null}
          {result.groups.map((group) => (
            <section key={group.episodeNo ?? "story"} className={styles.checkGroup} aria-label={`${group.label}的检查结果`}>
              <h3 className={styles.checkGroupTitle}>
                {group.label}
                {group.episodeNo !== null && outline?.episodes.some((episode) => episode.episodeNo === group.episodeNo) ? <a className={styles.textLink} href={`#${outlineEpisodeAnchor(group.episodeNo)}`}>查看这一集大纲</a> : null}
              </h3>
              <ul className={styles.checkList}>
                {group.findings.map((finding) => (
                  <li key={finding.id} className={styles.checkItem} data-kind={finding.kind}>
                    <p className={styles.checkQuestion}>
                      <span className={styles.checkKind}>{EPISODE_WRITING_KIND_LABELS[finding.kind]}</span>
                      {finding.question}
                    </p>
                    <p><span className={styles.checkLabel}>依据</span>{finding.evidence}</p>
                    <p><span className={styles.checkLabel}>影响</span>{finding.why}</p>
                    <p><span className={styles.checkLabel}>建议</span>{finding.suggestion}</p>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      ) : null}
    </div>
  );
}
