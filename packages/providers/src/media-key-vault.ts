import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { z } from "zod";
import {
  MEDIA_KEY_SLOTS,
  adminMediaKeyUpdateSchema,
  type AdminMediaKeyUpdate,
  type MediaKeySlot,
} from "@ai-drama/contracts";
import type { RealMediaEnvironment } from "./real-media-runtime";

/**
 * Sibling encrypted vault for the three official media API keys.
 * Path: `<dirname(MODEL_ADMIN_CONFIG_PATH)>/media-keys.enc`, same MODEL_ADMIN_MASTER_KEY as writing models.
 * Per-slot managed flag: never-managed slots may fall back to process env; managed clear never falls back.
 */
const FORMAT = "ai-drama-studio.media-key-vault.v1";
const AAD = Buffer.from(FORMAT, "utf8");
const INITIALIZED = Buffer.from(`${FORMAT}.initialized\n`, "utf8");
const MAX_BYTES = 64 * 1024;
const SECRET_SCHEMA = z.string().min(8).max(512).regex(/^\S+$/u).nullable();
const revisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const slotSchema = z
  .object({
    managed: z.boolean(),
    apiKey: SECRET_SCHEMA,
  })
  .strict()
  .superRefine((value, ctx) => {
    // Unmanaged slots must not carry a vault secret (env is the only source until first admin save).
    if (!value.managed && value.apiKey !== null) {
      ctx.addIssue({ code: "custom", path: ["apiKey"], message: "Unmanaged slot cannot store a key" });
    }
  });
const settingsSchema = z
  .object({
    revision: revisionSchema,
    slots: z
      .object({
        OPENAI_MEDIA_API_KEY: slotSchema,
        DASHSCOPE_MEDIA_API_KEY: slotSchema,
        MINIMAX_API_KEY: slotSchema,
      })
      .strict(),
  })
  .strict();
const documentSchema = z
  .object({
    saved: settingsSchema,
    audit: z
      .array(
        z
          .object({
            at: z.string().datetime(),
            action: z.literal("slot_updated"),
            slot: z.enum(MEDIA_KEY_SLOTS),
            revision: revisionSchema,
          })
          .strict(),
      )
      .max(50),
  })
  .strict();
const envelopeSchema = z
  .object({
    format: z.literal(FORMAT),
    nonce: z.string(),
    tag: z.string(),
    ciphertext: z.string(),
  })
  .strict();

export interface ManagedMediaKeySlot {
  /** Once true (including after clear), process env is never used for this slot. */
  managed: boolean;
  apiKey: string | null;
}
export interface ManagedMediaKeys {
  revision: number;
  slots: Record<MediaKeySlot, ManagedMediaKeySlot>;
}
/** Server-only document. Never serialize into an HTTP response or log. */
export interface ManagedMediaKeyDocument {
  saved: ManagedMediaKeys;
  audit: Array<{ at: string; action: "slot_updated"; slot: MediaKeySlot; revision: number }>;
}

export class MediaKeyConfigError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MediaKeyConfigError";
  }
}

function storageError(): MediaKeyConfigError {
  return new MediaKeyConfigError(503, "ADMIN_CONFIG_STORAGE_UNAVAILABLE", "媒体密钥存储不可用，请联系管理员。");
}
function inputError(): MediaKeyConfigError {
  return new MediaKeyConfigError(400, "ADMIN_CONFIG_INVALID", "媒体密钥格式不正确。");
}
function codeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}
function strictBase64(value: string, size?: number): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw storageError();
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value || (size !== undefined && decoded.length !== size)) throw storageError();
  return decoded;
}

export function emptyManagedMediaKeys(): ManagedMediaKeys {
  return {
    revision: 0,
    slots: {
      OPENAI_MEDIA_API_KEY: { managed: false, apiKey: null },
      DASHSCOPE_MEDIA_API_KEY: { managed: false, apiKey: null },
      MINIMAX_API_KEY: { managed: false, apiKey: null },
    },
  };
}

function checkedDocument(input: unknown): ManagedMediaKeyDocument {
  const result = documentSchema.safeParse(input);
  if (!result.success) throw storageError();
  return result.data;
}

/** Sibling of models.enc in the same private directory. */
export function mediaKeyVaultPath(modelAdminConfigPath: string): string {
  if (!isAbsolute(modelAdminConfigPath)) throw storageError();
  return join(dirname(resolve(modelAdminConfigPath)), "media-keys.enc");
}

/**
 * Explicit projection: a managed slot replaces or clears the env value; an unmanaged slot leaves the env alone.
 * Managed clear never falls back to a stale environment secret.
 */
export function applyManagedMediaKeys(
  environment: RealMediaEnvironment,
  managed: ManagedMediaKeys | null | undefined,
): RealMediaEnvironment {
  if (!managed) return { ...environment };
  const result: RealMediaEnvironment = { ...environment };
  for (const slot of MEDIA_KEY_SLOTS) {
    const entry = managed.slots[slot];
    if (!entry.managed) continue;
    if (entry.apiKey === null) delete result[slot];
    else result[slot] = entry.apiKey;
  }
  return result;
}

/** Effective presence for probes: managed key, or unmanaged env fallback. */
export function mediaKeyPresent(managed: ManagedMediaKeys | null | undefined, slot: MediaKeySlot, environment: RealMediaEnvironment): boolean {
  const entry = managed?.slots[slot];
  if (entry?.managed) return entry.apiKey !== null;
  const value = environment[slot];
  return typeof value === "string" && value.length >= 8 && value.length <= 512 && !/\s/.test(value);
}

/**
 * Single-host encrypted media-key vault. Same POSIX rules as the writing-model vault.
 * Hot reload: callers re-read after save; there is no separate active/saved lag for media keys.
 */
export class MediaKeyVault {
  private readonly masterKey: Buffer;
  private readonly file: string;
  private readonly initial: ManagedMediaKeyDocument;
  private observedFile = false;
  private queue: Promise<void> = Promise.resolve();

  private constructor(options: { path: string; masterKey: Buffer }) {
    this.file = resolve(options.path);
    this.masterKey = Buffer.from(options.masterKey);
    this.initial = checkedDocument({ saved: emptyManagedMediaKeys(), audit: [] });
  }

  static async open(options: { path: string; masterKey: Buffer }): Promise<MediaKeyVault> {
    try {
      if (process.platform === "win32" || !isAbsolute(options.path) || options.masterKey.length !== 32) throw storageError();
      const vault = new MediaKeyVault(options);
      await vault.locked(async (doc) => {
        if (!vault.observedFile) await vault.persist(doc);
        if (!(await vault.markerPresent())) await vault.atomicWrite(`${vault.file}.initialized`, INITIALIZED);
      }, true);
      await vault.read();
      return vault;
    } catch {
      throw storageError();
    }
  }

  private async checkDirectory(): Promise<void> {
    const directory = dirname(this.file);
    if ((await fs.realpath(directory)) !== directory) throw storageError();
    let current = directory;
    while (true) {
      const info = await fs.lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw storageError();
      if (current === directory && ((info.mode & 0o777) !== 0o700 || (process.geteuid && info.uid !== process.geteuid()))) {
        throw storageError();
      }
      const parent = dirname(current);
      if (parent === current || current === sep) break;
      current = parent;
    }
  }

  private async markerPresent(): Promise<boolean> {
    let marker: fs.FileHandle;
    try {
      marker = await fs.open(`${this.file}.initialized`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      if (codeOf(error) === "ENOENT") return false;
      throw error;
    }
    try {
      const info = await marker.stat();
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        (info.mode & 0o777) !== 0o600 ||
        (process.geteuid && info.uid !== process.geteuid()) ||
        info.size !== INITIALIZED.length
      ) {
        throw storageError();
      }
      const bytes = Buffer.alloc(INITIALIZED.length + 1);
      const { bytesRead } = await marker.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== INITIALIZED.length || !bytes.subarray(0, bytesRead).equals(INITIALIZED)) throw storageError();
      return true;
    } finally {
      await marker.close();
    }
  }

  async read(): Promise<ManagedMediaKeyDocument> {
    return this.readDocument(false);
  }

  private async readDocument(allowUninitialized: boolean): Promise<ManagedMediaKeyDocument> {
    try {
      await this.checkDirectory();
      const initialized = await this.markerPresent();
      if (!initialized && !allowUninitialized) throw storageError();
      let handle: fs.FileHandle;
      try {
        handle = await fs.open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      } catch (error) {
        if (codeOf(error) === "ENOENT" && allowUninitialized && !initialized && !this.observedFile) {
          return structuredClone(this.initial);
        }
        throw error;
      }
      try {
        const info = await handle.stat();
        if (
          !info.isFile() ||
          info.nlink !== 1 ||
          (info.mode & 0o777) !== 0o600 ||
          (process.geteuid && info.uid !== process.geteuid()) ||
          info.size > MAX_BYTES
        ) {
          throw storageError();
        }
        const bytes = Buffer.alloc(MAX_BYTES + 1);
        let offset = 0;
        while (offset < bytes.length) {
          const chunk = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (!chunk.bytesRead) break;
          offset += chunk.bytesRead;
        }
        if (offset > MAX_BYTES) throw storageError();
        const envelope = envelopeSchema.parse(JSON.parse(Buffer.from(bytes.subarray(0, offset)).toString("utf8")));
        const decipher = createDecipheriv("aes-256-gcm", this.masterKey, strictBase64(envelope.nonce, 12));
        decipher.setAAD(AAD);
        decipher.setAuthTag(strictBase64(envelope.tag, 16));
        const plaintext = Buffer.concat([decipher.update(strictBase64(envelope.ciphertext)), decipher.final()]);
        try {
          const doc = checkedDocument(JSON.parse(plaintext.toString("utf8")));
          this.observedFile = true;
          return doc;
        } finally {
          plaintext.fill(0);
        }
      } finally {
        await handle.close();
      }
    } catch {
      throw storageError();
    }
  }

  private serialize(doc: ManagedMediaKeyDocument): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.masterKey, nonce);
    cipher.setAAD(AAD);
    const plaintext = Buffer.from(JSON.stringify(checkedDocument(structuredClone(doc))), "utf8");
    try {
      const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const result = Buffer.from(
        JSON.stringify({
          format: FORMAT,
          nonce: nonce.toString("base64"),
          tag: cipher.getAuthTag().toString("base64"),
          ciphertext: encrypted.toString("base64"),
        }),
        "utf8",
      );
      if (result.length > MAX_BYTES) throw storageError();
      return result;
    } finally {
      plaintext.fill(0);
    }
  }

  private async persist(doc: ManagedMediaKeyDocument): Promise<void> {
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
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      if (temporaryCreated) await fs.unlink(temporary).catch(() => undefined);
    }
  }

  private async locked<T>(operation: (doc: ManagedMediaKeyDocument) => Promise<T>, allowUninitialized = false): Promise<T> {
    const run = this.queue.then(async () => {
      let lock: fs.FileHandle | undefined;
      let result!: T;
      let failure: MediaKeyConfigError | undefined;
      const lockPath = `${this.file}.lock`;
      try {
        await this.checkDirectory();
        try {
          lock = await fs.open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        } catch (error) {
          if (codeOf(error) === "EEXIST") {
            throw new MediaKeyConfigError(409, "ADMIN_CONFIG_BUSY", "媒体密钥正在保存，请重新读取后再试。");
          }
          throw error;
        }
        await lock.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
        await lock.sync();
        result = await operation(await this.readDocument(allowUninitialized));
      } catch (error) {
        failure = error instanceof MediaKeyConfigError ? error : storageError();
      }
      if (lock) {
        try {
          await lock.close();
          await fs.unlink(lockPath);
        } catch {
          failure ??= storageError();
        }
      }
      if (failure) throw failure;
      return result;
    });
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async updateSlot(body: AdminMediaKeyUpdate): Promise<ManagedMediaKeyDocument> {
    const parsed = adminMediaKeyUpdateSchema.safeParse(body);
    if (!parsed.success) throw inputError();
    const input = parsed.data;
    return this.locked(async (doc) => {
      if (doc.saved.revision !== input.expectedRevision) {
        throw new MediaKeyConfigError(409, "ADMIN_CONFIG_CONFLICT", "媒体密钥已更新，请重新读取后再保存。");
      }
      if (input.expectedRevision === Number.MAX_SAFE_INTEGER) throw storageError();
      const slot = doc.saved.slots[input.slot];
      if (input.secretAction === "replace") {
        slot.managed = true;
        slot.apiKey = input.apiKey!;
      } else if (input.secretAction === "clear") {
        slot.managed = true;
        slot.apiKey = null;
      }
      // keep: leave slot as-is (still bumps revision so CAS advances and clients resync).
      doc.saved.revision += 1;
      doc.audit = [
        ...doc.audit,
        { action: "slot_updated" as const, slot: input.slot, revision: doc.saved.revision, at: new Date().toISOString() },
      ].slice(-50);
      await this.persist(doc);
      return structuredClone(doc);
    });
  }
}
