import { z } from "zod";

export const storageProviderSchema = z.enum(["cos", "oss", "s3", "minio"]);
export type StorageProvider = z.infer<typeof storageProviderSchema>;
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const storageConfigurationFieldsSchema = z.object({
  provider: storageProviderSchema,
  endpoint: z.string().max(512),
  region: z.string().regex(/^[a-z0-9-]{1,64}$/),
  bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
  prefix: z.string().max(180).regex(/^(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\/?)?$/),
  forcePathStyle: z.boolean(),
}).strict();
export const storageDraftUpdateSchema = storageConfigurationFieldsSchema.extend({
  expectedRevision: revision,
  secretAction: z.enum(["keep", "replace"]),
  accessKeyId: z.string().min(3).max(256).regex(/^[\x21-\x7e]+$/).optional(),
  secretAccessKey: z.string().min(8).max(256).regex(/^[\x21-\x7e]+$/).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.secretAction === "replace" ? !value.accessKeyId || !value.secretAccessKey : value.accessKeyId !== undefined || value.secretAccessKey !== undefined) {
    ctx.addIssue({ code: "custom", path: ["secretAction"], message: "Replace both credentials together, or keep both." });
  }
});
export const storageTestRequestSchema = z.object({ expectedRevision: revision, confirmProbe: z.literal(true) }).strict();
export const storageActivateRequestSchema = z.object({ expectedRevision: revision }).strict();
export type StorageDraftUpdate = z.infer<typeof storageDraftUpdateSchema>;
export type StorageTestRequest = z.infer<typeof storageTestRequestSchema>;
export type StorageActivateRequest = z.infer<typeof storageActivateRequestSchema>;

export const storageConfigurationViewSchema = storageConfigurationFieldsSchema.extend({
  id: z.string().uuid().nullable(), hasCredentials: z.boolean(), source: z.enum(["environment", "managed"]),
}).strict();
export const storageSettingsViewSchema = z.object({
  revision,
  active: storageConfigurationViewSchema,
  draft: storageConfigurationViewSchema.nullable(),
  test: z.object({ status: z.enum(["not_tested", "passed", "failed"]), testedAt: z.string().datetime().nullable(), expiresAt: z.string().datetime().nullable() }).strict(),
  managed: z.boolean(),
}).strict();

/** A public projection: neither credential value nor a credential fingerprint is exposed. */
export interface StorageConfigurationView extends z.infer<typeof storageConfigurationFieldsSchema> {
  id: string | null;
  hasCredentials: boolean;
  source: "environment" | "managed";
}
export interface StorageSettingsView {
  revision: number;
  active: StorageConfigurationView;
  draft: StorageConfigurationView | null;
  test: { status: "not_tested" | "passed" | "failed"; testedAt: string | null; expiresAt: string | null };
  managed: boolean;
}
