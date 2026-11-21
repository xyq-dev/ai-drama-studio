import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { FEATURE_KEYS, type UsageAmount, type UsageCost } from "@ai-drama/contracts";
import { FeatureVaultError } from "./feature-config-vault";

/**
 * Call records and task locks. This file is not encrypted because it must not contain credentials.
 * Unknown usage stays unknown; this store never writes a zero for a missing amount.
 */
const usageSchema = z.object({
  status: z.enum(["present", "unknown", "pending"]),
  amount: z.number().nonnegative().optional(),
  unit: z.enum(["token", "image", "character", "request"]).optional(),
}).strict();
const costSchema = z.object({
  status: z.enum(["present", "pending", "unknown", "estimated"]),
  amount: z.string().regex(/^(0|[1-9]\d{0,7})(\.\d{1,8})?$/).optional(),
  currency: z.enum(["CNY", "USD"]).optional(),
  source: z.string().max(120).optional(),
  rule: z.string().max(200).optional(),
}).strict();
const recordSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["production", "admin_test"]),
  workspaceId: z.string().min(1).max(80),
  projectId: z.string().min(1).max(80).nullable(),
  projectLabel: z.string().max(200),
  episodeId: z.string().min(1).max(80).nullable(),
  episodeLabel: z.string().max(200),
  taskId: z.string().min(1).max(200),
  attempt: z.number().int().min(1).max(100),
  actorId: z.string().min(1).max(80),
  feature: z.enum(FEATURE_KEYS),
  vendor: z.string().max(40),
  vendorLabel: z.string().max(40),
  model: z.string().max(128),
  modelLabel: z.string().max(128),
  configVersion: z.string().max(80).nullable(),
  credentialRef: z.string().max(120).nullable(),
  result: z.enum(["succeeded", "failed", "unknown"]),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  usage: usageSchema,
  cost: costSchema,
  vendorRequestId: z.string().min(8).max(200),
}).strict();
const lockSchema = z.object({
  workspaceId: z.string().min(1).max(80),
  taskId: z.string().min(1).max(200),
  feature: z.enum(FEATURE_KEYS),
  versionId: z.string().max(80),
  credentialRef: z.string().max(120),
  vendor: z.string().max(40),
  model: z.string().max(128),
  projectId: z.string().min(1).max(80),
  episodeId: z.string().min(1).max(80).nullable(),
}).strict();
const fileSchema = z.object({
  records: z.array(recordSchema).max(500),
  locks: z.array(lockSchema).max(500),
}).strict();

export type StoredUsage = z.infer<typeof recordSchema>;
export type StoredLock = z.infer<typeof lockSchema>;

export function featureUsagePath(modelAdminConfigPath: string): string {
  return join(dirname(modelAdminConfigPath), "feature-usage.json");
}

function assertNoSecret(value: unknown, secrets: readonly string[]): void {
  const text = JSON.stringify(value);
  for (const secret of secrets) {
    if (secret.length >= 8 && text.includes(secret)) throw new FeatureVaultError(500, "ADMIN_CONFIG_INVALID");
  }
}

export class FeatureUsageStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {
    if (!isAbsolute(file)) throw new FeatureVaultError(503, "ADMIN_CONFIG_STORAGE_UNAVAILABLE");
  }

  async read(): Promise<{ records: StoredUsage[]; locks: StoredLock[] }> {
    return this.locked(async (doc) => structuredClone(doc));
  }

  async update(mutate: (doc: { records: StoredUsage[]; locks: StoredLock[] }) => void, secrets: readonly string[] = []): Promise<void> {
    await this.locked(async (doc) => {
      mutate(doc);
      doc.records = doc.records.slice(-500);
      doc.locks = doc.locks.slice(-500);
      assertNoSecret(doc, secrets);
      fileSchema.parse(doc);
      await this.persist(doc);
    });
  }

  private async locked<T>(operation: (doc: { records: StoredUsage[]; locks: StoredLock[] }) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const doc = await this.load();
      return operation(doc);
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async load(): Promise<{ records: StoredUsage[]; locks: StoredLock[] }> {
    try {
      const handle = await fs.open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.size > 2_000_000) {
          throw new FeatureVaultError(503, "ADMIN_CONFIG_STORAGE_UNAVAILABLE");
        }
        const bytes = Buffer.alloc(info.size);
        await handle.read(bytes, 0, info.size, 0);
        return fileSchema.parse(JSON.parse(bytes.toString("utf8")));
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { records: [], locks: [] };
      if (error instanceof FeatureVaultError) throw error;
      throw new FeatureVaultError(503, "ADMIN_CONFIG_STORAGE_UNAVAILABLE");
    }
  }

  private async persist(doc: { records: StoredUsage[]; locks: StoredLock[] }): Promise<void> {
    const directory = dirname(this.file);
    const info = await fs.stat(directory);
    if (!info.isDirectory() || (info.mode & 0o777) !== 0o700) throw new FeatureVaultError(503, "ADMIN_CONFIG_STORAGE_UNAVAILABLE");
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(JSON.stringify(doc));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, this.file);
  }
}

export function blankUsage(): UsageAmount {
  return { status: "unknown" };
}

const USAGE_UNITS = ["token", "image", "character", "request"] as const;

export function normalizeUsage(value: UsageAmount | undefined): { status: "present" | "unknown" | "pending"; amount?: number; unit?: (typeof USAGE_UNITS)[number] } {
  if (!value || value.status !== "present" || value.amount === undefined || !value.unit || !(USAGE_UNITS as readonly string[]).includes(value.unit)) {
    if (value?.status === "pending") return { status: "pending" };
    return { status: "unknown" };
  }
  return { status: "present", amount: value.amount, unit: value.unit as (typeof USAGE_UNITS)[number] };
}

export function normalizeCost(value: UsageCost | undefined): UsageCost {
  if (!value) return { status: "unknown" };
  if (value.status === "present" && value.amount && value.currency && value.source) {
    return { status: "present", amount: value.amount, currency: value.currency, source: value.source };
  }
  if (value.status === "estimated" && value.rule) return { status: "estimated", rule: value.rule, ...(value.amount && value.currency ? { amount: value.amount, currency: value.currency } : {}) };
  if (value.status === "pending") return { status: "pending" };
  return { status: "unknown" };
}
