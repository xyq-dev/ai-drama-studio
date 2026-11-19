import { timingSafeEqual } from "node:crypto";
import type { CreatorAccountRole } from "@ai-drama/domain";
import type { RequestHeaders, SiteAuthState } from "../auth/site-auth";

/**
 * Proof that a request may start paid text / platform creation on the caller's own works,
 * or (separately) act as the site operator for admin config.
 *
 * With site login on: a request carrying a valid session, the exact site origin and the
 * session CSRF token proves the signed-in account. Role decides whether that is site admin
 * (`operatorAllowed`) or only platform creation on own works (`platformCreationAllowed`).
 * Without the site login (local development, isolated acceptances) the server-side operator
 * token is still required in X-Operator-Token. The token never reaches the browser from the
 * server.
 */
export interface OperatorProof {
  /** The request carried a valid site session with its origin and CSRF token. */
  session: boolean;
  /** Present when `session` is true. */
  role?: CreatorAccountRole;
  token: string | undefined;
}

export function operatorProof(site: SiteAuthState | null | undefined, headers: RequestHeaders): OperatorProof {
  let session = false;
  let role: CreatorAccountRole | undefined;
  if (site?.kind === "enabled") {
    try {
      site.auth.authorizeWrite(headers);
      session = true;
      role = site.auth.peek(headers).role;
    } catch {
      session = false;
      role = undefined;
    }
  }
  const token = headers["x-operator-token"];
  return { session, role, token: typeof token === "string" ? token : undefined };
}

/** Earlier callers pass the bare header value. */
export function asProof(value: OperatorProof | string | undefined): OperatorProof {
  return typeof value === "object" ? value : { session: false, token: value };
}

function sameToken(configured: string, presented: string | undefined): boolean {
  if (presented === undefined) return false;
  const left = Buffer.from(configured, "utf8");
  const right = Buffer.from(presented, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface OperatorPolicy {
  /**
   * Site login is on. When true, a valid session may authorize platform creation, and a
   * session with role=operator may authorize site admin. Never treat "any session" as admin.
   */
  siteOperator?: boolean;
  operatorToken: string | null;
}

/** Whether any operator / creation proof channel can be authorized at all (for options). */
export function operatorConfigured(policy: OperatorPolicy): boolean {
  return policy.siteOperator === true || Boolean(policy.operatorToken);
}

/**
 * Site administrator only: model console, media keys, storage, provisioning, ops views.
 * A creator session with valid CSRF must NOT pass this check.
 */
export function operatorAllowed(policy: OperatorPolicy, value: OperatorProof | string | undefined): boolean {
  const proof = asProof(value);
  if (policy.siteOperator === true && proof.session && proof.role === "operator") return true;
  return Boolean(policy.operatorToken) && sameToken(policy.operatorToken!, proof.token);
}

/**
 * Use already-configured platform creation capabilities on the caller's own works
 * (title writing, TTS, image, video, auto-creation, etc.). Operators and ACTIVE creators
 * both pass when the site session + CSRF are valid. Ownership filters still apply.
 */
export function platformCreationAllowed(policy: OperatorPolicy, value: OperatorProof | string | undefined): boolean {
  const proof = asProof(value);
  if (policy.siteOperator === true && proof.session) return true;
  return Boolean(policy.operatorToken) && sameToken(policy.operatorToken!, proof.token);
}
