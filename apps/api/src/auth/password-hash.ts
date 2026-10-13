import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Administrator password hashing with Node's built-in scrypt (RFC 7914): salted and memory-hard, no new dependency.
 *
 * Parameters follow the OWASP Password Storage Cheat Sheet minimum for scrypt: N = 2^17, r = 8, p = 1
 * (128 MiB per verification). The hash records its own parameters, so they can be raised later without breaking
 * existing hashes; verification only accepts a bounded range so a configured hash cannot exhaust the process.
 *
 * Format: scrypt$<log2 N>$<r>$<p>$<salt base64url>$<key base64url>
 * The same format is produced by scripts/site-auth-password.mjs; site-auth.spec.ts checks the two agree.
 */
export const PASSWORD_HASH_DEFAULTS = { log2N: 17, r: 8, p: 1, saltBytes: 16, keyBytes: 32 } as const;
const MAX_MEMORY = 256 * 1024 * 1024;
const FORMAT = /^scrypt\$(\d{2})\$(\d{1,2})\$(\d{1,2})\$([A-Za-z0-9_-]{22,88})\$([A-Za-z0-9_-]{43,88})$/u;

export interface ParsedPasswordHash {
  log2N: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

function scrypt(password: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password.normalize("NFC"), salt, keyLength, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

/** Null for anything that is not a well-formed hash with parameters inside the accepted range. */
export function parsePasswordHash(value: string): ParsedPasswordHash | null {
  const match = FORMAT.exec(value);
  if (!match) return null;
  const [, log2N, r, p, salt, key] = match;
  const parsed = { log2N: Number(log2N), r: Number(r), p: Number(p), salt: Buffer.from(salt!, "base64url"), key: Buffer.from(key!, "base64url") };
  if (parsed.log2N < 15 || parsed.log2N > 20 || parsed.r < 8 || parsed.r > 16 || parsed.p < 1 || parsed.p > 4) return null;
  if (parsed.salt.length < 16 || parsed.key.length < 32) return null;
  if (128 * parsed.r * 2 ** parsed.log2N * parsed.p > MAX_MEMORY) return null;
  return parsed;
}

export async function hashPassword(password: string, parameters = PASSWORD_HASH_DEFAULTS): Promise<string> {
  const salt = randomBytes(parameters.saltBytes);
  const key = await scrypt(password, salt, parameters.keyBytes,
    { N: 2 ** parameters.log2N, r: parameters.r, p: parameters.p, maxmem: MAX_MEMORY });
  return `scrypt$${String(parameters.log2N)}$${String(parameters.r)}$${String(parameters.p)}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

/** Constant-time comparison of the derived key; always performs the full derivation. */
export async function verifyPassword(password: string, hash: ParsedPasswordHash): Promise<boolean> {
  const derived = await scrypt(password, hash.salt, hash.key.length,
    { N: 2 ** hash.log2N, r: hash.r, p: hash.p, maxmem: MAX_MEMORY });
  return derived.length === hash.key.length && timingSafeEqual(derived, hash.key);
}
