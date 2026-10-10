import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AdminSessionView } from "@ai-drama/contracts";

export const ADMIN_AUTH = "ADMIN_AUTH";
export const ADMIN_SESSION_COOKIE = "ads_admin_session";
export const ADMIN_SESSION_DURATION_MS = 30 * 60 * 1_000;
const MAX_SESSIONS = 20;
const LOGIN_WINDOW_MS = 60_000;
const MAX_LOGIN_ATTEMPTS = 5;
const OPAQUE_TOKEN = /^[A-Za-z0-9_-]{43}$/u;

export type AdminRequestHeaders = Record<string, string | string[] | undefined>;

const ERROR_MESSAGES = {
  ADMIN_NOT_CONFIGURED: "管理员配置尚未就绪。",
  ADMIN_UNAUTHENTICATED: "请先登录管理员后台。",
  ADMIN_LOGIN_FAILED: "管理员凭据无效。",
  ADMIN_RATE_LIMITED: "登录尝试过于频繁，请稍后再试。",
  ADMIN_SESSION_LIMIT: "管理员会话已达上限，请稍后再试。",
  ADMIN_ORIGIN_REJECTED: "请求来源不受信任。",
  ADMIN_CONTENT_TYPE_REJECTED: "请求必须使用 JSON。",
  ADMIN_CSRF_REJECTED: "请求校验失败，请重新读取登录状态。",
  ADMIN_CONFIG_BUSY: "配置正在保存，请稍后重试。",
  ADMIN_CONFIG_CONFLICT: "配置已更新，请重新读取后再保存。",
  ADMIN_CONFIG_STORAGE_UNAVAILABLE: "安全配置存储暂不可用。",
  ADMIN_CONFIG_INVALID: "模型配置无效，请检查输入。",
  ADMIN_INTERNAL_ERROR: "管理员请求暂时无法完成。",
} as const;

export type AdminErrorCode = keyof typeof ERROR_MESSAGES;

/** Only this fixed code/message vocabulary may cross the admin HTTP boundary. */
export class AdminHttpError extends Error {
  constructor(readonly status: number, readonly code: AdminErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "AdminHttpError";
  }
}

interface StoredSession {
  csrfToken: string;
  expiresAt: number;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function matches(value: string, expectedDigest: Buffer): boolean {
  return timingSafeEqual(digest(value), expectedDigest);
}

function header(headers: AdminRequestHeaders, key: string): string | undefined {
  const value = headers[key];
  return typeof value === "string" ? value : undefined;
}

/** A server-configured origin, never inferred from Host or forwarded headers. */
function configuredOrigin(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AdminHttpError(503, "ADMIN_NOT_CONFIGURED");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.origin !== value || url.username || url.password ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && local))) {
    throw new AdminHttpError(503, "ADMIN_NOT_CONFIGURED");
  }
  return url;
}

/** Single API process sessions. Only hashes of session IDs are retained; a restart revokes all sessions. */
export class AdminAuth {
  private readonly tokenDigest: Buffer;
  private readonly secure: boolean;
  private readonly sessions = new Map<string, StoredSession>();
  private loginAttempts: number[] = [];
  private readonly now: () => number;
  readonly publicOrigin: string;

  constructor(config: { token: string; publicOrigin: string }, options: { now?: () => number } = {}) {
    if (config.token.length < 32 || config.token.length > 256 || /\s/u.test(config.token)) {
      throw new AdminHttpError(503, "ADMIN_NOT_CONFIGURED");
    }
    const origin = configuredOrigin(config.publicOrigin);
    this.publicOrigin = origin.origin;
    this.secure = origin.protocol === "https:";
    this.tokenDigest = digest(config.token);
    this.now = options.now ?? Date.now;
  }

  /** Login is the sole mutation that does not have a session CSRF token yet. */
  assertOriginAndJson(headers: AdminRequestHeaders, requireJson = true): void {
    if (header(headers, "origin") !== this.publicOrigin) {
      throw new AdminHttpError(403, "ADMIN_ORIGIN_REJECTED");
    }
    const contentType = header(headers, "content-type");
    if ((requireJson || contentType !== undefined) &&
        contentType?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      throw new AdminHttpError(415, "ADMIN_CONTENT_TYPE_REJECTED");
    }
  }

  login(token: unknown): { session: AdminSessionView; cookie: string } {
    const now = this.now();
    this.loginAttempts = this.loginAttempts.filter((at) => at > now - LOGIN_WINDOW_MS);
    if (this.loginAttempts.length >= MAX_LOGIN_ATTEMPTS) {
      throw new AdminHttpError(429, "ADMIN_RATE_LIMITED");
    }
    this.loginAttempts.push(now);
    if (typeof token !== "string" || token.length < 32 || token.length > 256 ||
        !matches(token, this.tokenDigest)) {
      throw new AdminHttpError(401, "ADMIN_LOGIN_FAILED");
    }
    this.prune(now);
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new AdminHttpError(429, "ADMIN_SESSION_LIMIT");
    }
    const id = randomBytes(32).toString("base64url");
    const value = { csrfToken: randomBytes(32).toString("base64url"), expiresAt: now + ADMIN_SESSION_DURATION_MS };
    this.sessions.set(digest(id).toString("hex"), value);
    return { session: this.view(value), cookie: this.cookie(id, ADMIN_SESSION_DURATION_MS / 1_000) };
  }

  session(headers: AdminRequestHeaders): AdminSessionView {
    return this.view(this.requireSession(headers).value);
  }

  authorizeWrite(headers: AdminRequestHeaders, requireJson = true): void {
    this.assertOriginAndJson(headers, requireJson);
    const { value } = this.requireSession(headers);
    const csrf = header(headers, "x-admin-csrf");
    if (!csrf || !OPAQUE_TOKEN.test(csrf) || !matches(csrf, digest(value.csrfToken))) {
      throw new AdminHttpError(403, "ADMIN_CSRF_REJECTED");
    }
  }

  logout(headers: AdminRequestHeaders): string {
    this.authorizeWrite(headers, false);
    const { key } = this.requireSession(headers);
    this.sessions.delete(key);
    return this.cookie("", 0);
  }

  private requireSession(headers: AdminRequestHeaders): { key: string; value: StoredSession } {
    const raw = header(headers, "cookie");
    if (!raw || raw.length > 8_192) throw new AdminHttpError(401, "ADMIN_UNAUTHENTICATED");
    const values = raw.split(";").flatMap((part) => {
      const separator = part.indexOf("=");
      return separator >= 0 && part.slice(0, separator).trim() === ADMIN_SESSION_COOKIE
        ? [part.slice(separator + 1).trim()] : [];
    });
    if (values.length !== 1 || !OPAQUE_TOKEN.test(values[0]!)) {
      throw new AdminHttpError(401, "ADMIN_UNAUTHENTICATED");
    }
    const key = digest(values[0]!).toString("hex");
    const now = this.now();
    this.prune(now);
    const value = this.sessions.get(key);
    if (!value) throw new AdminHttpError(401, "ADMIN_UNAUTHENTICATED");
    return { key, value };
  }

  private prune(now: number): void {
    for (const [key, value] of this.sessions) {
      if (value.expiresAt <= now) this.sessions.delete(key);
    }
  }

  private view(value: StoredSession): AdminSessionView {
    return { authenticated: true, csrfToken: value.csrfToken, expiresAt: new Date(value.expiresAt).toISOString() };
  }

  private cookie(value: string, maxAge: number): string {
    return `${ADMIN_SESSION_COOKIE}=${value}; Path=/api/v1/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${this.secure ? "; Secure" : ""}`;
  }
}

export interface AdminHeaderResponse {
  setHeader(name: string, value: string): void;
}

/** Can also run before the JSON body parser, so parser failures are never cached. */
export function setAdminResponseHeaders(response: AdminHeaderResponse): void {
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("Pragma", "no-cache");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

/** Backend failures are mapped by code only; raw messages and causes are never returned. */
export function safeAdminError(error: unknown): AdminHttpError {
  if (error instanceof AdminHttpError) return error;
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (code === "ADMIN_CONFIG_CONFLICT" || code === "ADMIN_CONFIG_BUSY") return new AdminHttpError(409, code);
  if (code === "ADMIN_CONFIG_STORAGE_UNAVAILABLE") return new AdminHttpError(503, code);
  if (code === "ADMIN_CONFIG_INVALID") return new AdminHttpError(400, code);
  return new AdminHttpError(500, "ADMIN_INTERNAL_ERROR");
}
