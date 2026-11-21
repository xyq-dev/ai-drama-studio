import { featureModelLabel, type FeatureKey } from "@ai-drama/contracts";
import type { LegacyFeatureHint } from "./feature-config.service";

export interface LegacyModelSnapshot {
  defaultProvider: string | null;
  providers: Record<string, { apiKey: string | null; models: string[] } | undefined>;
}

export interface LegacyMediaSnapshot {
  dashscopeApiKey: string | null;
  openaiMediaApiKey: string | null;
  minimaxApiKey: string | null;
}

/**
 * Read the already-saved live vendor for one feature. A DashScope media key stays on storyboard.
 * It is not copied onto writing or voice. Voice legacy is MiniMax only.
 */
export function legacyLiveFor(feature: FeatureKey, models: LegacyModelSnapshot | null, media: LegacyMediaSnapshot | null): LegacyFeatureHint | null {
  if (feature === "writing") {
    const provider = models?.defaultProvider;
    if (provider !== "openai" && provider !== "deepseek" && provider !== "anthropic") return null;
    const entry = models?.providers[provider];
    const model = entry?.models[0];
    if (!entry?.apiKey || !model) return null;
    const vendorLabel = provider === "openai" ? "OpenAI" : provider === "deepseek" ? "DeepSeek" : "Claude";
    return { vendor: provider, model, vendorLabel, modelLabel: featureModelLabel(model) };
  }
  if (feature === "storyboard") {
    if (media?.dashscopeApiKey) return { vendor: "bailian", model: "qwen-image-3.0", vendorLabel: "阿里云", modelLabel: "Qwen Image" };
    if (media?.openaiMediaApiKey) return { vendor: "openai", model: "gpt-image-2.5-sunburst", vendorLabel: "OpenAI", modelLabel: "GPT Image Sunburst" };
    return null;
  }
  if (media?.minimaxApiKey) return { vendor: "minimax", model: "speech-2.8-hd", vendorLabel: "MiniMax", modelLabel: "speech-2.8-hd" };
  return null;
}

export function legacySecretFor(feature: FeatureKey, vendor: string, models: LegacyModelSnapshot | null, media: LegacyMediaSnapshot | null): string | null {
  if (feature === "writing" && (vendor === "openai" || vendor === "deepseek" || vendor === "anthropic")) {
    return models?.providers[vendor]?.apiKey ?? null;
  }
  if (feature === "storyboard" && vendor === "bailian") return media?.dashscopeApiKey ?? null;
  if (feature === "storyboard" && vendor === "openai") return media?.openaiMediaApiKey ?? null;
  if (feature === "voice" && vendor === "minimax") return media?.minimaxApiKey ?? null;
  return null;
}
