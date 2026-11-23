import { WRITING_MODEL_CHANNELS, isDeepseekWritingModel, type UsageAmount, type UsageCost } from "@ai-drama/contracts";
import { DEEPSEEK_CHAT_COMPLETIONS_URL, deepseekWritingAdapter } from "./text-writing";

/** A short, cheap JSON Output ping. Not a full script generation, and never retried automatically. */
export const DEEPSEEK_WRITING_PROBE_TIMEOUT_MS = 30_000;
export const DEEPSEEK_WRITING_PROBE_MAX_TOKENS = 256;

export interface DeepseekWritingProbeResult {
  ok: boolean;
  outcome?: "unknown";
  message: string;
  usage: UsageAmount;
  cost: UsageCost;
}

const UNKNOWN_USAGE: UsageAmount = { status: "unknown" };
const UNKNOWN_COST: UsageCost = { status: "unknown" };

function result(ok: boolean, message: string, usage: UsageAmount = UNKNOWN_USAGE): DeepseekWritingProbeResult {
  return { ok, message, usage, cost: UNKNOWN_COST };
}

function unknownResult(message: string): DeepseekWritingProbeResult {
  return { ...result(false, message), outcome: "unknown" };
}

function publicMessage(message: string, secret: string): string {
  if (secret.length > 0 && message.includes(secret)) return "检测没有通过，草稿已保留，可以重试。";
  return message.length > 200 ? message.slice(0, 200) : message;
}

/**
 * Official DeepSeek writing probe: one POST /chat/completions with Bearer auth and JSON Output.
 * This is not GET /models; a passing result means the credential produced a non-empty JSON object
 * from the selected official model. UNKNOWN or empty content is not resent.
 */
export async function probeDeepseekWriting(options: {
  apiKey: string;
  model: string;
  fetchImpl: typeof fetch | undefined;
  timeoutMs?: number;
}): Promise<DeepseekWritingProbeResult> {
  const { apiKey, model } = options;
  if (!options.fetchImpl) {
    return result(false, "当前环境未接通供应商检测，测试没有发出。");
  }
  if (!isDeepseekWritingModel(model)) {
    return result(false, "该模型不在官方编剧候选中，检测没有发出。");
  }
  if (apiKey.length < 8 || /\s/u.test(apiKey)) {
    return result(false, "认证失败：API Key 格式无法用于请求。");
  }
  const timeoutMs = Math.min(options.timeoutMs ?? DEEPSEEK_WRITING_PROBE_TIMEOUT_MS, DEEPSEEK_WRITING_PROBE_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await options.fetchImpl(DEEPSEEK_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: 'Reply with json only. EXAMPLE JSON OUTPUT: {"ok":true}',
          },
          {
            role: "user",
            content: 'Return a json object: {"ok":true}',
          },
        ],
        thinking: { type: "disabled" },
        response_format: { type: "json_object" },
        max_tokens: DEEPSEEK_WRITING_PROBE_MAX_TOKENS,
        stream: false,
      }),
      redirect: "manual",
      signal: controller.signal,
    });
    const raw = await response.text();
    if (response.status === 401) return result(false, "认证失败：请检查 API Key 是否正确。");
    if (response.status === 402) return result(false, "余额不足：请先为 DeepSeek 账号充值。");
    if (response.status === 429) return result(false, "请求被限流：请稍后再检测，不会自动重试。");
    if (response.status === 408 || response.status === 504) return unknownResult("请求超时，请先核对供应商的调用记录。");
    if (response.status === 400 || response.status === 413 || response.status === 422) {
      return result(false, "请求参数被拒绝，检测没有通过。");
    }
    if (response.status >= 500 && response.status <= 599) {
      return unknownResult("供应商服务异常，请核对调用记录。");
    }
    if (response.status < 200 || response.status >= 300) {
      return result(false, "检测没有通过，草稿已保留，可以重试。");
    }
    // A successful body must not echo the key; error statuses are already classified above and never copy the body.
    if (raw.includes(apiKey)) {
      return result(false, "检测响应含有敏感内容，结果已丢弃。");
    }
    const answer = deepseekWritingAdapter.parseAnswer(raw, apiKey);
    const tokens = answer.usage.totalTokens;
    const usage: UsageAmount = tokens !== null && !String(tokens).includes(apiKey)
      ? { status: "present", amount: tokens, unit: "token" }
      : UNKNOWN_USAGE;
    if (answer.errorCode || !answer.content) {
      return result(false, "没有收到完整的检测回复。", usage);
    }
    const version = WRITING_MODEL_CHANNELS.deepseek.models.find((item) => item.id === model)?.label;
    if (answer.responseModel !== model && answer.responseModel?.toLowerCase() !== version?.toLowerCase()) {
      return result(false, "供应商返回的模型与所选模型不符。", usage);
    }
    try {
      const parsed: unknown = JSON.parse(answer.content);
      if (!parsed || typeof parsed !== "object" || !("ok" in parsed) || parsed.ok !== true) {
        return result(false, "模型回复未通过格式检查。", usage);
      }
    } catch {
      return result(false, "模型回复不是合法 JSON。", usage);
    }
    return result(true, publicMessage("已用所选模型完成一次最小 JSON 编剧探测，可以启用这一份草稿。", apiKey), usage);
  } catch (error) {
    const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
    if (name === "AbortError" || name === "TimeoutError" || controller.signal.aborted) {
      return unknownResult("请求超时，请先核对供应商的调用记录。");
    }
    return unknownResult("未收到供应商响应，请核对调用记录。");
  } finally {
    clearTimeout(timer);
  }
}
