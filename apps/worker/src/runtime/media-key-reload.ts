import {
  MediaKeyVault,
  applyManagedMediaKeys,
  mediaKeyVaultPath,
  type RealMediaEnvironment,
  type ServerRealMediaRuntime,
} from "@ai-drama/providers";

/**
 * Optional shared vault bootstrap for the worker. Uses the same MODEL_ADMIN_CONFIG_PATH +
 * MODEL_ADMIN_MASTER_KEY as the API (sibling media-keys.enc). Process-only; never from .env files.
 */
export function mediaKeyVaultBootstrap(processEnv: Record<string, string | undefined>): {
  path: string;
  masterKey: Buffer;
} | null {
  const path = processEnv.MODEL_ADMIN_CONFIG_PATH;
  const key = processEnv.MODEL_ADMIN_MASTER_KEY;
  // Both absent: vault intentionally unused (process-env media keys only).
  if (path === undefined && key === undefined) return null;
  // Partial or malformed config must fail closed — never silently ignore and keep stale env keys.
  if (!path || !key || !/^[a-fA-F0-9]{64}$/.test(key)) {
    throw new Error("MODEL_ADMIN_MEDIA_KEY_VAULT_MISCONFIGURED");
  }
  return { path: mediaKeyVaultPath(path), masterKey: Buffer.from(key, "hex") };
}

/** Open the vault (or null when unset). Failures propagate so a misconfigured vault fails closed. */
export async function openWorkerMediaKeyVault(
  processEnv: Record<string, string | undefined>,
): Promise<MediaKeyVault | null> {
  const bootstrap = mediaKeyVaultBootstrap(processEnv);
  if (!bootstrap) return null;
  return MediaKeyVault.open(bootstrap);
}

/**
 * Re-read managed media keys into the live runtime so a key saved in the API console is used
 * on the next worker submit without a deploy. Does not call vendors.
 */
export async function refreshWorkerMediaKeys(
  vault: MediaKeyVault | null,
  processMediaEnv: RealMediaEnvironment,
  runtime: ServerRealMediaRuntime,
): Promise<void> {
  if (!vault) return;
  const managed = (await vault.read()).saved;
  runtime.reloadMediaApiKeys(applyManagedMediaKeys(processMediaEnv, managed));
}
