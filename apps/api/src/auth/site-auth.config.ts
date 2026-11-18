import type { CreatorAccountStore } from "@ai-drama/database";
import type { ApiEnv } from "../config/env";
import { SiteAuth, type CreatorLoginDirectory, type SiteAuthState } from "./site-auth";

/**
 * SITE_AUTH_ENABLED is independent of MODEL_ADMIN_ENABLED. Unset or exactly "false" keeps the earlier behaviour (no
 * application login; the deployment must then protect the site in front of it). Any other value — including an
 * explicitly empty one (loadApiEnv keeps "" for this key) — or "true" with anything missing or invalid is
 * "misconfigured": every protected request is refused, never served anonymously.
 *
 * Creator accounts are optional: when a CreatorAccountStore is provided, non-operator usernames can authenticate.
 * Public registration defaults OFF (CREATOR_PUBLIC_REGISTRATION_ENABLED must be exactly "true").
 */
export function siteAuthFromEnv(
  env: ApiEnv,
  options: { creators?: CreatorAccountStore | null } = {},
): SiteAuthState {
  const enabled = env.SITE_AUTH_ENABLED;
  if (enabled === undefined || enabled === "false") return { kind: "disabled" };
  if (enabled !== "true") return { kind: "misconfigured" };
  const username = env.SITE_AUTH_USERNAME ?? "admin";
  const passwordHash = env.SITE_AUTH_PASSWORD_HASH;
  const publicOrigin = env.SITE_AUTH_PUBLIC_ORIGIN;
  if (!passwordHash || !publicOrigin) return { kind: "misconfigured" };
  const creators: CreatorLoginDirectory | null = options.creators
    ? {
      findActiveByUsername: async (name) => {
        // Never allow a creator username to shadow the operator account.
        if (name === username) return null;
        const found = await options.creators!.findActiveByUsername(env.APP_WORKSPACE_ID, name);
        return found ? { id: found.id, username: found.username, passwordHash: found.passwordHash } : null;
      },
    }
    : null;
  try {
    return {
      kind: "enabled",
      auth: new SiteAuth(
        { username, passwordHash, publicOrigin },
        {
          allowHttpLoopback: env.NODE_ENV !== "production",
          creators,
          publicRegistrationEnabled: env.CREATOR_PUBLIC_REGISTRATION_ENABLED === "true",
        },
      ),
    };
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
  if (env.CREATOR_PUBLIC_REGISTRATION_ENABLED === "true") {
    warnings.push("CREATOR_PUBLIC_REGISTRATION_ENABLED=true: public creator self-service registration is on.");
  }
  return warnings;
}
