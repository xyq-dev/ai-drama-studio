import { Body, Controller, Get, Headers, Inject, Post, Res } from "@nestjs/common";
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
 * The only routes reachable without a session (besides health): read the session, log in, log out.
 * Responses carry fixed codes and messages only; passwords and tokens are never echoed or logged.
 */
@Controller("auth")
export class AuthController {
  constructor(@Inject(SITE_AUTH) private readonly state: SiteAuthState) {}

  @Get("session")
  session(@Headers() headers: RequestHeaders, @Res({ passthrough: true }) response: AuthResponse) {
    return this.send(response, () => {
      if (this.state.kind === "disabled") return { enabled: false, authenticated: false };
      // A passive check (a page asking whether its session is still there) must not keep the session alive.
      return headers["x-session-check"] === "passive" ? this.auth().peek(headers) : this.auth().session(headers);
    });
  }

  @Post("login")
  login(@Headers() headers: RequestHeaders, @Body() body: unknown, @Res({ passthrough: true }) response: AuthResponse) {
    return this.send(response, async () => {
      const result = await this.auth().login(headers, body);
      response.setHeader("Set-Cookie", result.cookies);
      return result.session;
    });
  }

  @Post("logout")
  logout(@Headers() headers: RequestHeaders, @Res({ passthrough: true }) response: AuthResponse) {
    return this.send(response, () => {
      response.setHeader("Set-Cookie", this.auth().logout(headers));
      return undefined;
    }, 204);
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
      const error = cause instanceof SiteAuthError ? cause : new SiteAuthError(503, "AUTH_NOT_CONFIGURED");
      response.status(error.status);
      return { error: { code: error.code, message: error.message } };
    }
  }
}
