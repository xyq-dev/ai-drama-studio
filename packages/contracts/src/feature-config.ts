import { z } from "zod";

/**
 * Per-feature vendor configuration. Model ids are the ones this repository can actually call.
 * Prototype short names (GPT Image, CosyVoice, DeepSeek Chat) are not an allowlist.
 *
 * Connected means an adapter exists in this repo:
 * - writing × bailian: the qwen text adapter is retired, so the slot is unconnected.
 * - storyboard × google: no image adapter.
 * - voice × openai: no speech adapter (reachable so the unconnected state is explicit).
 * Official voice stays MiniMax speech-2.8-hd. Bailian qwen3-tts-flash is only used when an operator enables it.
 */
export const FEATURE_KEYS = ["writing", "storyboard", "voice"] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

export const FEATURE_VENDOR_KEYS = ["bailian", "openai", "deepseek", "google", "minimax"] as const;
export type FeatureVendor = (typeof FEATURE_VENDOR_KEYS)[number];

export const FEATURE_LABELS: Record<FeatureKey, string> = {
  writing: "剧本编写",
  storyboard: "分镜生图",
  voice: "角色配音",
};

export const FEATURE_VENDOR_LABELS: Record<FeatureVendor, string> = {
  bailian: "阿里云",
  openai: "OpenAI",
  deepseek: "DeepSeek",
  google: "Google",
  minimax: "MiniMax",
};

export interface FeatureModelOption {
  id: string;
  label: string;
}

export interface FeatureVendorCapability {
  vendor: FeatureVendor;
  connected: boolean;
  /** Shown when connected is false. Never includes a credential. */
  gap: string | null;
  models: readonly FeatureModelOption[];
}

const WRITING_OPENAI: readonly FeatureModelOption[] = [
  { id: "gpt-6-astra", label: "GPT-6 Astra" },
  { id: "gpt-6.1-sol", label: "GPT-6.1 Sol" },
  { id: "gpt-6-luna", label: "GPT-6 Luna" },
];

export const FEATURE_CAPABILITIES: Record<FeatureKey, readonly FeatureVendorCapability[]> = {
  writing: [
    {
      vendor: "bailian",
      connected: false,
      gap: "剧本编写的阿里云百炼文本适配器已退役，无法保存、测试或启用。接入缺口：在用的百炼编剧适配器。",
      models: [],
    },
    { vendor: "openai", connected: true, gap: null, models: WRITING_OPENAI },
    { vendor: "deepseek", connected: true, gap: null, models: [{ id: "deepseek-flash", label: "DeepSeek Flash" }] },
  ],
  storyboard: [
    { vendor: "bailian", connected: true, gap: null, models: [{ id: "qwen-image-3.0", label: "Qwen Image" }] },
    { vendor: "openai", connected: true, gap: null, models: [{ id: "gpt-image-2.5-sunburst", label: "GPT Image Sunburst" }] },
    {
      vendor: "google",
      connected: false,
      gap: "分镜生图目前没有 Google 生图适配器，无法保存、测试或启用。接入缺口：Google 图像生成适配器。",
      models: [],
    },
  ],
  voice: [
    { vendor: "bailian", connected: true, gap: null, models: [{ id: "qwen3-tts-flash", label: "qwen3-tts-flash" }] },
    { vendor: "minimax", connected: true, gap: null, models: [{ id: "speech-2.8-hd", label: "speech-2.8-hd" }] },
  ],
};

/** Vendors a caller may name even when they are not a button, so the unconnected state is explicit. */
const EXTRA_UNCONNECTED: Record<FeatureKey, readonly FeatureVendorCapability[]> = {
  writing: [],
  storyboard: [],
  voice: [
    {
      vendor: "openai",
      connected: false,
      gap: "角色配音目前只支持阿里云百炼和 MiniMax。OpenAI 配音适配器尚未接入，无法保存、测试或启用。接入缺口：OpenAI TTS / 语音合成适配器。",
      models: [],
    },
  ],
};

export function featureCapability(feature: FeatureKey, vendor: string): FeatureVendorCapability | null {
  const listed = FEATURE_CAPABILITIES[feature].find((item) => item.vendor === vendor);
  if (listed) return listed;
  return EXTRA_UNCONNECTED[feature].find((item) => item.vendor === vendor) ?? null;
}

export function featureModelLabel(model: string): string {
  for (const feature of FEATURE_KEYS) {
    for (const slot of [...FEATURE_CAPABILITIES[feature], ...EXTRA_UNCONNECTED[feature]]) {
      const found = slot.models.find((item) => item.id === model);
      if (found) return found.label;
    }
  }
  if (model === "claude-opus-5-5") return "Claude Opus 5.5";
  return model;
}

export const FEATURE_PROBE_SCALE = "1 次最小请求";
export const FEATURE_PROBE_COST_NOTE = "可能产生供应商费用。金额未回传前不会显示为 0。取消则不会发起调用。";

const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const featureKeySchema = z.enum(FEATURE_KEYS);
const vendorSchema = z.enum(FEATURE_VENDOR_KEYS);

export const featureDraftSaveSchema = z.object({
  expectedRevision: revision,
  vendor: vendorSchema,
  model: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
  secretAction: z.enum(["keep", "replace", "clear"]),
  apiKey: z.string().min(8).max(512).regex(/^\S+$/u).optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.secretAction === "replace") !== (value.apiKey !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["apiKey"], message: "Secret action and value do not match" });
  }
});
export type FeatureDraftSave = z.infer<typeof featureDraftSaveSchema>;

export const featureTestRequestSchema = z.object({
  expectedRevision: revision,
  vendor: vendorSchema,
  confirmCost: z.literal(true),
}).strict();
export type FeatureTestRequest = z.infer<typeof featureTestRequestSchema>;

export const featureEnableRequestSchema = z.object({
  expectedRevision: revision,
  vendor: vendorSchema,
  testToken: z.string().regex(/^[A-Za-z0-9_-]{16,80}$/),
}).strict();
export type FeatureEnableRequest = z.infer<typeof featureEnableRequestSchema>;

export type FeatureDraftStatus = "blank" | "saved" | "testing" | "passed" | "failed";

export interface FeatureSlotView {
  vendor: FeatureVendor;
  label: string;
  connected: boolean;
  gap: string | null;
  models: FeatureModelOption[];
  model: string | null;
  keyConfigured: boolean;
  draftStatus: FeatureDraftStatus;
  testToken: string | null;
  failureMessage: string | null;
}

export interface FeatureLiveView {
  source: "enabled" | "legacy";
  vendor: string;
  vendorLabel: string;
  model: string;
  modelLabel: string;
  version: string | null;
}

export interface FeatureCardView {
  feature: FeatureKey;
  label: string;
  live: FeatureLiveView | null;
  /** No enabled version and no saved draft on any connected vendor. */
  firstTime: boolean;
  slots: FeatureSlotView[];
  probeScale: string;
  probeCostNote: string;
}

export interface FeatureConfigView {
  revision: number;
  features: FeatureCardView[];
  validation: "local_only";
}

export interface FeatureMutationResult {
  view: FeatureConfigView;
  probe?: { ok: boolean; message: string };
}

export type UsageStatus = "present" | "unknown" | "pending";
export type CostStatus = "present" | "pending" | "unknown" | "estimated";

export interface UsageAmount {
  status: UsageStatus;
  amount?: number;
  unit?: string;
}

export interface UsageCost {
  status: CostStatus;
  amount?: string;
  currency?: "CNY" | "USD";
  source?: string;
  rule?: string;
}

export interface UsageRecordView {
  id: string;
  taskId: string;
  attempt: number;
  feature: FeatureKey;
  featureLabel: string;
  vendorLabel: string;
  modelLabel: string;
  configVersion: string | null;
  result: "succeeded" | "failed" | "unknown";
  startedAt: string;
  usageText: string;
  costText: string;
  projectId: string | null;
  projectLabel: string;
  episodeId: string | null;
  episodeLabel: string;
  kind: "production" | "admin_test";
  credentialRef: string | null;
}

export interface UsageSummaryView {
  scope: "episode_production";
  projectId: string | null;
  episodeId: string | null;
  projects: Array<{ id: string; label: string }>;
  episodes: Array<{ id: string; label: string; projectId: string }>;
  totals: Array<{ feature: FeatureKey; featureLabel: string; usageText: string; costText: string }>;
  records: UsageRecordView[];
  footnote: string;
}

export const USAGE_FOOTNOTE = "仅汇总已确认金额；部分费用待回传。未知用量按原样保留，不会显示为 0。不同单位分别汇总。管理员测试不计入本集生产汇总。";

const UNIT_LABEL: Record<string, string> = {
  token: "tokens",
  image: "张",
  character: "字符",
  request: "次",
};

/** Never renders an unknown or pending amount as zero. */
export function formatUsage(usage: UsageAmount): string {
  if (usage.status !== "present" || usage.amount === undefined || !usage.unit) return "未知";
  if (!Number.isFinite(usage.amount) || usage.amount < 0) return "未知";
  const unit = UNIT_LABEL[usage.unit] ?? usage.unit;
  return `${usage.amount.toLocaleString("zh-CN")} ${unit}`;
}

export function formatCost(cost: UsageCost): string {
  if (cost.status === "pending") return "待回传费用";
  if (cost.status === "estimated") return cost.rule ? `估算 · ${cost.rule}` : "估算";
  if (cost.status !== "present" || !cost.amount || !cost.currency) return "未知";
  if (!/^(0|[1-9]\d{0,7})(\.\d{1,8})?$/.test(cost.amount)) return "未知";
  const symbol = cost.currency === "CNY" ? "¥" : "US$";
  return `${symbol}${cost.amount}`;
}

export function sumPresentUsage(records: Array<{ feature: FeatureKey; usage: UsageAmount }>, feature: FeatureKey): string {
  const rows = records.filter((item) => item.feature === feature);
  const present = rows.filter((item) => item.usage.status === "present" && item.usage.unit && item.usage.amount !== undefined);
  if (present.length === 0) return "未知";
  const units = new Set(present.map((item) => item.usage.unit));
  if (units.size !== 1) return "未知";
  const amount = present.reduce((total, item) => total + (item.usage.amount ?? 0), 0);
  return formatUsage({ status: "present", amount, unit: present[0]!.usage.unit });
}

export function sumPresentCost(records: Array<{ feature: FeatureKey; cost: UsageCost }>, feature: FeatureKey): string {
  const rows = records.filter((item) => item.feature === feature);
  const present = rows.filter((item) => item.cost.status === "present" && item.cost.amount && item.cost.currency);
  if (present.length === 0) {
    if (rows.some((item) => item.cost.status === "pending")) return "待回传费用";
    return "未知";
  }
  const currencies = new Set(present.map((item) => item.cost.currency));
  if (currencies.size !== 1) return "未知";
  const currency = present[0]!.cost.currency!;
  const scale = 100_000_000n;
  let total = 0n;
  for (const item of present) {
    const [whole = "0", fraction = ""] = item.cost.amount!.split(".");
    total += BigInt(whole) * scale + BigInt(fraction.padEnd(8, "0"));
  }
  const whole = total / scale;
  const fraction = (total % scale).toString().padStart(8, "0").replace(/0+$/, "");
  const amount = fraction ? `${whole.toString()}.${fraction}` : whole.toString();
  return formatCost({ status: "present", amount, currency });
}

export interface FeatureChoiceInput {
  feature: FeatureKey;
  vendor: string;
  model: string;
  /** Active writing-provider allowlist. Null skips this extra gate (catalog still applies). */
  writingAllowlist?: readonly string[] | null;
  /** Remaining writing calls. Null skips the budget gate. Zero blocks a writing test or enable. */
  writingCallsRemaining?: number | null;
}

export function featureChoiceBlock(input: FeatureChoiceInput): { ok: true } | { ok: false; code: string; message: string } {
  if (!featureKeySchema.safeParse(input.feature).success) {
    return { ok: false, code: "FEATURE_CONFIG_INVALID", message: "功能配置无效。" };
  }
  const capability = featureCapability(input.feature, input.vendor);
  if (!capability) return { ok: false, code: "FEATURE_VENDOR_UNCONNECTED", message: "该服务商尚未接入。" };
  if (!capability.connected) {
    return { ok: false, code: "FEATURE_VENDOR_UNCONNECTED", message: capability.gap ?? "该服务商尚未接入。" };
  }
  if (!capability.models.some((item) => item.id === input.model)) {
    return { ok: false, code: "FEATURE_MODEL_NOT_APPROVED", message: "该模型不在获准列表中，已阻止这次操作。" };
  }
  if (input.feature === "writing" && input.writingAllowlist && !input.writingAllowlist.includes(input.model)) {
    return { ok: false, code: "FEATURE_MODEL_NOT_APPROVED", message: "该模型不在当前写作白名单中，已阻止这次操作。" };
  }
  if (input.feature === "writing" && input.writingCallsRemaining !== null && input.writingCallsRemaining !== undefined && input.writingCallsRemaining < 1) {
    return { ok: false, code: "FEATURE_BUDGET_BLOCKED", message: "今日写作调用次数已用完，已阻止测试和启用。" };
  }
  return { ok: true };
}

/** Explicit enable of Bailian voice is not a fallback. Missing or MiniMax stays on MiniMax. */
export function officialVoiceRoute(enabled: "minimax" | "bailian" | null | undefined): "minimax" | "bailian" {
  return enabled === "bailian" ? "bailian" : "minimax";
}

export function storyboardProviderForVendor(vendor: string): "openai-media" | "dashscope-media" | null {
  if (vendor === "openai") return "openai-media";
  if (vendor === "bailian") return "dashscope-media";
  return null;
}

export function writingProviderForVendor(vendor: string): "openai" | "deepseek" | "anthropic" | null {
  if (vendor === "openai" || vendor === "deepseek" || vendor === "anthropic") return vendor;
  return null;
}
