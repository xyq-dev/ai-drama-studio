import { useId } from "react";
import { COMFYUI_PROMPT_LIMIT, type ComfyUiJob, type ComfyUiQuoteInput, type ComfyUiReference, type ComfyUiStatus, type ComfyUiWorkflow } from "../lib/real-media-client";
import styles from "./real-media-panel.module.css";

export const comfyUiAvailability: Record<ComfyUiStatus, string> = {
  available: "ComfyUI 图片生成可用。",
  disabled: "ComfyUI 图片生成尚未启用。",
  unconfigured: "ComfyUI 尚未配置工作流。",
  unreachable: "暂时无法连接 ComfyUI。",
  missing_dependencies: "ComfyUI 缺少所需节点或模型。",
  unavailable: "当前项目或媒体环境尚未开放 ComfyUI 图片生成。",
};

const jobStates: Record<string, string> = {
  PENDING: "等待排队", QUEUED: "排队中", RUNNING: "生成中", WAITING_EXTERNAL: "进度暂不可用，保留原任务",
  SUCCEEDED: "已生成，可查看候选图", FAILED: "生成失败", CANCELED: "已取消", UNKNOWN: "结果待核实，不会自动重新生成",
};
const jobPhases: Record<string, string> = {
  QUEUED: "排队中", RUNNING: "生成中", FINALIZING: "正在验证并保存图片", STORING: "正在验证并保存图片",
  UNKNOWN: jobStates.UNKNOWN!, FAILED: jobStates.FAILED!, COMPLETE: jobStates.SUCCEEDED!, CANCELED: jobStates.CANCELED!,
};
const jobCodes: Record<string, string> = {
  COMFYUI_QUEUED: "排队中",
  COMFYUI_RUNNING: "生成中",
  COMFYUI_PROGRESS_UNAVAILABLE: "进度暂不可用，保留原任务",
  COMFYUI_RESULT_STORAGE_FAILED: "结果暂未入库，将继续尝试取回原结果",
  COMFYUI_RESULT_DOWNLOAD_FAILED: "图片暂未取回，将继续查询原结果",
  COMFYUI_CANCEL_UNSUPPORTED: "当前阶段不支持定向取消",
  COMFYUI_CANCEL_RUNNING_UNSUPPORTED: "任务已开始，当前实例不支持定向取消",
  COMFYUI_CANCEL_NOT_CONFIRMED: "取消结果待确认，将继续查看原任务",
  COMFYUI_OUTPUT_INVALID: "工作流没有返回可用的图片",
  REAL_MEDIA_OUTPUT_INVALID: "生成图片未通过校验",
  REAL_MEDIA_SOURCE_INVALID: "参考图已失效，任务未完成",
  REAL_MEDIA_INPUT_CHANGED: "镜头或参考图版本已变化，任务未完成",
  REAL_MEDIA_SUBMISSION_UNKNOWN: jobStates.UNKNOWN!,
};

export function comfyUiJobLabel(job: ComfyUiJob): string {
  if (job.state === "SUCCEEDED" || job.state === "CANCELED") return jobStates[job.state]!;
  if (job.errorCode === "COMFYUI_RESULT_STORAGE_FAILED" && job.state === "FAILED") return "结果存储失败";
  return jobCodes[job.errorCode ?? ""] ?? jobPhases[job.phase?.toUpperCase() ?? ""] ?? jobStates[job.state] ?? jobStates.WAITING_EXTERNAL!;
}

export function comfyUiJobSettled(job: ComfyUiJob): boolean {
  return ["SUCCEEDED", "FAILED", "CANCELED"].includes(job.state);
}

interface Props {
  workflows: readonly ComfyUiWorkflow[];
  input: ComfyUiQuoteInput | null;
  references: readonly ComfyUiReference[];
  disabled: boolean;
  onChange: (input: ComfyUiQuoteInput) => void;
}

export function ComfyUiImageFields({ workflows, input, references, disabled, onChange }: Props) {
  const promptHelpId = useId();
  const referenceHelpId = useId();
  const workflow = workflows.find(item => item.id === input?.workflowId);
  if (!input || !workflow) return null;
  const promptTooLong = input.prompt.trim().length > COMFYUI_PROMPT_LIMIT;
  return <div className={styles.comfyFields}>
    <div className={styles.fields}>
      <label>ComfyUI 工作流
        <select aria-label="ComfyUI 工作流" value={workflow.id} disabled={disabled} onChange={event => {
          const next = workflows.find(item => item.id === event.target.value), size = next?.dimensions[0];
          if (next && size) onChange({ workflowId: next.id, prompt: input.prompt, ...size });
        }}>
          {workflows.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </label>
      <label>图片尺寸
        <select aria-label="图片尺寸" value={`${input.width}x${input.height}`} disabled={disabled} onChange={event => {
          const size = workflow.dimensions.find(item => `${item.width}x${item.height}` === event.target.value);
          if (size) onChange({ ...input, ...size });
        }}>
          {workflow.dimensions.map(({ width, height }) => <option key={`${width}x${height}`} value={`${width}x${height}`}>{width} × {height}</option>)}
        </select>
      </label>
    </div>
    <label>图片提示词
      <textarea aria-label="图片提示词" aria-describedby={promptTooLong ? promptHelpId : undefined}
        value={input.prompt} rows={4} maxLength={COMFYUI_PROMPT_LIMIT} disabled={disabled}
        onChange={event => onChange({ ...input, prompt: event.target.value })} />
      {promptTooLong ? <span id={promptHelpId}>图片提示词最多 {COMFYUI_PROMPT_LIMIT} 字符，请缩短后再生成。</span> : null}
    </label>
    {workflow.requiresReference ? <label>参考图片
      <select aria-label="参考图片" aria-describedby={!references.length ? referenceHelpId : undefined}
        value={input.referenceAssetId ?? ""} disabled={disabled} onChange={event => onChange({ ...input, referenceAssetId: event.target.value || undefined })}>
        <option value="">请选择本作品的图片</option>
        {references.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select>
      {!references.length ? <span id={referenceHelpId}>本作品暂无可用参考图片。</span> : null}
    </label> : null}
    {workflow.requiresReference && input.referenceAssetId ? <img className={styles.referenceThumbnail} alt="当前参考图片"
      src={`/api/v1/real-media/assets/${input.referenceAssetId}/content`} /> : null}
  </div>;
}
