import { describe, expect, it, vi } from "vitest";
import { VOICE_COMPOSE_JOB_SCHEMA } from "@ai-drama/domain";
import { PersistenceError } from "@ai-drama/database";
import { VoiceComposeService } from "./voice-compose.service";

const workspaceId = "11111111-1111-4111-8111-111111111111", shotRevisionId = "22222222-2222-4222-8222-222222222222";
const projectId = "33333333-3333-4333-8333-333333333333", planRevisionId = "44444444-4444-4444-8444-444444444444";
const request = { planRevisionId, videoAssetId: "55555555-5555-4555-8555-555555555555", expectedInputHash: "a".repeat(64) };
const context = { actorId: "owner", traceId: "trace", idempotencyKey: "voice-render-1" };
function setup(enabled = true) {
  const freezeInTransaction = vi.fn(async () => ({ projectId, snapshot: { schema: VOICE_COMPOSE_JOB_SCHEMA }, inputHash: "b".repeat(64) }));
  const storageReady = vi.fn(async () => true);
  const client = { transaction: "same" };
  const createAndQueueWorkflowJob = vi.fn(async (_scope: unknown, factory: (c: unknown) => Promise<unknown>) => {
    const frozen = await factory(client);
    return { status: 202, body: { workflowRunId: "workflow", jobId: "job", dispatchSeq: 1, frozen }, replayed: false };
  });
  const service = new VoiceComposeService({ workspaceId, enabled, jobs: { createAndQueueWorkflowJob } as never,
    store: { freezeInTransaction } as never, speech: { storageReady } });
  return { service, freezeInTransaction, storageReady, createAndQueueWorkflowJob, client };
}
describe("voice composition submits to the existing job chain", () => {
  it("freezes authoritative sources in the same idempotent Job transaction and uses MEDIA_COMPOSE", async () => {
    const { service, freezeInTransaction, createAndQueueWorkflowJob, client } = setup();
    const result = await service.render(shotRevisionId, request, context);
    expect(result.status).toBe(202);
    expect(freezeInTransaction).toHaveBeenCalledWith(client, workspaceId, shotRevisionId, expect.objectContaining({
      planRevisionId, originalAudio: "mute", ducking: true, musicGain: 0.25,
    }));
    expect(createAndQueueWorkflowJob.mock.calls[0]?.[0]).toMatchObject({ workspaceId, actorId: "owner", httpMethod: "POST",
      routeKey: `/shot-revisions/${shotRevisionId}/voice-compose`, key: context.idempotencyKey });
    expect(result.body).toMatchObject({ frozen: { workspaceId, projectId, sourceShotRevisionId: shotRevisionId,
      type: VOICE_COMPOSE_JOB_SCHEMA, kind: "MEDIA_COMPOSE", inputHash: "b".repeat(64), inputSnapshot: { schema: VOICE_COMPOSE_JOB_SCHEMA } } });
  });
  it("fails closed when disabled, unavailable or given client paths, settings or a missing command key", async () => {
    const closed = setup(false);
    await expect(closed.service.render(shotRevisionId, request, context)).rejects.toMatchObject({ code: "CONFIGURATION_ERROR" });
    expect(closed.createAndQueueWorkflowJob).not.toHaveBeenCalled();
    const unavailable = setup(); unavailable.storageReady.mockResolvedValue(false);
    await expect(unavailable.service.render(shotRevisionId, request, context)).rejects.toMatchObject({ code: "SPEECH_STORAGE_UNAVAILABLE" });
    for (const extra of [{ fontPath: "/private/font" }, { objectKey: "remote/file" }, { musicGain: 4 }]) {
      const configured = setup();
      await expect(configured.service.render(shotRevisionId, { ...request, ...extra }, context)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
      expect(configured.createAndQueueWorkflowJob).not.toHaveBeenCalled();
    }
    const configured = setup();
    await expect(configured.service.render(shotRevisionId, request, { ...context, idempotencyKey: undefined })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(configured.createAndQueueWorkflowJob).not.toHaveBeenCalled();
  });
  it("does not queue an obsolete preflight when authoritative selection validation fails", async () => {
    const { service, freezeInTransaction } = setup();
    freezeInTransaction.mockRejectedValue(new PersistenceError("COMPOSE_INPUT_CHANGED", "Sources changed"));
    await expect(service.render(shotRevisionId, request, context)).rejects.toMatchObject({ code: "COMPOSE_INPUT_CHANGED" });
  });
});
