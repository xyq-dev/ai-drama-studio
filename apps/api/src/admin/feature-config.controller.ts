import { Body, Controller, Get, Headers, Inject, Optional, Param, Post, Put, Query, Res } from "@nestjs/common";
import {
  FEATURE_KEYS,
  featureDraftSaveSchema,
  featureEnableRequestSchema,
  featureTestRequestSchema,
  type FeatureKey,
} from "@ai-drama/contracts";
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
    return this.send(response, () => {
      const { auth, backend } = this.configured();
      this.requireOperator(headers, auth);
      authorizeJsonWrite(auth, headers);
      const key = this.feature(feature);
      const input = featureDraftSaveSchema.safeParse(body);
      if (!input.success) throw new AdminHttpError(400, "ADMIN_CONFIG_INVALID");
      return backend.saveDraft(key, input.data);
    });
  }

  @Post("features/:feature/test")
  testDraft(
    @Param("feature") feature: string,
    @Headers() headers: RequestHeaders,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: AdminResponse,
  ) {
    return this.send(response, () => {
      const { auth, backend } = this.configured();
      this.requireOperator(headers, auth);
      authorizeJsonWrite(auth, headers);
      const input = featureTestRequestSchema.safeParse(body);
      if (!input.success) throw new AdminHttpError(400, "ADMIN_CONFIG_INVALID");
      return backend.testDraft(this.feature(feature), input.data);
    });
  }

  @Post("features/:feature/enable")
  enable(
    @Param("feature") feature: string,
    @Headers() headers: RequestHeaders,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: AdminResponse,
  ) {
    return this.send(response, () => {
      const { auth, backend } = this.configured();
      this.requireOperator(headers, auth);
      authorizeJsonWrite(auth, headers);
      const input = featureEnableRequestSchema.safeParse(body);
      if (!input.success) throw new AdminHttpError(400, "ADMIN_CONFIG_INVALID");
      return backend.enable(this.feature(feature), input.data);
    });
  }

  @Get("usage")
  usage(
    @Headers() headers: RequestHeaders,
    @Query("projectId") projectId: string | undefined,
    @Query("episodeId") episodeId: string | undefined,
    @Res({ passthrough: true }) response: AdminResponse,
  ) {
    return this.send(response, () => {
      const { auth, backend } = this.configured();
      this.requireOperator(headers, auth);
      return backend.operatorUsage(projectId || null, episodeId || null);
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

function authorizeJsonWrite(auth: SiteAuth, headers: RequestHeaders): void {
  auth.authorizeWrite(headers);
  const contentType = headers["content-type"];
  if (typeof contentType !== "string" || contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new SiteAuthError(415, "AUTH_CONTENT_TYPE_REJECTED");
  }
}
