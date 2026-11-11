import { describe, expect, it } from "vitest";
import { StorageSettingsCipher, storageConfigurationView, storageSettingsOptions, type StorageServerConfiguration } from "./storage-settings-store";
import { storageDraftUpdateSchema, storageSettingsViewSchema } from "@ai-drama/contracts";
const config: StorageServerConfiguration = { provider: "oss", endpoint: "https://oss-cn-hangzhou.aliyuncs.com", region: "cn-hangzhou", bucket: "synthetic-bucket", prefix: "drama", forcePathStyle: false, accessKeyId: "synthetic-access-id", secretAccessKey: "synthetic-secret-never-public" };
describe("storage settings credential boundary", () => {
  it("encrypts both credentials with a random nonce and authenticates revision and workspace", () => {
    const cipher = new StorageSettingsCipher(Buffer.alloc(32, 7));
    const encrypted = cipher.seal("workspace", "revision", config);
    expect(cipher.open("workspace", "revision", encrypted)).toEqual(config);
    expect(cipher.seal("workspace", "revision", config)).not.toBe(encrypted);
    expect(encrypted).not.toContain(config.accessKeyId); expect(encrypted).not.toContain(config.secretAccessKey);
    expect(() => cipher.open("other", "revision", encrypted)).toThrow("STORAGE_SETTINGS_UNAVAILABLE");
    expect(() => cipher.open("workspace", "other", encrypted)).toThrow("STORAGE_SETTINGS_UNAVAILABLE");
    expect(() => new StorageSettingsCipher(Buffer.alloc(32, 8)).open("workspace", "revision", encrypted)).toThrow();
    const parts = encrypted.split("."); parts[3] = Buffer.from("tampered").toString("base64");
    expect(() => cipher.open("workspace", "revision", parts.join("."))).toThrow();
  });
  it("has an exact public projection that rejects secret fields even on successful responses", () => {
    const active = storageConfigurationView({ id: null, source: "environment", configuration: config });
    const view = { revision: 0, active, draft: null, managed: false, test: { status: "not_tested", testedAt: null, expiresAt: null } };
    expect(storageSettingsViewSchema.safeParse(view).success).toBe(true);
    expect(JSON.stringify(view)).not.toContain(config.accessKeyId); expect(JSON.stringify(view)).not.toContain(config.secretAccessKey);
    expect(storageSettingsViewSchema.safeParse({ ...view, active: { ...active, secretAccessKey: "leak" } }).success).toBe(false);
  });
  it("requires complete replacement or a clean keep and refuses path traversal", () => {
    const { accessKeyId, secretAccessKey, ...fields } = config;
    expect(storageDraftUpdateSchema.safeParse({ ...fields, expectedRevision: 0, secretAction: "keep" }).success).toBe(true);
    expect(storageDraftUpdateSchema.safeParse({ ...fields, expectedRevision: 0, secretAction: "keep", accessKeyId }).success).toBe(false);
    expect(storageDraftUpdateSchema.safeParse({ ...fields, expectedRevision: 0, secretAction: "replace", secretAccessKey }).success).toBe(false);
    for (const prefix of ["../", "one//two", "/absolute", "one/./two", "one?redirect=x"]) expect(storageDraftUpdateSchema.safeParse({ ...fields, prefix, expectedRevision: 0, secretAction: "keep" }).success).toBe(false);
  });
  it("fails closed for malformed masters and non-HTTPS or credentialed operator origins", () => {
    expect(storageSettingsOptions({}).enabled).toBe(false);
    expect(() => storageSettingsOptions({ STORAGE_SETTINGS_ENABLED: "true" })).toThrow();
    expect(() => storageSettingsOptions({ STORAGE_SETTINGS_KEY: "x" })).toThrow();
    expect(() => storageSettingsOptions({ STORAGE_SETTINGS_KEY: Buffer.alloc(32).toString("base64") + "\n" })).toThrow();
    for (const endpoint of ["http://127.0.0.1", "https://user:secret@host", "https://host/path", "https://host?query"]) expect(() => storageSettingsOptions({ STORAGE_SETTINGS_ALLOWED_ENDPOINTS: endpoint })).toThrow();
    const parsed = storageSettingsOptions({ STORAGE_SETTINGS_ENABLED: "true", STORAGE_SETTINGS_KEY: Buffer.alloc(32).toString("base64"), STORAGE_SETTINGS_ALLOWED_ENDPOINTS: "https://objects.internal:9000" });
    expect(parsed.key?.length).toBe(32); expect(parsed.allowedEndpoints).toEqual(["https://objects.internal:9000"]);
  });
});
