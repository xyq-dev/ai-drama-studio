import type { TitleWritingUsageView } from "@ai-drama/contracts";

/**
 * Honest auto-creation cost display (phase 1): separate recorded token usage from amount pricing.
 * Unknown amounts stay unknown — never invent a unit price or show 0 as a fee.
 */

export type AutoCreationBillingKind = "unknown";

/** Amount line when no provider receipt / official unit price exists. Never "0". */
export function formatAutoCreationBillingAmount(billing: AutoCreationBillingKind | "unknown"): string {
  void billing;
  return "尚未计价";
}

/** Token usage only — independent of whether an amount has been priced. */
export function formatAutoCreationUsage(usage: TitleWritingUsageView): string {
  if (usage.status === "present") {
    const input = usage.inputTokens === null ? "未知" : String(usage.inputTokens);
    const output = usage.outputTokens === null ? "未知" : String(usage.outputTokens);
    const total = usage.totalTokens === null ? "未知" : String(usage.totalTokens);
    return `用量 输入 ${input} / 输出 ${output} / 合计 ${total} tokens`;
  }
  return "用量 未知";
}

/** Run/start header: call counts stay as-is; amount is named separately when unpriced. */
export function formatAutoCreationBudgetBillingNote(billing: AutoCreationBillingKind | "unknown"): string {
  return `金额${formatAutoCreationBillingAmount(billing)}`;
}

/** Start-page fee sentence: no estimate, no invented total, no collapsing into a bare「费用未知」. */
export function formatAutoCreationStartBillingNote(billing: AutoCreationBillingKind | "unknown"): string {
  return `费用以服务商账单为准，本页不估算金额；金额${formatAutoCreationBillingAmount(billing)}`;
}

/** User-revise quote (confirm=false): always show counts/rounds; amount only when known (today: never). */
export function formatAutoCreationReviseQuoteBillingNote(billing: AutoCreationBillingKind | "unknown"): string {
  return `金额${formatAutoCreationBillingAmount(billing)}（未确认不会扣次或发模型）`;
}

export interface AutoCreationCallDisplayInput {
  stageLabel: string;
  attemptNo: number;
  stateText: string;
  errorCode: string | null;
  providerLabel: string;
  model: string;
  providerRequestId: string | null;
  usage: TitleWritingUsageView;
  billingStatus: AutoCreationBillingKind | "unknown";
  createdAt: string;
  finishedAt: string | null;
}

/**
 * One call row a person can check against a provider bill:
 * stage, provider, model, provider request id (when present), usage, time, billing status.
 */
export function formatAutoCreationCallRecord(call: AutoCreationCallDisplayInput): string {
  const requestId = call.providerRequestId && call.providerRequestId.trim().length > 0
    ? call.providerRequestId.trim()
    : "无";
  const time = call.finishedAt ?? call.createdAt;
  const error = call.errorCode ? `（${call.errorCode}）` : "";
  return [
    `${call.stageLabel} 第 ${String(call.attemptNo)} 次：${call.stateText}${error}`,
    `服务商 ${call.providerLabel}`,
    `模型 ${call.model}`,
    `请求 id ${requestId}`,
    formatAutoCreationUsage(call.usage),
    `时间 ${time}`,
    `计费 ${formatAutoCreationBillingAmount(call.billingStatus)}`,
  ].join("；");
}

/** Guard for UI/tests: never treat unknown billing as a numeric zero amount string. */
export function autoCreationBillingLooksLikeZeroAmount(text: string): boolean {
  return /(?:^|[^\d.])(?:¥|￥|\$)?\s*0(?:\.0+)?(?:\s*元)?(?:$|[^\d.])/u.test(text)
    || text.includes("费用 0")
    || text.includes("金额 0")
    || text.includes("费用：0")
    || text.includes("金额：0");
}
