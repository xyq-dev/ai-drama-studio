/** Vendor catalog shown under 后台「AI 大模型». Status must come from live project capability, not the Figma demo. */
export const AI_MODEL_VENDOR_IDS = ["deepseek", "openai", "bailian", "anthropic"] as const;
export type AiModelVendorId = (typeof AI_MODEL_VENDOR_IDS)[number];

export interface AiModelVendorDef {
  id: AiModelVendorId;
  label: string;
  shortLabel: string;
  mark: string;
  href: string;
}

export const AI_MODEL_VENDORS: readonly AiModelVendorDef[] = [
  {
    id: "deepseek",
    label: "DeepSeek",
    shortLabel: "DeepSeek",
    mark: "D",
    href: "/admin/ai-models/deepseek",
  },
  {
    id: "openai",
    label: "OpenAI",
    shortLabel: "OpenAI",
    mark: "O",
    href: "/admin/ai-models/openai",
  },
  {
    id: "bailian",
    label: "阿里云百炼",
    shortLabel: "阿里云百炼",
    mark: "千",
    href: "/admin/ai-models/bailian",
  },
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    shortLabel: "Anthropic",
    mark: "A",
    href: "/admin/ai-models/anthropic",
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
