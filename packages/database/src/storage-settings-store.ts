import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  storageConfigurationFieldsSchema, storageDraftUpdateSchema,
  type StorageConfigurationView, type StorageDraftUpdate, type StorageSettingsView,
} from "@ai-drama/contracts";
import type { PostgresPool } from "./index";

export interface StorageServerConfiguration extends ReturnType<typeof storageConfigurationFieldsSchema.parse> {
  accessKeyId: string;
  secretAccessKey: string;
}
export interface StorageConfigurationRevision {
  id: string | null;
  source: "environment" | "managed";
  configuration: StorageServerConfiguration;
}
export class StorageSettingsError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); this.name = "StorageSettingsError"; }
}
const failure = () => new StorageSettingsError(503, "STORAGE_SETTINGS_UNAVAILABLE");
const conflict = () => new StorageSettingsError(409, "STORAGE_SETTINGS_CONFLICT");
export const STORAGE_TEST_TTL_MS = 15 * 60 * 1000;
const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const KEY = new RegExp(`^real-media/(${UUID})/(${UUID})/(${UUID})/(${UUID})/[a-f0-9]{64}\\.(png|mp4|wav|vtt)$`);
interface StateRow {
  revision: string | number; legacy_id: string; active_id: string; draft_id: string | null;
  tested_id: string | null; test_status: "not_tested" | "passed" | "failed"; tested_at: Date | null;
}
interface Queryable { query(sql: string, values?: unknown[]): Promise<unknown> }
const rows = <T>(result: unknown): T[] => (result as { rows: T[] }).rows;
const asRevision = (value: number | string): number => {
  const n = Number(value); if (!Number.isSafeInteger(n) || n < 0) throw failure(); return n;
};
const safe = (error: unknown): never => { if (error instanceof StorageSettingsError) throw error; throw failure(); };

/** Authenticated payload contains the configuration, including both credentials; database columns contain no keys. */
export class StorageSettingsCipher {
  readonly #key: Buffer;
  constructor(key: Buffer) { if (key.length !== 32) throw failure(); this.#key = Buffer.from(key); }
  seal(workspaceId: string, id: string, configuration: StorageServerConfiguration): string {
    const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.#key, nonce);
    cipher.setAAD(Buffer.from(`ads.storage.v1:${workspaceId}:${id}`));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(configuration), "utf8"), cipher.final()]);
    return ["v1", nonce.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(".");
  }
  open(workspaceId: string, id: string, ciphertext: string): StorageServerConfiguration {
    try {
      const [version, nonce, tag, bytes, ...rest] = ciphertext.split(".");
      if (version !== "v1" || !nonce || !tag || !bytes || rest.length || ciphertext.length > 8192) throw failure();
      const decode = (value: string, length?: number) => {
        const data = Buffer.from(value, "base64");
        if (data.toString("base64") !== value || (length !== undefined && data.length !== length)) throw failure();
        return data;
      };
      const decipher = createDecipheriv("aes-256-gcm", this.#key, decode(nonce, 12));
      decipher.setAAD(Buffer.from(`ads.storage.v1:${workspaceId}:${id}`)); decipher.setAuthTag(decode(tag, 16));
      const plaintext = Buffer.concat([decipher.update(decode(bytes)), decipher.final()]);
      try {
        const parsed: unknown = JSON.parse(plaintext.toString("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw failure();
        const { accessKeyId, secretAccessKey, ...fields } = parsed as Record<string, unknown>;
        const config = storageConfigurationFieldsSchema.parse(fields);
        if (typeof accessKeyId !== "string" || typeof secretAccessKey !== "string" || !accessKeyId || !secretAccessKey
          || accessKeyId.length > 256 || secretAccessKey.length > 256) throw failure();
        return { ...config, accessKeyId, secretAccessKey };
      } finally { plaintext.fill(0); }
    } catch { throw failure(); }
  }
}
export function storageConfigurationView(value: StorageConfigurationRevision): StorageConfigurationView {
  const c = value.configuration;
  return { id: value.id, provider: c.provider, endpoint: c.endpoint, region: c.region, bucket: c.bucket,
    prefix: c.prefix, forcePathStyle: c.forcePathStyle, hasCredentials: Boolean(c.accessKeyId && c.secretAccessKey), source: value.source };
}

/** Database is the shared API/Worker authority. No process-local active pointer or routing cache. */
export class StorageSettingsStore {
  private readonly cipher: StorageSettingsCipher;
  constructor(private readonly pool: PostgresPool, readonly workspaceId: string, key: Buffer,
    private readonly legacy: StorageServerConfiguration, private readonly now: () => number = Date.now) {
    this.cipher = new StorageSettingsCipher(key);
  }
  async assertReady(): Promise<void> {
    try {
      await this.pool.query("SELECT revision, legacy_id, active_id, draft_id, tested_id, test_status, tested_at FROM storage_settings_state LIMIT 0");
      await this.pool.query("SELECT encrypted_configuration FROM storage_configuration_revision LIMIT 0");
      await this.pool.query("SELECT configuration_id FROM storage_object_binding LIMIT 0");
      await this.pool.query("SELECT action FROM storage_settings_audit LIMIT 0");
    } catch { throw failure(); }
  }
  private async state(client: Queryable): Promise<StateRow | null> {
    return rows<StateRow>(await client.query("SELECT * FROM storage_settings_state WHERE workspace_id=$1", [this.workspaceId]))[0] ?? null;
  }
  private async config(client: Queryable, id: string): Promise<StorageConfigurationRevision> {
    const row = rows<{ id: string; source: "environment" | "managed"; encrypted_configuration: string }>(await client.query(
      "SELECT id,source,encrypted_configuration FROM storage_configuration_revision WHERE workspace_id=$1 AND id=$2", [this.workspaceId, id]))[0];
    if (!row) throw failure();
    return { id: row.id, source: row.source, configuration: this.cipher.open(this.workspaceId, row.id, row.encrypted_configuration) };
  }
  private async insertConfig(client: Queryable, configuration: StorageServerConfiguration, source: "environment" | "managed"): Promise<string> {
    const id = randomUUID();
    await client.query("INSERT INTO storage_configuration_revision(id,workspace_id,source,encrypted_configuration) VALUES($1,$2,$3,$4)",
      [id, this.workspaceId, source, this.cipher.seal(this.workspaceId, id, configuration)]);
    return id;
  }
  private async ensureState(client: Queryable): Promise<StateRow> {
    const state = await this.state(client); if (state) return state;
    const legacyId = await this.insertConfig(client, this.legacy, "environment");
    await client.query("INSERT INTO storage_settings_state(workspace_id,legacy_id,active_id) VALUES($1,$2,$2)", [this.workspaceId, legacyId]);
    return (await this.state(client))!;
  }
  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect(); await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`storage-settings:${this.workspaceId}`]);
      const result = await work(client); await client.query("COMMIT"); return result;
    } catch (error) { if (client) await client.query("ROLLBACK").catch(() => undefined); return safe(error); }
    finally { client?.release(); }
  }
  private expect(state: StateRow, expected: number): void { if (asRevision(state.revision) !== expected) throw conflict(); }
  private async audit(client: Queryable, revision: number, action: string): Promise<void> {
    await client.query("INSERT INTO storage_settings_audit(workspace_id,revision,action) VALUES($1,$2,$3)", [this.workspaceId, revision, action]);
  }
  async view(): Promise<StorageSettingsView> {
    // One read-only transaction yields a consistent state and immutable configs even during activation.
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect(); await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const state = await this.state(client);
      const active = state ? await this.config(client, state.active_id) : { id: null, source: "environment" as const, configuration: this.legacy };
      const draft = state?.draft_id ? await this.config(client, state.draft_id) : null;
      const testedAt = state?.tested_at ? new Date(state.tested_at).toISOString() : null;
      const expiresAt = state?.test_status === "passed" && state.tested_at ? new Date(new Date(state.tested_at).getTime() + STORAGE_TEST_TTL_MS).toISOString() : null;
      const result: StorageSettingsView = { revision: state ? asRevision(state.revision) : 0, active: storageConfigurationView(active),
        draft: draft ? storageConfigurationView(draft) : null,
        test: { status: state?.test_status ?? "not_tested", testedAt, expiresAt }, managed: active.source === "managed" };
      await client.query("COMMIT"); return result;
    } catch (error) { if (client) await client.query("ROLLBACK").catch(() => undefined); return safe(error); }
    finally { client?.release(); }
  }
  async save(input: StorageDraftUpdate, validate: (configuration: StorageServerConfiguration) => void): Promise<void> {
    const parsed = storageDraftUpdateSchema.safeParse(input);
    if (!parsed.success) throw new StorageSettingsError(400, "STORAGE_SETTINGS_INVALID");
    await this.transaction(async client => {
      const state = await this.ensureState(client); this.expect(state, parsed.data.expectedRevision);
      const prior = await this.config(client, state.draft_id ?? state.active_id);
      const { expectedRevision: _revision, secretAction, accessKeyId, secretAccessKey, ...fields } = parsed.data;
      if (secretAction === "keep" && prior.configuration.provider !== fields.provider) throw new StorageSettingsError(400, "STORAGE_SETTINGS_CREDENTIALS_REQUIRED");
      const configuration: StorageServerConfiguration = { ...fields,
        prefix: fields.prefix.replace(/\/$/, ""),
        accessKeyId: secretAction === "replace" ? accessKeyId! : prior.configuration.accessKeyId,
        secretAccessKey: secretAction === "replace" ? secretAccessKey! : prior.configuration.secretAccessKey };
      validate(configuration);
      const id = await this.insertConfig(client, configuration, "managed"), revision = asRevision(state.revision) + 1;
      await client.query("UPDATE storage_settings_state SET revision=$2,draft_id=$3,tested_id=NULL,test_status='not_tested',tested_at=NULL,updated_at=now() WHERE workspace_id=$1", [this.workspaceId, revision, id]);
      await this.audit(client, revision, "saved");
    });
  }
  async draftForTest(expectedRevision: number): Promise<StorageConfigurationRevision> {
    return this.transaction(async client => {
      const state = await this.state(client); if (!state) throw conflict(); this.expect(state, expectedRevision);
      if (!state.draft_id) throw new StorageSettingsError(400, "STORAGE_SETTINGS_DRAFT_REQUIRED");
      return this.config(client, state.draft_id);
    });
  }
  async recordTest(expectedRevision: number, configurationId: string, passed: boolean): Promise<void> {
    await this.transaction(async client => {
      const state = await this.state(client); if (!state) throw conflict(); this.expect(state, expectedRevision);
      if (state.draft_id !== configurationId) throw conflict();
      const revision = asRevision(state.revision) + 1;
      await client.query("UPDATE storage_settings_state SET revision=$2,tested_id=$3,test_status=$4,tested_at=$5,updated_at=now() WHERE workspace_id=$1",
        [this.workspaceId, revision, configurationId, passed ? "passed" : "failed", new Date(this.now())]);
      await this.audit(client, revision, passed ? "tested_passed" : "tested_failed");
    });
  }
  async activate(expectedRevision: number): Promise<void> {
    await this.transaction(async client => {
      const state = await this.state(client); if (!state) throw conflict(); this.expect(state, expectedRevision);
      if (!state.draft_id || state.tested_id !== state.draft_id || state.test_status !== "passed" || !state.tested_at
        || this.now() - new Date(state.tested_at).getTime() > STORAGE_TEST_TTL_MS || this.now() < new Date(state.tested_at).getTime()) {
        throw new StorageSettingsError(409, "STORAGE_SETTINGS_TEST_REQUIRED");
      }
      if (state.active_id === state.draft_id) return;
      const revision = asRevision(state.revision) + 1;
      await client.query("UPDATE storage_settings_state SET revision=$2,active_id=draft_id,updated_at=now() WHERE workspace_id=$1", [this.workspaceId, revision]);
      await this.audit(client, revision, "activated");
    });
  }
  private key(key: string): void { const match = KEY.exec(key); if (!match || match[1] !== this.workspaceId) throw new StorageSettingsError(400, "STORAGE_OBJECT_KEY_INVALID"); }
  /** Reserve before PUT, under the same lock as activation; a failed PUT retries on its original immutable target. */
  async reserve(key: string): Promise<StorageConfigurationRevision> {
    this.key(key);
    return this.transaction(async client => {
      const state = await this.ensureState(client);
      const existing = rows<{ configuration_id: string }>(await client.query("SELECT configuration_id FROM storage_object_binding WHERE workspace_id=$1 AND object_key=$2", [this.workspaceId, key]))[0];
      if (existing) return this.config(client, existing.configuration_id);
      const legacyAsset = rows(await client.query("SELECT 1 FROM asset WHERE workspace_id=$1 AND storage_provider='s3' AND object_key=$2 LIMIT 1", [this.workspaceId, key])).length > 0;
      const id = legacyAsset ? state.legacy_id : state.active_id;
      await client.query("INSERT INTO storage_object_binding(workspace_id,object_key,configuration_id) VALUES($1,$2,$3)", [this.workspaceId, key, id]);
      return this.config(client, id);
    });
  }
  async resolve(key: string): Promise<StorageConfigurationRevision> {
    this.key(key);
    try {
      const binding = rows<{ configuration_id: string }>(await this.pool.query("SELECT configuration_id FROM storage_object_binding WHERE workspace_id=$1 AND object_key=$2", [this.workspaceId, key]))[0];
      if (binding) return this.config(this.pool, binding.configuration_id);
      const state = await this.state(this.pool);
      return state ? this.config(this.pool, state.legacy_id) : { id: null, source: "environment", configuration: structuredClone(this.legacy) };
    } catch (error) { return safe(error); }
  }
}

export interface StorageSettingsEnvironment {
  STORAGE_SETTINGS_ENABLED?: string;
  STORAGE_SETTINGS_KEY?: string;
  STORAGE_SETTINGS_ALLOWED_ENDPOINTS?: string;
}
export function storageSettingsOptions(env: StorageSettingsEnvironment): { enabled: boolean; key: Buffer | null; allowedEndpoints: string[] } {
  if (env.STORAGE_SETTINGS_ENABLED !== undefined && !["true", "false"].includes(env.STORAGE_SETTINGS_ENABLED)) throw failure();
  const enabled = env.STORAGE_SETTINGS_ENABLED === "true";
  const value = env.STORAGE_SETTINGS_KEY;
  const key = value ? Buffer.from(value, "base64") : null;
  if ((enabled && !key) || (key && (key.length !== 32 || key.toString("base64") !== value))) throw failure();
  const allowedEndpoints = (env.STORAGE_SETTINGS_ALLOWED_ENDPOINTS ?? "").split(",").map(v => v.trim()).filter(Boolean);
  if (allowedEndpoints.length > 20 || allowedEndpoints.some(value => {
    try { const url = new URL(value); return url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash; }
    catch { return true; }
  })) throw failure();
  return { enabled, key, allowedEndpoints };
}

/** Once any routing is persisted, disabling the console cannot silently revert historical reads or new writes. */
export async function openStorageSettingsStore(pool: PostgresPool, workspaceId: string, env: StorageSettingsEnvironment,
  legacy: StorageServerConfiguration): Promise<StorageSettingsStore | null> {
  const options = storageSettingsOptions(env);
  if (!options.key) {
    try {
      const exists = rows<{ present: boolean }>(await pool.query("SELECT to_regclass('storage_settings_state') IS NOT NULL AS present"))[0]?.present;
      if (exists && rows(await pool.query("SELECT 1 FROM storage_settings_state WHERE workspace_id=$1", [workspaceId])).length) throw failure();
      return null;
    } catch { throw failure(); }
  }
  const store = new StorageSettingsStore(pool, workspaceId, options.key, legacy);
  await store.assertReady(); await store.view();
  return store;
}
