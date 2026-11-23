import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const STEP_MS = 30_000;
const DIGITS = 6;

function base32Encode(bytes: Buffer): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(input: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = input.replace(/=+$/u, "").toUpperCase().replace(/[\s-]/gu, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = alphabet.indexOf(char);
    if (index < 0) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

function hotp(secret: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secret).update(message).digest();
  const offset = digest[digest.length - 1]! & 15;
  const binary = ((digest[offset]! & 127) << 24)
    | (digest[offset + 1]! << 16)
    | (digest[offset + 2]! << 8)
    | digest[offset + 3]!;
  return String(binary % 1_000_000).padStart(DIGITS, "0");
}

export function createTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpUri(secret: string, username: string): string {
  const label = encodeURIComponent(`红果创作:${username}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent("红果创作")}&digits=${String(DIGITS)}&period=30`;
}

export function currentTotp(secret: string, now = Date.now()): string {
  return hotp(base32Decode(secret), Math.floor(now / STEP_MS));
}

export function verifyTotp(secret: string, code: string, now = Date.now()): boolean {
  if (!/^\d{6}$/u.test(code)) return false;
  const key = base32Decode(secret);
  const counter = Math.floor(now / STEP_MS);
  const presented = Buffer.from(code);
  for (const step of [counter - 1, counter, counter + 1]) {
    const expected = Buffer.from(hotp(key, step));
    if (expected.length === presented.length && timingSafeEqual(expected, presented)) return true;
  }
  return false;
}

export function createRecoveryCodes(): string[] {
  return Array.from({ length: 8 }, () => randomBytes(5).toString("hex"));
}
