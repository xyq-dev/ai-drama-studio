import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { z } from "zod";
import {
  adminLimitsUpdateSchema, adminProviderKeySchema, adminProviderUpdateSchema,
  type AdminAuditView, type AdminLimitsUpdate, type AdminProviderUpdate, type TitleWritingProviderKey,
} from "@ai-drama/contracts";
import { DEEPSEEK_CHAT_URL, OPENAI_RESPONSES_URL, resolveQwenChatEndpoint } from "@ai-drama/providers";

const FORMAT = "ai-drama-studio.admin-model-vault.v1";
const AAD = Buffer.from(FORMAT, "utf8");
const INITIALIZED = Buffer.from(`${FORMAT}.initialized\n`, "utf8");
const MAX_BYTES = 256 * 1024;
const SECRET_SCHEMA = z.string().min(8).max(256).regex(/^\S+$/u).nullable();
const revisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const providerSchema = z.object({
  apiKey: SECRET_SCHEMA,
  baseUrl: z.string().max(512),
  models: adminProviderUpdateSchema.shape.models,
}).strict();
const settingsSchema = z.object({
  revision: revisionSchema,
  defaultProvider: adminProviderKeySchema.nullable(),
  maxCallsPerDay: z.number().int().min(1).max(500),
  maxActiveRuns: z.number().int().min(1).max(10),
  providers: z.object({ qwen: providerSchema, openai: providerSchema, deepseek: providerSchema }).strict(),
}).strict();
const documentSchema = z.object({
  active: settingsSchema,
  saved: settingsSchema,
  audit: z.array(z.object({
    at: z.string().datetime(), action: z.enum(["provider_updated", "limits_updated", "activated"]),
    providerKey: adminProviderKeySchema.optional(), revision: revisionSchema,
  }).strict()).max(50),
}).strict();
const envelopeSchema = z.object({
  format: z.literal(FORMAT), nonce: z.string(), tag: z.string(), ciphertext: z.string(),
}).strict();

/** Public errors intentionally contain neither filesystem paths nor rejected input. */
export class AdminConfigError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "AdminConfigError";
  }
}

export interface ManagedModelSettings {
  revision: number;
  defaultProvider: TitleWritingProviderKey | null;
  maxCallsPerDay: number;
  maxActiveRuns: number;
  providers: Record<TitleWritingProviderKey, { apiKey: string | null; baseUrl: string; models: string[] }>;
}
/** Server-only document. Never serialize this object into an HTTP response or log. */
export interface ManagedModelDocument {
  active: ManagedModelSettings;
  saved: ManagedModelSettings;
  audit: AdminAuditView[];
}

function storageError(): AdminConfigError {
  return new AdminConfigError(503, "ADMIN_CONFIG_STORAGE_UNAVAILABLE", "模型配置存储不可用，请联系管理员。");
}
function inputError(): AdminConfigError {
  return new AdminConfigError(400, "ADMIN_CONFIG_INVALID", "模型配置格式不正确。");
}
function codeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}
function validEndpoint(key: TitleWritingProviderKey, url: string): boolean {
  if (key === "qwen") return url === "" || resolveQwenChatEndpoint(url).ok;
  return url === (key === "openai" ? OPENAI_RESPONSES_URL : DEEPSEEK_CHAT_URL);
}
function checkedDocument(input: unknown): ManagedModelDocument {
  const result = documentSchema.safeParse(input);
  if (!result.success) throw storageError();
  const doc = result.data;
  if (doc.active.revision > doc.saved.revision || doc.audit.some((item) => item.revision > doc.saved.revision)) throw storageError();
  for (const settings of [doc.active, doc.saved]) {
    for (const key of ["qwen", "openai", "deepseek"] as const) {
      if (!validEndpoint(key, settings.providers[key].baseUrl)) throw storageError();
    }
  }
  if (doc.active.revision === doc.saved.revision && JSON.stringify(doc.active) !== JSON.stringify(doc.saved)) throw storageError();
  return doc;
}
function strictBase64(value: string, size?: number): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw storageError();
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value || (size !== undefined && decoded.length !== size)) throw storageError();
  return decoded;
}

/**
 * Single-host, persistent encrypted configuration. The private parent directory is provisioned
 * outside the app. A leftover .lock after a crash is deliberately not stolen: an operator must
 * first establish that no writer remains. Saved changes are activated only during API startup.
 */
export class ModelConfigVault {
  private readonly masterKey: Buffer;
  private readonly file: string;
  private readonly initial: ManagedModelDocument;
  private observedFile = false;
  private queue: Promise<void> = Promise.resolve();

  private constructor(options: { path: string; masterKey: Buffer; initial: ManagedModelSettings }) {
    this.file = resolve(options.path);
    this.masterKey = Buffer.from(options.masterKey);
    this.initial = checkedDocument({ active: options.initial, saved: options.initial, audit: [] });
  }

  static async open(options: { path: string; masterKey: Buffer; initial: ManagedModelSettings }): Promise<ModelConfigVault> {
    try {
      // POSIX permissions are the storage boundary. Windows ACL support is not claimed.
      if (process.platform === "win32" || !isAbsolute(options.path) || options.masterKey.length !== 32 || options.initial.revision !== 0) throw storageError();
      const vault = new ModelConfigVault(options);
      await vault.locked(async (doc) => {
        // Persist the baseline before the durable marker. A crash between these writes can only
        // reuse that verified encrypted baseline; it cannot silently use changed environment keys.
        if (!vault.observedFile) await vault.persist(doc);
        if (!(await vault.markerPresent())) await vault.atomicWrite(`${vault.file}.initialized`, INITIALIZED);
      }, true);
      await vault.read();
      return vault;
    } catch { throw storageError(); }
  }

  private async checkDirectory(): Promise<void> {
    const directory = dirname(this.file);
    if (await fs.realpath(directory) !== directory) throw storageError();
    // Refuse symlinks anywhere in the directory chain, not only the final parent.
    let current = directory;
    while (true) {
      const info = await fs.lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw storageError();
      if (current === directory && ((info.mode & 0o777) !== 0o700 || (process.geteuid && info.uid !== process.geteuid()))) throw storageError();
      const parent = dirname(current);
      if (parent === current || current === sep) break;
      current = parent;
    }
  }

  private async markerPresent(): Promise<boolean> {
    let marker: fs.FileHandle;
    try { marker = await fs.open(`${this.file}.initialized`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      if (codeOf(error) === "ENOENT") return false;
      throw error;
    }
    try {
      const info = await marker.stat();
      if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || (process.geteuid && info.uid !== process.geteuid()) || info.size !== INITIALIZED.length) throw storageError();
      const bytes = Buffer.alloc(INITIALIZED.length + 1);
      const { bytesRead } = await marker.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== INITIALIZED.length || !bytes.subarray(0, bytesRead).equals(INITIALIZED)) throw storageError();
      return true;
    } finally { await marker.close(); }
  }

  async read(): Promise<ManagedModelDocument> { return this.readDocument(false); }

  private async readDocument(allowUninitialized: boolean): Promise<ManagedModelDocument> {
    try {
      await this.checkDirectory();
      const initialized = await this.markerPresent();
      if (!initialized && !allowUninitialized) throw storageError();
      let handle: fs.FileHandle;
      try { handle = await fs.open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (error) {
        if (codeOf(error) === "ENOENT" && allowUninitialized && !initialized && !this.observedFile) return structuredClone(this.initial);
        throw error;
      }
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || (process.geteuid && info.uid !== process.geteuid()) || info.size > MAX_BYTES) throw storageError();
        // Bound the read even if a local process grows the file after stat().
        const bytes = Buffer.alloc(MAX_BYTES + 1);
        let offset = 0;
        while (offset < bytes.length) {
          const chunk = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (!chunk.bytesRead) break;
          offset += chunk.bytesRead;
        }
        if (offset > MAX_BYTES) throw storageError();
        const envelope = envelopeSchema.parse(JSON.parse(bytes.subarray(0, offset).toString("utf8")));
        const decipher = createDecipheriv("aes-256-gcm", this.masterKey, strictBase64(envelope.nonce, 12));
        decipher.setAAD(AAD);
        decipher.setAuthTag(strictBase64(envelope.tag, 16));
        const plaintext = Buffer.concat([decipher.update(strictBase64(envelope.ciphertext)), decipher.final()]);
        try {
          const doc = checkedDocument(JSON.parse(plaintext.toString("utf8")));
          this.observedFile = true;
          return doc;
        } finally { plaintext.fill(0); }
      } finally { await handle.close(); }
    } catch { throw storageError(); }
  }

  private serialize(doc: ManagedModelDocument): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.masterKey, nonce);
    cipher.setAAD(AAD);
    const plaintext = Buffer.from(JSON.stringify(checkedDocument(doc)), "utf8");
    try {
      const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const result = Buffer.from(JSON.stringify({ format: FORMAT, nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: encrypted.toString("base64") }), "utf8");
      if (result.length > MAX_BYTES) throw storageError();
      return result;
    } finally { plaintext.fill(0); }
  }

  private async persist(doc: ManagedModelDocument): Promise<void> {
    await this.atomicWrite(this.file, this.serialize(doc));
    this.observedFile = true;
  }

  private async atomicWrite(target: string, bytes: Buffer): Promise<void> {
    const temporary = `${target}.${randomUUID()}.tmp`;
    let handle: fs.FileHandle | undefined;
    let temporaryCreated = false;
    try {
      await this.checkDirectory();
      handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      temporaryCreated = true;
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporary, target);
      temporaryCreated = false;
      if (target === this.file) this.observedFile = true;
      const directory = await fs.open(dirname(this.file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await directory.sync(); } finally { await directory.close(); }
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      if (temporaryCreated) await fs.unlink(temporary).catch(() => undefined);
    }
  }

  private async locked<T>(operation: (doc: ManagedModelDocument) => Promise<T>, allowUninitialized = false): Promise<T> {
    const run = this.queue.then(async () => {
      let lock: fs.FileHandle | undefined;
      let result!: T;
      let failure: AdminConfigError | undefined;
      const lockPath = `${this.file}.lock`;
      try {
        await this.checkDirectory();
        try { lock = await fs.open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
        catch (error) {
          if (codeOf(error) === "EEXIST") throw new AdminConfigError(409, "ADMIN_CONFIG_BUSY", "模型配置正在保存，请重新读取后再试。");
          throw error;
        }
        await lock.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
        await lock.sync();
        result = await operation(await this.readDocument(allowUninitialized));
      } catch (error) {
        failure = error instanceof AdminConfigError ? error : storageError();
      }
      if (lock) {
        try { await lock.close(); await fs.unlink(lockPath); }
        catch { failure ??= storageError(); }
      }
      if (failure) throw failure;
      return result;
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private assertRevision(doc: ManagedModelDocument, expected: number): void {
    if (doc.saved.revision !== expected) throw new AdminConfigError(409, "ADMIN_CONFIG_CONFLICT", "模型配置已更新，请重新读取后再保存。");
    if (expected === Number.MAX_SAFE_INTEGER) throw storageError();
  }

  async updateProvider(key: TitleWritingProviderKey, body: AdminProviderUpdate): Promise<void> {
    const parsed = adminProviderUpdateSchema.safeParse(body);
    if (!adminProviderKeySchema.safeParse(key).success || !parsed.success || (parsed.data.baseUrl !== undefined && !validEndpoint(key, parsed.data.baseUrl))) throw inputError();
    const input = parsed.data;
    return this.locked(async (doc) => {
      this.assertRevision(doc, input.expectedRevision);
      const provider = doc.saved.providers[key];
      provider.models = [...input.models];
      if (input.baseUrl !== undefined) provider.baseUrl = input.baseUrl;
      if (input.secretAction === "replace") provider.apiKey = input.apiKey!;
      if (input.secretAction === "clear") provider.apiKey = null;
      doc.saved.revision += 1;
      doc.audit = [...doc.audit, { action: "provider_updated" as const, providerKey: key, revision: doc.saved.revision, at: new Date().toISOString() }].slice(-50);
      await this.persist(doc);
    });
  }

  async updateLimits(body: AdminLimitsUpdate): Promise<void> {
    const parsed = adminLimitsUpdateSchema.safeParse(body);
    if (!parsed.success) throw inputError();
    const { expectedRevision, ...limits } = parsed.data;
    return this.locked(async (doc) => {
      this.assertRevision(doc, expectedRevision);
      doc.saved = { ...doc.saved, ...limits, revision: doc.saved.revision + 1 };
      doc.audit = [...doc.audit, { action: "limits_updated" as const, revision: doc.saved.revision, at: new Date().toISOString() }].slice(-50);
      await this.persist(doc);
    });
  }

  async activateIfIdle(isIdle: () => Promise<boolean>): Promise<{ active: ManagedModelSettings; deferred: boolean }> {
    return this.locked(async (doc) => {
      if (doc.active.revision === doc.saved.revision) return { active: structuredClone(doc.active), deferred: false };
      if (!(await isIdle())) return { active: structuredClone(doc.active), deferred: true };
      doc.active = structuredClone(doc.saved);
      doc.audit = [...doc.audit, { action: "activated" as const, revision: doc.active.revision, at: new Date().toISOString() }].slice(-50);
      await this.persist(doc);
      return { active: structuredClone(doc.active), deferred: false };
    });
  }
}
