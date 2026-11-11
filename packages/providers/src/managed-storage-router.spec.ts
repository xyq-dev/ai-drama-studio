import { describe, expect, it, vi } from "vitest";
import { ManagedStorageRouter, type StorageRoutingRevision } from "./managed-storage-router";
const config: StorageRoutingRevision = { source: "managed", configuration: { provider: "oss", endpoint: "https://oss-cn-hangzhou.aliyuncs.com", region: "cn-hangzhou", bucket: "synthetic-bucket", prefix: "drama", forcePathStyle: false, accessKeyId: "test", secretAccessKey: "test" } };
describe("immutable storage routing", () => {
  it("reserves the durable target before writing and resolves each read independently", async () => {
    const order: string[] = [];
    const authority = { reserve: vi.fn(async () => { order.push("reserve"); return config; }), resolve: vi.fn(async () => config) };
    const client = { put: vi.fn(async () => { order.push("put"); return "created" as const; }), get: vi.fn(async () => (async function* () { yield Buffer.from("ok"); })()), destroy: vi.fn() };
    const router = new ManagedStorageRouter(authority, {}, () => client);
    await router.put({ key: "logical", bytes: Buffer.from("ok"), checksumSha256: "0".repeat(64), contentType: "image/png", ifNoneMatch: "*" });
    expect(order).toEqual(["reserve", "put"]); expect(client.destroy).toHaveBeenCalledTimes(1);
    const bytes: Uint8Array[] = []; for await (const chunk of await router.get("logical")) bytes.push(chunk);
    expect(Buffer.concat(bytes).toString()).toBe("ok"); expect(authority.resolve).toHaveBeenCalledExactlyOnceWith("logical");
    expect(client.destroy).toHaveBeenCalledTimes(2);
  });
  it("cannot write when reservation fails and closes streams on early verification failure", async () => {
    const factory = vi.fn(); const blocked = new ManagedStorageRouter({ reserve: async () => { throw new Error("conflict"); }, resolve: async () => config }, {}, factory);
    await expect(blocked.put({ key: "x", bytes: Buffer.from("x"), checksumSha256: "0".repeat(64), contentType: "image/png", ifNoneMatch: "*" })).rejects.toThrow("conflict"); expect(factory).not.toHaveBeenCalled();
    const destroy = vi.fn(), client = { put: async () => "created" as const, get: async () => (async function* () { yield Buffer.from("first"); yield Buffer.from("second"); })(), destroy };
    const router = new ManagedStorageRouter({ reserve: async () => config, resolve: async () => config }, {}, () => client);
    for await (const _chunk of await router.get("x")) break;
    expect(destroy).toHaveBeenCalledOnce(); router.destroy(); await expect(router.get("x")).rejects.toThrow();
  });
});
