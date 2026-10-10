import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { parsePasswordHash, verifyPassword, type ParsedPasswordHash } from "./password-hash";

/**
 * One administrator login for the whole site (pages, the same-origin API, assets, downloads and the model console).
 * Sessions are random, server-side and revocable; only SHA-256 digests of session IDs are kept, in this API process.
 * A restart therefore ends every session (single API instance by design). Nothing here touches the model vault.
 */
export const SITE_AUTH = "SITE_AUTH";
export const SESSION_IDLE_MS = 2 * 60 * 60 * 1_000;
export const SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1_000;
const MAX_SESSIONS = 20;
const LOGIN_WINDOW_MS = 60_000;
const MAX_LOGIN_ATTEMPTS = 5;
const OPAQUE_TOKEN = /^[A-Za-z0-9_-]{43}$/u;
/** The cookie of the earlier token-only model console, cleared on every login and logout. */
const LEGACY_ADMIN_COOKIE = "ads_admin_session";

export type RequestHeaders = Record<string, string | string[] | undefined>;

const MESSAGES = {
  AUTH_NOT_CONFIGURED: "登录服务配置不完整，已拒绝访问。请联系服务器管理员。",
  AUTH_REQUIRED: "请先登录。",
  AUTH_SESSION_EXPIRED: "登录已过期或已退出，请重新登录。",
  AUTH_LOGIN_FAILED: "账号或密码不正确。",
  AUTH_RATE_LIMITED: "登录尝试过于频繁，请稍后再试。",
  AUTH_SESSION_LIMIT: "同时登录的会话过多，请稍后再试。",
  AUTH_ORIGIN_REJECTED: "请求来源不受信任。",
  AUTH_CSRF_REJECTED: "请求校验失败，请刷新页面后重试。",
  AUTH_CONTENT_TYPE_REJECTED: "请求必须使用 JSON。",
} as const;

export type SiteAuthErrorCode = keyof typeof MESSAGES;

export class SiteAuthError extends Error {
  constructor(readonly status: number, readonly code: SiteAuthErrorCode) {
    super(MESSAGES[code]);
    this.name = "SiteAuthError";
  }
}

export interface SiteSessionView {
  enabled: true;
  authenticated: true;
  username: string;
  csrfToken: string;
  expiresAt: string;
}

interface StoredSession {
  csrfToken: string;
  createdAt: number;
  lastSeenAt: number;
}

const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();
const same = (value: string, expected: Buffer): boolean => timingSafeEqual(digest(value), expected);

function header(headers: RequestHeaders, key: string): string | undefined {
  const value = headers[key];
  return typeof value === "string" ? value : undefined;
}

/** All values of one cookie name; more than one copy is treated as no session. */
function cookieValues(headers: RequestHeaders, name: string): string[] {
  const raw = header(headers, "cookie");
  if (!raw || raw.length > 8_192) return [];
  return raw.split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    return separator >= 0 && part.slice(0, separator).trim() === name ? [part.slice(separator + 1).trim()] : [];
  });
}

export interface SiteAuthConfig {
  username: string;
  passwordHash: string;
  publicOrigin: string;
}

export class SiteAuth {
  private readonly usernameDigest: Buffer;
  private readonly hash: ParsedPasswordHash;
  private readonly sessions = new Map<string, StoredSession>();
  private loginAttempts: number[] = [];
  private readonly now: () => number;
  readonly username: string;
  readonly publicOrigin: string;
  readonly secure: boolean;
  readonly sessionCookie: string;
  readonly csrfCookie: string;

  constructor(config: SiteAuthConfig, options: { now?: () => number; allowHttpLoopback?: boolean } = {}) {
    if (!/^[A-Za-z0-9._-]{1,64}$/u.test(config.username)) throw new SiteAuthError(503, "AUTH_NOT_CONFIGURED");
    const hash = parsePasswordHash(config.passwordHash);
    if (!hash) throw new SiteAuthError(503, "AUTH_NOT_CONFIGURED");
    let origin: URL;
    try {
      origin = new URL(config.publicOrigin);
    } catch {
      throw new SiteAuthError(503, "AUTH_NOT_CONFIGURED");
    }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
    if (origin.origin !== config.publicOrigin || origin.username || origin.password ||
        (origin.protocol !== "https:" && !(origin.protocol === "http:" && loopback && options.allowHttpLoopback !== false))) {
      throw new SiteAuthError(503, "AUTH_NOT_CONFIGURED");
    }
    this.username = config.username;
    this.usernameDigest = digest(config.username);
    this.hash = hash;
    this.publicOrigin = origin.origin;
    this.secure = origin.protocol === "https:";
    // __Host- pins the cookie to this exact host, path / and HTTPS; plain names only for loopback development.
    this.sessionCookie = this.secure ? "__Host-ads_session" : "ads_session";
    this.csrfCookie = this.secure ? "__Host-ads_csrf" : "ads_csrf";
    this.now = options.now ?? Date.now;
  }

  /** The browser origin must be exactly the configured one; Host and forwarded headers are never trusted. */
  assertOrigin(headers: RequestHeaders): void {
    if (header(headers, "origin") !== this.publicOrigin) throw new SiteAuthError(403, "AUTH_ORIGIN_REJECTED");
  }

  /**
   * Username and password from the login form. The failure is the same for an unknown user and a wrong password,
   * and the password is always verified so both take the same time. Attempts are limited per minute.
   */
  async login(headers: RequestHeaders, body: unknown): Promise<{ session: SiteSessionView; cookies: string[] }> {
    this.assertOrigin(headers);
    if (header(headers, "content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      throw new SiteAuthError(415, "AUTH_CONTENT_TYPE_REJECTED");
    }
    const now = this.now();
    this.loginAttempts = this.loginAttempts.filter((at) => at > now - LOGIN_WINDOW_MS);
    if (this.loginAttempts.length >= MAX_LOGIN_ATTEMPTS) throw new SiteAuthError(429, "AUTH_RATE_LIMITED");
    this.loginAttempts.push(now);
    const input = typeof body === "object" && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : {};
    const keys = Object.keys(input).sort().join(",");
    const username = typeof input.username === "string" && input.username.length <= 64 ? input.username : "";
    const password = typeof input.password === "string" && input.password.length >= 1 && input.password.length <= 1_024
      ? input.password : "";
    const passwordOk = await verifyPassword(password, this.hash);
    const usernameOk = same(username, this.usernameDigest);
    if (keys !== "password,username" || !usernameOk || !passwordOk || password.length === 0) {
      throw new SiteAuthError(401, "AUTH_LOGIN_FAILED");
    }
    // A new login never reuses an earlier session ID from this browser.
    const previous = this.lookup(headers);
    if (previous) this.sessions.delete(previous.key);
    this.prune(now);
    if (this.sessions.size >= MAX_SESSIONS) throw new SiteAuthError(429, "AUTH_SESSION_LIMIT");
    const id = randomBytes(32).toString("base64url");
    const value: StoredSession = { csrfToken: randomBytes(32).toString("base64url"), createdAt: now, lastSeenAt: now };
    this.sessions.set(digest(id).toString("hex"), value);
    return { session: this.view(value), cookies: this.issue(id, value.csrfToken) };
  }

  /** A valid session or an error; also refreshes the idle deadline. */
  session(headers: RequestHeaders): SiteSessionView {
    const found = this.lookup(headers);
    if (!found) throw this.missing(headers);
    found.value.lastSeenAt = this.now();
    return this.view(found.value);
  }

  /** The same answer as session() without counting as activity: for a page's own expiry check, not for access. */
  peek(headers: RequestHeaders): SiteSessionView {
    const found = this.lookup(headers);
    if (!found) throw this.missing(headers);
    return this.view(found.value);
  }

  /**
   * For long-lived responses (the event stream): binds to the session the request carries and returns a check that
   * is true only while that very session still exists and has not expired. The check never counts as activity, so
   * server pushes cannot extend the idle limit. Null when the request has no valid session.
   */
  watch(headers: RequestHeaders): (() => boolean) | null {
    const found = this.lookup(headers);
    if (!found) return null;
    const { key, value } = found;
    return () => this.sessions.get(key) === value && this.expiresAt(value) > this.now();
  }

  /** Writes need the session, the exact origin and the session's CSRF token in X-CSRF-Token. */
  authorizeWrite(headers: RequestHeaders): void {
    this.assertOrigin(headers);
    const found = this.lookup(headers);
    if (!found) throw this.missing(headers);
    const csrf = header(headers, "x-csrf-token");
    if (!csrf || !OPAQUE_TOKEN.test(csrf) || !same(csrf, digest(found.value.csrfToken))) {
      throw new SiteAuthError(403, "AUTH_CSRF_REJECTED");
    }
    found.value.lastSeenAt = this.now();
  }

  /** Revokes the server-side session (when there is one) and clears every login cookie. */
  logout(headers: RequestHeaders): string[] {
    const found = this.lookup(headers);
    if (found) {
      this.authorizeWrite(headers);
      this.sessions.delete(found.key);
    } else {
      this.assertOrigin(headers);
    }
    return this.clear();
  }

  clear(): string[] {
    const secure = this.secure ? "; Secure" : "";
    return [
      `${this.sessionCookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
      `${this.csrfCookie}=; Path=/; SameSite=Strict; Max-Age=0${secure}`,
      `${LEGACY_ADMIN_COOKIE}=; Path=/api/v1/admin; HttpOnly; SameSite=Strict; Max-Age=0${secure}`,
    ];
  }

  private issue(id: string, csrfToken: string): string[] {
    const secure = this.secure ? "; Secure" : "";
    const maxAge = SESSION_ABSOLUTE_MS / 1_000;
    return [
      `${this.sessionCookie}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${String(maxAge)}${secure}`,
      // Readable by the page so writes can echo it; useless without the HttpOnly session it is bound to.
      `${this.csrfCookie}=${csrfToken}; Path=/; SameSite=Strict; Max-Age=${String(maxAge)}${secure}`,
      `${LEGACY_ADMIN_COOKIE}=; Path=/api/v1/admin; HttpOnly; SameSite=Strict; Max-Age=0${secure}`,
    ];
  }

  private lookup(headers: RequestHeaders): { key: string; value: StoredSession } | null {
    const values = cookieValues(headers, this.sessionCookie);
    if (values.length !== 1 || !OPAQUE_TOKEN.test(values[0]!)) return null;
    const key = digest(values[0]!).toString("hex");
    this.prune(this.now());
    const value = this.sessions.get(key);
    return value ? { key, value } : null;
  }

  /** No cookie at all means not logged in; a cookie the server does not know means expired, revoked or forged. */
  private missing(headers: RequestHeaders): SiteAuthError {
    return cookieValues(headers, this.sessionCookie).length > 0
      ? new SiteAuthError(401, "AUTH_SESSION_EXPIRED")
      : new SiteAuthError(401, "AUTH_REQUIRED");
  }

  private expiresAt(value: StoredSession): number {
    return Math.min(value.createdAt + SESSION_ABSOLUTE_MS, value.lastSeenAt + SESSION_IDLE_MS);
  }

  private prune(now: number): void {
    for (const [key, value] of this.sessions) {
      if (this.expiresAt(value) <= now) this.sessions.delete(key);
    }
  }

  private view(value: StoredSession): SiteSessionView {
    return { enabled: true, authenticated: true, username: this.username, csrfToken: value.csrfToken,
      expiresAt: new Date(this.expiresAt(value)).toISOString() };
  }
}

/** What the API does about login, decided once at startup from the process environment. */
export type SiteAuthState =
  | { kind: "disabled" }
  | { kind: "enabled"; auth: SiteAuth }
  | { kind: "misconfigured" };
