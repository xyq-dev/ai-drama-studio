import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { request as httpsRequest } from "node:https";

export interface ManagedStorageConfiguration {
  provider: "cos" | "oss" | "s3" | "minio";
  endpoint: string; region: string; bucket: string;
  accessKeyId: string; secretAccessKey: string; prefix: string; forcePathStyle: boolean;
}
export interface ManagedStorageRequest {
  method: "GET" | "HEAD" | "PUT" | "DELETE";
  url: URL; headers: Record<string, string>; body?: Uint8Array;
}
export interface ManagedStorageResponse {
  status: number; headers: Record<string, string | undefined>; body: AsyncIterable<Uint8Array>;
}
export interface ManagedStorageClientOptions {
  /** Operator-controlled exact HTTPS origins. Required for every MinIO endpoint. */
  allowedEndpoints?: readonly string[];
  /** Trusted transport injection for offline protocol tests; never supplied by the HTTP API. */
  transport?: (request: ManagedStorageRequest) => Promise<ManagedStorageResponse>;
  now?: () => Date;
}
export interface ManagedStoragePut {
  key: string; bytes: Uint8Array; contentType: string; checksumSha256: string; ifNoneMatch: "*";
}
export interface ManagedStorageClient {
  put(input: ManagedStoragePut): Promise<"created" | "exists">;
  get(key: string): Promise<AsyncIterable<Uint8Array>>;
  /** Writes, verifies and deletes one random 32-byte probe. Never touches an application object. */
  test(): Promise<void>;
  destroy(): void;
}
const TIMEOUT_MS = 10_000;
const MAX_OBJECT_BYTES = 512 * 1024 * 1024;
const unavailable = () => new Error("MANAGED_STORAGE_UNAVAILABLE");
const invalid = () => new Error("MANAGED_STORAGE_CONFIGURATION_INVALID");
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, ch => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);

function origin(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw invalid();
    return url.origin;
  } catch { throw invalid(); }
}
function validPath(value: string, allowEmpty: boolean): boolean {
  return (allowEmpty && value === "") || (value.length <= 900 && /^[a-zA-Z0-9_./-]+$/.test(value)
    && value.split("/").every(segment => segment !== "" && segment !== "." && segment !== ".."));
}

/** Reject user-selected network destinations; cloud hosts are derived, MinIO requires operator approval. */
export function validateManagedStorageConfiguration(configuration: ManagedStorageConfiguration,
  options: Pick<ManagedStorageClientOptions, "allowedEndpoints"> = {}): ManagedStorageConfiguration {
  const c = { ...configuration };
  c.prefix = c.prefix.replace(/\/$/, "");
  if (!["cos", "oss", "s3", "minio"].includes(c.provider) || !/^[a-z][a-z0-9-]{1,39}$/.test(c.region)
    || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(c.bucket) || !validPath(c.prefix, true)
    || !/^[a-zA-Z0-9_-]{1,128}$/.test(c.accessKeyId) || !/^[\x21-\x7e]{1,256}$/.test(c.secretAccessKey)
    || typeof c.forcePathStyle !== "boolean") throw invalid();
  c.endpoint = origin(c.endpoint);
  let expected: string;
  if (c.provider === "cos") {
    if (!/^[a-z0-9][a-z0-9-]*-[0-9]{5,20}$/.test(c.bucket) || c.forcePathStyle) throw invalid();
    expected = `https://cos.${c.region}.myqcloud.com`;
  } else if (c.provider === "oss") {
    if (c.forcePathStyle) throw invalid();
    expected = `https://oss-${c.region}.aliyuncs.com`;
  } else if (c.provider === "s3") {
    expected = `https://s3.${c.region}.amazonaws.com${c.region.startsWith("cn-") ? ".cn" : ""}`;
  } else {
    if (!options.allowedEndpoints?.some(value => origin(value) === c.endpoint) || !c.forcePathStyle) throw invalid();
    return c;
  }
  if (c.endpoint !== expected) throw invalid();
  return c;
}

/** Native HTTPS follows no redirects and bounds both connection and response lifetime. */
function nativeTransport(input: ManagedStorageRequest): Promise<ManagedStorageResponse> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(input.url, { method: input.method, headers: input.headers, agent: false }, response => {
      const headers: ManagedStorageResponse["headers"] = {};
      for (const [key, value] of Object.entries(response.headers)) headers[key] = Array.isArray(value) ? value.join(",") : value;
      resolve({ status: response.statusCode ?? 0, headers, body: response });
    });
    const timeout = setTimeout(() => req.destroy(unavailable()), TIMEOUT_MS);
    req.on("error", () => { clearTimeout(timeout); reject(unavailable()); });
    req.on("close", () => clearTimeout(timeout));
    req.end(input.body);
  });
}

/** Bound stalled iterators as well as bytes; callers still verify their expected asset size/hash. */
async function* safeStream(body: AsyncIterable<Uint8Array>, maxBytes = MAX_OBJECT_BYTES): AsyncIterable<Uint8Array> {
  let size = 0;
  const iterator = body[Symbol.asyncIterator]();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(unavailable()), TIMEOUT_MS); });
  try {
    for (;;) {
      const item = await Promise.race([iterator.next(), timeout]);
      if (item.done) return;
      if (!(item.value instanceof Uint8Array) || (size += item.value.byteLength) > maxBytes) throw unavailable();
      yield item.value;
    }
  } catch { throw unavailable(); }
  finally {
    clearTimeout(timer);
    // A hostile/failed iterator must not delay error delivery while closing.
    void iterator.return?.().catch(() => undefined);
  }
}
async function smallBody(body: AsyncIterable<Uint8Array>, maxBytes = 16_384): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of safeStream(body, maxBytes)) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** COS SHA1 request authentication, per https://www.tencentcloud.com/document/product/436/7778. */
function signCos(c: ManagedStorageConfiguration, request: ManagedStorageRequest, now: Date): void {
  const time = Math.floor(now.getTime() / 1000);
  const keyTime = `${time - 30};${time + 300}`;
  const names = Object.keys(request.headers).sort();
  const parameters = [...request.url.searchParams].map(([k, v]) => [k.toLowerCase(), v] as const).sort(([a], [b]) => a.localeCompare(b));
  const canonical = `${request.method.toLowerCase()}\n${request.url.pathname}\n${parameters.map(([k, v]) => `${encode(k)}=${encode(v)}`).join("&")}\n${names.map(k => `${encode(k)}=${encode(request.headers[k]!)}`).join("&")}\n`;
  const signKey = createHmac("sha1", c.secretAccessKey).update(keyTime).digest("hex");
  const stringToSign = `sha1\n${keyTime}\n${createHash("sha1").update(canonical).digest("hex")}\n`;
  const signature = createHmac("sha1", signKey).update(stringToSign).digest("hex");
  request.headers.authorization = `q-sign-algorithm=sha1&q-ak=${c.accessKeyId}&q-sign-time=${keyTime}&q-key-time=${keyTime}&q-header-list=${names.join(";")}&q-url-param-list=${parameters.map(([key]) => key).join(";")}&q-signature=${signature}`;
}

/** OSS native V4, not S3 compatibility. Canonical URI includes the bucket; empty query values omit '='.
 * https://www.alibabacloud.com/help/en/oss/developer-reference/recommend-to-use-signature-version-4 */
function signOss(c: ManagedStorageConfiguration, request: ManagedStorageRequest, now: Date): void {
  const timestamp = now.toISOString().replace(/[-:]|\.\d{3}/g, "");
  const date = timestamp.slice(0, 8);
  request.headers["x-oss-date"] = timestamp;
  request.headers["x-oss-content-sha256"] = "UNSIGNED-PAYLOAD";
  const names = Object.keys(request.headers).filter(k => k === "host" || k === "content-type" || k === "content-md5" || k.startsWith("x-oss-")).sort();
  const query = [...request.url.searchParams].map(([k, v]) => [encode(k), encode(v)] as const)
    .sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => v ? `${k}=${v}` : k).join("&");
  const canonical = `${request.method}\n/${c.bucket}${request.url.pathname}\n${query}\n${names.map(k => `${k}:${request.headers[k]!.trim()}\n`).join("")}\nhost\nUNSIGNED-PAYLOAD`;
  const scope = `${date}/${c.region}/oss/aliyun_v4_request`;
  let key: Buffer = Buffer.from(`aliyun_v4${c.secretAccessKey}`);
  for (const part of [date, c.region, "oss", "aliyun_v4_request"]) key = createHmac("sha256", key).update(part).digest();
  const signature = createHmac("sha256", key).update(`OSS4-HMAC-SHA256\n${timestamp}\n${scope}\n${sha256(canonical)}`).digest("hex");
  request.headers.authorization = `OSS4-HMAC-SHA256 Credential=${c.accessKeyId}/${scope}, AdditionalHeaders=host, Signature=${signature}`;
}

interface PutResult { result: "created" | "exists"; versionId?: string }
class Client implements ManagedStorageClient {
  readonly #c: ManagedStorageConfiguration;
  readonly #transport: NonNullable<ManagedStorageClientOptions["transport"]>;
  readonly #now: () => Date;
  readonly #s3?: S3Client;
  #destroyed = false;
  constructor(c: ManagedStorageConfiguration, options: ManagedStorageClientOptions) {
    this.#c = validateManagedStorageConfiguration(c, options);
    this.#transport = options.transport ?? nativeTransport;
    this.#now = options.now ?? (() => new Date());
    if (c.provider === "s3" || c.provider === "minio") this.#s3 = new S3Client({
      endpoint: this.#c.endpoint, region: c.region, forcePathStyle: c.forcePathStyle, maxAttempts: 1, followRegionRedirects: false,
      requestHandler: { connectionTimeout: 5_000, requestTimeout: TIMEOUT_MS },
      credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
    });
  }
  #key(key: string): string {
    if (this.#destroyed) throw unavailable();
    if (!validPath(key, false)) throw new Error("MANAGED_STORAGE_INPUT_INVALID");
    const full = this.#c.prefix ? `${this.#c.prefix}/${key}` : key;
    if (full.length > 1024) throw new Error("MANAGED_STORAGE_INPUT_INVALID");
    return full;
  }
  async #native(method: ManagedStorageRequest["method"], key = "", body?: Uint8Array,
    extra: Record<string, string> = {}, query = ""): Promise<ManagedStorageResponse> {
    if (this.#destroyed) throw unavailable();
    const endpoint = new URL(this.#c.endpoint);
    const url = new URL(`https://${this.#c.bucket}.${endpoint.host}/${key}${query}`);
    const request: ManagedStorageRequest = { method, url, body, headers: { host: url.host, ...extra } };
    if (body) request.headers["content-length"] = String(body.byteLength);
    if (this.#c.provider === "cos") signCos(this.#c, request, this.#now());
    else signOss(this.#c, request, this.#now());
    try { return await this.#transport(request); } catch { throw unavailable(); }
  }
  async #unversioned(): Promise<void> {
    const response = await this.#native("GET", "", undefined, {}, "?versioning");
    const xml = (await smallBody(response.body)).toString("utf8").trim().replace(/^<\?xml[^?]*\?>\s*/, "");
    if (response.status !== 200 || !/^<VersioningConfiguration(?:\s+[^>]*)?(?:\s*\/>|>\s*<\/VersioningConfiguration>)$/.test(xml)) {
      throw new Error("MANAGED_STORAGE_VERSIONING_UNSUPPORTED");
    }
  }
  async #put(input: ManagedStoragePut): Promise<PutResult> {
    const key = this.#key(input.key);
    if (input.ifNoneMatch !== "*" || !/^[a-f0-9]{64}$/.test(input.checksumSha256)
      || input.bytes.byteLength < 1 || input.bytes.byteLength > MAX_OBJECT_BYTES || sha256(input.bytes) !== input.checksumSha256
      || !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+(?:;[\x20-\x7e]*)?$/.test(input.contentType)
      || input.contentType.length > 128) throw new Error("MANAGED_STORAGE_INPUT_INVALID");
    if (this.#s3) {
      try {
        const result = await this.#s3.send(new PutObjectCommand({ Bucket: this.#c.bucket, Key: key,
          Body: input.bytes, ContentLength: input.bytes.byteLength, ContentType: input.contentType,
          IfNoneMatch: "*", ChecksumSHA256: Buffer.from(input.checksumSha256, "hex").toString("base64") }), { abortSignal: AbortSignal.timeout(TIMEOUT_MS) });
        return { result: "created", versionId: result.VersionId };
      } catch (error) {
        if (error && typeof error === "object" && "$metadata" in error
          && (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 412) return { result: "exists" };
        // SDK errors may contain credentials and signed URLs; expose only a fixed code.
        throw unavailable();
      }
    }
    // Forbid-overwrite is ineffective in versioned COS/OSS buckets. Never cache this safety check.
    await this.#unversioned();
    const p = this.#c.provider;
    const response = await this.#native("PUT", key, input.bytes, { "content-type": input.contentType,
      "content-md5": createHash("md5").update(input.bytes).digest("base64"),
      [`x-${p}-forbid-overwrite`]: "true", [`x-${p}-${p === "oss" ? "object-" : ""}acl`]: "private" });
    const body = (await smallBody(response.body)).toString("utf8");
    if (response.status === 409 && /<Code>FileAlreadyExists<\/Code>/.test(body)) return { result: "exists" };
    if (response.status !== 200) throw unavailable();
    return { result: "created", versionId: response.headers[`x-${p}-version-id`] };
  }
  async put(input: ManagedStoragePut): Promise<"created" | "exists"> {
    const result = await this.#put(input);
    // Detect an operator changing bucket versioning between the safety check and PUT; do not publish the asset.
    if (!this.#s3 && result.versionId) throw new Error("MANAGED_STORAGE_VERSIONING_UNSUPPORTED");
    return result.result;
  }
  async get(key: string): Promise<AsyncIterable<Uint8Array>> {
    const fullKey = this.#key(key);
    try {
      if (this.#s3) {
        const response = await this.#s3.send(new GetObjectCommand({ Bucket: this.#c.bucket, Key: fullKey }), { abortSignal: AbortSignal.timeout(TIMEOUT_MS) });
        if (!response.Body || !(Symbol.asyncIterator in response.Body)) throw unavailable();
        return safeStream(response.Body as AsyncIterable<Uint8Array>);
      }
      const response = await this.#native("GET", fullKey);
      if (response.status !== 200) { await smallBody(response.body); throw unavailable(); }
      return safeStream(response.body);
    } catch { throw unavailable(); }
  }
  async #deleteProbe(key: string, versionId?: string): Promise<void> {
    const fullKey = this.#key(key);
    if (!/^\.ads-storage-probe\/[a-f0-9-]{36}$/.test(key)) throw unavailable();
    try {
      if (this.#s3) {
        await this.#s3.send(new DeleteObjectCommand({ Bucket: this.#c.bucket, Key: fullKey, VersionId: versionId }), { abortSignal: AbortSignal.timeout(TIMEOUT_MS) });
      } else {
        const response = await this.#native("DELETE", fullKey, undefined, {}, versionId ? `?versionId=${encode(versionId)}` : "");
        await smallBody(response.body);
        if (response.status !== 204 && response.status !== 200) throw unavailable();
      }
    } catch { throw new Error("MANAGED_STORAGE_PROBE_CLEANUP_FAILED"); }
  }
  async test(): Promise<void> {
    if (this.#destroyed) throw unavailable();
    try {
      if (this.#s3) await this.#s3.send(new HeadBucketCommand({ Bucket: this.#c.bucket }), { abortSignal: AbortSignal.timeout(TIMEOUT_MS) });
      else {
        const response = await this.#native("HEAD");
        await smallBody(response.body);
        if (response.status !== 200) throw unavailable();
      }
    } catch { throw unavailable(); }
    // Refuse unsupported versioning before attempting any probe mutation or cleanup.
    if (!this.#s3) await this.#unversioned();
    const key = `.ads-storage-probe/${randomUUID()}`;
    const bytes = randomBytes(32), checksumSha256 = sha256(bytes);
    let cleanup = false, failure: unknown;
    const versions = new Set<string | undefined>();
    try {
      // The random key belongs exclusively to this invocation, even when PUT's response is lost.
      cleanup = true;
      const result = await this.#put({ key, bytes, checksumSha256, contentType: "application/octet-stream", ifNoneMatch: "*" });
      if (result.result !== "created") { cleanup = false; throw unavailable(); }
      versions.add(result.versionId);
      // A configured MinIO deployment must actually honor If-None-Match, not merely accept the header.
      const replacement = Buffer.from(bytes); replacement[0] = replacement[0]! ^ 1;
      const duplicate = await this.#put({ key, bytes: replacement, checksumSha256: sha256(replacement), contentType: "application/octet-stream", ifNoneMatch: "*" });
      if (duplicate.result !== "exists") {
        versions.add(duplicate.versionId);
        throw new Error("MANAGED_STORAGE_CONDITIONAL_WRITE_UNSUPPORTED");
      }
      const actual = await smallBody(await this.get(key), bytes.byteLength);
      if (actual.length !== bytes.length || sha256(actual) !== checksumSha256) throw unavailable();
      if (!this.#s3 && result.versionId) throw new Error("MANAGED_STORAGE_VERSIONING_UNSUPPORTED");
    } catch (error) { failure = error; }
    if (cleanup) {
      // On an ambiguous initial PUT failure, make a best-effort deletion of our exact random key.
      if (versions.size === 0) versions.add(undefined);
      let cleanupFailed = false;
      for (const version of versions) {
        try { await this.#deleteProbe(key, version); } catch { cleanupFailed = true; }
      }
      if (cleanupFailed) throw new Error("MANAGED_STORAGE_PROBE_CLEANUP_FAILED");
    }
    if (failure !== undefined) throw failure;
  }
  destroy(): void { this.#destroyed = true; this.#s3?.destroy(); }
}

export function createManagedStorageClient(configuration: ManagedStorageConfiguration,
  options: ManagedStorageClientOptions = {}): ManagedStorageClient { return new Client(configuration, options); }
