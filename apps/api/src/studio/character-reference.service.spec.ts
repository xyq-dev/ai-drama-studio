import { describe, expect, it, vi } from "vitest";
import {
  PersistenceError,
  type CharacterReferenceStore,
  type JobPersistenceService,
  type MediaAssetStore,
  type RuntimeStore,
  type TextChainService,
} from "@ai-drama/database";
import { StudioService } from "./studio.service";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const SHOT = "33333333-3333-4333-8333-333333333333";
const REVISION = "44444444-4444-4444-8444-444444444444";
const context = { actorId: "owner", traceId: "t", idempotencyKey: "k" };

function capturingJobs() {
  const created: Array<{ kind: string; inputSnapshot: Record<string, unknown> }> = [];
  const jobs = {
    createQueueOrReuse: async (_scope: unknown, resolve: (client: unknown) => Promise<{ kind: string; input: never }>) => {
      const resolved = await resolve({});
      created.push(resolved.input);
      return { replayed: false, status: 202, body: { jobId: "job", workflowRunId: "run", dispatchSeq: 1 } };
    },
    createAndQueueWorkflowJob: async (_scope: unknown, resolve: (client: unknown) => Promise<never>) => {
      created.push(await resolve({}));
      return { replayed: false, status: 202, body: { jobId: "job", workflowRunId: "run", dispatchSeq: 1 } };
    },
  } as unknown as JobPersistenceService;
  return { jobs, created };
}

const media = {
  prepareShotGenerationInTransaction: async () => ({ projectId: PROJECT, promptText: "prompt", dialogue: "line" }),
  findReusableShotAssetsInTransaction: async () => [],
} as unknown as MediaAssetStore;

function service(options: { gate: "legacy" | "strict"; references?: Partial<CharacterReferenceStore>; imageEnabled?: boolean }) {
  const { jobs, created } = capturingJobs();
  const studio = new StudioService(jobs, {} as RuntimeStore, {} as TextChainService, WORKSPACE, undefined, media,
    options.imageEnabled ?? true, "/tmp/unused", true, false, false, null, false, false,
    options.references as CharacterReferenceStore | undefined, options.gate);
  return { studio, created };
}

describe("character reference video gate", () => {
  it("keeps the legacy video snapshot unchanged and never consults reference storage", async () => {
    const strictVideoReferencesInTransaction = vi.fn();
    const { studio, created } = service({ gate: "legacy", references: { strictVideoReferencesInTransaction } });
    await studio.generateShotVideo(SHOT, {}, context);
    expect(strictVideoReferencesInTransaction).not.toHaveBeenCalled();
    expect(created[0]?.inputSnapshot).not.toHaveProperty("characterReferences");
    expect(created[0]?.inputSnapshot.schema).toBe("m3.mock.video.v1");
  });

  it("freezes the selected references into the strict video input", async () => {
    const refs = [{ characterRevisionId: REVISION, assetId: "asset-1", checksumSha256: "ab".repeat(32) }];
    const { studio, created } = service({ gate: "strict", references: {
      strictVideoReferencesInTransaction: vi.fn(async () => refs) } });
    await studio.generateShotVideo(SHOT, {}, context);
    expect(created[0]?.inputSnapshot.characterReferences).toEqual(refs);
  });

  it("refuses a strict video without storage or with an unusable reference, and does not gate speech", async () => {
    const missing = service({ gate: "strict" });
    await expect(missing.studio.generateShotVideo(SHOT, {}, context))
      .rejects.toMatchObject({ code: "CHARACTER_REFERENCE_STORAGE_UNAVAILABLE" });
    const refused = service({ gate: "strict", references: { strictVideoReferencesInTransaction: async () => {
      throw new PersistenceError("CHARACTER_REFERENCE_REQUIRED", "missing selection");
    } } });
    await expect(refused.studio.generateShotVideo(SHOT, {}, context)).rejects.toMatchObject({ code: "CHARACTER_REFERENCE_REQUIRED" });
    expect(refused.created).toHaveLength(0);
    await refused.studio.generateShotTts(SHOT, {}, context);
    expect(refused.created[0]?.inputSnapshot).not.toHaveProperty("characterReferences");
  });
});

describe("character reference generation", () => {
  it("needs the Mock image switch and reference storage", async () => {
    await expect(service({ gate: "legacy", imageEnabled: false }).studio.generateCharacterReference(REVISION, {}, context))
      .rejects.toMatchObject({ code: "CONFIGURATION_ERROR" });
    await expect(service({ gate: "legacy" }).studio.generateCharacterReference(REVISION, {}, context))
      .rejects.toMatchObject({ code: "CHARACTER_REFERENCE_STORAGE_UNAVAILABLE" });
  });

  it("queues a reference job bound to the character revision content, without a shot", async () => {
    const { studio, created } = service({ gate: "legacy", references: {
      prepareGenerationInTransaction: async () => ({ projectId: PROJECT, characterId: "c", characterContentHash: "cd".repeat(32),
        providerConfigurationId: "p" }),
    } });
    await studio.generateCharacterReference(REVISION, { seed: "s1" }, context);
    expect(created[0]).toMatchObject({ kind: "MEDIA_CHARACTER_REFERENCE", projectId: PROJECT });
    expect(created[0]).not.toHaveProperty("sourceShotRevisionId");
    expect(created[0]?.inputSnapshot).toEqual({ schema: "m3.mock.character-reference.v1", characterRevisionId: REVISION,
      characterContentHash: "cd".repeat(32), seed: "s1", bypassCache: false, outcome: "success", executionMode: "sync",
      capability: "image.generate" });
  });

  it("validates review and selection bodies before touching storage", async () => {
    const { studio } = service({ gate: "legacy", references: {} });
    await expect(studio.reviewCharacterReference("a", { decision: "MAYBE" }, context)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(studio.selectCharacterReference("c", { assetId: "nope", expectedSelectedAssetId: null }, context))
      .rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
