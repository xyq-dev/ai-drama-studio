import { probeDeepseekWriting } from "@ai-drama/providers";
import { FeatureConfigError, networkRefusingFeatureProbe, type FeatureProbe } from "./feature-config.service";

/**
 * Production writing probe. DeepSeek uses one official Chat Completions JSON Output request.
 * Other writing vendors stay refused until they have their own authorized send path.
 * fetchImpl is required so tests cannot fall through to the real network.
 */
export function featureWritingProbe(fetchImpl: typeof fetch | undefined): FeatureProbe {
  const refused = networkRefusingFeatureProbe();
  return async (input) => {
    if (input.feature !== "writing" || input.vendor !== "deepseek") return refused(input);
    if (!fetchImpl) {
      throw new FeatureConfigError(503, "FEATURE_PROBE_REFUSED", "当前环境未接通供应商检测，测试没有发出。");
    }
    return probeDeepseekWriting({
      apiKey: input.apiKey,
      model: input.model,
      fetchImpl,
    });
  };
}
