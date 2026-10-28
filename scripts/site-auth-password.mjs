import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Creates the site login password hash (SITE_AUTH_PASSWORD_HASH). The password is read from a hidden terminal prompt
 * (typed twice) or from a protected file; it is never a command-line argument, never printed and never stored.
 * The format and parameters match apps/api/src/auth/password-hash.ts (scrypt, N = 2^17, r = 8, p = 1, 16-byte salt);
 * the API test suite verifies hashes made here.
 */
const PARAMETERS = { log2N: 17, r: 8, p: 1, saltBytes: 16, keyBytes: 32 };
const MIN_LENGTH = 8;
const MAX_LENGTH = 1024;

export function hashPassword(password) {
  return new Promise((resolvePromise, reject) => {
    const salt = randomBytes(PARAMETERS.saltBytes);
    scryptCallback(password.normalize("NFC"), salt, PARAMETERS.keyBytes,
      { N: 2 ** PARAMETERS.log2N, r: PARAMETERS.r, p: PARAMETERS.p, maxmem: 256 * 1024 * 1024 }, (error, key) => {
        if (error) reject(error);
        else resolvePromise(`scrypt$${PARAMETERS.log2N}$${PARAMETERS.r}$${PARAMETERS.p}$${salt.toString("base64url")}$${key.toString("base64url")}`);
      });
  });
}

export function checkPassword(password) {
  if (typeof password !== "string" || password.length < MIN_LENGTH || password.length > MAX_LENGTH) {
    throw new Error(`The password must be ${MIN_LENGTH}-${MAX_LENGTH} characters.`);
  }
  if (/[\r\n]/.test(password)) throw new Error("The password must be a single line.");
  return password;
}

/** A private regular file: not a link, owned by nobody else's group/world access (POSIX mode 600 or stricter). */
export async function readPasswordFile(path) {
  if (!isAbsolute(path)) throw new Error("Use an absolute path for the password file.");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("The password file must be a regular file, not a link.");
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) throw new Error("The password file must not be readable by group or others (chmod 600).");
  const text = await readFile(path, "utf8");
  return checkPassword(text.replace(/\r?\n$/, ""));
}

/** Reads one line from the terminal without echoing it. */
function promptHidden(question) {
  return new Promise((resolvePromise, reject) => {
    const input = process.stdin;
    if (!input.isTTY) {
      reject(new Error("No terminal for a hidden prompt. Use --password-file with a private file instead."));
      return;
    }
    process.stderr.write(question);
    let value = "";
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    const done = (error) => {
      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onData);
      process.stderr.write("\n");
      if (error) reject(error); else resolvePromise(value);
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\r" || character === "\n") { done(); return; }
        if (character === "\u0003") { done(new Error("Canceled.")); return; }
        if (character === "\u007f" || character === "\b") { value = value.slice(0, -1); continue; }
        value += character;
      }
    };
    input.on("data", onData);
  });
}

async function writePrivate(path, content) {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try { await file.writeFile(content); await file.sync(); } finally { await file.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 2) options[args[index]] = args[index + 1];
  const known = new Set(["--password-file", "--output", "--username"]);
  try {
    if (args.length % 2 !== 0 || Object.keys(options).some((key) => !known.has(key))) {
      throw new Error("Usage: node scripts/site-auth-password.mjs [--username admin] [--password-file /private/file] [--output /private/new-file.env]");
    }
    const username = options["--username"] ?? "admin";
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(username)) throw new Error("The username may use letters, digits, dot, dash and underscore.");
    let password;
    if (options["--password-file"]) {
      password = await readPasswordFile(options["--password-file"]);
    } else {
      password = checkPassword(await promptHidden("New site password: "));
      if (await promptHidden("Repeat the password: ") !== password) throw new Error("The two entries differ.");
    }
    const lines = `SITE_AUTH_USERNAME=${username}\nSITE_AUTH_PASSWORD_HASH=${await hashPassword(password)}\n`;
    if (options["--output"]) {
      if (!isAbsolute(options["--output"])) throw new Error("Use an absolute path for --output.");
      await writePrivate(options["--output"], lines);
      process.stderr.write(`Wrote ${options["--output"]} (mode 600). The password itself is not stored.\n`);
    } else {
      // Only the hash; it is not the password, but keep it in the protected API environment file.
      process.stdout.write(lines);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Failed."}\n`);
    process.exitCode = 1;
  }
}
