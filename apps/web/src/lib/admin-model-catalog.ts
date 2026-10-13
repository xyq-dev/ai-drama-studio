import type { TitleWritingProviderKey } from "@ai-drama/contracts";

/**
 * Candidate model IDs offered by the administrator model picker on /admin/models. They are options only: the saved
 * list is still the server-side whitelist, checked by the existing contract, and any other valid ID can be added as a
 * custom model. Nothing here is fetched from a provider.
 *
 * Checked against the official documentation on 2026-10-10, against the request each adapter sends
 * (packages/providers/src/text-writing.ts):
 * - Qwen (compatible mode, response_format json_object, enable_thinking false): every ID below is listed verbatim as a
 *   hybrid-thinking model (thinking can be turned off) at https://help.aliyun.com/zh/model-studio/deep-thinking ;
 *   its series (Qwen3.7-Plus, Qwen3.8-Max, Qwen3.8-Flash) supports JSON Object mode at
 *   https://help.aliyun.com/zh/model-studio/json-mode ; qwen3.8-max and qwen3.8-flash also appear as model IDs at
 *   https://help.aliyun.com/zh/model-studio/models . Thinking-only IDs (qwen3.7-max-preview, qwen3.7-max-2026-05-17,
 *   ...) are left out. Region availability is not stated there and is not claimed.
 * - OpenAI (Responses API, text.format json_schema strict): each model's own page gives the exact model ID, lists
 *   v1/responses as supported and structured_outputs as a feature: https://developers.openai.com/api/docs/models/<id>.
 * - DeepSeek (chat completions, response_format json_object, thinking disabled): the two `model` values at
 *   https://api-docs.deepseek.com/quick_start/pricing , both with JSON output and non-thinking mode; the
 *   {"thinking": {"type": "disabled"}} switch is at https://api-docs.deepseek.com/guides/thinking_mode .
 *
 * Not claimed: that an account or region has a model enabled, that any candidate has been called by this project, or
 * any price, speed or ranking. Notes repeat only the provider's own description.
 */
export type ModelCandidate = { id: string; name: string; note: string };

export const MODEL_CANDIDATES: Readonly<Record<TitleWritingProviderKey, readonly ModelCandidate[]>> = {
  qwen: [
    { id: "qwen3.7-plus-2026-05-26", name: "Qwen3.7-Plus（固定快照）", note: "本项目千问默认使用的固定快照，可关闭思考模式" },
    { id: "qwen3.7-plus", name: "Qwen3.7-Plus", note: "官方稳定名称，不是固定快照，可关闭思考模式" },
    { id: "qwen3.8-max", name: "Qwen3.8-Max", note: "官方 Max 系列，可关闭思考模式" },
    { id: "qwen3.8-flash", name: "Qwen3.8-Flash", note: "官方 Flash 系列，可关闭思考模式" },
  ],
  openai: [
    { id: "gpt-6-astra", name: "GPT-6 Astra", note: "官方说明：能力最强，适合要求最高的任务" },
    { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", note: "官方说明：接近 Astra 的表现，成本更低" },
    { id: "gpt-6-luna", name: "GPT-6 Luna", note: "官方说明：效率最高，适合聚焦、大批量的任务" },
  ],
  deepseek: [
    { id: "deepseek-flash", name: "DeepSeek Flash", note: "官方当前对应 DeepSeek-V4.1-Flash" },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", note: "官方当前对应 DeepSeek-V4-Pro" },
  ],
};

export function candidateFor(providerKey: TitleWritingProviderKey, id: string): ModelCandidate | undefined {
  return MODEL_CANDIDATES[providerKey].find((candidate) => candidate.id === id);
}
