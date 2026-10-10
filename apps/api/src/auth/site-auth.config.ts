import type { ApiEnv } from "../config/env";
import { SiteAuth, type SiteAuthState } from "./site-auth";

/**
 * SITE_AUTH_ENABLED is independent of MODEL_ADMIN_ENABLED. Unset or exactly "false" keeps the earlier behaviour (no
 * application login; the deployment must then protect the site in front of it). Any other value — including an
 * explicitly empty one (loadApiEnv keeps "" for this key) — or "true" with anything missing or invalid is
 * "misconfigured": every protected request is refused, never served anonymously.
 */
export function siteAuthFromEnv(env: ApiEnv): SiteAuthState {
  const enabled = env.SITE_AUTH_ENABLED;
  if (enabled === undefined || enabled === "false") return { kind: "disabled" };
  if (enabled !== "true") return { kind: "misconfigured" };
  const username = env.SITE_AUTH_USERNAME ?? "admin";
  const passwordHash = env.SITE_AUTH_PASSWORD_HASH;
  const publicOrigin = env.SITE_AUTH_PUBLIC_ORIGIN;
  if (!passwordHash || !publicOrigin) return { kind: "misconfigured" };
  try {
    return { kind: "enabled", auth: new SiteAuth({ username, passwordHash, publicOrigin },
      // Production never issues cookies without Secure, even behind a loopback proxy.
      { allowHttpLoopback: env.NODE_ENV !== "production" }) };
  } catch {
    return { kind: "misconfigured" };
  }
}

/** Startup notes about the configuration, without any value. */
export function siteAuthWarnings(env: ApiEnv, state: SiteAuthState): string[] {
  const warnings: string[] = [];
  if (state.kind === "misconfigured") warnings.push("SITE_AUTH_ENABLED is set but the login configuration is incomplete or invalid; all protected requests are refused.");
  if (state.kind === "disabled" && env.NODE_ENV === "production") warnings.push("SITE_AUTH_ENABLED is not true; the application does not require a login and relies on protection in front of it.");
  if (env.MODEL_ADMIN_TOKEN !== undefined) warnings.push("MODEL_ADMIN_TOKEN is no longer used and is ignored; remove it from the API environment file.");
  if (env.MODEL_ADMIN_PUBLIC_ORIGIN !== undefined) warnings.push("MODEL_ADMIN_PUBLIC_ORIGIN is no longer used; the site origin is SITE_AUTH_PUBLIC_ORIGIN.");
  return warnings;
}
