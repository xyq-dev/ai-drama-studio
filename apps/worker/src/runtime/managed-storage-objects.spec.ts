import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ManagedStorageRouter, type StorageRoutingRevision } from "@ai-drama/providers";
import { S3RealMediaObjects } from "./real-media-objects";
const workspaceId = "11111111-1111-4111-8111-111111111111", projectId = "22222222-2222-4222-8222-222222222222", generationJobId = "33333333-3333-4333-8333-333333333333", jobAttemptId = "44444444-4444-4444-8444-444444444444";
const config = (bucket: string): StorageRoutingRevision => ({ source: "managed", configuration: { provider: "oss", endpoint: "https://oss-cn-hangzhou.aliyuncs.com", region: "cn-hangzhou", bucket, accessKeyId: "synthetic", secretAccessKey: "synthetic", prefix: "drama", forcePathStyle: false } });
describe("worker verified media with managed routing", () => {
  it("writes and verifies through the selected backend while prior immutable bindings survive activation", async () => {
    let active = config("first-bucket"); const bindings = new Map<string, StorageRoutingRevision>(), objects = new Map<string, Uint8Array>();
    const router = new ManagedStorageRouter({ reserve: async key => { if (!bindings.has(key)) bindings.set(key, active); return bindings.get(key)!; }, resolve: async key => bindings.get(key)! }, {}, revision => {
      const physical = (key: string) => `${revision.configuration.bucket}/${revision.configuration.prefix}/${key}`;
      return { put: async input => { if (objects.has(physical(input.key))) return "exists"; objects.set(physical(input.key), input.bytes); return "created"; }, get: async key => (async function* () { yield objects.get(physical(key))!; })(), destroy: () => undefined };
    });
    const store = new S3RealMediaObjects(router), common = { workspaceId, projectId, generationJobId, jobAttemptId, mimeType: "image/png" };
    const first = await store.putVerified({ ...common, bytes: Buffer.from("first") }); active = config("second-bucket");
    const second = await store.putVerified({ ...common, bytes: Buffer.from("second") }); expect(first.storageProvider).toBe("s3");
    expect(first.objectKey).toBe(`real-media/${workspaceId}/${projectId}/${generationJobId}/${jobAttemptId}/${createHash("sha256").update("first").digest("hex")}.png`);
    expect((await store.readVerified(first, { workspaceId, projectId, maxBytes: 32 })).toString()).toBe("first");
    expect((await store.readVerified(second, { workspaceId, projectId, maxBytes: 32 })).toString()).toBe("second");
    expect(await store.putVerified({ ...common, bytes: Buffer.from("first") })).toEqual(first);
    expect([...objects.keys()].filter(key => key.startsWith("first-bucket/"))).toHaveLength(1); expect(objects.size).toBe(2);
    await expect(store.readVerified(first, { workspaceId, projectId: generationJobId, maxBytes: 32 })).rejects.toThrow();
    router.destroy();
  });
});
