import { Body, Controller, Get, Headers, Inject, Optional, Param, Post, Put, Query, Res } from "@nestjs/common";
import {
  FEATURE_KEYS,
  FEATURE_LABELS,
  FEATURE_VENDOR_LABELS,
  featureDraftSaveSchema,
  featureEnableRequestSchema,
  featureRollbackRequestSchema,
  featureTestRequestSchema,
  type FeatureKey,
  type FeatureVendor,
} from "@ai-drama/contracts";
import { noteCredentialChange, noteOperation } from "./operation-log-store";
import { SITE_AUTH, SiteAuthError, type RequestHeaders, type SiteAuth, type SiteAuthState } from "../auth/site-auth";
import { AdminHttpError, safeAdminError, setAdminResponseHeaders } from "./admin-auth";
import { FeatureConfigError, type FeatureConfigService } from "./feature-config.service";

export const FEATURE_CONFIG_SERVICE = "FEATURE_CONFIG_SERVICE";

interface AdminResponse {
  setHeader(name: string, value: string): void;
  status(code: number): void;
}

/**
 * Feature configuration and call records. Operator session only. Responses never include a credential.
 * Test and enable do not run unless the body passes the schema; a missing confirmCost never reaches the probe.
 */
@Controller("admin")
export class FeatureConfigController {
  constructor(
    @Inject(FEATURE_CONFIG_SERVICE) private readonly backend: FeatureConfigService | null,
    @Optional() @Inject(SITE_AUTH) private readonly site: SiteAuthState | null = null,
  ) {}

  @Get("features")
  features(@Headers() headers: RequestHeaders, @Res({ passthrough: true }) response: AdminResponse) {
    return this.send(response, () => {
      const { auth, backend } = this.configured();
      this.requireOperator(headers, auth);
      return backend.view();
    });
  }

  @Put("features/:feature/draft")
  saveDraft(
    @Param("feature") feature: string,
    @Headers() headers: RequestHeaders,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: AdminResponse,
  ) {
    return this.send(response, async () => {
      const { auth, backend } = this.configured();
      this.requireOperator(headers, auth);
      authorizeJsonWrite(auth, headers);
      const key = this.feature(feature);
      const input = featureDraftSaveSchema.safeParse(body);
      if (!input.success) throw new AdminHttpError(400, "ADMIN_CONFIG_INVALID");
      const view = await backend.saveDraft(key, input.data);
      const label = `${FEATURE_LABELS[key]} · ${vendorLabel(input.data.vendor)}`;
      if (input.data.secretAction === "replace" && input.data.apiKey) {
        await noteCredentialChange({ action: "保存功能密钥", label, status: "已保存", secret: input.data.apiKey, source: "管理后台 /admin/features" });
      } else if (input.data.secretAction === "clear") {
        await noteCredentialChange({ action: "清除功能密钥", label, status: "已清除", source: "管理后台 /admin/features" });
      }
      return view;
    });
  }

  @Post("features/:feature/test")
  testDraft(
    @Param("feature") feature: string,
    @Headers() headers: RequestHeaders,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: AdminResponse,
  ) {
    return this.send(response, async () => {
      const { auth, backend } = this.configured();
      this.requireOperator(headers, auth);
      authorizeJsonWrite(auth, headers);
      const input = featureTestRequestSchema.safeParse(body);
      if (!input.success) throw new AdminHttpError(400, "ADMIN_CONFIG_INVALID");
      const key = this.feature(feature);
      const result = await backend.testDraft(key, input.data);
      await noteOperation({
        action: "测试功能配置",
        target: `${FEATURE_LABELS[key]} · ${vendorLabel(input.data.vendor)}`,
        result: result.probe?.ok === false ? "failed" : "success",
        source: "管理后台 /admin/features",
        detail: "测试结果已记录。完整密钥未写入。",
      });
      return result;
    });
  }

  @Post("features/:feature/enable")
  enable(
    @Param("feature") feature: string,
    @Headers() headers: RequestHeaders,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: AdminResponse,
  ) {
    return this.send(response, async () => {
      const { auth, backend } = this.configured();
      this.requireOperator(headers, auth);
      authorizeJsonWrite(auth, headers);
      const input = featureEnableRequestSchema.safeParse(body);
      if (!input.success) throw new AdminHttpError(400, "ADMIN_CONFIG_INVALID");
      const key = this.feature(feature);
      const view = await backend.enable(key, input.data);
      await noteOperation({
        action: "启用功能配置",
        target: `${FEATURE_LABELS[key]} · ${vendorLabel(input.data.vendor)}`,
        result: "success",
        source: "管理后台 /admin/features",
        detail: "已启用刚刚测试通过的草稿。完整密钥未写入。",
      });
      return view;
    });
  }

  @Post("features/:feature/rollback")
  rollback(
    @Param("feature") feature: string,
    @Headers() headers: RequestHeaders,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: AdminResponse,
  ) {
    return this.send(response, async () => {
      const { auth, backend } = this.configured();
      this.requireOperator(headers, auth);
      authorizeJsonWrite(auth, headers);
      const input = featureRollbackRequestSchema.safeParse(body);
      if (!input.success) throw new AdminHttpError(400, "ADMIN_CONFIG_INVALID");
      const key = this.feature(feature);
      const view = await backend.rollback(key, input.data);
      await noteOperation({
        action: "回退功能配置",
        target: FEATURE_LABELS[key],
        result: "success",
        source: "管理后台 /admin/features",
        detail: "已恢复上一启用版本。进行中的任务锁未改写。完整密钥未写入。",
      });
      return view;
    });
  }

  @Get("usage")
  usage(
    @Headers() headers: RequestHeaders,
    @Query("projectId") projectId: string | undefined,
    @Query("episodeId") episodeId: string | undefined,
    @Query("feature") feature: string | undefined,
    @Query("vendor") vendor: string | undefined,
    @Query("model") model: string | undefined,
    @Res({ passthrough: true }) response: AdminResponse,
  ) {
    return this.send(response, () => {
      const { auth, backend } = this.configured();
      this.requireOperator(headers, auth);
      return backend.operatorUsage(projectId || null, episodeId || null, {
        feature: feature || null,
        vendor: vendor || null,
        model: model || null,
      });
    });
  }

  @Get("usage/:recordId")
  usageDetail(
    @Param("recordId") recordId: string,
    @Headers() headers: RequestHeaders,
    @Res({ passthrough: true }) response: AdminResponse,
  ) {
    return this.send(response, () => {
      const { auth, backend } = this.configured();
      this.requireOperator(headers, auth);
      return backend.operatorUsageDetail(recordId);
    });
  }

  private feature(value: string): FeatureKey {
    if ((FEATURE_KEYS as readonly string[]).includes(value)) return value as FeatureKey;
    throw new AdminHttpError(400, "ADMIN_CONFIG_INVALID");
  }

  private configured(): { auth: SiteAuth; backend: FeatureConfigService } {
    if (!this.backend || this.site?.kind !== "enabled") throw new AdminHttpError(503, "ADMIN_NOT_CONFIGURED");
    return { auth: this.site.auth, backend: this.backend };
  }

  private requireOperator(headers: RequestHeaders, auth: SiteAuth): void {
    const session = auth.session(headers);
    if (session.role !== "operator") throw new SiteAuthError(401, "AUTH_REQUIRED");
  }

  private async send(response: AdminResponse, work: () => unknown | Promise<unknown>): Promise<unknown> {
    setAdminResponseHeaders(response);
    try {
      const body = await work();
      response.status(200);
      return body;
    } catch (cause) {
      if (cause instanceof SiteAuthError) {
        response.status(cause.status);
        return { error: { code: cause.code, message: cause.message } };
      }
      if (cause instanceof FeatureConfigError) {
        response.status(cause.status);
        return { error: { code: cause.code, message: cause.message } };
      }
      const error = safeAdminError(cause);
      response.status(error.status);
      return { error: { code: error.code, message: error.message } };
    }
  }
}

function vendorLabel(vendor: FeatureVendor): string {
  return FEATURE_VENDOR_LABELS[vendor];
}

function authorizeJsonWrite(auth: SiteAuth, headers: RequestHeaders): void {
  auth.authorizeWrite(headers);
  const contentType = headers["content-type"];
  if (typeof contentType !== "string" || contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new SiteAuthError(415, "AUTH_CONTENT_TYPE_REJECTED");
  }
}
