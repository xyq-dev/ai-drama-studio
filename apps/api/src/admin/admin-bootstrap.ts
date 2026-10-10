import { isAbsolute, relative, sep } from "node:path";
import type { ApiEnv } from "../config/env";
import { findRepoRoot } from "../config/env-file";
import { AdminAuth, AdminHttpError } from "./admin-auth";

export interface AdminBootstrap {
  path: string;
  masterKey: Buffer;
  auth: AdminAuth | null;
}

/** Process-only configuration. Disabling the login does not discard previously managed models. */
export function adminBootstrap(env: ApiEnv, repoRoot = findRepoRoot(__dirname)): AdminBootstrap | null {
  const fail = (): never => { throw new AdminHttpError(503, "ADMIN_NOT_CONFIGURED"); };
  if (env.MODEL_ADMIN_ENABLED !== undefined && !["true", "false"].includes(env.MODEL_ADMIN_ENABLED)) fail();
  const enabled = env.MODEL_ADMIN_ENABLED === "true";
  const path = env.MODEL_ADMIN_CONFIG_PATH;
  const key = env.MODEL_ADMIN_MASTER_KEY;
  if (!enabled && path === undefined && key === undefined) return null;
  if (!path || !isAbsolute(path) || !key || !/^[a-fA-F0-9]{64}$/.test(key)) return fail();
  // Secret files are deployment state, never release source or build artifacts.
  const inside = relative(repoRoot, path);
  if (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)) return fail();
  let auth: AdminAuth | null = null;
  if (enabled) {
    const token = env.MODEL_ADMIN_TOKEN;
    const publicOrigin = env.MODEL_ADMIN_PUBLIC_ORIGIN;
    if (!token || !publicOrigin || token === env.TITLE_WRITING_OPERATOR_TOKEN || token === env.QWEN_WEB_OPERATOR_TOKEN) return fail();
    // Production never allows insecure cookies, even for a loopback-facing proxy.
    if (env.NODE_ENV === "production" && !publicOrigin.startsWith("https://")) return fail();
    auth = new AdminAuth({ token, publicOrigin });
  }
  return { path, masterKey: Buffer.from(key, "hex"), auth };
}
