import { NextResponse, type NextRequest } from "next/server";
import { resolveApiUpstream } from "./lib/api-upstream";
import { loginUrl, type LoginReason } from "./lib/site-session";

/**
 * Page protection (Next.js proxy, Node runtime). Every page except /login asks the API whether the request carries a
 * valid server-side session; a cookie that merely exists is not enough. Not signed in → /login?returnTo=… ; login
 * service unavailable → /login as well (closed, never open). API routes are not handled here: the API checks every
 * request itself and answers 401 JSON. Only built static assets bypass this.
 *
 * Admin and object-storage pages additionally require role=operator. A creator opening /admin* or /settings/storage
 * is redirected to /studio — they must not receive admin HTML/config.
 */
export type PageAccess = "allowed" | "signed-out" | "expired" | "unavailable";
export type PageRole = "operator" | "creator";

export type PageSession = {
  access: PageAccess;
  /** Present when access is allowed and site login is enabled with an authenticated session. */
  role?: PageRole;
  /** False when the API reports site login is switched off (legacy open mode). */
  siteLoginEnabled: boolean;
};

const SESSION_COOKIES = ["__Host-ads_session", "ads_session"];

const OPERATOR_ONLY_PREFIXES = ["/admin", "/settings/storage"];

export function isOperatorOnlyPath(pathname: string): boolean {
  return OPERATOR_ONLY_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export async function pageSession(cookie: string | null, fetchImpl: typeof fetch = fetch): Promise<PageSession> {
  let response: Response;
  try {
    response = await fetchImpl(`${resolveApiUpstream(process.env.NEXT_PUBLIC_API_BASE_URL)}/api/v1/auth/session`, {
      headers: { accept: "application/json", ...(cookie ? { cookie } : {}) },
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return { access: "unavailable", siteLoginEnabled: true };
  }
  if (response.status === 401) {
    const hadSession = SESSION_COOKIES.some((name) => new RegExp(`(?:^|;\\s*)${name}=`).test(cookie ?? ""));
    return { access: hadSession ? "expired" : "signed-out", siteLoginEnabled: true };
  }
  if (response.status !== 200) return { access: "unavailable", siteLoginEnabled: true };
  try {
    const body = await response.json() as {
      enabled?: unknown;
      authenticated?: unknown;
      role?: unknown;
    };
    // Login switched off on the API: the site keeps its earlier behaviour (protected in front of the app, if at all).
    if (body.enabled === false) return { access: "allowed", siteLoginEnabled: false };
    if (body.authenticated !== true) return { access: "signed-out", siteLoginEnabled: true };
    const role = body.role === "operator" || body.role === "creator" ? body.role : undefined;
    return { access: "allowed", siteLoginEnabled: true, role };
  } catch {
    return { access: "unavailable", siteLoginEnabled: true };
  }
}

/** @deprecated Prefer pageSession; kept for existing unit tests that only assert login gate. */
export async function pageAccess(cookie: string | null, fetchImpl: typeof fetch = fetch): Promise<PageAccess> {
  return (await pageSession(cookie, fetchImpl)).access;
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const session = await pageSession(request.headers.get("cookie"));
  if (session.access !== "allowed") {
    const reason: LoginReason | undefined = session.access === "expired" ? "expired" : session.access === "unavailable" ? "unavailable" : undefined;
    const target = new URL(loginUrl(`${request.nextUrl.pathname}${request.nextUrl.search}`, reason), request.nextUrl.origin);
    const response = NextResponse.redirect(target, 307);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  }
  const pathname = request.nextUrl.pathname;
  // Site login on + authenticated creator must not receive admin / storage HTML.
  if (session.siteLoginEnabled && isOperatorOnlyPath(pathname) && session.role !== "operator") {
    const response = NextResponse.redirect(new URL("/studio", request.nextUrl.origin), 307);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  }
  return NextResponse.next();
}

export const config = {
  // Everything except login/register, the API (which enforces the session itself) and built static assets.
  matcher: ["/((?!login$|register$|api/|_next/static/).*)"],
};
