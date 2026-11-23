import { isDeepseekWritingModel, type UsageAmount, type UsageCost } from "@ai-drama/contracts";
import { DEEPSEEK_CHAT_COMPLETIONS_URL } from "./text-writing";

/** A short, cheap JSON Output ping. Not a full script generation, and never retried automatically. */
export const DEEPSEEK_WRITING_PROBE_TIMEOUT_MS = 30_000;
export const DEEPSEEK_WRITING_PROBE_MAX_TOKENS = 256;

export interface DeepseekWritingProbeResult {
  ok: boolean;
  message: string;
  usage: UsageAmount;
  cost: UsageCost;
}

const UNKNOWN_USAGE: UsageAmount = { status: "unknown" };
const UNKNOWN_COST: UsageCost = { status: "unknown" };

function result(ok: boolean, message: string, usage: UsageAmount = UNKNOWN_USAGE): DeepseekWritingProbeResult {
  return { ok, message, usage, cost: UNKNOWN_COST };
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function usageOf(body: unknown, secret: string): UsageAmount {
  if (!body || typeof body !== "object" || Array.isArray(body)) return UNKNOWN_USAGE;
  const usage = (body as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return UNKNOWN_USAGE;
  const total = tokenCount((usage as { total_tokens?: unknown }).total_tokens);
  if (total === null) return UNKNOWN_USAGE;
  const packed = String(total);
  if (secret.length > 0 && packed.includes(secret)) return UNKNOWN_USAGE;
  return { status: "present", amount: total, unit: "token" };
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
    if (response.status === 408 || response.status === 504) return result(false, "请求超时：结果不明，不会自动重试。");
    if (response.status === 400 || response.status === 413 || response.status === 422) {
      return result(false, "请求参数被拒绝，检测没有通过。");
    }
    if (response.status >= 500 && response.status <= 599) {
      return result(false, "供应商服务异常，结果不明，不会自动重试。");
    }
    if (response.status < 200 || response.status >= 300) {
      return result(false, "检测没有通过，草稿已保留，可以重试。");
    }
    // A successful body must not echo the key; error statuses are already classified above and never copy the body.
    if (raw.includes(apiKey)) {
      return result(false, "检测响应含有敏感内容，结果已丢弃。");
    }
    let body: unknown;
    try {
      body = JSON.parse(raw) as unknown;
    } catch {
      return result(false, "返回不是合法 JSON，不能视为有效编剧结果。");
    }
    const usage = usageOf(body, apiKey);
    const choice = body && typeof body === "object" && !Array.isArray(body)
      && Array.isArray((body as { choices?: unknown }).choices)
      && (body as { choices: unknown[] }).choices.length === 1
      ? (body as { choices: Array<{ finish_reason?: unknown; message?: { content?: unknown } }> }).choices[0]
      : null;
    const finish = choice?.finish_reason;
    const content = typeof choice?.message?.content === "string" ? choice.message.content : "";
    if (finish === "length") return result(false, "输出被截断，不能视为有效编剧结果。", usage);
    if (finish && finish !== "stop") return result(false, "返回状态不是完整停止，不能视为有效编剧结果。", usage);
    if (content.trim().length === 0) {
      return result(false, "返回内容为空，即使结束原因为 stop 也不能视为有效编剧结果。未自动重试。", usage);
    }
    try {
      const parsed = JSON.parse(content) as unknown;
      if (!parsed || typeof parsed !== "object") {
        return result(false, "返回 JSON 字段不符合检测要求，不能视为有效编剧结果。", usage);
      }
    } catch {
      return result(false, "返回内容不是合法 JSON，不能视为有效编剧结果。", usage);
    }
    return result(true, publicMessage("已用所选模型完成一次最小 JSON 编剧探测，可以启用这一份草稿。", apiKey), usage);
  } catch (error) {
    const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
    if (name === "AbortError" || name === "TimeoutError" || controller.signal.aborted) {
      return result(false, "请求超时：结果不明，不会自动重试。");
    }
    return result(false, "无法连接供应商，结果不明，不会自动重试。");
  } finally {
    clearTimeout(timer);
  }
}
