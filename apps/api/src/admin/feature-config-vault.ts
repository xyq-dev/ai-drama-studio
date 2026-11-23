import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { FEATURE_KEYS, FEATURE_VENDOR_KEYS, type FeatureDraftStatus, type FeatureKey, type FeatureVendor } from "@ai-drama/contracts";

/**
 * Encrypted per-feature drafts. Sibling of models.enc, same MODEL_ADMIN_MASTER_KEY.
 * Credential bytes live only in this file. Call records are a different file and must not be written here.
 */
const FORMAT = "ai-drama-studio.feature-config.v1";
const AAD = Buffer.from(FORMAT, "utf8");
const MAX_BYTES = 256 * 1024;
const SECRET = z.string().min(8).max(512).regex(/^\S+$/u);
const revisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const slotSchema = z.object({
  model: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/).nullable(),
  credentialRef: z.string().regex(/^fc_[A-Za-z0-9_-]{8,80}$/).nullable(),
  draftStatus: z.enum(["blank", "saved", "testing", "passed", "failed", "unknown"]),
  testToken: z.string().regex(/^[A-Za-z0-9_-]{16,80}$/).nullable(),
  testedFingerprint: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  failureMessage: z.string().max(400).nullable(),
  updatedAt: z.string().datetime().nullable(),
}).strict();
const liveSchema = z.object({
  versionId: z.string().regex(/^ver_[A-Za-z0-9_-]{8,80}$/),
  vendor: z.enum(FEATURE_VENDOR_KEYS),
  model: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
  credentialRef: z.string().regex(/^fc_[A-Za-z0-9_-]{8,80}$/),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const featureSchema = z.object({
  live: liveSchema.nullable(),
  /** The enabled version replaced by the latest enable. Absent on files written before rollback existed. */
  previousLive: liveSchema.nullable().optional(),
  slots: z.partialRecord(z.enum(FEATURE_VENDOR_KEYS), slotSchema),
}).strict();
const documentSchema = z.object({
  revision: revisionSchema,
  features: z.object({ writing: featureSchema, storyboard: featureSchema, voice: featureSchema }).strict(),
  credentials: z.record(z.string().regex(/^fc_[A-Za-z0-9_-]{8,80}$/), SECRET),
}).strict();
const envelopeSchema = z.object({
  format: z.literal(FORMAT),
  nonce: z.string(),
  tag: z.string(),
  ciphertext: z.string(),
}).strict();

export interface FeatureSlotRecord {
  model: string | null;
  credentialRef: string | null;
  draftStatus: FeatureDraftStatus;
  testToken: string | null;
  testedFingerprint: string | null;
  failureMessage: string | null;
  updatedAt: string | null;
}
export interface FeatureLiveRecord {
  versionId: string;
  vendor: FeatureVendor;
  model: string;
  credentialRef: string;
  fingerprint: string;
}
export interface FeatureRecord {
  live: FeatureLiveRecord | null;
  previousLive?: FeatureLiveRecord | null;
  slots: Partial<Record<FeatureVendor, FeatureSlotRecord>>;
}
export interface FeatureVaultDocument {
  revision: number;
  features: Record<FeatureKey, FeatureRecord>;
  credentials: Record<string, string>;
}

export class FeatureVaultError extends Error {
  constructor(readonly status: number, readonly code: "ADMIN_CONFIG_CONFLICT" | "ADMIN_CONFIG_BUSY" | "ADMIN_CONFIG_STORAGE_UNAVAILABLE" | "ADMIN_CONFIG_INVALID") {
    super(code);
    this.name = "FeatureVaultError";
  }
}

function emptyFeature(): FeatureRecord {
  return { live: null, slots: {} };
}

export function emptyFeatureVault(): FeatureVaultDocument {
  return {
    revision: 0,
    features: { writing: emptyFeature(), storyboard: emptyFeature(), voice: emptyFeature() },
    credentials: {},
  };
}

export function featureVaultPath(modelAdminConfigPath: string): string {
  if (!isAbsolute(modelAdminConfigPath)) throw new FeatureVaultError(503, "ADMIN_CONFIG_STORAGE_UNAVAILABLE");
  return join(dirname(resolve(modelAdminConfigPath)), "feature-config.enc");
}

function codeOf(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
}

function strictBase64(value: string, bytes?: number): Buffer {
  const decoded = Buffer.from(value, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== value || (bytes !== undefined && decoded.length !== bytes)) {
    throw new FeatureVaultError(503, "ADMIN_CONFIG_STORAGE_UNAVAILABLE");
  }
  return decoded;
}

export class FeatureConfigVault {
  private queue: Promise<void> = Promise.resolve();
  private observed = false;

  private constructor(
    private readonly file: string,
    private readonly masterKey: Buffer,
  ) {}

  static async open(options: { path: string; masterKey: Buffer }): Promise<FeatureConfigVault> {
    if (!isAbsolute(options.path) || options.masterKey.length !== 32) throw new FeatureVaultError(503, "ADMIN_CONFIG_STORAGE_UNAVAILABLE");
    const vault = new FeatureConfigVault(options.path, options.masterKey);
    await vault.checkDirectory();
    return vault;
  }

  async read(): Promise<FeatureVaultDocument> {
    return this.locked(async (doc) => structuredClone(doc), true);
  }

  async update(mutate: (doc: FeatureVaultDocument) => void, expectedRevision: number): Promise<FeatureVaultDocument> {
    // A missing file is an empty vault. The first save creates it; a file that disappears after it was read is an error.
    return this.locked(async (doc) => {
      if (doc.revision !== expectedRevision) throw new FeatureVaultError(409, "ADMIN_CONFIG_CONFLICT");
      if (doc.revision === Number.MAX_SAFE_INTEGER) throw new FeatureVaultError(503, "ADMIN_CONFIG_STORAGE_UNAVAILABLE");
      mutate(doc);
      doc.revision += 1;
      const checked = documentSchema.parse(doc);
      await this.persist(checked);
      return structuredClone(checked);
    }, true);
  }

  private async checkDirectory(): Promise<void> {
    const directory = dirname(this.file);
    let info: Awaited<ReturnType<typeof fs.stat>>;
    try { info = await fs.stat(directory); } catch { throw new FeatureVaultError(503, "ADMIN_CONFIG_STORAGE_UNAVAILABLE"); }
    if (!info.isDirectory() || (info.mode & 0o777) !== 0o700) throw new FeatureVaultError(503, "ADMIN_CONFIG_STORAGE_UNAVAILABLE");
  }

  private async readDocument(allowMissing: boolean): Promise<FeatureVaultDocument> {
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (codeOf(error) === "ENOENT" && allowMissing && !this.observed) return emptyFeatureVault();
      throw new FeatureVaultError(503, "ADMIN_CONFIG_STORAGE_UNAVAILABLE");
    }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.size > MAX_BYTES) {
        throw new FeatureVaultError(503, "ADMIN_CONFIG_STORAGE_UNAVAILABLE");
      }
      const bytes = Buffer.alloc(info.size);
      await handle.read(bytes, 0, info.size, 0);
      const envelope = envelopeSchema.parse(JSON.parse(bytes.toString("utf8")));
      const decipher = createDecipheriv("aes-256-gcm", this.masterKey, strictBase64(envelope.nonce, 12));
      decipher.setAAD(AAD);
      decipher.setAuthTag(strictBase64(envelope.tag, 16));
      const plaintext = Buffer.concat([decipher.update(strictBase64(envelope.ciphertext)), decipher.final()]);
      try {
        const doc = documentSchema.parse(JSON.parse(plaintext.toString("utf8")));
        for (const feature of FEATURE_KEYS) {
          if (!doc.features[feature]) throw new FeatureVaultError(503, "ADMIN_CONFIG_STORAGE_UNAVAILABLE");
        }
        this.observed = true;
        return doc;
      } finally {
        plaintext.fill(0);
      }
    } catch (error) {
      if (error instanceof FeatureVaultError) throw error;
      throw new FeatureVaultError(503, "ADMIN_CONFIG_STORAGE_UNAVAILABLE");
    } finally {
      await handle.close();
    }
  }

  private serialize(doc: FeatureVaultDocument): Buffer {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.masterKey, nonce);
    cipher.setAAD(AAD);
    const plaintext = Buffer.from(JSON.stringify(documentSchema.parse(structuredClone(doc))), "utf8");
    try {
      const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const result = Buffer.from(JSON.stringify({
        format: FORMAT,
        nonce: nonce.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: encrypted.toString("base64"),
      }), "utf8");
      if (result.length > MAX_BYTES) throw new FeatureVaultError(503, "ADMIN_CONFIG_STORAGE_UNAVAILABLE");
      return result;
    } finally {
      plaintext.fill(0);
    }
  }

  private async persist(doc: FeatureVaultDocument): Promise<void> {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    let handle: fs.FileHandle | undefined;
    try {
      await this.checkDirectory();
      handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(this.serialize(doc));
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(temporary, this.file);
      this.observed = true;
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      await fs.unlink(temporary).catch(() => undefined);
    }
  }

  private async locked<T>(operation: (doc: FeatureVaultDocument) => Promise<T>, allowMissing = false): Promise<T> {
    const run = this.queue.then(async () => {
      const lockPath = `${this.file}.lock`;
      let lock: fs.FileHandle | undefined;
      try {
        await this.checkDirectory();
        try {
          lock = await fs.open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        } catch (error) {
          if (codeOf(error) === "EEXIST") throw new FeatureVaultError(409, "ADMIN_CONFIG_BUSY");
          throw new FeatureVaultError(503, "ADMIN_CONFIG_STORAGE_UNAVAILABLE");
        }
        const result = await operation(await this.readDocument(allowMissing));
        await lock.close();
        lock = undefined;
        await fs.unlink(lockPath);
        return result;
      } catch (error) {
        if (lock) {
          await lock.close().catch(() => undefined);
          await fs.unlink(lockPath).catch(() => undefined);
        }
        if (error instanceof FeatureVaultError) throw error;
        if (error instanceof Error && error.name === "FeatureConfigError") throw error;
        throw new FeatureVaultError(503, "ADMIN_CONFIG_STORAGE_UNAVAILABLE");
      }
    });
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }
}
