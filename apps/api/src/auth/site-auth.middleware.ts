import { Inject, Injectable, type NestMiddleware } from "@nestjs/common";
import { sessionAllowsStaffPermission } from "@ai-drama/domain";
import { runWithCreatorAccess, type CreatorAccessScope } from "./creator-access";
import { SITE_AUTH, SiteAuthError, type RequestHeaders, type SiteAuthState } from "./site-auth";

/**
 * The exact routes that need no session. Everything else under the API — reads, writes, asset content, downloads,
 * exports, the model console — requires one. Matching is on method and the exact path (no prefixes, no patterns),
 * so no other route can share an exemption. Health stays anonymous for operators' probes and returns no business data.
 * Public registration is listed here but the controller still refuses unless CREATOR_PUBLIC_REGISTRATION_ENABLED=true.
 */
const ANONYMOUS = new Set([
  "GET /health/live", "HEAD /health/live",
  "GET /health/ready", "HEAD /health/ready",
  "GET /auth/session",
  "POST /auth/login",
  "POST /auth/login/totp",
  "POST /auth/invites/accept",
  "POST /auth/logout",
  "POST /auth/register",
]);
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

interface MiddlewareRequest {
  method: string;
  originalUrl: string;
  headers: RequestHeaders;
  /** Express/Nest parsed query; used when originalUrl is rewritten without the search string. */
  query?: Record<string, unknown>;
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

/** Operator ops view (`?view=ops`). Creators never get this even if the query is present. */
export function opsViewRequested(request: Pick<MiddlewareRequest, "originalUrl" | "query">): boolean {
  const search = request.originalUrl.includes("?")
    ? request.originalUrl.slice(request.originalUrl.indexOf("?") + 1)
    : "";
  if (new URLSearchParams(search).get("view") === "ops") return true;
  const view = request.query?.view;
  if (typeof view === "string") return view === "ops";
  if (Array.isArray(view) && typeof view[0] === "string") return view[0] === "ops";
  return false;
}

@Injectable()
export class SiteAuthMiddleware implements NestMiddleware {
  constructor(@Inject(SITE_AUTH) private readonly state: SiteAuthState) {}

  use(request: MiddlewareRequest, response: MiddlewareResponse, next: () => void): void {
    if (this.state.kind === "disabled" || isAnonymous(request.method, request.originalUrl)) {
      // Auth off (and anonymous probes): stores stay open so acceptance/legacy fixtures keep working.
      runWithCreatorAccess({ kind: "open" }, () => next());
      return;
    }
    try {
      if (this.state.kind !== "enabled") throw new SiteAuthError(503, "AUTH_NOT_CONFIGURED");
      let session;
      if (SAFE_METHODS.has(request.method.toUpperCase())) {
        session = this.state.auth.session(request.headers);
      } else {
        this.state.auth.authorizeWrite(request.headers);
        session = this.state.auth.peek(request.headers);
      }
      // Bound staff may browse the cross-owner library. Changes to other creators' works use audited admin routes.
      const staffListRead = ["GET", "HEAD"].includes(request.method.toUpperCase()) && routeOf(request.originalUrl) === "/library/projects";
      const opsView = opsViewRequested(request) && sessionAllowsStaffPermission({ ...session, required: "review_works" })
        && (!session.staffId || staffListRead);
      const scope: CreatorAccessScope = {
        kind: "scoped",
        role: session.role,
        accountId: session.accountId,
        username: session.username,
        opsView,
      };
      runWithCreatorAccess(scope, () => next());
    } catch (cause) {
      const error = cause instanceof SiteAuthError ? cause : new SiteAuthError(503, "AUTH_NOT_CONFIGURED");
      // Always JSON, never the login page: API callers see a status and a fixed code.
      response.statusCode = error.status;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.setHeader("Cache-Control", "private, no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.end(JSON.stringify({ error: { code: error.code, message: error.message } }));
    }
  }
}
