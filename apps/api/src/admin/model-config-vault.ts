import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { z } from "zod";
import {
  TITLE_WRITING_PROVIDER_KEYS, TITLE_WRITING_STORED_PROVIDER_KEYS, TITLE_WRITING_V1_LEFT_OUT_PROVIDER_KEYS,
  adminLimitsUpdateSchema, adminProviderKeySchema, adminProviderUpdateSchema,
  ANTHROPIC_WORKSPACE_ID_SHAPE, workspaceUpdateOf,
  type AdminAuditView, type AdminLimitsUpdate, type AdminProviderUpdate, type TitleWritingProviderKey,
  type TitleWritingV1LeftOutProviderKey,
} from "@ai-drama/contracts";
import { ANTHROPIC_MESSAGES_URL, DEEPSEEK_CHAT_COMPLETIONS_URL, OPENAI_RESPONSES_URL } from "@ai-drama/providers";

/**
 * v1 held qwen, openai and deepseek. v2 holds openai and anthropic (Claude) and, since 2026-10-17, an optional deepseek
 * entry. A v1 file is still read (same master key, same AES-256-GCM integrity, its own AAD) and converted in memory; the
 * first write after that keeps the original v1 ciphertext as an exclusive backup file before the v2 file replaces it, so
 * a rollback can restore it byte for byte. The v1 DeepSeek settings are never carried over.
 *
 * The deepseek entry (and a DeepSeek default) is written only while DeepSeek has a key, so a file without it keeps
 * exactly what the release before it reads. The first write that adds DeepSeek to such a file first keeps that file's
 * bytes as an exclusive backup (DEEPSEEK_BACKUP_SUFFIX), once; clearing the DeepSeek key returns the file to the older
 * shape.
 */
const FORMAT_V1 = "ai-drama-studio.admin-model-vault.v1";
const FORMAT = "ai-drama-studio.admin-model-vault.v2";
const AAD_V1 = Buffer.from(FORMAT_V1, "utf8");
const AAD = Buffer.from(FORMAT, "utf8");
/** The durable marker keeps its v1 text: it only proves the vault was initialized. */
const INITIALIZED = Buffer.from(`${FORMAT_V1}.initialized\n`, "utf8");
/** Name suffix of the kept v1 file. Never overwritten once written. */
export const V1_BACKUP_SUFFIX = ".v1-retired-providers.bak";
/** Name suffix of the kept file from before DeepSeek was first saved. Written once, never overwritten. */
export const DEEPSEEK_BACKUP_SUFFIX = ".v2-before-deepseek.bak";
const MAX_BYTES = 256 * 1024;
const SECRET_SCHEMA = z.string().min(8).max(256).regex(/^\S+$/u).nullable();
const revisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/**
 * workspaceId (Claude only) is written only when set, so a vault that never had one keeps exactly the fields an older
 * release reads; older files without it read as "no workspace".
 */
const providerSchema = z.object({
  apiKey: SECRET_SCHEMA,
  baseUrl: z.string().max(512),
  models: adminProviderUpdateSchema.shape.models,
  workspaceId: z.string().regex(ANTHROPIC_WORKSPACE_ID_SHAPE).optional(),
}).strict();
const settingsSchema = z.object({
  revision: revisionSchema,
  defaultProvider: adminProviderKeySchema.nullable(),
  maxCallsPerDay: z.number().int().min(1).max(500),
  maxActiveRuns: z.number().int().min(1).max(10),
  providers: z.object({ openai: providerSchema, anthropic: providerSchema, deepseek: providerSchema.optional() }).strict(),
}).strict();
const documentSchema = z.object({
  active: settingsSchema,
  saved: settingsSchema,
  audit: z.array(z.object({
    at: z.string().datetime(), action: z.enum(["provider_updated", "limits_updated", "activated", "format_upgraded"]),
    // Entries written before the retirement may name a retired provider; they stay as recorded.
    providerKey: z.enum(TITLE_WRITING_STORED_PROVIDER_KEYS).optional(), revision: revisionSchema,
  }).strict()).max(50),
  /** Names only: which retired providers had settings in the v1 file and whether one was the default. */
  retired: z.object({
    providers: z.array(z.enum(TITLE_WRITING_V1_LEFT_OUT_PROVIDER_KEYS)).max(TITLE_WRITING_V1_LEFT_OUT_PROVIDER_KEYS.length),
    retiredDefault: z.enum(TITLE_WRITING_V1_LEFT_OUT_PROVIDER_KEYS).nullable(),
  }).strict().optional(),
}).strict();
const envelopeSchema = z.object({
  format: z.enum([FORMAT_V1, FORMAT]), nonce: z.string(), tag: z.string(), ciphertext: z.string(),
}).strict();

// The retired v1 layout, read only to convert it.
const v1SettingsSchema = z.object({
  revision: revisionSchema,
  defaultProvider: z.enum(["qwen", "openai", "deepseek"]).nullable(),
  maxCallsPerDay: z.number().int().min(1).max(500),
  maxActiveRuns: z.number().int().min(1).max(10),
  providers: z.object({ qwen: providerSchema, openai: providerSchema, deepseek: providerSchema }).strict(),
}).strict();
const v1DocumentSchema = z.object({
  active: v1SettingsSchema,
  saved: v1SettingsSchema,
  audit: z.array(z.object({
    at: z.string().datetime(), action: z.enum(["provider_updated", "limits_updated", "activated"]),
    providerKey: z.enum(["qwen", "openai", "deepseek"]).optional(), revision: revisionSchema,
  }).strict()).max(50),
}).strict();
type V1Settings = z.infer<typeof v1SettingsSchema>;

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
  providers: Record<TitleWritingProviderKey, { apiKey: string | null; baseUrl: string; models: string[]; workspaceId?: string }>;
}
/** What a conversion from v1 left out. Names only. */
export interface RetiredProviderNote {
  providers: TitleWritingV1LeftOutProviderKey[];
  retiredDefault: TitleWritingV1LeftOutProviderKey | null;
}
/** Server-only document. Never serialize this object into an HTTP response or log. */
export interface ManagedModelDocument {
  active: ManagedModelSettings;
  saved: ManagedModelSettings;
  audit: AdminAuditView[];
  retired?: RetiredProviderNote;
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
const ENDPOINTS: Readonly<Record<TitleWritingProviderKey, string>> = {
  openai: OPENAI_RESPONSES_URL, anthropic: ANTHROPIC_MESSAGES_URL, deepseek: DEEPSEEK_CHAT_COMPLETIONS_URL,
};
function validEndpoint(key: TitleWritingProviderKey, url: string): boolean {
  return url === ENDPOINTS[key];
}
/** DeepSeek as a file without its entry reads: no key, no models, the official endpoint. */
function noDeepseek(): ManagedModelSettings["providers"]["deepseek"] {
  return { apiKey: null, baseUrl: DEEPSEEK_CHAT_COMPLETIONS_URL, models: [] };
}
function deepseekUnset(provider: { apiKey: string | null; models: string[]; baseUrl: string; workspaceId?: string }): boolean {
  return provider.apiKey === null && provider.models.length === 0 && provider.baseUrl === DEEPSEEK_CHAT_COMPLETIONS_URL
    && provider.workspaceId === undefined;
}
/** Whether a stored document needs the DeepSeek-aware release: a DeepSeek entry or a DeepSeek default. */
function mentionsDeepseek(doc: { active: unknown; saved: unknown }): boolean {
  return [doc.active, doc.saved].some((settings) => {
    const record = settings as { defaultProvider?: unknown; providers?: Record<string, unknown> } | null;
    return record?.defaultProvider === "deepseek" || Object.prototype.hasOwnProperty.call(record?.providers ?? {}, "deepseek");
  });
}
/** The stored shape: an unset DeepSeek entry is left out, so the file stays readable by the release before it. */
function compactDocument(doc: ManagedModelDocument): unknown {
  const compact = (settings: ManagedModelSettings) => {
    const { deepseek, ...others } = settings.providers;
    return { ...settings, providers: deepseekUnset(deepseek) ? others : { ...others, deepseek } };
  };
  return { ...doc, active: compact(doc.active), saved: compact(doc.saved) };
}
function checkedDocument(input: unknown): ManagedModelDocument {
  const result = documentSchema.safeParse(input);
  if (!result.success) throw storageError();
  const doc = result.data as ManagedModelDocument;
  for (const settings of [doc.active, doc.saved]) {
    settings.providers.deepseek ??= noDeepseek();
    // A DeepSeek default always comes with a DeepSeek key: clearing the key also clears that default.
    if (settings.defaultProvider === "deepseek" && settings.providers.deepseek.apiKey === null) throw storageError();
  }
  if (doc.active.revision > doc.saved.revision || doc.audit.some((item) => item.revision > doc.saved.revision)) throw storageError();
  for (const settings of [doc.active, doc.saved]) {
    for (const key of TITLE_WRITING_PROVIDER_KEYS) {
      if (!validEndpoint(key, settings.providers[key].baseUrl)) throw storageError();
    }
    if (settings.providers.openai.workspaceId !== undefined || settings.providers.deepseek.workspaceId !== undefined) throw storageError();
  }
  if (doc.active.revision === doc.saved.revision && JSON.stringify(doc.active) !== JSON.stringify(doc.saved)) throw storageError();
  return doc;
}

/**
 * The v1 settings as v2: OpenAI keeps its key, models and endpoint; Claude starts unconfigured; the qwen and deepseek
 * entries are left out (they stay only in the kept v1 file) and a retired default becomes no default. Revisions are
 * kept, so the saved/active difference (a pending restart) is the same as before.
 */
function convertSettings(v1: V1Settings): ManagedModelSettings {
  return {
    revision: v1.revision,
    defaultProvider: v1.defaultProvider === "openai" ? "openai" : null,
    maxCallsPerDay: v1.maxCallsPerDay,
    maxActiveRuns: v1.maxActiveRuns,
    providers: {
      openai: { ...v1.providers.openai, models: [...v1.providers.openai.models] },
      anthropic: { apiKey: null, baseUrl: ANTHROPIC_MESSAGES_URL, models: [] },
      // The v1 DeepSeek key and models are left behind on purpose: DeepSeek starts unconfigured and needs a new key.
      deepseek: noDeepseek(),
    },
  };
}
function convertedDocument(input: unknown): ManagedModelDocument {
  const result = v1DocumentSchema.safeParse(input);
  if (!result.success) throw storageError();
  const v1 = result.data;
  const used = (key: TitleWritingV1LeftOutProviderKey) => [v1.active, v1.saved]
    .some((settings) => settings.providers[key].apiKey !== null || settings.providers[key].models.length > 0 || settings.defaultProvider === key);
  // The default the saved settings name, else the one still active: either way a retired default is reported.
  const savedDefault = v1.saved.defaultProvider === "qwen" || v1.saved.defaultProvider === "deepseek" ? v1.saved.defaultProvider : v1.active.defaultProvider;
  // A v1 document with equal revisions has equal settings, so the converted ones are equal too.
  return checkedDocument({
    active: convertSettings(v1.active),
    saved: convertSettings(v1.saved),
    audit: v1.audit.map((item) => ({ ...item })),
    retired: {
      providers: TITLE_WRITING_V1_LEFT_OUT_PROVIDER_KEYS.filter(used),
      retiredDefault: savedDefault === "qwen" || savedDefault === "deepseek" ? savedDefault : null,
    },
  });
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
  /** The exact bytes of the file while it is still a v1 file; kept before the first v2 write replaces it. */
  private v1Bytes: Buffer | null = null;
  /** The exact bytes of a v2 file without DeepSeek, read under the writer lock; kept before a write adds DeepSeek. */
  private beforeDeepseekBytes: Buffer | null = null;
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

  async read(): Promise<ManagedModelDocument> { return this.readDocument(false, false); }

  private async readDocument(allowUninitialized: boolean, underLock: boolean): Promise<ManagedModelDocument> {
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
        const raw = Buffer.from(bytes.subarray(0, offset));
        const envelope = envelopeSchema.parse(JSON.parse(raw.toString("utf8")));
        const v1 = envelope.format === FORMAT_V1;
        const decipher = createDecipheriv("aes-256-gcm", this.masterKey, strictBase64(envelope.nonce, 12));
        decipher.setAAD(v1 ? AAD_V1 : AAD);
        decipher.setAuthTag(strictBase64(envelope.tag, 16));
        const plaintext = Buffer.concat([decipher.update(strictBase64(envelope.ciphertext)), decipher.final()]);
        try {
          const parsed = JSON.parse(plaintext.toString("utf8")) as unknown;
          const doc = v1 ? convertedDocument(parsed) : checkedDocument(parsed);
          // Only a read under the writer lock decides what the next write must back up; an unlocked read (a view)
          // racing the first v2 write must not bring the old bytes back.
          if (underLock) {
            this.v1Bytes = v1 ? raw : null;
            this.beforeDeepseekBytes = !v1 && !mentionsDeepseek(parsed as { active: unknown; saved: unknown }) ? raw : null;
          }
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
    const plaintext = Buffer.from(JSON.stringify(compactDocument(checkedDocument(structuredClone(doc)))), "utf8");
    try {
      const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const result = Buffer.from(JSON.stringify({ format: FORMAT, nonce: nonce.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: encrypted.toString("base64") }), "utf8");
      if (result.length > MAX_BYTES) throw storageError();
      return result;
    } finally { plaintext.fill(0); }
  }

  /**
   * Writes the document. Over a v1 file, the original v1 bytes are first kept in a backup file of their own (created
   * exclusively, 0600, never overwritten), and only then does the v2 file replace the v1 file atomically. A failure
   * before the rename leaves the v1 file in place, so the previous configuration still opens.
   */
  private async persist(doc: ManagedModelDocument): Promise<void> {
    let next = doc;
    if (this.v1Bytes) {
      await this.keepV1Backup(this.v1Bytes);
      next = { ...doc, audit: [...doc.audit, { action: "format_upgraded" as const, revision: doc.saved.revision, at: new Date().toISOString() }].slice(-50) };
    }
    const bytes = this.serialize(next);
    // The first time DeepSeek reaches a file the release before it can read, that file is kept first (once).
    if (this.beforeDeepseekBytes && mentionsDeepseek(compactDocument(checkedDocument(structuredClone(next))) as { active: unknown; saved: unknown })) {
      await this.keepDeepseekBackup(this.beforeDeepseekBytes);
    }
    await this.atomicWrite(this.file, bytes);
    this.v1Bytes = null;
    this.beforeDeepseekBytes = null;
    this.observedFile = true;
  }

  /**
   * The file from before DeepSeek, kept once. The earliest backup is kept, whatever the live file holds by now, but
   * only if it is intact: a private regular file of this user (0600, one link, no symlink) within the size limit, a
   * v2 envelope that decrypts and authenticates with the master key, and a document the release before DeepSeek reads
   * (no DeepSeek entry or default). A damaged or incompatible backup stops the write: the live file is not replaced
   * and the backup is not overwritten. Without a backup, these bytes are published complete (exclusiveWrite).
   */
  private async keepDeepseekBackup(bytes: Buffer): Promise<void> {
    const target = `${this.file}${DEEPSEEK_BACKUP_SUFFIX}`;
    if (await this.intactDeepseekBackup(target)) return;
    await this.exclusiveWrite(target, bytes);
    // What was published is checked like a backup found later.
    if (!(await this.intactDeepseekBackup(target))) throw storageError();
  }

  /** False when there is no backup; true when it is intact; a storage error for anything else at that name. */
  private async intactDeepseekBackup(target: string): Promise<boolean> {
    try {
      const info = await fs.lstat(target);
      if (info.isSymbolicLink() || !info.isFile()) throw storageError();
    } catch (error) {
      if (codeOf(error) === "ENOENT") return false;
      throw storageError();
    }
    try {
      const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      let raw: Buffer;
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || (process.geteuid && info.uid !== process.geteuid())
          || info.size === 0 || info.size > MAX_BYTES) throw storageError();
        const bytes = Buffer.alloc(info.size + 1);
        let offset = 0;
        while (offset < bytes.length) {
          const chunk = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (!chunk.bytesRead) break;
          offset += chunk.bytesRead;
        }
        if (offset !== info.size) throw storageError();
        raw = Buffer.from(bytes.subarray(0, offset));
      } finally { await handle.close(); }
      const envelope = envelopeSchema.parse(JSON.parse(raw.toString("utf8")));
      if (envelope.format !== FORMAT) throw storageError();
      const decipher = createDecipheriv("aes-256-gcm", this.masterKey, strictBase64(envelope.nonce, 12));
      decipher.setAAD(AAD);
      decipher.setAuthTag(strictBase64(envelope.tag, 16));
      const plaintext = Buffer.concat([decipher.update(strictBase64(envelope.ciphertext)), decipher.final()]);
      try {
        const parsed = JSON.parse(plaintext.toString("utf8")) as { active: unknown; saved: unknown };
        checkedDocument(parsed);
        if (mentionsDeepseek(parsed)) throw storageError();
      } finally { plaintext.fill(0); }
      return true;
    } catch {
      throw storageError();
    }
  }

  /** The kept v1 file. An existing backup is never replaced; it must hold exactly these bytes. */
  private async keepV1Backup(bytes: Buffer): Promise<void> {
    const target = `${this.file}${V1_BACKUP_SUFFIX}`;
    let existing: fs.FileHandle | undefined;
    try { existing = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      if (codeOf(error) !== "ENOENT") throw error;
    }
    if (existing) {
      try {
        const info = await existing.stat();
        if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || (process.geteuid && info.uid !== process.geteuid())
          || info.size !== bytes.length) throw storageError();
        const kept = Buffer.alloc(bytes.length);
        let offset = 0;
        while (offset < kept.length) {
          const chunk = await existing.read(kept, offset, kept.length - offset, offset);
          if (!chunk.bytesRead) break;
          offset += chunk.bytesRead;
        }
        if (offset !== kept.length || !kept.equals(bytes)) throw storageError();
        return;
      } finally { await existing.close(); }
    }
    await this.exclusiveWrite(target, bytes);
  }

  /**
   * Publishes a backup only once it is complete: the bytes go to a private temporary file (exclusive, 0600), are synced,
   * and are then linked to the final name, which never replaces an existing file (EEXIST fails the write). A failure at
   * any point leaves no file at the final name, so the next save writes the backup again.
   */
  private async exclusiveWrite(target: string, bytes: Buffer): Promise<void> {
    await this.checkDirectory();
    const temporary = `${target}.${randomUUID()}.tmp`;
    let created = false;
    try {
      const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created = true;
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally { await handle.close(); }
      await fs.link(temporary, target);
    } finally {
      if (created) await fs.unlink(temporary).catch(() => undefined);
    }
    const directory = await fs.open(dirname(this.file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  }

  /** Names only: what the v1 conversion left out, and whether the original v1 file is kept. */
  async retiredNote(): Promise<{ providers: string[]; retiredDefault: string | null; backupKept: boolean } | null> {
    const doc = await this.read();
    if (!doc.retired) return null;
    let backupKept: boolean;
    try {
      backupKept = (await fs.lstat(`${this.file}${V1_BACKUP_SUFFIX}`)).isFile();
    } catch { backupKept = false; }
    return { providers: [...doc.retired.providers], retiredDefault: doc.retired.retiredDefault, backupKept };
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
        result = await operation(await this.readDocument(allowUninitialized, true));
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

  /**
   * claimDefault: when no default provider is saved and this provider ends up with a key and models, it becomes the
   * default in the same write (the console's "only the Claude key" setup). An existing default is never replaced.
   */
  async updateProvider(key: TitleWritingProviderKey, body: AdminProviderUpdate, options: { claimDefault?: boolean; makeDefault?: boolean } = {}): Promise<void> {
    const parsed = adminProviderUpdateSchema.safeParse(body);
    if (!adminProviderKeySchema.safeParse(key).success || !parsed.success || (parsed.data.baseUrl !== undefined && !validEndpoint(key, parsed.data.baseUrl))) throw inputError();
    const input = parsed.data;
    const workspace = workspaceUpdateOf(input);
    // Only Claude has a workspace; its id must have the documented shape (it becomes a request header).
    if (typeof workspace === "string" && workspace !== "keep" && (key !== "anthropic" || !ANTHROPIC_WORKSPACE_ID_SHAPE.test(workspace))) throw inputError();
    if (key !== "anthropic" && input.workspaceAction !== undefined && input.workspaceAction !== "keep") throw inputError();
    return this.locked(async (doc) => {
      this.assertRevision(doc, input.expectedRevision);
      const provider = doc.saved.providers[key];
      provider.models = [...input.models];
      if (input.baseUrl !== undefined) provider.baseUrl = input.baseUrl;
      if (input.secretAction === "replace") provider.apiKey = input.apiKey!;
      if (input.secretAction === "clear") provider.apiKey = null;
      // DeepSeek without a key keeps nothing and is not the default, so the file returns to the shape the release
      // before it reads.
      if (key === "deepseek" && provider.apiKey === null) {
        provider.models = [];
        if (doc.saved.defaultProvider === "deepseek") doc.saved.defaultProvider = null;
      }
      // A replaced or cleared key drops the previous workspace unless this update names one.
      if (workspace === null) delete provider.workspaceId;
      else if (workspace !== "keep") provider.workspaceId = workspace;
      if (options.claimDefault && doc.saved.defaultProvider === null && provider.apiKey !== null && provider.models.length > 0) {
        doc.saved.defaultProvider = key;
      }
      // makeDefault: the DeepSeek quick setup makes DeepSeek the default for new requests, replacing another default.
      if (options.makeDefault && provider.apiKey !== null && provider.models.length > 0) doc.saved.defaultProvider = key;
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
      // DeepSeek can be the default only while it has a key (its quick setup saves both at once).
      if (limits.defaultProvider === "deepseek" && doc.saved.providers.deepseek.apiKey === null) throw inputError();
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
