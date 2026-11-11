import { Body, Controller, Get, Headers, Inject, Optional, Post, Put, Res } from "@nestjs/common";
import { storageActivateRequestSchema, storageDraftUpdateSchema, storageSettingsViewSchema, storageTestRequestSchema } from "@ai-drama/contracts";
import { StorageSettingsError } from "@ai-drama/database";
import { SITE_AUTH, SiteAuthError, type RequestHeaders, type SiteAuth, type SiteAuthState } from "../auth/site-auth";
import { setAdminResponseHeaders } from "./admin-auth";
import type { StorageSettingsService } from "./storage-settings.service";

export const STORAGE_SETTINGS_SERVICE = "STORAGE_SETTINGS_SERVICE";
interface Response { setHeader(name: string, value: string): void; status(code: number): void }
const messages: Record<string, string> = {
  STORAGE_SETTINGS_UNAVAILABLE: "存储设置尚未就绪，请检查服务器配置。",
  STORAGE_SETTINGS_CONFLICT: "配置已更新，请刷新后重试。",
  STORAGE_SETTINGS_INVALID: "存储参数无效，请检查服务商、地域、地址及密钥。",
  STORAGE_SETTINGS_CREDENTIALS_REQUIRED: "切换服务商时需要重新填写完整密钥。",
  STORAGE_SETTINGS_DRAFT_REQUIRED: "请先保存配置草稿。",
  STORAGE_SETTINGS_TEST_REQUIRED: "请重新测试当前草稿，测试通过后 15 分钟内可以启用。",
};

@Controller("admin/storage")
export class StorageSettingsController {
  constructor(@Inject(STORAGE_SETTINGS_SERVICE) private readonly backend: StorageSettingsService | null,
    @Optional() @Inject(SITE_AUTH) private readonly site: SiteAuthState | null = null) {}
  @Get()
  view(@Headers() headers: RequestHeaders, @Res({ passthrough: true }) response: Response) {
    return this.send(response, () => { const { auth, backend } = this.configured(); auth.session(headers); return backend.view(); });
  }
  @Put("draft")
  save(@Headers() headers: RequestHeaders, @Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    return this.send(response, () => {
      const { auth, backend } = this.configured(); this.write(auth, headers);
      const parsed = storageDraftUpdateSchema.safeParse(body); if (!parsed.success) throw new StorageSettingsError(400, "STORAGE_SETTINGS_INVALID");
      return backend.save(parsed.data);
    });
  }
  @Post("test")
  test(@Headers() headers: RequestHeaders, @Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    return this.send(response, () => {
      const { auth, backend } = this.configured(); this.write(auth, headers);
      const parsed = storageTestRequestSchema.safeParse(body); if (!parsed.success) throw new StorageSettingsError(400, "STORAGE_SETTINGS_INVALID");
      return backend.test(parsed.data.expectedRevision);
    });
  }
  @Post("activate")
  activate(@Headers() headers: RequestHeaders, @Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    return this.send(response, () => {
      const { auth, backend } = this.configured(); this.write(auth, headers);
      const parsed = storageActivateRequestSchema.safeParse(body); if (!parsed.success) throw new StorageSettingsError(400, "STORAGE_SETTINGS_INVALID");
      return backend.activate(parsed.data.expectedRevision);
    });
  }
  private configured(): { auth: SiteAuth; backend: StorageSettingsService } {
    if (!this.backend || this.site?.kind !== "enabled") throw new StorageSettingsError(503, "STORAGE_SETTINGS_UNAVAILABLE");
    return { auth: this.site.auth, backend: this.backend };
  }
  private write(auth: SiteAuth, headers: RequestHeaders): void {
    auth.authorizeWrite(headers);
    const contentType = headers["content-type"];
    if (typeof contentType !== "string" || contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw new SiteAuthError(415, "AUTH_CONTENT_TYPE_REJECTED");
  }
  private async send(response: Response, work: () => unknown | Promise<unknown>): Promise<unknown> {
    setAdminResponseHeaders(response);
    try { const result = storageSettingsViewSchema.parse(await work()); response.status(200); return result; }
    catch (error) {
      if (error instanceof SiteAuthError) { response.status(error.status); return { error: { code: error.code, message: error.message } }; }
      const safe = error instanceof StorageSettingsError && messages[error.code] ? error : new StorageSettingsError(503, "STORAGE_SETTINGS_UNAVAILABLE");
      response.status(safe.status); return { error: { code: safe.code, message: messages[safe.code] } };
    }
  }
}
