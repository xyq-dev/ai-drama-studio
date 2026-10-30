"use client";

import type { VimaxPlatformPreviewReport, VimaxPlatformSourceSnapshot } from "@ai-drama/contracts";
import styles from "./vimax-preview-panel.module.css";

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

export function VimaxStoryboardReview({ report, source, stale, note = "本次校验未执行保存或审批。" }: {
  report: VimaxPlatformPreviewReport; source: VimaxPlatformSourceSnapshot; stale: boolean; note?: string;
}) {
  if (report.status === "blocked") return <div className={styles.error} role="status">
    <p><strong>方案未通过校验</strong></p>
    {report.diagnostics.map((issue, index) => <p key={index}>{DIAGNOSTICS[issue.code] ?? "方案未通过完整性检查，请修正后再导入。"}<small>（{issue.path}）</small></p>)}
  </div>;
  const review = report.review;
  const names = new Map(source.characters.map((character) => [character.key, character.name]));
  return <div>
    <p className={stale ? styles.notice : styles.success}><strong>{stale ? "此前的结构校验结果" : "结构校验通过，可以人工对照"}</strong> · {note}</p>
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
