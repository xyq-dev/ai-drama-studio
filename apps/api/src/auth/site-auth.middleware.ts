import { Inject, Injectable, type NestMiddleware } from "@nestjs/common";
import { SITE_AUTH, SiteAuthError, type RequestHeaders, type SiteAuthState } from "./site-auth";

/**
 * The exact routes that need no session. Everything else under the API — reads, writes, asset content, downloads,
 * exports, the model console — requires one. Matching is on method and the exact path (no prefixes, no patterns),
 * so no other route can share an exemption. Health stays anonymous for operators' probes and returns no business data.
 */
const ANONYMOUS = new Set([
  "GET /health/live", "HEAD /health/live",
  "GET /health/ready", "HEAD /health/ready",
  "GET /auth/session",
  "POST /auth/login",
  "POST /auth/logout",
]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

interface MiddlewareRequest {
  method: string;
  originalUrl: string;
  headers: RequestHeaders;
}

interface MiddlewareResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body: string): void;
}

/** The route path without query and without the global /api/v1 prefix (absent in some test applications). */
export function routeOf(originalUrl: string): string {
  const path = originalUrl.split("?", 1)[0]!.split("#", 1)[0]!;
  return path.startsWith("/api/v1/") ? path.slice("/api/v1".length) : path;
}

export function isAnonymous(method: string, originalUrl: string): boolean {
  return ANONYMOUS.has(`${method.toUpperCase()} ${routeOf(originalUrl)}`);
}

@Injectable()
export class SiteAuthMiddleware implements NestMiddleware {
  constructor(@Inject(SITE_AUTH) private readonly state: SiteAuthState) {}

  use(request: MiddlewareRequest, response: MiddlewareResponse, next: () => void): void {
    if (this.state.kind === "disabled" || isAnonymous(request.method, request.originalUrl)) {
      next();
      return;
    }
    try {
      if (this.state.kind !== "enabled") throw new SiteAuthError(503, "AUTH_NOT_CONFIGURED");
      if (SAFE_METHODS.has(request.method.toUpperCase())) this.state.auth.session(request.headers);
      else this.state.auth.authorizeWrite(request.headers);
    } catch (cause) {
      const error = cause instanceof SiteAuthError ? cause : new SiteAuthError(503, "AUTH_NOT_CONFIGURED");
      // Always JSON, never the login page: API callers see a status and a fixed code.
      response.statusCode = error.status;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.setHeader("Cache-Control", "private, no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.end(JSON.stringify({ error: { code: error.code, message: error.message } }));
      return;
    }
    next();
  }
}
