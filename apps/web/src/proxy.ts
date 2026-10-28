import { NextResponse, type NextRequest } from "next/server";
import { resolveApiUpstream } from "./lib/api-upstream";
import { loginUrl, type LoginReason } from "./lib/site-session";

/**
 * Page protection (Next.js proxy, Node runtime). Every page except /login asks the API whether the request carries a
 * valid server-side session; a cookie that merely exists is not enough. Not signed in → /login?returnTo=… ; login
 * service unavailable → /login as well (closed, never open). API routes are not handled here: the API checks every
 * request itself and answers 401 JSON. Only built static assets bypass this.
 */
export type PageAccess = "allowed" | "signed-out" | "expired" | "unavailable";

const SESSION_COOKIES = ["__Host-ads_session", "ads_session"];

export async function pageAccess(cookie: string | null, fetchImpl: typeof fetch = fetch): Promise<PageAccess> {
  let response: Response;
  try {
    response = await fetchImpl(`${resolveApiUpstream(process.env.NEXT_PUBLIC_API_BASE_URL)}/api/v1/auth/session`, {
      headers: { accept: "application/json", ...(cookie ? { cookie } : {}) },
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return "unavailable";
  }
  if (response.status === 401) {
    const hadSession = SESSION_COOKIES.some((name) => new RegExp(`(?:^|;\\s*)${name}=`).test(cookie ?? ""));
    return hadSession ? "expired" : "signed-out";
  }
  if (response.status !== 200) return "unavailable";
  try {
    const body = await response.json() as { enabled?: unknown; authenticated?: unknown };
    // Login switched off on the API: the site keeps its earlier behaviour (protected in front of the app, if at all).
    if (body.enabled === false) return "allowed";
    return body.authenticated === true ? "allowed" : "signed-out";
  } catch {
    return "unavailable";
  }
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const access = await pageAccess(request.headers.get("cookie"));
  if (access === "allowed") return NextResponse.next();
  const reason: LoginReason | undefined = access === "expired" ? "expired" : access === "unavailable" ? "unavailable" : undefined;
  // Next requires an absolute Location. It is the request's own origin with a fixed path (/login) and a query built
  // only from the checked returnTo, so the target can never be another site's page.
  const target = new URL(loginUrl(`${request.nextUrl.pathname}${request.nextUrl.search}`, reason), request.nextUrl.origin);
  const response = NextResponse.redirect(target, 307);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config = {
  // Everything except the login page, the API (which enforces the session itself) and built static assets.
  matcher: ["/((?!login$|api/|_next/static/).*)"],
};
