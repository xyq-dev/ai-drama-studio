import { Body, Controller, Get, Headers, Inject, Optional, Param, Put, Res } from "@nestjs/common";
import {
  adminLimitsUpdateSchema,
  adminProviderKeySchema,
  adminProviderUpdateSchema,
} from "@ai-drama/contracts";
import type { AdminLimitsUpdate, AdminModelsView, AdminProviderUpdate, TitleWritingProviderKey } from "@ai-drama/contracts";
import { SITE_AUTH, SiteAuthError, type RequestHeaders, type SiteAuth, type SiteAuthState } from "../auth/site-auth";
import { AdminHttpError, safeAdminError, setAdminResponseHeaders } from "./admin-auth";

export const ADMIN_MODELS_SERVICE = "ADMIN_MODELS_SERVICE";

export interface AdminModelsBackend {
  view(): Promise<AdminModelsView>;
  updateProvider(providerKey: TitleWritingProviderKey, body: AdminProviderUpdate): Promise<AdminModelsView>;
  updateLimits(body: AdminLimitsUpdate): Promise<AdminModelsView>;
}

interface AdminResponse {
  setHeader(name: string, value: string): void;
  status(code: number): void;
}

/**
 * The model console. Signing in is the site login; the console additionally needs MODEL_ADMIN_ENABLED and the site
 * login switched on. With the site login off or misconfigured it refuses (503) instead of opening anonymously.
 */
@Controller("admin")
export class AdminModelsController {
  constructor(
    @Inject(ADMIN_MODELS_SERVICE) private readonly backend: AdminModelsBackend | null,
    @Optional() @Inject(SITE_AUTH) private readonly site: SiteAuthState | null = null,
  ) {}

  @Get("models")
  models(@Headers() headers: RequestHeaders, @Res({ passthrough: true }) response: AdminResponse) {
    return this.send(response, () => {
      const { auth, backend } = this.configured();
      auth.session(headers);
      return backend.view();
    });
  }

  @Put("models/providers/:providerKey")
  updateProvider(
    @Param("providerKey") providerKey: string,
    @Headers() headers: RequestHeaders,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: AdminResponse,
  ) {
    return this.send(response, () => {
      const { auth, backend } = this.configured();
      authorizeJsonWrite(auth, headers);
      const key = adminProviderKeySchema.safeParse(providerKey);
      const input = adminProviderUpdateSchema.safeParse(body);
      if (!key.success || !input.success) throw new AdminHttpError(400, "ADMIN_CONFIG_INVALID");
      return backend.updateProvider(key.data, input.data);
    });
  }

  @Put("models/limits")
  updateLimits(
    @Headers() headers: RequestHeaders,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: AdminResponse,
  ) {
    return this.send(response, () => {
      const { auth, backend } = this.configured();
      authorizeJsonWrite(auth, headers);
      const input = adminLimitsUpdateSchema.safeParse(body);
      if (!input.success) throw new AdminHttpError(400, "ADMIN_CONFIG_INVALID");
      return backend.updateLimits(input.data);
    });
  }

  private configured(): { auth: SiteAuth; backend: AdminModelsBackend } {
    if (!this.backend || this.site?.kind !== "enabled") throw new AdminHttpError(503, "ADMIN_NOT_CONFIGURED");
    return { auth: this.site.auth, backend: this.backend };
  }

  private async send(response: AdminResponse, work: () => unknown | Promise<unknown>, status = 200): Promise<unknown> {
    setAdminResponseHeaders(response);
    try {
      const body = await work();
      response.status(status);
      return body;
    } catch (cause) {
      if (cause instanceof SiteAuthError) {
        response.status(cause.status);
        return { error: { code: cause.code, message: cause.message } };
      }
      const error = safeAdminError(cause);
      response.status(error.status);
      return { error: { code: error.code, message: error.message } };
    }
  }
}

/** Console writes are JSON only, on top of the site's session, origin and CSRF checks. */
function authorizeJsonWrite(auth: SiteAuth, headers: RequestHeaders): void {
  auth.authorizeWrite(headers);
  const contentType = headers["content-type"];
  if (typeof contentType !== "string" || contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new SiteAuthError(415, "AUTH_CONTENT_TYPE_REJECTED");
  }
}
