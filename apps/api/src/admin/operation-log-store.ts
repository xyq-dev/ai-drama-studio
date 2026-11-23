import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { assertNoCredential, maskCredential } from "./admin-ops-present";

const recordSchema = z.object({
  id: z.string().uuid(),
  at: z.string().datetime(),
  actor: z.string().min(1).max(80),
  action: z.string().min(1).max(80),
  target: z.string().min(1).max(240),
  result: z.enum(["success", "failed"]),
  secretStatus: z.enum(["已保存", "已清除"]).nullable(),
  secretMask: z.string().regex(/^sk-\*\*\*.{1,8}$/u).nullable(),
  source: z.string().min(1).max(160),
  detail: z.string().max(400),
}).strict();

const fileSchema = z.object({
  records: z.array(recordSchema).max(500),
}).strict();

export type OperationLogRecord = z.infer<typeof recordSchema>;

export interface NewOperationLog {
  actor?: string;
  action: string;
  target: string;
  result: "success" | "failed";
  secretStatus?: "已保存" | "已清除" | null;
  secretMask?: string | null;
  source: string;
  detail?: string;
}

export function operationLogPath(modelAdminConfigPath: string): string {
  return join(dirname(modelAdminConfigPath), "operation-log.json");
}

/**
 * File audit beside feature-usage.json. Absolute path, mode 0600, no credentials.
 * Historical rows are not invented. The file is capped at 500 records.
 */
export class OperationLogStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {
    if (!isAbsolute(file)) throw new Error("OPERATION_LOG_PATH");
  }

  async list(): Promise<OperationLogRecord[]> {
    const doc = await this.load();
    return [...doc.records].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  }

  async get(id: string): Promise<OperationLogRecord | null> {
    const doc = await this.load();
    return doc.records.find((record) => record.id === id) ?? null;
  }

  async append(entry: NewOperationLog, forbidden: readonly string[] = []): Promise<OperationLogRecord> {
    const record: OperationLogRecord = {
      id: randomUUID(),
      at: new Date().toISOString(),
      actor: entry.actor?.trim() || "平台管理员",
      action: entry.action,
      target: entry.target,
      result: entry.result,
      secretStatus: entry.secretStatus ?? null,
      secretMask: entry.secretMask ?? null,
      source: entry.source,
      detail: entry.detail ?? "",
    };
    assertNoCredential(record, forbidden);
    recordSchema.parse(record);
    await this.locked(async (doc) => {
      doc.records.push(record);
      doc.records = doc.records.slice(-500);
      assertNoCredential(doc, forbidden);
      fileSchema.parse(doc);
      await this.persist(doc);
    });
    return record;
  }

  private async locked(operation: (doc: { records: OperationLogRecord[] }) => Promise<void>): Promise<void> {
    const run = this.queue.then(async () => {
      const doc = await this.load();
      await operation(doc);
    });
    this.queue = run.then(() => undefined, () => undefined);
    await run;
  }

  private async load(): Promise<{ records: OperationLogRecord[] }> {
    try {
      const handle = await fs.open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await handle.stat();
        if (!info.isFile() || !privateMode(info.mode, 0o600) || info.size > 2_000_000) throw new Error("OPERATION_LOG_STORAGE");
        const bytes = Buffer.alloc(info.size);
        await handle.read(bytes, 0, info.size, 0);
        return fileSchema.parse(JSON.parse(bytes.toString("utf8")));
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return { records: [] };
      if (error instanceof Error && (error.message === "OPERATION_LOG_SECRET" || error.message === "OPERATION_LOG_STORAGE")) throw error;
      throw new Error("OPERATION_LOG_STORAGE", { cause: error });
    }
  }

  private async persist(doc: { records: OperationLogRecord[] }): Promise<void> {
    const directory = dirname(this.file);
    const info = await fs.stat(directory);
    if (!info.isDirectory() || !privateMode(info.mode, 0o700)) throw new Error("OPERATION_LOG_STORAGE");
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

/**
 * POSIX keeps the log directory at 0700 and the file at 0600.
 * Node on Windows reports 0666 for both even after chmod, so that check cannot succeed there.
 */
function privateMode(actual: number, expected: number): boolean {
  if (process.platform === "win32") return true;
  return (actual & 0o777) === expected;
}

let journal: OperationLogStore | null = null;

export function setOperationJournal(next: OperationLogStore | null): void {
  journal = next;
}

export function operationJournal(): OperationLogStore | null {
  return journal;
}

/** Best-effort audit. A log failure must not change the operator action or echo a secret. */
export async function noteOperation(entry: NewOperationLog, forbidden: readonly string[] = []): Promise<void> {
  const store = journal;
  if (!store) return;
  try {
    await store.append(entry, forbidden);
  } catch {
    // Swallow. The caller already finished the real action.
  }
}

export async function noteCredentialChange(input: {
  action: string;
  label: string;
  status: "已保存" | "已清除";
  secret?: string;
  source: string;
  result?: "success" | "failed";
}): Promise<void> {
  const mask = input.secret ? maskCredential(input.secret) : null;
  const target = mask ? `${input.label} · ${input.status} (${mask})` : `${input.label} · ${input.status}`;
  await noteOperation({
    action: input.action,
    target,
    result: input.result ?? "success",
    secretStatus: input.status,
    secretMask: mask,
    source: input.source,
    detail: "日志只记录掩码状态和操作结果，完整密钥未写入，也不会在详情中展示。",
  }, input.secret ? [input.secret] : []);
}
