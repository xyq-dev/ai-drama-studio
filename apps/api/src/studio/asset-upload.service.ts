import { createHash } from "node:crypto";
import {
  ASSET_UPLOAD_MAX_BYTES,
  ASSET_UPLOAD_MIME_TYPES,
  createUploadSessionSchema,
  type CompleteUploadSessionResponse,
  type CreateUploadSessionResponse,
  type UploadSessionView,
} from "@ai-drama/contracts";
import {
  PersistenceError,
  UploadSessionStore,
  uploadObjectKey,
} from "@ai-drama/database";

export interface UploadObjectClient {
  put(input: {
    key: string;
    bytes: Uint8Array;
    contentType: string;
    checksumSha256: string;
    ifNoneMatch: "*";
  }): Promise<"created" | "exists">;
  get(key: string): Promise<AsyncIterable<Uint8Array>>;
}

export interface AssetUploadServiceDependencies {
  workspaceId: string;
  store: UploadSessionStore;
  /** Null when object storage is not wired; never pretend success. */
  objects: UploadObjectClient | null;
}

export interface AssetUploadResult {
  status: number;
  body: unknown;
}

const ERRORS: Record<string, { status: number; message: string }> = {
  NOT_FOUND: { status: 404, message: "未找到该上传会话或作品。" },
  VALIDATION_ERROR: { status: 400, message: "上传请求无效。" },
  UNSUPPORTED_MEDIA: { status: 400, message: "不支持的图片格式，仅允许 PNG、JPEG 或 WebP。" },
  UPLOAD_LIMIT: { status: 400, message: "上传文件超过 8 MiB 上限。" },
  OBJECT_HASH_MISMATCH: { status: 409, message: "上传内容校验失败，哈希或大小与预期不符。" },
  UPLOAD_SESSION_EXPIRED: { status: 409, message: "上传会话已过期，请重新创建。" },
  UPLOAD_SESSION_UNAVAILABLE: { status: 503, message: "上传会话存储尚未启用。" },
  UPLOAD_STORAGE_UNAVAILABLE: { status: 503, message: "对象存储尚未就绪，无法上传。" },
};

function failure(code: string): AssetUploadResult {
  const error = ERRORS[code] ?? { status: 400, message: "上传请求失败。" };
  return { status: error.status, body: { error: { code, message: error.message } } };
}

async function readObjectBytes(
  objects: UploadObjectClient,
  key: string,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of await objects.get(key)) {
    size += chunk.byteLength;
    if (size > maxBytes) {
      throw new PersistenceError("OBJECT_HASH_MISMATCH", "上传内容校验失败，哈希或大小与预期不符。");
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, size);
}

/** Storyboard/source image uploads: session → proxied PUT → verify → UPLOAD Asset. No image-provider keys. */
export class AssetUploadService {
  constructor(private readonly deps: AssetUploadServiceDependencies) {}

  private requireObjects(): UploadObjectClient {
    if (!this.deps.objects) {
      throw new PersistenceError("UPLOAD_STORAGE_UNAVAILABLE", "对象存储尚未就绪，无法上传。");
    }
    return this.deps.objects;
  }

  private async access(work: () => Promise<AssetUploadResult>): Promise<AssetUploadResult> {
    try {
      if (!(await this.deps.store.storageReady())) return failure("UPLOAD_SESSION_UNAVAILABLE");
      return await work();
    } catch (error) {
      if (error instanceof PersistenceError && ERRORS[error.code]) return failure(error.code);
      throw error;
    }
  }

  async createSession(body: unknown): Promise<AssetUploadResult> {
    return this.access(async () => {
      this.requireObjects();
      const parsed = createUploadSessionSchema.safeParse(body);
      if (!parsed.success) {
        const mimeIssue = parsed.error.issues.some((issue) => issue.path[0] === "mimeType");
        const sizeIssue = parsed.error.issues.some((issue) => issue.path[0] === "byteSize");
        if (mimeIssue) throw new PersistenceError("UNSUPPORTED_MEDIA", ERRORS.UNSUPPORTED_MEDIA!.message);
        if (sizeIssue) throw new PersistenceError("UPLOAD_LIMIT", ERRORS.UPLOAD_LIMIT!.message);
        throw new PersistenceError("VALIDATION_ERROR", ERRORS.VALIDATION_ERROR!.message);
      }
      const session = await this.deps.store.createSession(this.deps.workspaceId, parsed.data);
      const response: CreateUploadSessionResponse = {
        uploadSession: session,
        uploadUrl: `/api/v1/asset-upload-sessions/${session.id}/object`,
      };
      return { status: 201, body: response };
    });
  }

  async putObject(
    sessionId: string,
    body: Buffer | undefined,
    headers: { contentType?: string; contentSha256?: string; contentLength?: string },
  ): Promise<AssetUploadResult> {
    return this.access(async () => {
      const objects = this.requireObjects();
      const session = await this.deps.store.getSession(this.deps.workspaceId, sessionId);
      if (session.status === "EXPIRED" || Date.parse(session.expiresAt) <= Date.now()) {
        throw new PersistenceError("UPLOAD_SESSION_EXPIRED", ERRORS.UPLOAD_SESSION_EXPIRED!.message);
      }
      if (session.status === "COMPLETED") {
        return { status: 200, body: { uploadSession: session } };
      }
      const contentType = (headers.contentType ?? "").split(";")[0]!.trim().toLowerCase();
      if (!(ASSET_UPLOAD_MIME_TYPES as readonly string[]).includes(contentType)) {
        throw new PersistenceError("UNSUPPORTED_MEDIA", ERRORS.UNSUPPORTED_MEDIA!.message);
      }
      if (contentType !== session.expectedMimeType) {
        throw new PersistenceError("UNSUPPORTED_MEDIA", ERRORS.UNSUPPORTED_MEDIA!.message);
      }
      if (!body || !Buffer.isBuffer(body)) {
        throw new PersistenceError("VALIDATION_ERROR", ERRORS.VALIDATION_ERROR!.message);
      }
      if (body.byteLength > ASSET_UPLOAD_MAX_BYTES) {
        throw new PersistenceError("UPLOAD_LIMIT", ERRORS.UPLOAD_LIMIT!.message);
      }
      if (body.byteLength !== session.expectedByteSize) {
        throw new PersistenceError("OBJECT_HASH_MISMATCH", ERRORS.OBJECT_HASH_MISMATCH!.message);
      }
      if (headers.contentLength != null && headers.contentLength !== ""
        && Number(headers.contentLength) !== body.byteLength) {
        throw new PersistenceError("OBJECT_HASH_MISMATCH", ERRORS.OBJECT_HASH_MISMATCH!.message);
      }
      const checksumSha256 = createHash("sha256").update(body).digest("hex");
      if (headers.contentSha256) {
        const declared = headers.contentSha256.trim().toLowerCase();
        if (declared !== checksumSha256) {
          throw new PersistenceError("OBJECT_HASH_MISMATCH", ERRORS.OBJECT_HASH_MISMATCH!.message);
        }
      }
      if (session.expectedContentHash && session.expectedContentHash !== checksumSha256) {
        throw new PersistenceError("OBJECT_HASH_MISMATCH", ERRORS.OBJECT_HASH_MISMATCH!.message);
      }
      const objectKey = uploadObjectKey(
        this.deps.workspaceId,
        session.projectId,
        session.id,
        session.expectedMimeType,
        checksumSha256,
      );
      try {
        await objects.put({
          key: objectKey,
          bytes: body,
          contentType: session.expectedMimeType,
          checksumSha256,
          ifNoneMatch: "*",
        });
      } catch {
        throw new PersistenceError("UPLOAD_STORAGE_UNAVAILABLE", ERRORS.UPLOAD_STORAGE_UNAVAILABLE!.message);
      }
      const updated = await this.deps.store.markUploaded(this.deps.workspaceId, session.id, {
        objectKey,
        byteSize: body.byteLength,
        checksumSha256,
        mimeType: session.expectedMimeType,
      });
      return { status: 200, body: { uploadSession: updated } };
    });
  }

  async complete(sessionId: string, traceId: string): Promise<AssetUploadResult> {
    return this.access(async () => {
      const objects = this.requireObjects();
      const session = await this.deps.store.getSession(this.deps.workspaceId, sessionId);
      if (session.status === "COMPLETED" && session.completedAssetId) {
        const body: CompleteUploadSessionResponse = { assetId: session.completedAssetId };
        return { status: 200, body };
      }
      if (session.status === "EXPIRED" || Date.parse(session.expiresAt) <= Date.now()) {
        throw new PersistenceError("UPLOAD_SESSION_EXPIRED", ERRORS.UPLOAD_SESSION_EXPIRED!.message);
      }
      if (session.status !== "UPLOADED") {
        throw new PersistenceError("OBJECT_HASH_MISMATCH", ERRORS.OBJECT_HASH_MISMATCH!.message);
      }
      let bytes: Buffer;
      try {
        bytes = await readObjectBytes(objects, session.temporaryStorageKey, session.expectedByteSize);
      } catch (error) {
        if (error instanceof PersistenceError) throw error;
        throw new PersistenceError("UPLOAD_STORAGE_UNAVAILABLE", ERRORS.UPLOAD_STORAGE_UNAVAILABLE!.message);
      }
      const checksumSha256 = createHash("sha256").update(bytes).digest("hex");
      if (bytes.byteLength !== session.expectedByteSize
        || (session.expectedContentHash != null && session.expectedContentHash !== checksumSha256)) {
        throw new PersistenceError("OBJECT_HASH_MISMATCH", ERRORS.OBJECT_HASH_MISMATCH!.message);
      }
      const result = await this.deps.store.complete(
        this.deps.workspaceId,
        session.id,
        {
          mimeType: session.expectedMimeType,
          byteSize: bytes.byteLength,
          checksumSha256,
          objectKey: session.temporaryStorageKey,
        },
        { traceId },
      );
      const body: CompleteUploadSessionResponse = { assetId: result.assetId };
      return { status: 200, body };
    });
  }

  /** Test helper: expose session view shape. */
  view(session: UploadSessionView): UploadSessionView {
    return session;
  }
}
