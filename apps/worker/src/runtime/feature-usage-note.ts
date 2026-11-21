import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { RealMediaConfiguration } from "@ai-drama/contracts";

/**
 * Appends one production call beside the API feature-usage file.
 * Missing admin config, a busy lock, or a duplicate vendor request is a no-op.
 * This file never receives an API key.
 */
export async function noteFeatureUsage(input: {
  workspaceId: string;
  projectId: string;
  jobId: string;
  actorId: string;
  capability: RealMediaConfiguration["capability"];
  providerKey: string;
  model: string;
  vendorRequestId: string;
  ok: boolean;
  usage?: Record<string, number>;
  costAmount?: string;
  costCurrency?: string;
}): Promise<void> {
  const configPath = process.env.MODEL_ADMIN_CONFIG_PATH;
  if (!configPath || !isAbsolute(configPath) || input.vendorRequestId.length < 8) return;
  const feature = input.capability === "image.generate" ? "storyboard" : input.capability === "audio.tts" ? "voice" : null;
  if (!feature) return;
  const file = join(dirname(configPath), "feature-usage.json");
  const lockPath = `${file}.lock`;
  let lock: fs.FileHandle | undefined;
  try {
    const directory = await fs.stat(dirname(file));
    if (!directory.isDirectory() || (directory.mode & 0o777) !== 0o700) return;
    lock = await fs.open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const doc = await readUsage(file);
    if (doc.records.some((item) => item.vendorRequestId === input.vendorRequestId)) return;
    const taskLock = doc.locks.find((item) => item.workspaceId === input.workspaceId && item.taskId === input.jobId && item.feature === feature);
    const vendor = taskLock?.vendor ?? vendorFor(input.providerKey);
    const now = new Date().toISOString();
    const usage = presentUsage(feature, input.usage);
    const cost = input.costAmount && (input.costCurrency === "CNY" || input.costCurrency === "USD")
      ? { status: "present", amount: input.costAmount, currency: input.costCurrency, source: "provider" }
      : usage.status === "present" ? { status: "pending" } : { status: "unknown" };
    doc.records.push({
      id: randomUUID(),
      kind: "production",
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      projectLabel: input.projectId,
      episodeId: taskLock?.episodeId ?? null,
      episodeLabel: taskLock?.episodeId ? "分集" : "分集未知",
      taskId: input.jobId,
      attempt: doc.records.filter((item) => item.taskId === input.jobId && item.feature === feature).length + 1,
      actorId: input.actorId || "worker",
      feature,
      vendor,
      vendorLabel: vendor,
      model: taskLock?.model ?? input.model,
      modelLabel: taskLock?.model ?? input.model,
      configVersion: taskLock?.versionId ?? null,
      credentialRef: taskLock?.credentialRef ?? null,
      result: input.ok ? "succeeded" : "failed",
      startedAt: now,
      finishedAt: now,
      usage,
      cost,
      vendorRequestId: input.vendorRequestId,
    });
    doc.records = doc.records.slice(-500);
    const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(JSON.stringify(doc));
    await handle.close();
    await fs.rename(temporary, file);
  } catch {
    return;
  } finally {
    if (lock) {
      await lock.close().catch(() => undefined);
      await fs.unlink(lockPath).catch(() => undefined);
    }
  }
}

function vendorFor(providerKey: string): string {
  if (providerKey === "openai-media") return "openai";
  if (providerKey === "dashscope-media") return "bailian";
  if (providerKey === "minimax-tts") return "minimax";
  return providerKey;
}

function presentUsage(feature: "storyboard" | "voice", usage: Record<string, number> | undefined): { status: "present" | "unknown"; amount?: number; unit?: "image" | "character" | "token" } {
  const amount = usage ? Object.values(usage).find((value) => Number.isFinite(value) && value > 0) : undefined;
  if (amount === undefined) return { status: "unknown" };
  return { status: "present", amount, unit: feature === "storyboard" ? "image" : "character" };
}

async function readUsage(file: string): Promise<{ records: Array<Record<string, unknown> & { vendorRequestId?: string; taskId?: string; feature?: string; workspaceId?: string }>; locks: Array<{ workspaceId: string; taskId: string; feature: string; versionId: string; credentialRef: string; vendor: string; model: string; episodeId: string | null }> }> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as { records?: unknown; locks?: unknown };
    return {
      records: Array.isArray(parsed.records) ? parsed.records as never : [],
      locks: Array.isArray(parsed.locks) ? parsed.locks as never : [],
    };
  } catch {
    return { records: [], locks: [] };
  }
}
