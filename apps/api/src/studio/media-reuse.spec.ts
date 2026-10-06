import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobPersistenceService, MediaAssetRecord, MediaAssetStore, RuntimeStore, TextChainService } from "@ai-drama/database";
import { StudioService } from "./studio.service";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const SHOT = "33333333-3333-4333-8333-333333333333";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const CHECKSUM = createHash("sha256").update(PNG).digest("hex");
const root = resolve(tmpdir(), `media-reuse-${process.pid}`);

function assetFor(jobId: string, assetId: string): MediaAssetRecord {
  return {
    id: assetId, projectId: PROJECT, kind: "IMAGE", storageProvider: "mock-object-store",
    objectKey: `mock-images/${PROJECT}/${jobId}/${CHECKSUM}.png`, mimeType: "image/png", byteSize: PNG.length,
    checksumSha256: CHECKSUM, width: 1, height: 1, status: "ACTIVE", reviewStatus: "DRAFT",
    sourceJobAttemptId: "44444444-4444-4444-8444-444444444444", sourceGenerationJobId: jobId,
    sourceShotRevisionId: SHOT, providerRequestId: null, durationMs: null, rowVersion: 1,
    createdAt: "2026-10-06T00:00:00.000Z",
  } as MediaAssetRecord;
}

async function store(jobId: string, bytes = PNG): Promise<void> {
  await mkdir(join(root, "mock-images", PROJECT, jobId), { recursive: true });
  await writeFile(join(root, "mock-images", PROJECT, jobId, `${CHECKSUM}.png`), bytes);
}

function harness(candidates: Array<{ assetId: string; jobId: string }>) {
  const find = vi.fn(async () => candidates);
  const media = {
    prepareShotGenerationInTransaction: async () => ({ projectId: PROJECT, promptText: "prompt", dialogue: null }),
    findReusableShotAssetsInTransaction: find,
    getWorkspaceAsset: async (_workspace: string, assetId: string) => {
      const candidate = candidates.find((item) => item.assetId === assetId)!;
      return assetFor(candidate.jobId, assetId);
    },
  } as unknown as MediaAssetStore;
  const jobs = {
    createQueueOrReuse: async (_scope: unknown, resolveJob: (client: unknown) => Promise<{ kind: string; input?: unknown; body?: unknown }>) => {
      const resolved = await resolveJob({});
      return resolved.kind === "reuse"
        ? { replayed: false, status: 200, body: resolved.body }
        : { replayed: false, status: 202, body: { workflowRunId: "run-new", jobId: "job-new", dispatchSeq: 1 } };
    },
  } as unknown as JobPersistenceService;
  const service = new StudioService(jobs, {} as RuntimeStore, {} as TextChainService, WORKSPACE, undefined, media, true, root);
  const generate = (body: Record<string, unknown> = {}) =>
    service.generateShotImage(SHOT, body, { actorId: "owner", traceId: "t", idempotencyKey: "k" });
  return { generate, find };
}

describe("media input reuse", () => {
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reuses a readable earlier result without creating a job or cost", async () => {
    await store("55555555-5555-4555-8555-555555555555");
    const { generate } = harness([{ assetId: "asset-1", jobId: "55555555-5555-4555-8555-555555555555" }]);
    const result = await generate();
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ cache: "HIT", assetId: "asset-1",
      sourceJobId: "55555555-5555-4555-8555-555555555555", sourceShotRevisionId: SHOT, jobKind: "MEDIA_IMAGE", newCost: "none" });
  });

  it("skips a missing or damaged object and falls back to a new job", async () => {
    await store("66666666-6666-4666-8666-666666666666", Buffer.concat([PNG, Buffer.from([0])]));
    const damaged = harness([
      { assetId: "missing", jobId: "55555555-5555-4555-8555-555555555555" },
      { assetId: "damaged", jobId: "66666666-6666-4666-8666-666666666666" },
    ]);
    expect(await damaged.generate()).toMatchObject({ status: 202, body: { jobId: "job-new" } });
  });

  it("takes the next candidate when the newest one is unreadable", async () => {
    await store("77777777-7777-4777-8777-777777777777");
    const { generate } = harness([
      { assetId: "missing", jobId: "55555555-5555-4555-8555-555555555555" },
      { assetId: "good", jobId: "77777777-7777-4777-8777-777777777777" },
    ]);
    expect(await generate()).toMatchObject({ status: 200, body: { assetId: "good" } });
  });

  it("never looks up a reusable result for an explicit regeneration", async () => {
    await store("55555555-5555-4555-8555-555555555555");
    const { generate, find } = harness([{ assetId: "asset-1", jobId: "55555555-5555-4555-8555-555555555555" }]);
    expect(await generate({ bypassCache: true })).toMatchObject({ status: 202, body: { jobId: "job-new" } });
    expect(find).not.toHaveBeenCalled();
  });
});
