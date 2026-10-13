import { isAbsolute, relative, sep } from "node:path";
import type { ApiEnv } from "../config/env";
import { findRepoRoot } from "../config/env-file";
import { AdminHttpError } from "./admin-auth";

export interface AdminBootstrap {
  path: string;
  masterKey: Buffer;
  /** Whether the model console routes are open. Who may use them is decided by the site login, not here. */
  enabled: boolean;
}

/**
 * Process-only configuration of the encrypted model vault. Disabling the console does not discard previously managed
 * models. MODEL_ADMIN_TOKEN and MODEL_ADMIN_PUBLIC_ORIGIN are no longer read: the console uses the site login.
 */
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
  return { path, masterKey: Buffer.from(key, "hex"), enabled };
}
