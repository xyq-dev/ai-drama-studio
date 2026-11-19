import { z } from "zod";

/** Max upload size for storyboard/source images (8 MiB). */
export const ASSET_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;

export const ASSET_UPLOAD_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type AssetUploadMimeType = (typeof ASSET_UPLOAD_MIME_TYPES)[number];

export const uploadSessionStatusSchema = z.enum([
  "PENDING",
  "UPLOADED",
  "COMPLETED",
  "EXPIRED",
  "FAILED",
]);
export type UploadSessionStatus = z.infer<typeof uploadSessionStatusSchema>;

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

export const createUploadSessionSchema = z.object({
  projectId: z.string().uuid(),
  assetType: z.literal("IMAGE"),
  mimeType: z.enum(ASSET_UPLOAD_MIME_TYPES),
  byteSize: z.number().int().min(1).max(ASSET_UPLOAD_MAX_BYTES),
  contentHash: sha256Hex.optional(),
  shotRevisionId: z.string().uuid().optional(),
  autoStoryboardRunId: z.string().uuid().optional(),
}).strict();
export type CreateUploadSessionRequest = z.infer<typeof createUploadSessionSchema>;

export const uploadSessionViewSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string().uuid(),
  storageProvider: z.string().min(1),
  temporaryStorageKey: z.string().min(1),
  expectedMimeType: z.enum(ASSET_UPLOAD_MIME_TYPES),
  expectedByteSize: z.number().int().positive(),
  expectedContentHash: sha256Hex.nullable(),
  status: uploadSessionStatusSchema,
  expiresAt: z.string().datetime(),
  createdBy: z.string().min(1),
  createdAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
  completedAssetId: z.string().uuid().nullable(),
  sourceShotRevisionId: z.string().uuid().nullable(),
}).strict();
export type UploadSessionView = z.infer<typeof uploadSessionViewSchema>;

export const createUploadSessionResponseSchema = z.object({
  uploadSession: uploadSessionViewSchema,
  /** Same-origin API-proxied PUT URL (acts as the short-lived upload URL without S3 presigning). */
  uploadUrl: z.string().min(1),
}).strict();
export type CreateUploadSessionResponse = z.infer<typeof createUploadSessionResponseSchema>;

export const completeUploadSessionResponseSchema = z.object({
  assetId: z.string().uuid(),
}).strict();
export type CompleteUploadSessionResponse = z.infer<typeof completeUploadSessionResponseSchema>;
