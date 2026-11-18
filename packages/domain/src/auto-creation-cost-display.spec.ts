import { describe, expect, it } from "vitest";
import {
  autoCreationBillingLooksLikeZeroAmount,
  formatAutoCreationBudgetBillingNote,
  formatAutoCreationCallRecord,
  formatAutoCreationReviseQuoteBillingNote,
  formatAutoCreationStartBillingNote,
  formatAutoCreationUsage,
} from "./auto-creation-cost-display";

describe("auto-creation honest cost display (phase 1)", () => {
  it("shows recorded tokens when usage.status=present and never invents an amount", () => {
    const usage = formatAutoCreationUsage({
      status: "present", inputTokens: 120, outputTokens: 340, totalTokens: 460,
    });
    expect(usage).toBe("用量 输入 120 / 输出 340 / 合计 460 tokens");
    expect(usage).not.toContain("费用");
    expect(formatAutoCreationBudgetBillingNote("unknown")).toBe("金额尚未计价");
    expect(formatAutoCreationStartBillingNote("unknown")).toContain("金额尚未计价");
    expect(formatAutoCreationStartBillingNote("unknown")).not.toContain("费用未知");
    expect(autoCreationBillingLooksLikeZeroAmount(formatAutoCreationBudgetBillingNote("unknown"))).toBe(false);
  });

  it("keeps usage unknown separate from amount not yet priced", () => {
    expect(formatAutoCreationUsage({
      status: "unknown", inputTokens: null, outputTokens: null, totalTokens: null,
    })).toBe("用量 未知");
    expect(formatAutoCreationReviseQuoteBillingNote("unknown")).toContain("金额尚未计价");
    expect(formatAutoCreationReviseQuoteBillingNote("unknown")).toContain("未确认不会扣次或发模型");
  });

  it("lists bill-check fields on a call record without collapsing into 费用未知 or 0", () => {
    const line = formatAutoCreationCallRecord({
      stageLabel: "研究与受众分析",
      attemptNo: 1,
      stateText: "已完成",
      errorCode: null,
      providerLabel: "DeepSeek",
      model: "deepseek-flash",
      providerRequestId: "req-last-key-1",
      usage: { status: "present", inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      billingStatus: "unknown",
      createdAt: "2026-11-17T01:00:00.000Z",
      finishedAt: "2026-11-17T01:00:02.000Z",
    });
    expect(line).toContain("研究与受众分析 第 1 次：已完成");
    expect(line).toContain("服务商 DeepSeek");
    expect(line).toContain("模型 deepseek-flash");
    expect(line).toContain("请求 id req-last-key-1");
    expect(line).toContain("用量 输入 10 / 输出 20 / 合计 30 tokens");
    expect(line).toContain("时间 2026-11-17T01:00:02.000Z");
    expect(line).toContain("计费 尚未计价");
    expect(line).not.toContain("费用未知");
    expect(autoCreationBillingLooksLikeZeroAmount(line)).toBe(false);

    const missingId = formatAutoCreationCallRecord({
      stageLabel: "分集大纲",
      attemptNo: 2,
      stateText: "结果不确定",
      errorCode: "timeout",
      providerLabel: "DeepSeek",
      model: "deepseek-flash",
      providerRequestId: null,
      usage: { status: "unknown", inputTokens: null, outputTokens: null, totalTokens: null },
      billingStatus: "unknown",
      createdAt: "2026-11-17T02:00:00.000Z",
      finishedAt: null,
    });
    expect(missingId).toContain("请求 id 无");
    expect(missingId).toContain("用量 未知");
    expect(missingId).toContain("时间 2026-11-17T02:00:00.000Z");
  });
});
