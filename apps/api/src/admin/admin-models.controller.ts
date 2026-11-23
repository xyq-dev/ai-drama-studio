import { Body, Controller, Get, Headers, Inject, Optional, Param, Post, Put, Res } from "@nestjs/common";
import {
  adminLimitsUpdateSchema,
  adminProviderKeySchema,
  adminProviderUpdateSchema, adminVendorKeySchema, adminVendorSaveSchema, adminVendorCheckSchema,
  type AdminVendorKey, type AdminVendorSave, type AdminVendorCheck, type AdminVendorView, type AdminVendorCheckResult,
} from "@ai-drama/contracts";
import type { AdminLimitsUpdate, AdminModelsView, AdminProviderUpdate, ComfyUiAdminCheck, TitleWritingProviderKey } from "@ai-drama/contracts";
import { SITE_AUTH, SiteAuthError, type RequestHeaders, type SiteSessionView, type SiteAuth, type SiteAuthState } from "../auth/site-auth";
import { AdminHttpError, safeAdminError, setAdminResponseHeaders } from "./admin-auth";
import { StaffAccessError, assertStaffPermission } from "./staff-access.service";
import type { StaffPermission } from "@ai-drama/domain";

export const ADMIN_MODELS_SERVICE = "ADMIN_MODELS_SERVICE";
export const ADMIN_COMFYUI_CHECK = "ADMIN_COMFYUI_CHECK";

export interface AdminModelsBackend {
  vendors(): Promise<AdminVendorView[]>;
  vendor(vendor: AdminVendorKey): Promise<AdminVendorView>;
  saveVendor(vendor: AdminVendorKey, body: AdminVendorSave): Promise<AdminVendorView>;
  checkVendor(vendor: AdminVendorKey, body: AdminVendorCheck): Promise<AdminVendorCheckResult>;
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
    @Optional() @Inject(ADMIN_COMFYUI_CHECK) private readonly checkComfyUi: (() => Promise<ComfyUiAdminCheck>) | null = null,
  ) {}

  @Get("models")
  models(@Headers() headers: RequestHeaders, @Res({ passthrough: true }) response: AdminResponse) {
    return this.send(response, () => this.authorizedBackend(headers).backend.view());
  }

  @Post("models/comfyui/check")
  comfyUiConnection(@Headers() headers: RequestHeaders, @Body() body: unknown, @Res({ passthrough: true }) response: AdminResponse) {
    return this.send(response, () => {
      this.authorizedBackend(headers, true, "probe_models");
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length > 0) {
        throw new AdminHttpError(400, "ADMIN_CONFIG_INVALID");
      }
      if (!this.checkComfyUi) throw new AdminHttpError(503, "ADMIN_NOT_CONFIGURED");
      return this.checkComfyUi();
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
      const { backend, session } = this.authorizedBackend(headers, true, "enable_models");
      const key = adminProviderKeySchema.safeParse(providerKey);
      const input = adminProviderUpdateSchema.safeParse(body);
      if (!key.success || !input.success) throw new AdminHttpError(400, "ADMIN_CONFIG_INVALID");
      assertCredentialPermission(session, input.data);
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
      const { backend } = this.authorizedBackend(headers, true, "enable_models");
      const input = adminLimitsUpdateSchema.safeParse(body);
      if (!input.success) throw new AdminHttpError(400, "ADMIN_CONFIG_INVALID");
      return backend.updateLimits(input.data);
    });
  }

  @Get("models/vendors")
  vendors(@Headers() headers: RequestHeaders, @Res({ passthrough: true }) response: AdminResponse) {
    return this.send(response, () => this.authorizedBackend(headers).backend.vendors());
  }

  @Get("models/vendors/:vendor")
  vendor(@Param("vendor") id: string, @Headers() headers: RequestHeaders, @Res({ passthrough: true }) response: AdminResponse) {
    return this.send(response, () => this.authorizedBackend(headers).backend.vendor(vendorKey(id)));
  }

  @Put("models/vendors/:vendor")
  saveVendor(@Param("vendor") id: string, @Headers() headers: RequestHeaders, @Body() body: unknown,
    @Res({ passthrough: true }) response: AdminResponse) {
    return this.send(response, () => {
      const { backend, session } = this.authorizedBackend(headers, true, "enable_models");
      const input = adminVendorSaveSchema.safeParse(body);
      if (!input.success) throw new AdminHttpError(400, "ADMIN_CONFIG_INVALID");
      assertCredentialPermission(session, input.data);
      return backend.saveVendor(vendorKey(id), input.data);
    });
  }

  @Post("models/vendors/:vendor/check")
  checkVendor(@Param("vendor") id: string, @Headers() headers: RequestHeaders, @Body() body: unknown,
    @Res({ passthrough: true }) response: AdminResponse) {
    return this.send(response, () => {
      const { backend } = this.authorizedBackend(headers, true, "probe_models");
      const input = adminVendorCheckSchema.safeParse(body);
      if (!input.success) throw new AdminHttpError(400, "ADMIN_CONFIG_INVALID");
      return backend.checkVendor(vendorKey(id), input.data);
    });
  }

  private authorizedBackend(headers: RequestHeaders, write = false, permission?: StaffPermission) {
    if (this.site?.kind !== "enabled") throw new AdminHttpError(503, "ADMIN_NOT_CONFIGURED");
    const auth = this.site.auth;
    const session = auth.session(headers);
    if (session.role !== "operator") throw new SiteAuthError(401, "AUTH_REQUIRED");
    if (permission) assertStaffPermission(session, permission);
    if (!this.backend) throw new AdminHttpError(503, "ADMIN_NOT_CONFIGURED");
    if (write) authorizeJsonWrite(auth, headers);
    return { backend: this.backend, session };
  }

  private async send(response: AdminResponse, work: () => unknown | Promise<unknown>, status = 200): Promise<unknown> {
    setAdminResponseHeaders(response);
    try {
      const body = await work();
      response.status(status);
      return body;
    } catch (cause) {
      if (cause instanceof SiteAuthError || cause instanceof StaffAccessError) {
        response.status(cause.status);
        return { error: { code: cause.code, message: cause.message } };
      }
      const error = safeAdminError(cause);
      response.status(error.status);
      return { error: { code: error.code, message: error.message } };
    }
  }
}

function assertCredentialPermission(session: SiteSessionView, update: AdminProviderUpdate | AdminVendorSave): void {
  if (update.secretAction !== "keep" || update.workspaceAction === "replace" || update.workspaceAction === "clear") {
    assertStaffPermission(session, "maintain_model_keys");
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

function vendorKey(id: string): AdminVendorKey {
  const key = adminVendorKeySchema.safeParse(id);
  if (!key.success) throw new AdminHttpError(400, "ADMIN_CONFIG_INVALID");
  return key.data;
}
