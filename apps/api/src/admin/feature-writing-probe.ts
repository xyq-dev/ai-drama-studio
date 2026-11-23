import { QWEN_PLUS_MODEL, type UsageAmount } from "@ai-drama/contracts";
import { probeDeepseekWriting, sendAiSdkWriting } from "@ai-drama/providers";
import { z } from "zod";
import { FeatureConfigError, networkRefusingFeatureProbe, type FeatureProbe, type FeatureProbeInput, type FeatureProbeResult } from "./feature-config.service";

const titleReply = z.object({ title: z.string().trim().max(40).regex(/\p{Script=Han}/u) }).strict();

async function probeBailianWriting(input: FeatureProbeInput, fetchImpl: typeof fetch): Promise<FeatureProbeResult> {
  const answer = await sendAiSdkWriting({
    kind: "bailian",
    apiKey: input.apiKey,
    fetchImpl,
    timeoutMs: 30_000,
    request: {
      model: input.model,
      system: "你是短剧编剧。只返回规定的 JSON 对象。",
      user: "为一部讲述雨夜重逢的短剧拟一个简短的中文剧名。",
      schemaName: "writing_probe_title",
      jsonSchema: z.toJSONSchema(titleReply),
      maxOutputTokens: 128,
    },
  });
  const total = answer.usage.totalTokens;
  const usage: UsageAmount = total === null ? { status: "unknown" } : { status: "present", amount: total, unit: "token" };
  if (answer.outcome === "unknown") return { ok: false, outcome: "unknown", message: "结果未知，请核对供应商调用记录。", usage };
  if (answer.outcome !== "answered" || !answer.content) {
    const message = answer.errorCode === "auth" ? "认证失败，请检查密钥及访问权限。" : "未收到完整的编剧回复，请检查模型配置。";
    return { ok: false, message, usage };
  }
  // The Beijing qwen-plus alias currently maps to this documented snapshot (2026-11-23).
  if (answer.responseModel !== QWEN_PLUS_MODEL && answer.responseModel !== "qwen-plus-2025-12-01") {
    return { ok: false, message: "无法确认供应商返回了所选模型。", usage };
  }
  try {
    if (titleReply.safeParse(JSON.parse(answer.content)).success) return { ok: true, message: "检测通过", usage };
  } catch { /* An incomplete or non-JSON reply cannot verify the draft. */ }
  return { ok: false, message: "模型回复未通过编剧格式检查。", usage };
}

/** Only enabled writing probes may use the injected transport. */
export function featureWritingProbe(fetchImpl: typeof fetch | undefined): FeatureProbe {
  const refused = networkRefusingFeatureProbe();
  return async (input) => {
    if (input.feature !== "writing" || (input.vendor !== "deepseek" && input.vendor !== "bailian")) return refused(input);
    if (!fetchImpl) {
      throw new FeatureConfigError(503, "FEATURE_PROBE_REFUSED", "当前环境未接通供应商检测，测试没有发出。");
    }
    if (input.vendor === "bailian") {
      return input.kind === "admin_test" ? probeBailianWriting(input, fetchImpl) : refused(input);
    }
    return probeDeepseekWriting({ apiKey: input.apiKey, model: input.model, fetchImpl });
  };
}
