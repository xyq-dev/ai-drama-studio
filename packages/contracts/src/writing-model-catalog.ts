// Project-approved text models, checked 2026-11-23 against each adapter's actual channel.
// Keep historical or unrecognised saved IDs in the vault; only this catalog supplies new choices.
export const WRITING_MODEL_CHANNELS = {
  deepseek: {
    id: "deepseek-direct",
    label: "DeepSeek 官方直连",
    endpoint: "https://api.deepseek.com/chat/completions",
    // The API accepts the alias (id); the pricing table gives the official version name (label).
    // https://api-docs.deepseek.com/quick_start/pricing/
    models: [
      { id: "deepseek-flash", label: "DeepSeek-V4.1-Flash-1017" },
      { id: "deepseek-v4-pro", label: "DeepSeek-V4-Pro-0813" },
    ],
  },
  openai: {
    id: "openai-direct",
    label: "OpenAI 官方直连",
    endpoint: "https://api.openai.com/v1/responses",
    // https://developers.openai.com/api/docs/models/gpt-6-astra
    // https://developers.openai.com/api/docs/models/gpt-6.1-sol
    // https://developers.openai.com/api/docs/models/gpt-6-luna
    models: [
      { id: "gpt-6-astra", label: "GPT-6 Astra" },
      { id: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
      { id: "gpt-6-luna", label: "GPT-6 Luna" },
    ],
  },
  anthropic: {
    id: "anthropic-direct",
    label: "Anthropic 官方直连",
    endpoint: "https://api.anthropic.com/v1/messages",
    // https://platform.claude.com/docs/en/models/overview
    // https://platform.claude.com/docs/en/models/fable-5-1/overview
    models: [
      { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
      { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
      { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
      { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
    ],
  },
  bailian: {
    id: "bailian-cn",
    label: "阿里云百炼（北京）",
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    // https://help.aliyun.com/zh/model-studio/qwen-plus (北京, structured output).
    // https://help.aliyun.com/zh/model-studio/list-model-permissions (API model and display name).
    models: [{ id: "qwen-plus", label: "通义千问-Plus" }],
  },
} as const;

export type WritingModelVendor = keyof typeof WRITING_MODEL_CHANNELS;
export type WritingModelChannelId = (typeof WRITING_MODEL_CHANNELS)[WritingModelVendor]["id"];

export function writingModelOptions(
  vendor: string,
  channel: string,
  allowlist?: readonly string[] | null,
): readonly { id: string; label: string }[] {
  if (!Object.hasOwn(WRITING_MODEL_CHANNELS, vendor)) return [];
  const catalog = WRITING_MODEL_CHANNELS[vendor as WritingModelVendor];
  if (catalog.id !== channel) return [];
  return allowlist == null ? catalog.models : catalog.models.filter(({ id }) => allowlist.includes(id));
}
