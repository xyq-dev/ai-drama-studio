import { z } from "zod";
import { BAILIAN_PLAN_KEY_MESSAGE, isBailianPlanKey, isBailianWorkspaceId, type AdminVendorCheckResult, type AdminVendorKey } from "@ai-drama/contracts";
import { ANTHROPIC_VERSION } from "@ai-drama/providers";

type Evidence = Pick<AdminVendorCheckResult, "status" | "message">;
const unknown: Evidence = { status: "unknown", message: "结果未知" };
const modelPage = z.object({
  data: z.array(z.object({ id: z.string() })),
  has_more: z.boolean().optional(),
});
const permissionPage = z.object({
  success: z.literal(true),
  output: z.object({
    permissions: z.array(z.object({ model: z.string(), permissions: z.object({ inference: z.boolean() }) })),
  }),
});

/** Read metadata only. Redirects are refused so credentials remain on the configured channel. */
export async function checkVendorCatalog(
  vendor: AdminVendorKey, model: string, key: string, workspaceId: string | undefined, fetchImpl: typeof fetch,
): Promise<Evidence> {
  let url: URL;
  if (vendor === "bailian") {
    if (isBailianPlanKey(key)) return { status: "failed", message: BAILIAN_PLAN_KEY_MESSAGE };
    if (!workspaceId || !isBailianWorkspaceId(workspaceId)) {
      return { status: "failed", message: "请先保存百炼北京业务空间 ID。" };
    }
    url = new URL(`https://${workspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/models/permissions`);
    url.search = new URLSearchParams({ model, authorization_scope: "AUTHORIZED", action: "INFERENCE" }).toString();
  } else {
    const endpoints = {
      openai: "https://api.openai.com/v1/models",
      deepseek: "https://api.deepseek.com/models",
      anthropic: "https://api.anthropic.com/v1/models?limit=1000",
    };
    url = new URL(endpoints[vendor]);
  }
  const headers: Record<string, string> = { accept: "application/json" };
  if (vendor === "anthropic") {
    headers["x-api-key"] = key;
    headers["anthropic-version"] = ANTHROPIC_VERSION;
    if (workspaceId) headers["anthropic-workspace-id"] = workspaceId;
  } else {
    headers.authorization = `Bearer ${key}`;
  }
  try {
    const response = await fetchImpl(url.toString(), {
      method: "GET", headers, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 408 || response.status === 504 || response.status >= 500) return unknown;
    if (response.status === 401 || response.status === 403) {
      return { status: "failed", message: "无法读取模型列表，请检查密钥及访问权限。" };
    }
    if (!response.ok) return { status: "failed", message: "模型列表请求被拒绝，请检查供应商配置。" };
    const body: unknown = await response.json();
    let found: boolean;
    if (vendor === "bailian") {
      const page = permissionPage.safeParse(body);
      if (!page.success) return unknown;
      found = page.data.output.permissions.some((item) => item.model === model && item.permissions.inference);
    } else {
      const page = modelPage.safeParse(body);
      if (!page.success) return unknown;
      found = page.data.data.some((item) => item.id === model);
      if (!found && page.data.has_more) return unknown;
    }
    return found
      ? { status: "listed", message: "已读取模型列表" }
      : { status: "unavailable", message: vendor === "bailian" ? "当前业务空间未获所选模型的推理权限。" : "已读取模型列表，当前凭证未列出所选模型。" };
  } catch {
    return unknown;
  }
}
