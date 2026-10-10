import { Body, Controller, Delete, Get, Headers, Inject, Param, Post, Put, Res } from "@nestjs/common";
import {
  adminLimitsUpdateSchema,
  adminProviderKeySchema,
  adminProviderUpdateSchema,
} from "@ai-drama/contracts";
import type { AdminLimitsUpdate, AdminModelsView, AdminProviderUpdate, TitleWritingProviderKey } from "@ai-drama/contracts";
import { ADMIN_AUTH, AdminAuth, AdminHttpError, safeAdminError, setAdminResponseHeaders } from "./admin-auth";
import type { AdminRequestHeaders } from "./admin-auth";

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

@Controller("admin")
export class AdminModelsController {
  constructor(
    @Inject(ADMIN_AUTH) private readonly auth: AdminAuth | null,
    @Inject(ADMIN_MODELS_SERVICE) private readonly backend: AdminModelsBackend | null,
  ) {}

  @Get("session")
  session(@Headers() headers: AdminRequestHeaders, @Res({ passthrough: true }) response: AdminResponse) {
    return this.send(response, () => this.configured().auth.session(headers));
  }

  @Post("session")
  login(
    @Headers() headers: AdminRequestHeaders,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: AdminResponse,
  ) {
    return this.send(response, () => {
      const { auth } = this.configured();
      auth.assertOriginAndJson(headers);
      const token = typeof body === "object" && body !== null && !Array.isArray(body) &&
        Object.keys(body).length === 1 && "token" in body ? body.token : undefined;
      const result = auth.login(token);
      response.setHeader("Set-Cookie", result.cookie);
      return result.session;
    });
  }

  @Delete("session")
  logout(@Headers() headers: AdminRequestHeaders, @Res({ passthrough: true }) response: AdminResponse) {
    return this.send(response, () => {
      response.setHeader("Set-Cookie", this.configured().auth.logout(headers));
      return undefined;
    }, 204);
  }

  @Get("models")
  models(@Headers() headers: AdminRequestHeaders, @Res({ passthrough: true }) response: AdminResponse) {
    return this.send(response, () => {
      const { auth, backend } = this.configured();
      auth.session(headers);
      return backend.view();
    });
  }

  @Put("models/providers/:providerKey")
  updateProvider(
    @Param("providerKey") providerKey: string,
    @Headers() headers: AdminRequestHeaders,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: AdminResponse,
  ) {
    return this.send(response, () => {
      const { auth, backend } = this.configured();
      auth.authorizeWrite(headers);
      const key = adminProviderKeySchema.safeParse(providerKey);
      const input = adminProviderUpdateSchema.safeParse(body);
      if (!key.success || !input.success) throw new AdminHttpError(400, "ADMIN_CONFIG_INVALID");
      return backend.updateProvider(key.data, input.data);
    });
  }

  @Put("models/limits")
  updateLimits(
    @Headers() headers: AdminRequestHeaders,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: AdminResponse,
  ) {
    return this.send(response, () => {
      const { auth, backend } = this.configured();
      auth.authorizeWrite(headers);
      const input = adminLimitsUpdateSchema.safeParse(body);
      if (!input.success) throw new AdminHttpError(400, "ADMIN_CONFIG_INVALID");
      return backend.updateLimits(input.data);
    });
  }

  private configured(): { auth: AdminAuth; backend: AdminModelsBackend } {
    if (!this.auth || !this.backend) throw new AdminHttpError(503, "ADMIN_NOT_CONFIGURED");
    return { auth: this.auth, backend: this.backend };
  }

  private async send(response: AdminResponse, work: () => unknown | Promise<unknown>, status = 200): Promise<unknown> {
    setAdminResponseHeaders(response);
    try {
      const body = await work();
      response.status(status);
      return body;
    } catch (cause) {
      const error = safeAdminError(cause);
      response.status(error.status);
      return { error: { code: error.code, message: error.message } };
    }
  }
}
