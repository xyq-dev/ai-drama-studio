import { describe, expect, it, vi } from "vitest";
import { MediaAssetStore } from "@ai-drama/database";
import { StudioService } from "./studio.service";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const revisionId = "33333333-3333-4333-8333-333333333333";
const videoId = "44444444-4444-4444-8444-444444444444";
const subtitleId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function service(flags: { av?: boolean; sm?: boolean } = {}) {
  const preflightCompose = vi.fn(async () => ({ schema: "m4.shot.compose.preflight.v1", manifest: {}, inputHash: "ab".repeat(32), guards: {} }));
  const runIdempotent = vi.fn();
  const studio = new StudioService(
    { runIdempotent } as never,
    {} as never,
    {} as never,
    workspaceId,
    undefined,
    { preflightCompose } as unknown as MediaAssetStore,
    false,
    null,
    flags.av ?? true,
    flags.sm ?? true,
  );
  return { studio, preflightCompose, runIdempotent };
}

describe("compose preflight service", () => {
  it("returns the store result without an idempotent write", async () => {
    const { studio, preflightCompose, runIdempotent } = service();
    const first = await studio.preflightShotCompose(revisionId, { videoAssetId: videoId });
    const second = await studio.preflightShotCompose(revisionId, {
      videoAssetId: videoId,
      audioAssetId: null,
      musicAssetId: null,
      subtitleAssetId: null,
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.inputHash).toBe(first.body.inputHash);
    expect(preflightCompose).toHaveBeenCalledTimes(2);
    expect(preflightCompose).toHaveBeenCalledWith(workspaceId, revisionId, {
      videoAssetId: videoId,
      audioAssetId: null,
      musicAssetId: null,
      subtitleAssetId: null,
    });
    expect(runIdempotent).not.toHaveBeenCalled();
  });

  it("rejects closed mock flags and malformed bodies before the store", async () => {
    const closed = service({ av: false });
    await expect(closed.studio.preflightShotCompose(revisionId, { videoAssetId: videoId })).rejects.toMatchObject({
      code: "CONFIGURATION_ERROR",
    });
    const speechOnly = service({ av: true, sm: false });
    await expect(speechOnly.studio.preflightShotCompose(revisionId, { videoAssetId: videoId })).resolves.toMatchObject({ status: 200 });
    await expect(speechOnly.studio.preflightShotCompose(revisionId, {
      videoAssetId: videoId,
      subtitleAssetId: subtitleId,
    })).rejects.toMatchObject({ code: "CONFIGURATION_ERROR" });
    const enabled = service();
    await expect(enabled.studio.preflightShotCompose(revisionId, { videoAssetId: videoId, objectKey: "mock/a.mp4" })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    await expect(enabled.studio.preflightShotCompose(revisionId, { videoAssetId: videoId, workspaceId })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(closed.preflightCompose).not.toHaveBeenCalled();
    expect(enabled.preflightCompose).not.toHaveBeenCalled();
  });
});
