import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createManagedStorageClient, validateManagedStorageConfiguration,
  type ManagedStorageConfiguration, type ManagedStorageRequest, type ManagedStorageResponse } from "./managed-storage-client";

const sdk = vi.hoisted(() => ({ configurations: [] as unknown[], send: vi.fn(), destroy: vi.fn() }));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class { constructor(config: unknown) { sdk.configurations.push(config); } send(command: unknown) { return sdk.send(command); } destroy() { sdk.destroy(); } },
  PutObjectCommand: class { readonly kind = "PUT"; constructor(readonly input: Record<string, unknown>) {} },
  GetObjectCommand: class { readonly kind = "GET"; constructor(readonly input: Record<string, unknown>) {} },
  HeadBucketCommand: class { readonly kind = "HEAD"; constructor(readonly input: Record<string, unknown>) {} },
  DeleteObjectCommand: class { readonly kind = "DELETE"; constructor(readonly input: Record<string, unknown>) {} },
}));
const now = () => new Date("2025-04-11T06:41:24Z");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function* chunks(value: string | Uint8Array = "") { yield typeof value === "string" ? Buffer.from(value) : value; }
const response = (status = 200, value: string | Uint8Array = "", headers = {}): ManagedStorageResponse => ({ status, headers, body: chunks(value) });
function config(provider: ManagedStorageConfiguration["provider"]): ManagedStorageConfiguration {
  const region = { cos: "ap-guangzhou", oss: "cn-hangzhou", s3: "us-east-1", minio: "us-east-1" }[provider];
  return { provider, region, bucket: provider === "cos" ? "sample-1250000000" : "sample", prefix: "studio",
    endpoint: { cos: `https://cos.${region}.myqcloud.com`, oss: `https://oss-${region}.aliyuncs.com`,
      s3: `https://s3.${region}.amazonaws.com`, minio: "https://objects.example.test" }[provider],
    accessKeyId: "test-access", secretAccessKey: "test-secret", forcePathStyle: provider === "minio" };
}
function input() { const bytes = Buffer.from("verified media"); return { key: "real-media/workspace/file.wav", bytes, checksumSha256: digest(bytes), contentType: "audio/wav", ifNoneMatch: "*" as const }; }
function nativeFixture() {
  const requests: ManagedStorageRequest[] = [], objects = new Map<string, Uint8Array>();
  const transport = vi.fn(async (request: ManagedStorageRequest) => {
    requests.push(request);
    if (request.url.searchParams.has("versioning")) return response(200, '<VersioningConfiguration xmlns="https://example.test"/>');
    if (request.method === "HEAD") return response();
    if (request.method === "PUT") { if (objects.has(request.url.pathname)) return response(409, "<Error><Code>FileAlreadyExists</Code></Error>"); objects.set(request.url.pathname, request.body!); return response(); }
    if (request.method === "GET") return response(200, objects.get(request.url.pathname) ?? "missing");
    objects.delete(request.url.pathname); return response(204);
  });
  return { requests, objects, transport };
}
beforeEach(() => { sdk.configurations = []; sdk.send.mockReset(); sdk.destroy.mockReset(); });

describe("managed storage destinations", () => {
  it.each(["cos", "oss", "s3", "minio"] as const)("validates %s before constructing transport", provider => {
    const c = config(provider), opts = { allowedEndpoints: ["https://objects.example.test"] };
    expect(validateManagedStorageConfiguration(c, opts)).toEqual(c);
    for (const endpoint of ["http://127.0.0.1", "https://metadata.google.internal", `${c.endpoint}.attacker.test`, `${c.endpoint}/path`, `${c.endpoint}?redirect=yes`, `https://user:pass@${new URL(c.endpoint).host}`]) {
      expect(() => createManagedStorageClient({ ...c, endpoint }, opts)).toThrow("MANAGED_STORAGE_CONFIGURATION_INVALID");
    }
  });
  it("requires operator-listed HTTPS and path addressing for MinIO", () => {
    expect(() => createManagedStorageClient(config("minio"))).toThrow("MANAGED_STORAGE_CONFIGURATION_INVALID");
    expect(() => createManagedStorageClient({ ...config("minio"), forcePathStyle: false }, { allowedEndpoints: ["https://objects.example.test"] })).toThrow("MANAGED_STORAGE_CONFIGURATION_INVALID");
    expect(() => createManagedStorageClient({ ...config("minio"), endpoint: "http://objects.example.test" }, { allowedEndpoints: ["http://objects.example.test"] })).toThrow("MANAGED_STORAGE_CONFIGURATION_INVALID");
  });
  it("rejects traversals, malformed credentials and cloud path style", () => {
    for (const patch of [{ bucket: "a.b" }, { prefix: "../escape" }, { prefix: "a//b" }, { accessKeyId: "key\r\nInjected:x" }, { forcePathStyle: true }]) {
      expect(() => createManagedStorageClient({ ...config("oss"), ...patch })).toThrow("MANAGED_STORAGE_CONFIGURATION_INVALID");
    }
  });
});

describe.each(["cos", "oss"] as const)("%s native protocol", provider => {
  it("matches independently calculated native signing fixtures", async () => {
    const f = nativeFixture();
    await createManagedStorageClient(config(provider), { transport: f.transport, now }).test();
    const auth = f.requests[0]!.headers.authorization;
    // Fixed HMAC fixtures use the vendor canonical algorithms, independently calculated with Python hashlib/hmac.
    expect(auth).toBe(provider === "cos"
      ? "q-sign-algorithm=sha1&q-ak=test-access&q-sign-time=1744353654;1744353984&q-key-time=1744353654;1744353984&q-header-list=host&q-url-param-list=&q-signature=26a39e5f92995219edbc7a7617fbe0dfcdbe2d2f"
      : "OSS4-HMAC-SHA256 Credential=test-access/20250411/cn-hangzhou/oss/aliyun_v4_request, AdditionalHeaders=host, Signature=e0ec5bf3d24271a647e9ee9b8281912b38ef6dd6328a112cfb222efc1c93f868");
  });
  it("writes create-only with prefix, content MD5 and private ACL; never assumes S3", async () => {
    const f = nativeFixture(), client = createManagedStorageClient(config(provider), { transport: f.transport, now });
    expect(await client.put(input())).toBe("created");
    expect(await client.put(input())).toBe("exists");
    expect(f.requests.map(r => r.method)).toEqual(["GET", "PUT", "GET", "PUT"]);
    const put = f.requests[1]!;
    expect(put.url.pathname).toBe("/studio/real-media/workspace/file.wav");
    expect(put.headers[`x-${provider}-forbid-overwrite`]).toBe("true");
    expect(put.headers[`x-${provider}-${provider === "oss" ? "object-" : ""}acl`]).toBe("private");
    expect(put.headers["content-md5"]).toBe(createHash("md5").update(input().bytes).digest("base64"));
    expect(put.headers.authorization).toContain(provider === "oss" ? "OSS4-HMAC-SHA256" : "q-sign-algorithm=sha1");
    expect(sdk.configurations).toHaveLength(0);
    expect(JSON.stringify(client)).not.toContain("test-secret");
  });
  it.each(["Enabled", "Suspended", "Unexpected"])("rejects %s versioning before any object mutation", async status => {
    const transport = vi.fn(async () => response(200, `<VersioningConfiguration><Status>${status}</Status></VersioningConfiguration>`));
    const client = createManagedStorageClient(config(provider), { transport, now });
    await expect(client.put(input())).rejects.toThrow("MANAGED_STORAGE_VERSIONING_UNSUPPORTED");
    expect(transport).toHaveBeenCalledOnce();
  });
  it("does not accept a malformed/denied versioning response or publish a versioned write", async () => {
    const f = nativeFixture(); f.transport.mockResolvedValueOnce(response(403, "denied-secret"));
    const client = createManagedStorageClient(config(provider), { transport: f.transport, now });
    await expect(client.put(input())).rejects.toThrow("MANAGED_STORAGE_VERSIONING_UNSUPPORTED");
    f.transport.mockResolvedValueOnce(response(200, "<VersioningConfiguration/>"));
    f.transport.mockResolvedValueOnce(response(200, "", { [`x-${provider}-version-id`]: "changed-between-check-and-write" }));
    await expect(client.put(input())).rejects.toThrow("MANAGED_STORAGE_VERSIONING_UNSUPPORTED");
  });
  it("tests actual write/read/delete of only its own random 32-byte object", async () => {
    const f = nativeFixture(), client = createManagedStorageClient(config(provider), { transport: f.transport, now });
    f.objects.set("/studio/existing.wav", Buffer.from("retain"));
    await client.test();
    const put = f.requests.find(r => r.method === "PUT")!, del = f.requests.find(r => r.method === "DELETE")!;
    expect(put.url.pathname).toMatch(/^\/studio\/\.ads-storage-probe\/[a-f0-9-]{36}$/);
    expect(put.body).toHaveLength(32);
    expect(del.url.pathname).toBe(put.url.pathname);
    expect(del.headers.authorization).toBeTruthy();
    expect([...f.objects.keys()]).toEqual(["/studio/existing.wav"]);
  });
  it("fails on corrupt readback and still deletes its probe", async () => {
    const f = nativeFixture();
    const transport = async (request: ManagedStorageRequest) => request.method === "GET" && !request.url.search
      ? response(200, Buffer.alloc(32)) : f.transport(request);
    await expect(createManagedStorageClient(config(provider), { transport, now }).test()).rejects.toThrow("MANAGED_STORAGE_UNAVAILABLE");
    expect(f.requests.at(-1)?.method).toBe("DELETE"); expect(f.objects.size).toBe(0);
  });
  it("never reports success if deletion fails", async () => {
    const f = nativeFixture();
    const transport = async (request: ManagedStorageRequest) => request.method === "DELETE" ? response(403, "secret") : f.transport(request);
    await expect(createManagedStorageClient(config(provider), { transport, now }).test()).rejects.toThrow("MANAGED_STORAGE_PROBE_CLEANUP_FAILED");
  });
  it("rejects a server that accepts create-only headers but still overwrites", async () => {
    const f = nativeFixture();
    const transport = async (request: ManagedStorageRequest) => {
      if (request.method === "PUT") f.objects.delete(request.url.pathname);
      return f.transport(request);
    };
    await expect(createManagedStorageClient(config(provider), { transport, now }).test()).rejects.toThrow("MANAGED_STORAGE_CONDITIONAL_WRITE_UNSUPPORTED");
    expect(f.objects.size).toBe(0);
  });
  it("does not issue a probe mutation if versioning preflight fails", async () => {
    const f = nativeFixture();
    const transport = vi.fn(async (request: ManagedStorageRequest) => request.url.searchParams.has("versioning")
      ? response(200, "<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>") : f.transport(request));
    await expect(createManagedStorageClient(config(provider), { transport, now }).test()).rejects.toThrow("MANAGED_STORAGE_VERSIONING_UNSUPPORTED");
    expect(transport.mock.calls.map(([r]) => r.method)).toEqual(["HEAD", "GET"]);
  });
  it("does not delete a preexisting colliding probe", async () => {
    const f = nativeFixture();
    const transport = vi.fn(async (request: ManagedStorageRequest) => request.method === "PUT"
      ? response(409, "<Code>FileAlreadyExists</Code>") : f.transport(request));
    await expect(createManagedStorageClient(config(provider), { transport, now }).test()).rejects.toThrow("MANAGED_STORAGE_UNAVAILABLE");
    expect(transport.mock.calls.some(([r]) => r.method === "DELETE")).toBe(false);
  });
  it("sanitizes network and midstream errors and rejects redirect responses", async () => {
    const f = nativeFixture(), client = createManagedStorageClient(config(provider), { transport: f.transport, now });
    f.transport.mockRejectedValueOnce(new Error("test-secret signed URL")); await expect(client.get("valid.wav")).rejects.toThrow(/^MANAGED_STORAGE_UNAVAILABLE$/);
    f.transport.mockResolvedValueOnce(response(307, "", { location: "https://attacker.test" })); await expect(client.get("valid.wav")).rejects.toThrow(/^MANAGED_STORAGE_UNAVAILABLE$/);
    async function* failed() { yield Buffer.from("first"); throw new Error("test-secret"); }
    f.transport.mockResolvedValueOnce({ status: 200, headers: {}, body: failed() });
    await expect((async () => { for await (const _chunk of await client.get("valid.wav")) { /* consume */ } })()).rejects.toThrow(/^MANAGED_STORAGE_UNAVAILABLE$/);
    expect(f.transport).toHaveBeenCalledTimes(3);
  });
  it("rejects unsafe keys and mismatching declared hash before requests", async () => {
    const f = nativeFixture(), client = createManagedStorageClient(config(provider), { transport: f.transport });
    await expect(client.get("a/../b")).rejects.toThrow("MANAGED_STORAGE_INPUT_INVALID");
    await expect(client.put({ ...input(), checksumSha256: "0".repeat(64) })).rejects.toThrow("MANAGED_STORAGE_INPUT_INVALID");
    expect(f.transport).not.toHaveBeenCalled();
  });
  it("bounds provider XML and probe readback bytes", async () => {
    const f = nativeFixture(), client = createManagedStorageClient(config(provider), { transport: f.transport });
    f.transport.mockResolvedValueOnce(response(200, "x".repeat(16_385)));
    await expect(client.put(input())).rejects.toThrow("MANAGED_STORAGE_UNAVAILABLE");
    const transport = async (request: ManagedStorageRequest) => request.method === "GET" && !request.url.search
      ? response(200, Buffer.alloc(33)) : f.transport(request);
    await expect(createManagedStorageClient(config(provider), { transport }).test()).rejects.toThrow("MANAGED_STORAGE_UNAVAILABLE");
    expect(f.objects.size).toBe(0);
  });
  it("ends stalled read streams after ten seconds", async () => {
    vi.useFakeTimers();
    try {
      const body: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => undefined), return: async () => ({ done: true, value: undefined }) }) };
      const client = createManagedStorageClient(config(provider), { transport: async () => ({ status: 200, headers: {}, body }) });
      const outcome = expect((async () => { for await (const _chunk of await client.get("valid.wav")) { /* consume */ } })()).rejects.toThrow(/^MANAGED_STORAGE_UNAVAILABLE$/);
      await vi.advanceTimersByTimeAsync(10_001);
      await outcome;
    } finally { vi.useRealTimers(); }
  });
});

describe("S3 and MinIO operations", () => {
  it.each(["s3", "minio"] as const)("uses %s conditional writes and bounded SDK requests", async provider => {
    const client = createManagedStorageClient(config(provider), { allowedEndpoints: ["https://objects.example.test"] }); sdk.send.mockResolvedValue({});
    expect(await client.put(input())).toBe("created");
    expect(sdk.configurations[0]).toMatchObject({ maxAttempts: 1, followRegionRedirects: false, requestHandler: { requestTimeout: 10_000 } });
    expect(sdk.send.mock.calls[0]![0].input).toMatchObject({ Key: "studio/real-media/workspace/file.wav", IfNoneMatch: "*", ChecksumSHA256: Buffer.from(input().checksumSha256, "hex").toString("base64") });
    sdk.send.mockRejectedValueOnce({ $metadata: { httpStatusCode: 412 } }); expect(await client.put(input())).toBe("exists");
    sdk.send.mockRejectedValueOnce(new Error("test-secret")); await expect(client.get(input().key)).rejects.toThrow(/^MANAGED_STORAGE_UNAVAILABLE$/);
    client.destroy(); expect(sdk.destroy).toHaveBeenCalledOnce(); await expect(client.get(input().key)).rejects.toThrow("MANAGED_STORAGE_UNAVAILABLE");
  });
  it("deletes the exact returned probe version in versioned buckets", async () => {
    let bytes = Buffer.alloc(0);
    sdk.send.mockImplementation(async (command: { kind: string; input: Record<string, unknown> }) => {
      if (command.kind === "PUT") {
        if (bytes.length) throw { $metadata: { httpStatusCode: 412 } };
        bytes = Buffer.from(command.input.Body as Uint8Array); return { VersionId: "probe-version" };
      }
      if (command.kind === "GET") return { Body: chunks(bytes) };
      return {};
    });
    await createManagedStorageClient(config("s3")).test();
    const commands = sdk.send.mock.calls.map(([command]) => command);
    expect(commands.map(c => c.kind)).toEqual(["HEAD", "PUT", "PUT", "GET", "DELETE"]);
    expect(commands[4].input).toMatchObject({ Key: commands[1].input.Key, VersionId: "probe-version" });
  });
});
