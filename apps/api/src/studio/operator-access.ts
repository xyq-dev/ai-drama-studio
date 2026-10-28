import { timingSafeEqual } from "node:crypto";
import type { RequestHeaders, SiteAuthState } from "../auth/site-auth";

/**
 * Who may start paid text calls (title writing, script breakdown, online candidates). With the site login on, the site
 * has exactly one account, the administrator who also holds the model console: a request carrying that account's valid
 * session, the exact site origin and the session's CSRF token is the operator, so the page needs no token field. The
 * check is the site login's own write check, done again here; a disabled button in the page is never the check.
 * Without the site login (local development, isolated acceptances) the server-side operator token is still required in
 * X-Operator-Token. The token never reaches the browser from the server.
 */
export interface OperatorProof {
  /** The request carried a valid site session with its origin and CSRF token. */
  session: boolean;
  token: string | undefined;
}

export function operatorProof(site: SiteAuthState | null | undefined, headers: RequestHeaders): OperatorProof {
  let session = false;
  if (site?.kind === "enabled") {
    try {
      site.auth.authorizeWrite(headers);
      session = true;
    } catch {
      session = false;
    }
  }
  const token = headers["x-operator-token"];
  return { session, token: typeof token === "string" ? token : undefined };
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
  /** The site login is on: its signed-in administrator is the operator. */
  siteOperator?: boolean;
  operatorToken: string | null;
}

/** Whether any operator can be authorized at all (for the options answer). */
export function operatorConfigured(policy: OperatorPolicy): boolean {
  return policy.siteOperator === true || Boolean(policy.operatorToken);
}

export function operatorAllowed(policy: OperatorPolicy, value: OperatorProof | string | undefined): boolean {
  const proof = asProof(value);
  if (policy.siteOperator === true && proof.session) return true;
  return Boolean(policy.operatorToken) && sameToken(policy.operatorToken!, proof.token);
}
