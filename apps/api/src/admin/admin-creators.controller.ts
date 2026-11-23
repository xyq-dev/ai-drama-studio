import { Body, Controller, Get, Headers, Inject, Optional, Post, Query, Res } from "@nestjs/common";
import { PersistenceError, type CreatorAccountStore } from "@ai-drama/database";
import { CREATOR_ACCOUNT_STORE, CREATOR_PLAN_LEDGER_STORE, AUTH_WORKSPACE_ID } from "../auth/auth.tokens";
import type { CreatorPlanLedgerStore } from "@ai-drama/database";
import { hashPassword } from "../auth/password-hash";
import { SITE_AUTH, SiteAuthError, type RequestHeaders, type SiteAuth, type SiteAuthState } from "../auth/site-auth";
import { StaffAccessError, assertStaffPermission } from "./staff-access.service";
import { setAdminResponseHeaders } from "./admin-auth";

interface AdminResponse {
  setHeader(name: string, value: string): void;
  status(code: number): void;
}

/**
 * Operator-only creator provisioning while public registration stays off.
 * Phase 1: API + docs only — no sidebar nav item, no full management page.
 * Responses never echo passwords or any API keys.
 */
@Controller("admin/creators")
export class AdminCreatorsController {
  constructor(
    @Optional() @Inject(SITE_AUTH) private readonly site: SiteAuthState | null = null,
    @Optional() @Inject(CREATOR_ACCOUNT_STORE) private readonly creators: CreatorAccountStore | null = null,
    @Optional() @Inject(CREATOR_PLAN_LEDGER_STORE) private readonly plans: CreatorPlanLedgerStore | null = null,
    @Inject(AUTH_WORKSPACE_ID) private readonly workspaceId: string,
  ) {}

  @Get()
  list(
    @Headers() headers: RequestHeaders,
    @Query("limit") limit: string | undefined,
    @Res({ passthrough: true }) response: AdminResponse,
  ) {
    return this.send(response, async () => {
      const { auth, creators } = this.configured();
      this.requireOperator(headers, auth);
      const parsed = Number(limit ?? "50");
      const items = await creators.listActive(this.workspaceId, Number.isFinite(parsed) ? parsed : 50);
      return {
        items: items.map((item) => ({
          id: item.id,
          username: item.username,
          status: item.status,
          createdAt: item.createdAt,
        })),
      };
    });
  }

  @Post()
  create(
    @Headers() headers: RequestHeaders,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: AdminResponse,
  ) {
    return this.send(response, async () => {
      const { auth, creators } = this.configured();
      this.requireOperator(headers, auth);
      authorizeJsonWrite(auth, headers);
      const input = typeof body === "object" && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : {};
      const username = typeof input.username === "string" ? input.username.trim() : "";
      const password = typeof input.password === "string" ? input.password : "";
      if (!/^[A-Za-z0-9._-]{1,64}$/u.test(username) || password.length < 8 || password.length > 1_024) {
        throw new SiteAuthError(400, "AUTH_LOGIN_FAILED");
      }
      if (username.toLowerCase() === auth.username.toLowerCase()) throw new SiteAuthError(400, "AUTH_LOGIN_FAILED");
      const passwordHash = process.env.NODE_ENV === "test"
        ? await hashPassword(password, { log2N: 15, r: 8, p: 1, saltBytes: 16, keyBytes: 32 })
        : await hashPassword(password);
      try {
        const account = await creators.createActive({
          workspaceId: this.workspaceId,
          username,
          passwordHash,
        });
        await this.plans?.ensureDefaultEntitlement(this.workspaceId, account.id);
        const { noteOperation } = await import("./operation-log-store");
        await noteOperation({
          action: "创建创作者",
          target: account.username,
          result: "success",
          source: "管理后台 /admin/users",
          detail: "已创建创作者账号。密码未写入日志。对方只能进入 /studio，不能访问 /admin。",
        }, [password]);
        // Never echo password or passwordHash.
        return { id: account.id, username: account.username, status: account.status, role: "creator" as const };
      } catch (error) {
        if (error instanceof PersistenceError && error.code === "VALIDATION_ERROR") {
          throw new SiteAuthError(409, "AUTH_LOGIN_FAILED");
        }
        if (error instanceof PersistenceError && error.code === "NOT_FOUND") {
          throw new SiteAuthError(503, "AUTH_NOT_CONFIGURED");
        }
        throw error;
      }
    }, 201);
  }

  private configured(): { auth: SiteAuth; creators: CreatorAccountStore } {
    if (this.site?.kind !== "enabled" || !this.creators) throw new SiteAuthError(503, "AUTH_NOT_CONFIGURED");
    return { auth: this.site.auth, creators: this.creators };
  }

  private requireOperator(headers: RequestHeaders, auth: SiteAuth): void {
    const session = auth.session(headers);
    if (session.role !== "operator") throw new SiteAuthError(401, "AUTH_REQUIRED");
    assertStaffPermission(session, "manage_creators");
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
      response.status(503);
      return { error: { code: "AUTH_NOT_CONFIGURED", message: "开户接口暂不可用。" } };
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
