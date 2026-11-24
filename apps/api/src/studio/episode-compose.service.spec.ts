import "reflect-metadata";
import { Test } from "@nestjs/testing";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PersistenceError, MediaAssetStore, type MediaAssetRecord } from "@ai-drama/database";
import { SafeExceptionFilter } from "../http/safe-exception.filter";
import { StudioController } from "./studio.controller";
import { StudioService } from "./studio.service";
import { STUDIO_SERVICE } from "./tokens";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const episodeId = "33333333-3333-4333-8333-333333333333";
const firstAssetId = "44444444-4444-4444-8444-444444444441";
const secondAssetId = "44444444-4444-4444-8444-444444444442";

function service(episodeComposeEnabled = true) {
  const preflightEpisodeCompose = vi.fn(async () => ({
    schema: "m4.episode.compose.preflight.v1",
    inputHash: "ab".repeat(32),
  }));
  const listEpisodeComposeCandidates = vi.fn(async () => ({ items: [], nextCursor: null }));
  const runIdempotent = vi.fn();
  const getProject = vi.fn();
  const listEpisodeComposites = vi.fn(async () => ({ items: [] as { assetId: string }[], nextCursor: null }));
  const createAndQueueWorkflowJob = vi.fn();
  const studio = new StudioService(
    { runIdempotent, createAndQueueWorkflowJob } as never,
    { getProject } as never,
    {} as never,
    workspaceId,
    undefined,
    { preflightEpisodeCompose, listEpisodeComposeCandidates, listEpisodeComposites } as unknown as MediaAssetStore,
    false,
    null,
    false,
    false,
    false,
    null,
    episodeComposeEnabled,
  );
  return { studio, preflightEpisodeCompose, listEpisodeComposeCandidates, runIdempotent, getProject, listEpisodeComposites, createAndQueueWorkflowJob };
}

describe("episode compose preflight service", () => {
  it("returns the owned episode’s stored list over HTTP while compose and preflight stay closed", async () => {
    const { studio, getProject, listEpisodeComposites, createAndQueueWorkflowJob, preflightEpisodeCompose } = service(false);
    const module = await Test.createTestingModule({
      controllers: [StudioController], providers: [{ provide: STUDIO_SERVICE, useValue: studio }],
    }).compile();
    const app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix("api/v1");
    app.useGlobalFilters(new SafeExceptionFilter());
    try {
      await app.listen(0, "127.0.0.1");
      const url = `${await app.getUrl()}/api/v1/projects/${projectId}/episodes/${episodeId}`;
      const empty = await fetch(`${url}/composites?limit=50`);
      expect(empty.status).toBe(200);
      expect(await empty.json()).toEqual({ items: [], nextCursor: null });
      expect(getProject).toHaveBeenCalledWith(workspaceId, projectId);
      expect(listEpisodeComposites).toHaveBeenCalledWith(workspaceId, projectId, episodeId, undefined, 50);

      const history = { items: [{ assetId: firstAssetId }], nextCursor: null };
      listEpisodeComposites.mockResolvedValueOnce(history);
      const saved = await fetch(`${url}/composites?limit=10`);
      expect(saved.status).toBe(200);
      expect(await saved.json()).toEqual(history);
      getProject.mockRejectedValueOnce(new PersistenceError("NOT_FOUND", "Project not found"));
      expect((await fetch(`${url}/composites`)).status).toBe(404);
      expect(listEpisodeComposites).toHaveBeenCalledTimes(2);

      for (const route of ["compose", "compose-preflight"]) {
        const response = await fetch(`${url}/${route}`, {
          method: "POST", headers: { "content-type": "application/json", "idempotency-key": "closed-episode" },
          body: JSON.stringify({ compositeAssetIds: [firstAssetId, secondAssetId],
            ...(route === "compose" ? { expectedInputHash: "ab".repeat(32) } : {}) }),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: { code: "CONFIGURATION_ERROR" } });
      }
      expect(preflightEpisodeCompose).not.toHaveBeenCalled();
      expect(createAndQueueWorkflowJob).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("reads candidates and returns a preflight without an idempotent write", async () => {
    const { studio, preflightEpisodeCompose, listEpisodeComposeCandidates, runIdempotent } = service();
    await expect(studio.listEpisodeComposeCandidates(projectId, episodeId, undefined, "20")).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    const first = await studio.preflightEpisodeCompose(projectId, episodeId, {
      compositeAssetIds: [firstAssetId, secondAssetId],
    });
    const second = await studio.preflightEpisodeCompose(projectId, episodeId, {
      compositeAssetIds: [firstAssetId, secondAssetId],
    });
    expect(first.status).toBe(200);
    expect(second.body.inputHash).toBe(first.body.inputHash);
    expect(preflightEpisodeCompose).toHaveBeenCalledWith(workspaceId, projectId, episodeId, [firstAssetId, secondAssetId]);
    expect(listEpisodeComposeCandidates).toHaveBeenCalledWith(workspaceId, projectId, episodeId, undefined, 20);
    expect(runIdempotent).not.toHaveBeenCalled();
  });

  it("rejects unknown fields, duplicate assets, and a missing media store before any write", async () => {
    const { studio, preflightEpisodeCompose } = service();
    await expect(studio.preflightEpisodeCompose(projectId, episodeId, {
      compositeAssetIds: [firstAssetId, secondAssetId],
      workspaceId,
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(studio.preflightEpisodeCompose(projectId, episodeId, {
      compositeAssetIds: [firstAssetId, firstAssetId],
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(studio.preflightEpisodeCompose(projectId, episodeId, {
      compositeAssetIds: [firstAssetId],
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const withoutStorage = new StudioService(
      { runIdempotent: vi.fn() } as never, {} as never, {} as never, workspaceId,
      undefined, undefined, false, null, false, false, false, null, true,
    );
    await expect(withoutStorage.preflightEpisodeCompose(projectId, episodeId, {
      compositeAssetIds: [firstAssetId, secondAssetId],
    })).rejects.toMatchObject({ code: "CONFIGURATION_ERROR" });
    expect(preflightEpisodeCompose).not.toHaveBeenCalled();
  });

  it("freezes the admin quality switch on submission for an episode render", async () => {
    const submit = vi.fn(async (_scope: unknown, create: (client: unknown) => Promise<unknown>) => create({}));
    const qualityCheckEnabled = vi.fn(async () => false);
    const freeze = vi.fn(async () => ({ snapshot: { schema: "m4.episode.compose.v1" }, inputHash: "cd".repeat(32) }));
    const studio = new StudioService({ createAndQueueWorkflowJob: submit } as never, {} as never, {} as never,
      workspaceId, undefined, { freezeEpisodeComposeInput: freeze } as never,
      false, null, false, false, false, null, true, false, undefined, "legacy", false, false, qualityCheckEnabled);
    await expect(studio.composeEpisode(projectId, episodeId, {
      compositeAssetIds: [firstAssetId, secondAssetId], expectedInputHash: "ab".repeat(32),
    }, { actorId: "creator", traceId: "trace", idempotencyKey: "one" })).resolves.toMatchObject({
      inputSnapshot: { qualityCheckEnabled: false }, inputHash: "cd".repeat(32),
    });
    expect(qualityCheckEnabled).toHaveBeenCalledOnce();
  });

  it("queues episode compose without a mock directory and refuses a closed episode switch", async () => {
    const createAndQueueWorkflowJob = vi.fn(async (_scope: unknown, factory: (client: unknown) => Promise<unknown>) => {
      await factory({});
      return { status: 202, body: { jobId: "99999999-9999-4999-8999-999999999999" } };
    });
    const freezeEpisodeComposeInput = vi.fn(async () => ({
      snapshot: { schema: "m4.episode.compose.v1", input: { episodeId } },
      inputHash: "cd".repeat(32),
    }));
    const enabled = new StudioService(
      { createAndQueueWorkflowJob } as never,
      {} as never,
      {} as never,
      workspaceId,
      undefined,
      { freezeEpisodeComposeInput } as unknown as MediaAssetStore,
      false,
      null,
      false,
      false,
      true,
      "D:\\compose-objects",
      true,
    );
    const body = { compositeAssetIds: [firstAssetId, secondAssetId], expectedInputHash: "ab".repeat(32) };
    await expect(enabled.composeEpisode(projectId, episodeId, body, {
      actorId: "user",
      traceId: "trace",
      idempotencyKey: "same-key",
    })).resolves.toMatchObject({ status: 202 });
    expect(createAndQueueWorkflowJob).toHaveBeenCalledTimes(1);
    expect(freezeEpisodeComposeInput).toHaveBeenCalledWith(expect.anything(), workspaceId, projectId, episodeId, body);
    const episodeOnly = new StudioService(
      { createAndQueueWorkflowJob } as never,
      { getProject: vi.fn() } as never,
      {} as never,
      workspaceId,
      undefined,
      { freezeEpisodeComposeInput, listEpisodeComposites: vi.fn(async () => ({ items: [], nextCursor: null })) } as unknown as MediaAssetStore,
      false,
      null,
      false,
      false,
      false,
      join(tmpdir(), "episode-compose-objects"),
      true,
    );
    await expect(episodeOnly.composeEpisode(projectId, episodeId, body, {
      actorId: "user",
      traceId: "trace",
      idempotencyKey: "episode-only",
    })).resolves.toMatchObject({ status: 202 });
    await expect(episodeOnly.listEpisodeComposites(projectId, episodeId)).resolves.toEqual({ items: [], nextCursor: null });
    expect(createAndQueueWorkflowJob).toHaveBeenCalledTimes(2);
    const closed = new StudioService(
      { createAndQueueWorkflowJob } as never,
      {} as never,
      {} as never,
      workspaceId,
      undefined,
      { freezeEpisodeComposeInput } as unknown as MediaAssetStore,
      false,
      null,
      false,
      false,
      true,
      join(tmpdir(), "episode-compose-objects"),
      false,
    );
    await expect(closed.composeEpisode(projectId, episodeId, body, {
      actorId: "user",
      traceId: "trace",
      idempotencyKey: "same-key",
    })).rejects.toMatchObject({ code: "CONFIGURATION_ERROR" });
    await expect(closed.composeShot(firstAssetId, { videoAssetId: firstAssetId, expectedInputHash: "ab".repeat(32) }, {
      actorId: "user",
      traceId: "trace",
      idempotencyKey: "shot",
    })).rejects.toMatchObject({ code: "CONFIGURATION_ERROR" });
    expect(createAndQueueWorkflowJob).toHaveBeenCalledTimes(2);
  });

  it("reads owner-scoped stored episode bytes while rendering and mock storage are off", async () => {
    const bytes = Buffer.from("stored-episode");
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const jobId = "99999999-9999-4999-8999-999999999999";
    const attemptId = "88888888-8888-4888-8888-888888888888";
    const assetId = "77777777-7777-4777-8777-777777777777";
    const objectKey = `compose/${workspaceId}/${projectId}/${jobId}/${attemptId}/${checksum}.mp4`;
    const asset: MediaAssetRecord = {
      id: assetId,
      projectId,
      kind: "COMPOSITE",
      storageProvider: "local-compose",
      objectKey,
      mimeType: "video/mp4",
      byteSize: bytes.length,
      checksumSha256: checksum,
      width: 1080,
      height: 1920,
      status: "ACTIVE",
      reviewStatus: "DRAFT",
      sourceJobAttemptId: attemptId,
      sourceGenerationJobId: jobId,
      sourceShotRevisionId: null,
      providerRequestId: null,
      durationMs: 2000,
      rowVersion: 1,
      createdAt: "2020-01-01T00:00:00.100001Z",
    };
    const getWorkspaceAsset = vi.fn(async () => asset);
    const compositeOutputSchema = vi.fn(async () => "m4.episode.compose.asset.v1");
    const root = await mkdtemp(join(tmpdir(), "episode-compose-"));
    const studio = new StudioService(
      { runIdempotent: vi.fn() } as never,
      {} as never,
      {} as never,
      workspaceId,
      undefined,
      { getWorkspaceAsset, compositeOutputSchema } as unknown as MediaAssetStore,
      false,
      null,
      false,
      false,
      false,
      root,
      false,
    );
    try {
      await expect(studio.readMockAssetContent(assetId)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await mkdir(join(root, "compose", workspaceId, projectId, jobId, attemptId), { recursive: true });
      await writeFile(join(root, objectKey), bytes);
      const content = { mimeType: "video/mp4", bytes, etag: `"${asset.checksumSha256}"` };
      await expect(studio.readMockAssetContent(assetId)).resolves.toEqual(content);
      expect(getWorkspaceAsset).toHaveBeenCalledWith(workspaceId, assetId);
      await expect(studio.readOperatorAssetContent(assetId, null)).resolves.toEqual(content);

      // A foreign or missing asset is rejected by the same owner-scoped lookup, before reading its schema or file.
      compositeOutputSchema.mockClear();
      getWorkspaceAsset.mockRejectedValueOnce(new PersistenceError("NOT_FOUND", "Asset not found"));
      await expect(studio.readMockAssetContent(assetId)).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(compositeOutputSchema).not.toHaveBeenCalled();
      await writeFile(join(root, objectKey), Buffer.alloc(bytes.length));
      await expect(studio.readMockAssetContent(assetId)).rejects.toMatchObject({ code: "ASSET_CONTENT_INVALID" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
    const image = new StudioService(
      { runIdempotent: vi.fn() } as never,
      {} as never,
      {} as never,
      workspaceId,
      undefined,
      { getWorkspaceAsset: vi.fn(async () => ({ ...asset, kind: "IMAGE" })) } as unknown as MediaAssetStore,
      false,
      null,
      false,
      false,
      false,
      null,
      false,
    );
    await expect(image.readMockAssetContent(assetId)).rejects.toMatchObject({
      code: "CONFIGURATION_ERROR",
      message: "Mock object storage is not configured",
    });
  });
});
