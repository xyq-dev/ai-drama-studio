/** Vendor catalog shown under 后台「AI 大模型». Status must come from live project capability, not the Figma demo. */
export const AI_MODEL_VENDOR_IDS = ["deepseek", "openai", "bailian", "anthropic"] as const;
export type AiModelVendorId = (typeof AI_MODEL_VENDOR_IDS)[number];

export interface AiModelVendorDef {
  id: AiModelVendorId;
  label: string;
  shortLabel: string;
  mark: string;
  href: string;
  /** npm package shown on the settings page when this repo already depends on that adapter family. */
  sdk: string | null;
  /** Honest capability line under the vendor name. Never claims a send path this repo does not have. */
  capability: string;
}

export const AI_MODEL_VENDORS: readonly AiModelVendorDef[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    shortLabel: "DeepSeek",
    mark: "D",
    href: "/admin/ai-models/deepseek",
    sdk: "@ai-sdk/deepseek",
    capability: "2 个候选模型 · 编剧已接入",
  },
  {
    id: "openai",
    label: "OpenAI",
    shortLabel: "OpenAI",
    mark: "O",
    href: "/admin/ai-models/openai",
    sdk: "@ai-sdk/openai",
    capability: "3 个候选模型 · 编剧与生图已接入",
  },
  {
    id: "bailian",
    label: "阿里云百炼",
    shortLabel: "阿里云百炼",
    mark: "千",
    href: "/admin/ai-models/bailian",
    sdk: null,
    capability: "写作已接入 qwen-plus · 凭证按功能绑定",
  },
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    shortLabel: "Anthropic",
    mark: "A",
    href: "/admin/ai-models/anthropic",
    sdk: "@ai-sdk/anthropic",
    capability: "可保存供应商凭证 · 功能配置编剧暂未开放",
  },
];

export const AI_MODELS_CATALOG_HREF = "/admin/ai-models";

export function isAiModelVendorId(value: string | undefined): value is AiModelVendorId {
  return (AI_MODEL_VENDOR_IDS as readonly string[]).includes(value ?? "");
}

export function aiModelVendor(id: string | undefined): AiModelVendorDef | null {
  return AI_MODEL_VENDORS.find((item) => item.id === id) ?? null;
}

export function isAiModelsPath(pathname: string): boolean {
  return pathname === AI_MODELS_CATALOG_HREF || pathname.startsWith(`${AI_MODELS_CATALOG_HREF}/`);
}

export function isFeatureConfigPath(pathname: string): boolean {
  return (
    pathname === "/admin" ||
    pathname.startsWith("/admin/features") ||
    pathname.startsWith("/admin/models") ||
    pathname.startsWith("/admin/media-keys")
  );
}

/** Generic on-page mask. Public views must not include secret suffixes, prefixes, or fingerprints. */
export const SAVED_SECRET_MASK = "••••••••";
