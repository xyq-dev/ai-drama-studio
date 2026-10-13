import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Explicit local provisioning of the encrypted model vault only. Never restarts a service or contacts a provider.
 * Signing in is the site login (SITE_AUTH_*, scripts/site-auth-password.mjs); no administrator token is created.
 */
export async function initializeAdmin({ directory }) {
  if (process.platform === "win32") throw new Error("Requires Linux/POSIX private file permissions.");
  if (typeof directory !== "string" || !isAbsolute(directory) || !/^[A-Za-z0-9_./-]+$/.test(directory)) {
    throw new Error("Choose an absolute private directory using letters, digits, slash, dot, dash or underscore.");
  }
  const path = resolve(directory);
  const root = fileURLToPath(new URL("../", import.meta.url));
  const child = relative(root, path);
  if (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child)) throw new Error("Private directory must be outside the repository.");
  const parent = dirname(path);
  const info = await lstat(parent);
  if (await realpath(parent) !== parent || !info.isDirectory() || (info.mode & 0o022) !== 0) {
    throw new Error("Private parent must exist, without symlinks or group/world write permission.");
  }
  // Never reuse a directory or overwrite a key: reinitialization would strand encrypted data.
  await mkdir(path, { mode: 0o700 });
  const values = {
    MODEL_ADMIN_ENABLED: "true",
    MODEL_ADMIN_CONFIG_PATH: `${path}/models.enc`,
    MODEL_ADMIN_MASTER_KEY: randomBytes(32).toString("hex"),
  };
  const file = await open(`${path}/api-admin.env`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(Object.entries(values).map(([name, value]) => `${name}=${value}\n`).join(""));
    await file.sync();
  } finally { await file.close(); }
  const folder = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await folder.sync(); } finally { await folder.close(); }
  return { environmentFile: `${path}/api-admin.env` };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== "--directory") {
      throw new Error("Usage: node scripts/admin-models-init.mjs --directory /private/new-directory");
    }
    const result = await initializeAdmin({ directory: args[1] });
    console.log(`Model vault bootstrap created. Environment file: ${result.environmentFile}\nNo service restarted. No provider called. Sign-in uses the site login. Keep this file private.`);
  } catch {
    console.error("Admin bootstrap failed. Check arguments, private parent ownership and existing directory. Nothing is printed; do not overwrite existing keys.");
    process.exitCode = 1;
  }
}
