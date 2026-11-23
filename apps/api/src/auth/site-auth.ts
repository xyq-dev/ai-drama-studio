import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { LEGACY_OWNER_ACCOUNT_ID, STAFF_PERMISSIONS, type CreatorAccountRole, type StaffPermission } from "@ai-drama/domain";
import { parsePasswordHash, verifyPassword, type ParsedPasswordHash } from "./password-hash";

/**
 * Site login: the existing operator (SITE_AUTH_USERNAME / SITE_AUTH_PASSWORD_HASH) plus optional creator accounts.
 * Operator login is never replaced. Creator passwords live in creator_account (migration); public registration is a
 * separate server flag defaulting off. Sessions are random, server-side and revocable; only SHA-256 digests of
 * session IDs are kept in this API process. A restart ends every session (single API instance by design).
 */

/** Lookup used only for creator (non-operator) usernames. LEGACY / DISABLED rows must not be returned. */
export interface CreatorLoginDirectory {
  findActiveByUsername(username: string): Promise<{ id: string; username: string; passwordHash: string } | null>;
}

export interface StaffLoginAccount {
  id: string;
  username: string;
  passwordHash: string | null;
  status: "pending" | "active" | "disabled";
  permissions: readonly string[];
  totpEnabled: boolean;
}

/** Staff passwords replace the env operator once a row exists for that username. */
export interface StaffLoginDirectory {
  findByUsername(username: string): Promise<StaffLoginAccount | null>;
  recordLogin(staffId: string): Promise<void>;
  verifySecondFactor(staffId: string, code: string): Promise<boolean>;
}

export type LoginResult =
  | { session: SiteSessionView; cookies: string[]; totpRequired: false }
  | { session: null; cookies: []; totpRequired: true; challenge: string };
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
  AUTH_REGISTRATION_DISABLED: "公开自助注册未开启。",
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
  role: CreatorAccountRole;
  accountId: string;
  csrfToken: string;
  expiresAt: string;
  /** Echoed for the login page; never enables registration by itself. */
  publicRegistrationEnabled: boolean;
  /** Null for the legacy env operator and for creators. Bound staff sessions re-read permissions on every request. */
  staffId: string | null;
  permissions: readonly StaffPermission[];
}

interface StoredSession {
  csrfToken: string;
  createdAt: number;
  lastSeenAt: number;
  role: CreatorAccountRole;
  accountId: string;
  username: string;
  staffId: string | null;
  publicId: string;
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
  private readonly creators: CreatorLoginDirectory | null;
  private staff: StaffLoginDirectory | null = null;
  private readonly staffLive = new Map<string, { status: StaffLoginAccount["status"]; permissions: readonly string[] }>();
  private readonly challenges = new Map<string, { staffId: string; username: string; expires: number }>();
  private readonly publicRegistrationEnabled: boolean;
  readonly username: string;
  readonly publicOrigin: string;
  readonly secure: boolean;
  readonly sessionCookie: string;
  readonly csrfCookie: string;

  constructor(config: SiteAuthConfig, options: {
    now?: () => number;
    allowHttpLoopback?: boolean;
    creators?: CreatorLoginDirectory | null;
    publicRegistrationEnabled?: boolean;
  } = {}) {
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
    this.creators = options.creators ?? null;
    this.publicRegistrationEnabled = options.publicRegistrationEnabled === true;
  }

  /** The browser origin must be exactly the configured one; Host and forwarded headers are never trusted. */
  assertOrigin(headers: RequestHeaders): void {
    if (header(headers, "origin") !== this.publicOrigin) throw new SiteAuthError(403, "AUTH_ORIGIN_REJECTED");
  }

  /**
   * Username and password from the login form. A staff row for that username is checked first and is not bypassed
   * by the env operator password. Otherwise the env operator, then an ACTIVE creator. Unknown user and wrong
   * password share one failure. Attempts are limited per minute.
   */
  setStaffDirectory(directory: StaffLoginDirectory | null): void {
    this.staff = directory;
  }

  syncStaff(staffId: string, access: { status: StaffLoginAccount["status"]; permissions: readonly string[] }): void {
    this.staffLive.set(staffId, access);
    if (access.status !== "active") this.revokeAccount(staffId);
  }

  listStaffSessions(accountId: string): { publicId: string; createdAt: string; lastSeenAt: string }[] {
    this.prune(this.now());
    const items: { publicId: string; createdAt: string; lastSeenAt: string }[] = [];
    for (const value of this.sessions.values()) {
      if (value.accountId !== accountId || !this.staffAllows(value)) continue;
      items.push({
        publicId: value.publicId,
        createdAt: new Date(value.createdAt).toISOString(),
        lastSeenAt: new Date(value.lastSeenAt).toISOString(),
      });
    }
    return items;
  }

  revokeStaffSession(accountId: string, publicId: string): boolean {
    for (const [key, value] of this.sessions) {
      if (value.accountId === accountId && value.publicId === publicId) {
        this.sessions.delete(key);
        return true;
      }
    }
    return false;
  }

  async login(headers: RequestHeaders, body: unknown): Promise<LoginResult> {
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
    if (keys !== "password,username" || password.length === 0 || username.length === 0) {
      await verifyPassword(password || " ", this.hash);
      throw new SiteAuthError(401, "AUTH_LOGIN_FAILED");
    }
    const operatorUsernameOk = same(username, this.usernameDigest);
    const operatorPasswordOk = await verifyPassword(password, this.hash);
    const staffAccount = this.staff ? await this.staff.findByUsername(username) : null;
    let role: CreatorAccountRole = "operator";
    let accountId = LEGACY_OWNER_ACCOUNT_ID;
    let sessionUsername = this.username;
    let staffId: string | null = null;
    if (staffAccount) {
      const staffHash = staffAccount.passwordHash ? parsePasswordHash(staffAccount.passwordHash) : null;
      const staffOk = staffHash ? await verifyPassword(password, staffHash) : false;
      if (!staffHash || !staffOk || staffAccount.status !== "active") throw new SiteAuthError(401, "AUTH_LOGIN_FAILED");
      if (staffAccount.totpEnabled) {
        const challenge = randomBytes(32).toString("base64url");
        this.challenges.set(challenge, { staffId: staffAccount.id, username: staffAccount.username, expires: now + 5 * 60_000 });
        return { session: null, cookies: [], totpRequired: true, challenge };
      }
      role = "operator";
      accountId = staffAccount.id;
      sessionUsername = staffAccount.username;
      staffId = staffAccount.id;
      this.staffLive.set(staffAccount.id, { status: "active", permissions: staffAccount.permissions });
      await this.staff?.recordLogin(staffAccount.id);
    } else if (operatorUsernameOk && operatorPasswordOk) {
      // Env operator until a staff row exists for this username. Works stay on the legacy owner unless ops view is on.
    } else {
      const creator = this.creators ? await this.creators.findActiveByUsername(username) : null;
      const creatorHash = creator ? parsePasswordHash(creator.passwordHash) : null;
      const creatorOk = creatorHash ? await verifyPassword(password, creatorHash) : await verifyPassword(password, this.hash);
      if (!creator || !creatorHash || !creatorOk) throw new SiteAuthError(401, "AUTH_LOGIN_FAILED");
      role = "creator";
      accountId = creator.id;
      sessionUsername = creator.username;
    }
    return this.issueSession(headers, now, { role, accountId, username: sessionUsername, staffId });
  }

  async completeTotp(headers: RequestHeaders, body: unknown): Promise<{ session: SiteSessionView; cookies: string[] }> {
    this.assertOrigin(headers);
    if (header(headers, "content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
      throw new SiteAuthError(415, "AUTH_CONTENT_TYPE_REJECTED");
    }
    const input = typeof body === "object" && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : {};
    const challenge = typeof input.challenge === "string" ? input.challenge : "";
    const code = typeof input.code === "string" ? input.code.trim() : "";
    const pending = this.challenges.get(challenge);
    if (!pending || pending.expires <= this.now() || !this.staff) throw new SiteAuthError(401, "AUTH_LOGIN_FAILED");
    const ok = await this.staff.verifySecondFactor(pending.staffId, code);
    if (!ok) throw new SiteAuthError(401, "AUTH_LOGIN_FAILED");
    this.challenges.delete(challenge);
    const account = await this.staff.findByUsername(pending.username);
    if (!account || account.status !== "active") throw new SiteAuthError(401, "AUTH_LOGIN_FAILED");
    this.staffLive.set(account.id, { status: "active", permissions: account.permissions });
    await this.staff.recordLogin(account.id);
    const issued = this.issueSession(headers, this.now(), {
      role: "operator", accountId: account.id, username: account.username, staffId: account.id,
    });
    return { session: issued.session, cookies: issued.cookies };
  }

  /** A valid session or an error; also refreshes the idle deadline. */
  session(headers: RequestHeaders): SiteSessionView {
    const found = this.lookup(headers);
    if (!found || !this.staffAllows(found.value)) throw this.missing(headers);
    found.value.lastSeenAt = this.now();
    return this.view(found.value);
  }

  /** The same answer as session() without counting as activity: for a page's own expiry check, not for access. */
  peek(headers: RequestHeaders): SiteSessionView {
    const found = this.lookup(headers);
    if (!found || !this.staffAllows(found.value)) throw this.missing(headers);
    return this.view(found.value);
  }

  /**
   * Signed-out visitor view for GET /auth/session. Carries the registration flag so /register can decide
   * whether to show the form; never authenticates. Used only when there is no session cookie at all
   * (AUTH_REQUIRED); expired/forged cookies still surface as AUTH_SESSION_EXPIRED.
   */
  anonymousSession(): {
    enabled: true;
    authenticated: false;
    publicRegistrationEnabled: boolean;
  } {
    return {
      enabled: true,
      authenticated: false,
      publicRegistrationEnabled: this.publicRegistrationEnabled,
    };
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
    if (!found || !this.staffAllows(found.value)) throw this.missing(headers);
    const csrf = header(headers, "x-csrf-token");
    if (!csrf || !OPAQUE_TOKEN.test(csrf) || !same(csrf, digest(found.value.csrfToken))) {
      throw new SiteAuthError(403, "AUTH_CSRF_REJECTED");
    }
    found.value.lastSeenAt = this.now();
  }

  /**
   * Drops every in-memory session for this account. Disabling a creator must not leave a cookie usable
   * until the 12-hour absolute lifetime. Operator sessions use a different account id and are left alone.
   */
  revokeAccount(accountId: string): void {
    if (!accountId) return;
    for (const [key, value] of this.sessions) {
      if (value.accountId === accountId) this.sessions.delete(key);
    }
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

  private issueSession(headers: RequestHeaders, now: number, input: {
    role: CreatorAccountRole;
    accountId: string;
    username: string;
    staffId: string | null;
  }): { session: SiteSessionView; cookies: string[]; totpRequired: false } {
    const previous = this.lookup(headers);
    if (previous) this.sessions.delete(previous.key);
    this.prune(now);
    if (this.sessions.size >= MAX_SESSIONS) throw new SiteAuthError(429, "AUTH_SESSION_LIMIT");
    const id = randomBytes(32).toString("base64url");
    const value: StoredSession = {
      csrfToken: randomBytes(32).toString("base64url"), createdAt: now, lastSeenAt: now,
      role: input.role, accountId: input.accountId, username: input.username, staffId: input.staffId,
      publicId: randomBytes(16).toString("base64url"),
    };
    this.sessions.set(digest(id).toString("hex"), value);
    return { session: this.view(value), cookies: this.issue(id, value.csrfToken), totpRequired: false };
  }

  private staffAllows(value: StoredSession): boolean {
    if (!value.staffId) return true;
    const live = this.staffLive.get(value.staffId);
    if (!live || live.status !== "active") {
      this.revokeAccount(value.accountId);
      return false;
    }
    return true;
  }

  private view(value: StoredSession): SiteSessionView {
    const live = value.staffId ? this.staffLive.get(value.staffId) : undefined;
    const permissions: readonly StaffPermission[] = value.role !== "operator"
      ? []
      : value.staffId
        ? STAFF_PERMISSIONS.filter((permission) => live?.permissions.includes(permission))
        : STAFF_PERMISSIONS;
    return {
      enabled: true,
      authenticated: true,
      username: value.username,
      role: value.role,
      accountId: value.accountId,
      csrfToken: value.csrfToken,
      expiresAt: new Date(this.expiresAt(value)).toISOString(),
      publicRegistrationEnabled: this.publicRegistrationEnabled,
      staffId: value.staffId,
      permissions,
    };
  }

  registrationEnabled(): boolean {
    return this.publicRegistrationEnabled;
  }
}

/** What the API does about login, decided once at startup from the process environment. */
export type SiteAuthState =
  | { kind: "disabled" }
  | { kind: "enabled"; auth: SiteAuth }
  | { kind: "misconfigured" };
