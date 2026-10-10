/**
 * Browser side of the site login. The session itself is an HttpOnly cookie the page never sees; the page only echoes
 * the session's CSRF token (a readable cookie set by the API at login) on writes. Nothing is put in localStorage or
 * sessionStorage, and the password never leaves the login form's request.
 */
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const CSRF_COOKIES = ["__Host-ads_csrf", "ads_csrf"];
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
export const DEFAULT_AFTER_LOGIN = "/studio";
export type LoginReason = "expired" | "signed-out" | "unavailable";

/** The session's CSRF token from its readable cookie, or null when not signed in (or login is off). */
export function csrfToken(cookieText: string = typeof document === "undefined" ? "" : document.cookie): string | null {
  for (const name of CSRF_COOKIES) {
    for (const part of cookieText.split(";")) {
      const separator = part.indexOf("=");
      if (separator > 0 && part.slice(0, separator).trim() === name) {
        const value = part.slice(separator + 1).trim();
        if (/^[A-Za-z0-9_-]{43}$/.test(value)) return value;
      }
    }
  }
  return null;
}

/**
 * Only a path on this site: starts with one "/", no scheme, no host, no backslash or control characters, not the login
 * page itself and not an API route. Anything else falls back to the default page.
 */
export function safeReturnTo(value: string | null | undefined): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_000) return DEFAULT_AFTER_LOGIN;
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point of this check
  if (!value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(value)) return DEFAULT_AFTER_LOGIN;
  let url: URL;
  try {
    url = new URL(value, "https://site.invalid");
  } catch {
    return DEFAULT_AFTER_LOGIN;
  }
  if (url.origin !== "https://site.invalid") return DEFAULT_AFTER_LOGIN;
  if (url.pathname === "/login" || url.pathname.startsWith("/api/") || url.pathname.startsWith("/_next/")) return DEFAULT_AFTER_LOGIN;
  return `${url.pathname}${url.search}${url.hash}`;
}

export function loginUrl(returnTo: string, reason?: LoginReason): string {
  const query = new URLSearchParams({ returnTo: safeReturnTo(returnTo) });
  if (reason) query.set("reason", reason);
  return `/login?${query.toString()}`;
}

function currentPath(): string {
  return typeof window === "undefined" ? DEFAULT_AFTER_LOGIN : `${window.location.pathname}${window.location.search}`;
}

/** Sends the browser to the login page, keeping where it was. */
export function goToLogin(reason: LoginReason): void {
  if (typeof window === "undefined" || window.location.pathname === "/login") return;
  window.location.assign(loginUrl(currentPath(), reason));
}

/**
 * Wraps fetch for the same-origin API: writes carry the session's CSRF token (alongside any Idempotency-Key and
 * If-Match the caller set), and a 401 from the login check sends the browser to the login page. The response is
 * returned unchanged, so callers keep their own error and conflict handling.
 */
export function withSession(fetchImpl: FetchLike): FetchLike {
  return async (input, init = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const token = SAFE_METHODS.has(method) ? null : csrfToken();
    // The request is passed on unchanged unless a CSRF token is added; the caller's header shape is kept.
    const response = await fetchImpl(input, token ? { ...init, headers: withHeader(init.headers, "X-CSRF-Token", token) } : init);
    if (response.status === 401) {
      try {
        const body = await response.clone().json() as { error?: { code?: unknown } };
        const code = body?.error?.code;
        if (code === "AUTH_SESSION_EXPIRED" || code === "AUTH_REQUIRED") goToLogin("expired");
      } catch {
        // Not the login check's answer; leave it to the caller.
      }
    }
    return response;
  };
}

function withHeader(headers: HeadersInit | undefined, name: string, value: string): HeadersInit {
  if (headers instanceof Headers) {
    const copy = new Headers(headers);
    if (!copy.has(name)) copy.set(name, value);
    return copy;
  }
  if (Array.isArray(headers)) {
    return headers.some(([key]) => key.toLowerCase() === name.toLowerCase()) ? headers : [...headers, [name, value]];
  }
  const record = { ...(headers as Record<string, string> | undefined) };
  return Object.keys(record).some((key) => key.toLowerCase() === name.toLowerCase()) ? record : { ...record, [name]: value };
}

export interface SiteSession {
  enabled: boolean;
  authenticated: boolean;
  username?: string;
  csrfToken?: string;
  expiresAt?: string;
}

/**
 * Reads the login state; a 401 means signed out. Throws only when the login service cannot answer. A passive read
 * (a page checking its own expiry) does not count as activity, so it cannot keep an idle session alive.
 */
export async function readSession(fetchImpl: FetchLike = globalThis.fetch.bind(globalThis), options: { passive?: boolean } = {}): Promise<SiteSession> {
  const response = await fetchImpl("/api/v1/auth/session", { headers: { Accept: "application/json", ...(options.passive ? { "X-Session-Check": "passive" } : {}) },
    credentials: "same-origin", cache: "no-store" });
  if (response.status === 401) return { enabled: true, authenticated: false };
  if (!response.ok) throw new Error("LOGIN_SERVICE_UNAVAILABLE");
  const body = await response.json() as SiteSession;
  return { enabled: body.enabled !== false, authenticated: body.authenticated === true, username: body.username, csrfToken: body.csrfToken, expiresAt: body.expiresAt };
}

export async function logout(fetchImpl: FetchLike = globalThis.fetch.bind(globalThis)): Promise<void> {
  const token = csrfToken();
  const response = await fetchImpl("/api/v1/auth/logout", {
    method: "POST", credentials: "same-origin", cache: "no-store",
    headers: { Accept: "application/json", ...(token ? { "X-CSRF-Token": token } : {}) },
  });
  if (response.status !== 204) throw new Error("LOGOUT_NOT_CONFIRMED");
}
