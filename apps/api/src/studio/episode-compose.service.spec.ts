import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MediaAssetStore, type MediaAssetRecord } from "@ai-drama/database";
import { StudioService } from "./studio.service";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const episodeId = "33333333-3333-4333-8333-333333333333";
const firstAssetId = "44444444-4444-4444-8444-444444444441";
const secondAssetId = "44444444-4444-4444-8444-444444444442";

function service() {
  const preflightEpisodeCompose = vi.fn(async () => ({
    schema: "m4.episode.compose.preflight.v1",
    inputHash: "ab".repeat(32),
  }));
  const listEpisodeComposeCandidates = vi.fn(async () => ({ items: [], nextCursor: null }));
  const runIdempotent = vi.fn();
  const studio = new StudioService(
    { runIdempotent } as never,
    {} as never,
    {} as never,
    workspaceId,
    undefined,
    { preflightEpisodeCompose, listEpisodeComposeCandidates } as unknown as MediaAssetStore,
    false,
    null,
    false,
    false,
    false,
    null,
  );
  return { studio, preflightEpisodeCompose, listEpisodeComposeCandidates, runIdempotent };
}

describe("episode compose preflight service", () => {
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
    const closed = new StudioService(
      { runIdempotent: vi.fn() } as never,
      {} as never,
      {} as never,
      workspaceId,
    );
    await expect(closed.preflightEpisodeCompose(projectId, episodeId, {
      compositeAssetIds: [firstAssetId, secondAssetId],
    })).rejects.toMatchObject({ code: "CONFIGURATION_ERROR" });
    expect(preflightEpisodeCompose).not.toHaveBeenCalled();
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
      {} as never,
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

  it("reads a stored episode composite from the compose directory when mock storage is absent", async () => {
    const checksum = "ab".repeat(32);
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
      byteSize: 128,
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
      mkdtempSync(join(tmpdir(), "episode-compose-")),
      true,
    );
    await expect(studio.readMockAssetContent(assetId)).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Asset content is unavailable",
    });
    expect(getWorkspaceAsset).toHaveBeenCalledWith(workspaceId, assetId);
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
