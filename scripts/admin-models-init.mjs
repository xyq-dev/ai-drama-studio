import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Explicit local provisioning only. Never restarts a service or contacts a provider. */
export async function initializeAdmin({ directory, publicOrigin }) {
  if (process.platform === "win32") throw new Error("Requires Linux/POSIX private file permissions.");
  if (typeof directory !== "string" || !isAbsolute(directory) || !/^[A-Za-z0-9_./-]+$/.test(directory)) {
    throw new Error("Choose an absolute private directory using letters, digits, slash, dot, dash or underscore.");
  }
  let url;
  try { url = new URL(publicOrigin); } catch { throw new Error("Invalid public origin."); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.origin !== publicOrigin || url.username || url.password ||
      (url.protocol !== "https:" && !(local && url.protocol === "http:"))) throw new Error("Use an exact HTTPS origin (HTTP only for loopback development).");
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
  const token = randomBytes(32).toString("base64url");
  const values = {
    MODEL_ADMIN_ENABLED: "true",
    MODEL_ADMIN_PUBLIC_ORIGIN: publicOrigin,
    MODEL_ADMIN_CONFIG_PATH: `${path}/models.enc`,
    MODEL_ADMIN_MASTER_KEY: randomBytes(32).toString("hex"),
    MODEL_ADMIN_TOKEN: token,
  };
  async function writePrivate(name, content) {
    const file = await open(`${path}/${name}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
  }
  await writePrivate("api-admin.env", Object.entries(values).map(([name, value]) => `${name}=${value}\n`).join(""));
  await writePrivate("admin-login.txt", `Admin URL: ${publicOrigin}/admin/models\nAdmin token: ${token}\nKeep private. This is not a model API key or title-writing operator token.\n`);
  const folder = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await folder.sync(); } finally { await folder.close(); }
  return { environmentFile: `${path}/api-admin.env`, loginFile: `${path}/admin-login.txt`, url: `${publicOrigin}/admin/models` };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 4 || args[0] !== "--directory" || args[2] !== "--origin") {
      throw new Error("Usage: node scripts/admin-models-init.mjs --directory /private/new-directory --origin https://drama.example.test");
    }
    const result = await initializeAdmin({ directory: args[1], publicOrigin: args[3] });
    console.log(`Admin bootstrap created. URL: ${result.url}\nEnvironment file: ${result.environmentFile}\nLogin file: ${result.loginFile}\nNo service restarted. No provider called. Keep these files private.`);
  } catch {
    console.error("Admin bootstrap failed. Check arguments, private parent ownership and existing directory. No credentials are printed; do not overwrite existing keys.");
    process.exitCode = 1;
  }
}
