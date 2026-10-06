import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobPersistenceService, MediaAssetRecord, MediaAssetStore, RuntimeStore, TextChainService } from "@ai-drama/database";
import { readBoundedMockPng } from "./mock-image-content";
import { StudioService } from "./studio.service";

/**
 * Real files in a temporary directory, with selected filesystem calls failing the way the OS reports permission,
 * file-handle and I/O faults. Only calls under the object store are affected; the root lookup stays real.
 */
const faults = vi.hoisted(() => ({ lstat: null as string | null, realpath: null as string | null,
  open: null as string | null, read: null as string | null }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const fail = (code: string) => Object.assign(new Error(`${code}: simulated failure at C:\\secret\\objects\\x.png`), { code });
  const underStore = (path: unknown) => String(path).includes("mock-images");
  return {
    ...actual,
    lstat: (async (path: string, ...rest: unknown[]) => {
      if (faults.lstat && underStore(path)) throw fail(faults.lstat);
      return (actual.lstat as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof actual.lstat,
    realpath: (async (path: string, ...rest: unknown[]) => {
      if (faults.realpath && underStore(path)) throw fail(faults.realpath);
      return (actual.realpath as (...args: unknown[]) => unknown)(path, ...rest);
    }) as typeof actual.realpath,
    open: (async (path: string, ...rest: unknown[]) => {
      if (faults.open && underStore(path)) throw fail(faults.open);
      const handle = await (actual.open as (...args: unknown[]) => Promise<Awaited<ReturnType<typeof actual.open>>>)(path, ...rest);
      if (!faults.read || !underStore(path)) return handle;
      const code = faults.read;
      return { read: async () => { throw fail(code); }, close: () => handle.close() };
    }) as typeof actual.open,
  };
});

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const SHOT = "33333333-3333-4333-8333-333333333333";
const JOB = "55555555-5555-4555-8555-555555555555";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const CHECKSUM = createHash("sha256").update(PNG).digest("hex");
const KEY = `mock-images/${PROJECT}/${JOB}/${CHECKSUM}.png`;
const root = resolve(tmpdir(), `mock-content-io-${process.pid}`);

async function storeObject(bytes = PNG): Promise<void> {
  await mkdir(join(root, "mock-images", PROJECT, JOB), { recursive: true });
  await writeFile(join(root, KEY), bytes);
}

function asset(): MediaAssetRecord {
  return {
    id: "asset-1", projectId: PROJECT, kind: "IMAGE", storageProvider: "mock-object-store", objectKey: KEY,
    mimeType: "image/png", byteSize: PNG.length, checksumSha256: CHECKSUM, width: 1, height: 1, status: "ACTIVE",
    reviewStatus: "DRAFT", sourceJobAttemptId: "attempt", sourceGenerationJobId: JOB, sourceShotRevisionId: SHOT,
    providerRequestId: null, durationMs: null, rowVersion: 1, createdAt: "2026-10-06T00:00:00.000Z",
  } as MediaAssetRecord;
}

function generator() {
  let created = 0;
  const media = {
    prepareShotGenerationInTransaction: async () => ({ projectId: PROJECT, promptText: "prompt", dialogue: null }),
    findReusableShotAssetsInTransaction: async () => [{ asset: asset(), jobId: JOB }],
  } as unknown as MediaAssetStore;
  const jobs = {
    createQueueOrReuse: async (_scope: unknown, resolveJob: (client: unknown) => Promise<{ kind: string; body?: unknown }>) => {
      const resolved = await resolveJob({});
      if (resolved.kind === "reuse") return { replayed: false, status: 200, body: resolved.body };
      created += 1;
      return { replayed: false, status: 202, body: { workflowRunId: "run-new", jobId: "job-new", dispatchSeq: 1 } };
    },
  } as unknown as JobPersistenceService;
  const service = new StudioService(jobs, {} as RuntimeStore, {} as TextChainService, WORKSPACE, undefined, media, true, root);
  return {
    generate: () => service.generateShotImage(SHOT, {}, { actorId: "owner", traceId: "t", idempotencyKey: "k" }),
    created: () => created,
  };
}

const read = () => readBoundedMockPng(root, KEY, { byteSize: PNG.length, checksumSha256: CHECKSUM });

afterEach(async () => {
  Object.assign(faults, { lstat: null, realpath: null, open: null, read: null });
  await rm(root, { recursive: true, force: true });
});

describe("mock object reader failure classes", () => {
  it("reports a proven missing object as NOT_FOUND and damaged bytes as ASSET_CONTENT_INVALID", async () => {
    await mkdir(join(root, "mock-images"), { recursive: true });
    await expect(read()).rejects.toMatchObject({ code: "NOT_FOUND" });
    await storeObject(Buffer.concat([PNG.subarray(0, PNG.length - 1), Buffer.from([0])]));
    await expect(read()).rejects.toMatchObject({ code: "ASSET_CONTENT_INVALID" });
  });

  it.each([
    ["lstat", "EACCES"], ["lstat", "EIO"], ["realpath", "EACCES"], ["realpath", "EIO"],
    ["open", "EMFILE"], ["open", "EACCES"], ["read", "EIO"],
  ] as const)("reports %s %s as ASSET_STORAGE_ERROR without the path", async (call, code) => {
    await storeObject();
    faults[call] = code;
    const error = await read().catch((caught: unknown) => caught as Error & { code: string });
    expect(error).toMatchObject({ code: "ASSET_STORAGE_ERROR" });
    expect(error.message).not.toMatch(/secret|objects|mock-images|[A-Z]:\\/);
  });
});

describe("input reuse under filesystem faults", () => {
  it("reuses a valid object, falls back only on a missing or damaged one", async () => {
    await storeObject();
    const valid = generator();
    expect(await valid.generate()).toMatchObject({ status: 200, body: { cache: "HIT", assetId: "asset-1" } });
    expect(valid.created()).toBe(0);
    await rm(join(root, KEY));
    const missing = generator();
    expect(await missing.generate()).toMatchObject({ status: 202 });
    expect(missing.created()).toBe(1);
    await storeObject(Buffer.concat([PNG.subarray(0, PNG.length - 1), Buffer.from([0])]));
    const damaged = generator();
    expect(await damaged.generate()).toMatchObject({ status: 202 });
    expect(damaged.created()).toBe(1);
  });

  it.each([["lstat", "EACCES"], ["realpath", "EIO"], ["open", "EMFILE"], ["read", "EIO"]] as const)(
    "fails the request on %s %s, creates no job, and reuses again once the fault clears",
    async (call, code) => {
      await storeObject();
      faults[call] = code;
      const faulty = generator();
      await expect(faulty.generate()).rejects.toMatchObject({ code: "ASSET_STORAGE_ERROR" });
      expect(faulty.created()).toBe(0);
      faults[call] = null;
      const healed = generator();
      expect(await healed.generate()).toMatchObject({ status: 200, body: { cache: "HIT", assetId: "asset-1" } });
      expect(healed.created()).toBe(0);
    },
  );
});
