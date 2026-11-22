import type {
  FeatureConfigView, FeatureDraftSave, FeatureEnableRequest, FeatureKey, FeatureMutationResult, FeatureRollbackRequest, FeatureTestRequest,
  UsageRecordView, UsageSummaryView,
} from "@ai-drama/contracts";
import { withSession } from "./site-session";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class FeatureApiError extends Error {
  constructor(readonly status: number, readonly code: string) {
    // Response bodies are not copied. A vendor error must not put a key on the page.
    super("Feature configuration request failed");
  }
}

const CODE_COPY: Record<string, string> = {
  FEATURE_VENDOR_UNCONNECTED: "该服务商尚未接入。",
  FEATURE_MODEL_NOT_APPROVED: "该模型不在获准列表中，已阻止这次操作。",
  FEATURE_BUDGET_BLOCKED: "今日写作调用次数已用完，已阻止测试和启用。",
  FEATURE_TEST_REQUIRED: "只能启用刚刚测试通过的这一份草稿。",
  FEATURE_TEST_STALE: "草稿已经变化，请重新测试。这次没有启用。",
  FEATURE_TEST_UNCONFIRMED: "还没有确认测试费用，没有发起调用。",
  FEATURE_DRAFT_INCOMPLETE: "请先保存草稿，再测试这一份配置。",
  FEATURE_NOT_CONFIGURED: "这项功能还没有可启用的配置。",
  ADMIN_CONFIG_CONFLICT: "配置已更新，请重新读取后再操作。",
  ADMIN_CONFIG_BUSY: "配置正在写入，请稍后再试。",
  ADMIN_CONFIG_INVALID: "这份配置无法保存。",
  ADMIN_NOT_CONFIGURED: "管理员配置尚未就绪。",
  FEATURE_PROBE_REFUSED: "没有接通模拟供应商，测试没有发出。",
  FEATURE_ROLLBACK_UNAVAILABLE: "没有可回退的上一配置版本。",
  AUTH_REQUIRED: "没有配置权限。",
  NETWORK_ERROR: "网络中断，操作没有完成。",
  REQUEST_FAILED: "操作没有完成。",
};

export function featureErrorCopy(error: unknown): string {
  if (error instanceof FeatureApiError) return CODE_COPY[error.code] ?? "操作没有完成。";
  return "操作没有完成。";
}

/**
 * Operator feature configuration and call records. The browser never stores a key.
 * Test requests include confirmCost only after the operator confirms the dialog.
 */
export function createFeatureConfigClient(fetchImpl?: FetchLike) {
  const send = withSession(fetchImpl ?? globalThis.fetch.bind(globalThis));
  async function request<T>(path: string, method: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await send(`/api/v1/admin${path}`, {
        method, cache: "no-store",
        headers: { Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw new FeatureApiError(0, "NETWORK_ERROR"); }
    let payload: unknown = null;
    if (response.status !== 204) {
      try { payload = await response.json(); } catch { /* A broken receipt is not success. */ }
    }
    if (!response.ok) {
      const value = payload as { error?: { code?: unknown } } | null;
      const code = value?.error?.code;
      throw new FeatureApiError(response.status, typeof code === "string" && /^[A-Z0-9_]{1,100}$/.test(code) ? code : "REQUEST_FAILED");
    }
    if (!payload || typeof payload !== "object") throw new FeatureApiError(0, "INVALID_RESPONSE");
    return payload as T;
  }
  return {
    view: () => request<FeatureConfigView>("/features", "GET"),
    saveDraft: (feature: FeatureKey, body: FeatureDraftSave) => request<FeatureConfigView>(`/features/${feature}/draft`, "PUT", body),
    testDraft: (feature: FeatureKey, body: FeatureTestRequest) => request<FeatureMutationResult>(`/features/${feature}/test`, "POST", body),
    enable: (feature: FeatureKey, body: FeatureEnableRequest) => request<FeatureConfigView>(`/features/${feature}/enable`, "POST", body),
    rollback: (feature: FeatureKey, body: FeatureRollbackRequest) => request<FeatureConfigView>(`/features/${feature}/rollback`, "POST", body),
    usage: (projectId: string | null, episodeId: string | null) => {
      const query = new URLSearchParams();
      if (projectId) query.set("projectId", projectId);
      if (episodeId) query.set("episodeId", episodeId);
      const suffix = query.size ? `?${query.toString()}` : "";
      return request<UsageSummaryView>(`/usage${suffix}`, "GET");
    },
    detail: (recordId: string) => request<UsageRecordView>(`/usage/${encodeURIComponent(recordId)}`, "GET"),
  };
}
