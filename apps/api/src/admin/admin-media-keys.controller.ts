import { Body, Controller, Get, Headers, Inject, Optional, Put, Res } from "@nestjs/common";
import { adminMediaKeyUpdateSchema, type MediaKeySlot } from "@ai-drama/contracts";
import { noteCredentialChange } from "./operation-log-store";
import type { AdminMediaKeysView } from "@ai-drama/contracts";
import { SITE_AUTH, SiteAuthError, type RequestHeaders, type SiteAuth, type SiteAuthState } from "../auth/site-auth";
import { AdminHttpError, safeAdminError, setAdminResponseHeaders } from "./admin-auth";
import type { AdminMediaKeysBackend } from "./admin-media-keys.service";

export const ADMIN_MEDIA_KEYS_SERVICE = "ADMIN_MEDIA_KEYS_SERVICE";

interface AdminResponse {
  setHeader(name: string, value: string): void;
  status(code: number): void;
}

/**
 * Media-key console. Same SITE_AUTH / operator gate as /admin/models. Creators get opaque 401.
 * Writes never call vendors and never return plaintext keys.
 */
@Controller("admin")
export class AdminMediaKeysController {
  constructor(
    @Inject(ADMIN_MEDIA_KEYS_SERVICE) private readonly backend: AdminMediaKeysBackend | null,
    @Optional() @Inject(SITE_AUTH) private readonly site: SiteAuthState | null = null,
  ) {}

  @Get("media-keys")
  mediaKeys(@Headers() headers: RequestHeaders, @Res({ passthrough: true }) response: AdminResponse) {
    return this.send(response, () => {
      const { auth, backend } = this.configured();
      this.requireOperator(headers, auth);
      return backend.view();
    });
  }

  @Put("media-keys")
  update(
    @Headers() headers: RequestHeaders,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: AdminResponse,
  ) {
    return this.send(response, async () => {
      const { auth, backend } = this.configured();
      this.requireOperator(headers, auth);
      authorizeJsonWrite(auth, headers);
      const input = adminMediaKeyUpdateSchema.safeParse(body);
      if (!input.success) throw new AdminHttpError(400, "ADMIN_CONFIG_INVALID");
      const view = await backend.updateSlot(input.data);
      if (input.data.secretAction === "replace" && input.data.apiKey) {
        await noteCredentialChange({
          action: "保存媒体密钥",
          label: MEDIA_LOG_LABEL[input.data.slot],
          status: "已保存",
          secret: input.data.apiKey,
          source: "管理后台 /admin/media-keys",
        });
      } else if (input.data.secretAction === "clear") {
        await noteCredentialChange({
          action: "清除媒体密钥",
          label: MEDIA_LOG_LABEL[input.data.slot],
          status: "已清除",
          source: "管理后台 /admin/media-keys",
        });
      }
      return view;
    });
  }

  private configured(): { auth: SiteAuth; backend: AdminMediaKeysBackend } {
    if (!this.backend || this.site?.kind !== "enabled") throw new AdminHttpError(503, "ADMIN_NOT_CONFIGURED");
    return { auth: this.site.auth, backend: this.backend };
  }

  private requireOperator(headers: RequestHeaders, auth: SiteAuth): void {
    const session = auth.session(headers);
    if (session.role !== "operator") throw new SiteAuthError(401, "AUTH_REQUIRED");
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

const MEDIA_LOG_LABEL: Record<MediaKeySlot, string> = {
  OPENAI_MEDIA_API_KEY: "OpenAI",
  DASHSCOPE_MEDIA_API_KEY: "阿里云",
  MINIMAX_API_KEY: "MiniMax",
};

function authorizeJsonWrite(auth: SiteAuth, headers: RequestHeaders): void {
  auth.authorizeWrite(headers);
  const contentType = headers["content-type"];
  if (typeof contentType !== "string" || contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new SiteAuthError(415, "AUTH_CONTENT_TYPE_REJECTED");
  }
}

export type { AdminMediaKeysView };
