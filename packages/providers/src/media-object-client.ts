import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
export interface MediaS3Configuration {
  endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; forcePathStyle: boolean;
}
/** Storage retries never cause another model invocation. Object writes remain create-only. */
export class MediaS3Client {
  readonly #client: S3Client;
  readonly #configuration: MediaS3Configuration;
  constructor(configuration: MediaS3Configuration) {
    this.#configuration = { ...configuration };
    this.#client = new S3Client({ endpoint: configuration.endpoint, region: configuration.region,
      forcePathStyle: configuration.forcePathStyle, maxAttempts: 1,
      credentials: { accessKeyId: configuration.accessKeyId, secretAccessKey: configuration.secretAccessKey } });
  }
  async put(input: { key: string; bytes: Uint8Array; contentType: string; checksumSha256: string; ifNoneMatch: "*" }): Promise<"created" | "exists"> {
    if (input.ifNoneMatch !== "*" || !/^[a-f0-9]{64}$/.test(input.checksumSha256)) throw new Error("MEDIA_OBJECT_INPUT_INVALID");
    try {
      await this.#client.send(new PutObjectCommand({ Bucket: this.#configuration.bucket, Key: input.key,
        Body: input.bytes, ContentType: input.contentType, ContentLength: input.bytes.byteLength,
        IfNoneMatch: "*", ChecksumSHA256: Buffer.from(input.checksumSha256, "hex").toString("base64") }));
      return "created";
    } catch (error) {
      if (error && typeof error === "object" && "$metadata" in error
        && (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 412) return "exists";
      throw new Error("MEDIA_OBJECT_STORAGE_UNAVAILABLE");
    }
  }
  async get(key: string): Promise<AsyncIterable<Uint8Array>> {
    try {
      const response = await this.#client.send(new GetObjectCommand({ Bucket: this.#configuration.bucket, Key: key }));
      if (!response.Body || !(Symbol.asyncIterator in response.Body)) throw new Error("MEDIA_OBJECT_STORAGE_UNAVAILABLE");
      return response.Body as AsyncIterable<Uint8Array>;
    } catch { throw new Error("MEDIA_OBJECT_STORAGE_UNAVAILABLE"); }
  }
  destroy(): void { this.#client.destroy(); }
}

/** Shared API/worker reader: namespace, size and content hash are verified before bytes leave the boundary. */
export async function readVerifiedS3MediaObject(client: { get(key: string): Promise<AsyncIterable<Uint8Array>> },
  input: { storageProvider: string; objectKey: string; byteSize: number; checksumSha256: string },
  scope: { workspaceId: string; projectId: string; maxBytes: number }): Promise<Buffer> {
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  const parts = input.objectKey.split("/");
  if (input.storageProvider !== "s3" || !Number.isSafeInteger(input.byteSize) || input.byteSize < 1
    || !Number.isSafeInteger(scope.maxBytes) || scope.maxBytes < 1 || input.byteSize > scope.maxBytes
    || !/^[a-f0-9]{64}$/.test(input.checksumSha256) || parts.length !== 6 || parts[0] !== "real-media"
    || parts[1] !== scope.workspaceId || parts[2] !== scope.projectId || !parts.slice(1, 5).every(p => uuid.test(p))
    || !["png", "mp4", "wav", "vtt"].some(ext => parts[5] === input.checksumSha256 + "." + ext)) throw new Error("MEDIA_OBJECT_CONTENT_INVALID");
  const chunks: Buffer[] = [], hash = createHash("sha256"); let size = 0;
  for await (const chunk of await client.get(input.objectKey)) {
    size += chunk.byteLength;
    if (size > input.byteSize || size > scope.maxBytes) throw new Error("MEDIA_OBJECT_CONTENT_INVALID");
    hash.update(chunk); chunks.push(Buffer.from(chunk));
  }
  if (size !== input.byteSize || hash.digest("hex") !== input.checksumSha256) throw new Error("MEDIA_OBJECT_CONTENT_INVALID");
  return Buffer.concat(chunks, size);
}
