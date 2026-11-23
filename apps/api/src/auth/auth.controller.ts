import { Body, Controller, Get, Headers, Inject, Optional, Post, Res } from "@nestjs/common";
import type { CreatorAccountStore, CreatorPlanLedgerStore } from "@ai-drama/database";
import { hashPassword } from "./password-hash";
import { AUTH_WORKSPACE_ID, CREATOR_ACCOUNT_STORE, CREATOR_PLAN_LEDGER_STORE } from "./auth.tokens";
import { STAFF_ACCESS_SERVICE, StaffAccessError, type StaffAccessService } from "../admin/staff-access.service";
import { SITE_AUTH, SiteAuthError, type RequestHeaders, type SiteAuthState } from "./site-auth";

interface AuthResponse {
  setHeader(name: string, value: string | string[]): void;
  status(code: number): void;
}

function noStore(response: AuthResponse): void {
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

/**
 * The only routes reachable without a session (besides health): read the session, log in, log out, and (when the
 * server flag allows) register a creator. Responses carry fixed codes and messages only; passwords are never echoed.
 */
@Controller("auth")
export class AuthController {
  constructor(
    @Inject(SITE_AUTH) private readonly state: SiteAuthState,
    @Inject(AUTH_WORKSPACE_ID) private readonly workspaceId: string,
    @Optional() @Inject(CREATOR_ACCOUNT_STORE) private readonly creators: CreatorAccountStore | null = null,
    @Optional() @Inject(CREATOR_PLAN_LEDGER_STORE) private readonly plans: CreatorPlanLedgerStore | null = null,
    @Optional() @Inject(STAFF_ACCESS_SERVICE) private readonly staff: StaffAccessService | null = null,
  ) {}

  @Get("session")
  session(@Headers() headers: RequestHeaders, @Res({ passthrough: true }) response: AuthResponse) {
    return this.send(response, () => {
      if (this.state.kind === "disabled") {
        return { enabled: false, authenticated: false, publicRegistrationEnabled: false };
      }
      const auth = this.auth();
      try {
        // A passive check (a page asking whether its session is still there) must not keep the session alive.
        return headers["x-session-check"] === "passive" ? auth.peek(headers) : auth.session(headers);
      } catch (cause) {
        // No cookie at all: return the registration flag so signed-out visitors can use /register when enabled.
        // Expired/forged cookies still raise AUTH_SESSION_EXPIRED and stay 401.
        if (cause instanceof SiteAuthError && cause.code === "AUTH_REQUIRED") {
          return auth.anonymousSession();
        }
        throw cause;
      }
    });
  }

  @Post("login")
  login(@Headers() headers: RequestHeaders, @Body() body: unknown, @Res({ passthrough: true }) response: AuthResponse) {
    return this.send(response, async () => {
      const result = await this.auth().login(headers, body);
      if (result.totpRequired) return { totpRequired: true, challenge: result.challenge };
      response.setHeader("Set-Cookie", result.cookies);
      if (result.session.role === "operator") {
        const { noteOperation } = await import("../admin/operation-log-store");
        await noteOperation({
          actor: result.session.username,
          action: "登录后台",
          target: "/admin",
          result: "success",
          source: "管理后台 /admin",
          detail: "管理员登录。日志不记录密码。",
        });
      }
      return result.session;
    });
  }

  @Post("login/totp")
  totp(@Headers() headers: RequestHeaders, @Body() body: unknown, @Res({ passthrough: true }) response: AuthResponse) {
    return this.send(response, async () => {
      const result = await this.auth().completeTotp(headers, body);
      response.setHeader("Set-Cookie", result.cookies);
      const { noteOperation } = await import("../admin/operation-log-store");
      await noteOperation({
        actor: result.session.username,
        action: "登录后台",
        target: "/admin",
        result: "success",
        source: "管理后台 /admin",
        detail: "管理员通过验证器登录。日志不记录动态码或恢复码。",
      }, [typeof body === "object" && body && "code" in body ? String((body as { code?: unknown }).code ?? "") : ""]);
      return result.session;
    });
  }

  @Post("invites/accept")
  acceptInvite(@Headers() headers: RequestHeaders, @Body() body: unknown, @Res({ passthrough: true }) response: AuthResponse) {
    return this.send(response, async () => {
      if (!this.staff) throw new SiteAuthError(503, "AUTH_NOT_CONFIGURED");
      this.auth().assertOrigin(headers);
      const input = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
      const token = typeof input.token === "string" ? input.token : "";
      const password = typeof input.password === "string" ? input.password : "";
      return this.staff.acceptInvite(token, password);
    });
  }

  @Post("logout")
  logout(@Headers() headers: RequestHeaders, @Res({ passthrough: true }) response: AuthResponse) {
    return this.send(response, () => {
      response.setHeader("Set-Cookie", this.auth().logout(headers));
      return undefined;
    }, 204);
  }

  /**
   * Public creator registration. Default OFF: refuses unless CREATOR_PUBLIC_REGISTRATION_ENABLED=true.
   * CI and tests use fixture accounts; do not enable this in the phase-4 PR deploy.
   */
  @Post("register")
  register(@Headers() headers: RequestHeaders, @Body() body: unknown, @Res({ passthrough: true }) response: AuthResponse) {
    return this.send(response, async () => {
      const auth = this.auth();
      if (!auth.registrationEnabled()) throw new SiteAuthError(403, "AUTH_REGISTRATION_DISABLED");
      auth.assertOrigin(headers);
      if (headers["content-type"]?.toString().split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
        throw new SiteAuthError(415, "AUTH_CONTENT_TYPE_REJECTED");
      }
      if (!this.creators) throw new SiteAuthError(503, "AUTH_NOT_CONFIGURED");
      const input = typeof body === "object" && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : {};
      const username = typeof input.username === "string" ? input.username.trim() : "";
      const password = typeof input.password === "string" ? input.password : "";
      if (!/^[A-Za-z0-9._-]{1,64}$/u.test(username) || password.length < 8 || password.length > 1_024) {
        throw new SiteAuthError(401, "AUTH_LOGIN_FAILED");
      }
      if (username === auth.username) throw new SiteAuthError(401, "AUTH_LOGIN_FAILED");
      const passwordHash = process.env.NODE_ENV === "test"
        ? await hashPassword(password, { log2N: 15, r: 8, p: 1, saltBytes: 16, keyBytes: 32 })
        : await hashPassword(password);
      const account = await this.creators.createActive({
        workspaceId: this.workspaceId, username, passwordHash,
      });
      await this.plans?.ensureDefaultEntitlement(this.workspaceId, account.id);
      return { id: account.id, username: account.username, role: "creator" as const };
    }, 201);
  }

  private auth() {
    if (this.state.kind !== "enabled") throw new SiteAuthError(503, "AUTH_NOT_CONFIGURED");
    return this.state.auth;
  }

  private async send(response: AuthResponse, work: () => unknown, status = 200): Promise<unknown> {
    noStore(response);
    try {
      const body = await work();
      response.status(status);
      return body;
    } catch (cause) {
      if (cause instanceof StaffAccessError) {
        response.status(cause.status);
        return { error: { code: cause.code, message: cause.message } };
      }
      const error = cause instanceof SiteAuthError ? cause : new SiteAuthError(503, "AUTH_NOT_CONFIGURED");
      response.status(error.status);
      return { error: { code: error.code, message: error.message } };
    }
  }
}
