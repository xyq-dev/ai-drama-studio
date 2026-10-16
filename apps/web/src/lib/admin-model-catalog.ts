import type { TitleWritingProviderKey } from "@ai-drama/contracts";

/**
 * Candidate model IDs offered by the administrator model picker on /admin/models. They are options only: the saved
 * list is still the server-side whitelist, checked by the existing contract, and any other valid ID can be added as a
 * custom model. Nothing here is fetched from a provider.
 *
 * Checked against the official documentation against the request each adapter sends
 * (packages/providers/src/text-writing.ts):
 * - OpenAI (Responses API, text.format json_schema strict), 2026-10-10: each model's own page gives the exact model ID,
 *   lists v1/responses as supported and structured_outputs as a feature: https://developers.openai.com/api/docs/models/<id>.
 * - Claude (Messages API, output_config.format json_schema, adaptive thinking), 2026-10-16: the Claude API IDs at
 *   https://platform.claude.com/docs/en/about-claude/models/overview ; each is listed as supported at
 *   https://platform.claude.com/docs/en/build-with-claude/structured-outputs and
 *   https://platform.claude.com/docs/en/build-with-claude/effort . Every current ID is a pinned snapshot.
 *   claude-opus-5-5 is also the model Claude Code was running when this was written; that is a coincidence of names,
 *   not a link: the site calls the API with its own Anthropic API key only.
 *
 * Not claimed: that an account has a model enabled, that any candidate has been called by this project, or any price,
 * speed or ranking. Notes repeat only the provider's own description.
 */
export type ModelCandidate = { id: string; name: string; note: string };

export const MODEL_CANDIDATES: Readonly<Record<TitleWritingProviderKey, readonly ModelCandidate[]>> = {
  openai: [
    { id: "gpt-6-astra", name: "GPT-6 Astra", note: "官方说明：能力最强，适合要求最高的任务" },
    { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", note: "官方说明：接近 Astra 的表现，成本更低" },
    { id: "gpt-6-luna", name: "GPT-6 Luna", note: "官方说明：效率最高，适合聚焦、大批量的任务" },
  ],
  anthropic: [
    { id: "claude-opus-5-5", name: "Claude Opus 5.5", note: "官方说明：适合长时间运行的编码与知识工作" },
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", note: "官方说明：速度与智能的最佳平衡" },
    { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", note: "官方说明：适合大批量、对延迟敏感的任务" },
    { id: "claude-fable-5-1", name: "Claude Fable 5.1", note: "官方说明：适合高难度推理与长周期任务" },
  ],
};

export function candidateFor(providerKey: TitleWritingProviderKey, id: string): ModelCandidate | undefined {
  return MODEL_CANDIDATES[providerKey].find((candidate) => candidate.id === id);
}
