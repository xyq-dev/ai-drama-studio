import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const PUBLIC_KEYS = ["NODE_ENV", "WEB_PORT", "NEXT_PUBLIC_API_BASE_URL"] as const;

export type PublicEnvKey = (typeof PUBLIC_KEYS)[number];

export function findRepoRoot(start: string): string {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return resolve(start);
    }
    current = parent;
  }
}

export function parseEnvText(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }
    const normalized = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trim() : trimmed;
    const separator = normalized.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const key = normalized.slice(0, separator).trim();
    let value = normalized.slice(separator + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function pickPublicEnv(source: Record<string, string | undefined>): Partial<Record<PublicEnvKey, string>> {
  const picked: Partial<Record<PublicEnvKey, string>> = {};
  for (const key of PUBLIC_KEYS) {
    const value = source[key];
    if (value !== undefined && value.length > 0) {
      picked[key] = value;
    }
  }
  return picked;
}

export function loadWebPublicEnv(start = process.cwd()): Partial<Record<PublicEnvKey, string>> {
  const root = findRepoRoot(start);
  const filePath = join(root, ".env");
  const fileValues = existsSync(filePath) ? parseEnvText(readFileSync(filePath, "utf8")) : {};
  const merged: Record<string, string | undefined> = { ...fileValues };
  for (const key of PUBLIC_KEYS) {
    if (process.env[key] !== undefined) {
      merged[key] = process.env[key];
    }
  }
  const picked = pickPublicEnv(merged);
  for (const key of PUBLIC_KEYS) {
    if (key === "NODE_ENV") {
      continue;
    }
    const value = picked[key];
    if (value !== undefined && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
  return picked;
}
