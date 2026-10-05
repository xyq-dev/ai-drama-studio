import { createHash, randomUUID } from "node:crypto";
import { SAMPLE_VIDEO_FIXTURE_IDS, SAMPLE_VIDEO_SCHEMA, sampleVideoDescription, type SampleVideoFixtureId } from "@ai-drama/contracts";
import { DomainError, parseComposePreflightRequest, parseComposeRenderRequest, parseComposeReviewRequest, parseEpisodeComposePreflightRequest, parseEpisodeComposeRenderRequest, regenerationSeed } from "@ai-drama/domain";
import { qwenWebAccessDecision } from "@ai-drama/providers";
import {
  JobPersistenceService,
  MediaAssetStore,
  MockTextService,
  PersistenceError,
  RuntimeStore,
  isMockMediaJobKind,
  TextChainService,
  insertProject,
  requestHash,
  type IdempotencyScope,
  type MockSceneSnapshot,
  type MockShotSnapshot,
  type TextEntityKind,
} from "@ai-drama/database";
import { z } from "zod";
import { assertReadableMockAv, readBoundedMockAv } from "./mock-av-content";
import { readBoundedMockSm } from "./mock-sm-content";
import { assertReadableMockImage, readBoundedMockPng } from "./mock-image-content";
import { readCompositeContent, readVerifiedCompositeBytes } from "./compose-content";
import { episodeExportBody, exportIdentity, holdEpisodeExportLatch, parseExpectedContentHash } from "./episode-export";

const projectBodySchema = z.object({
  title: z.string().min(1).max(200),
  premise: z.string().max(4000).default(""),
});

const mockWorkflowSchema = z.object({
  outcome: z.enum(["success", "retryable_failure", "terminal_failure", "cancel", "delayed"]).default("success"),
  label: z.string().max(200).default("mock"),
});

const storyRevisionBodySchema = z.object({
  content: z.record(z.string(), z.unknown()),
});

const scriptRevisionBodySchema = z.object({
  storyRevisionId: z.string().uuid().optional(),
  sourceStoryRevisionId: z.string().uuid().optional(),
  content: z.record(z.string(), z.unknown()),
}).superRefine((value, context) => {
  if (!value.storyRevisionId && !value.sourceStoryRevisionId) {
    context.addIssue({ code: "custom", message: "storyRevisionId is required" });
  }
  if (
    value.storyRevisionId &&
    value.sourceStoryRevisionId &&
    value.storyRevisionId !== value.sourceStoryRevisionId
  ) {
    context.addIssue({ code: "custom", message: "story revision fields must match" });
  }
});

const reviewBodySchema = z.object({
  to: z.enum(["IN_REVIEW", "REJECTED", "APPROVED"]),
  expectedReviewVersion: z.number().int().min(1).max(2_147_483_647),
  reviewNote: z.string().max(4000).nullable().optional(),
});

const sceneBodySchema = z.object({
  sourceScriptRevisionId: z.string().uuid(),
  locationRevisionId: z.string().uuid().nullable().optional(),
  ordinal: z.number().int().min(1).max(2_147_483_647),
  heading: z.string().min(1).max(400),
  timeOfDay: z.string().max(100).nullable().optional(),
  summary: z.string().max(4000),
});

const shotBodySchema = z.object({
  sourceSceneRevisionId: z.string().uuid(),
  ordinal: z.number().int().min(1).max(2_147_483_647),
  shotType: z.string().min(1).max(100),
  camera: z.string().max(1000),
  action: z.string().max(4000),
  dialogue: z.string().max(4000).nullable().optional(),
  durationHint: z.string().max(200).nullable().optional(),
  promptText: z.string().max(8000),
});

const generateImageBodySchema = z.object({
  seed: z.string().max(200).optional(),
  bypassCache: z.boolean().optional(),
}).strict();
const generateVideoBodySchema = generateImageBodySchema.extend({
  fixtureId: z.enum(SAMPLE_VIDEO_FIXTURE_IDS).optional(),
}).strict();

const textEntityBodySchema = z.object({
  projectId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(200).optional(),
  sourceScriptRevisionId: z.string().uuid(),
  content: z.record(z.string(), z.unknown()),
});

export interface StudioContext {
  actorId: string;
  traceId: string;
  idempotencyKey?: string;
}

export class StudioService {
  constructor(
    private readonly jobs: JobPersistenceService,
    private readonly store: RuntimeStore,
    private readonly textChain: TextChainService,
    private readonly workspaceId: string,
    private readonly mockText?: MockTextService,
    private readonly mediaAssets?: MediaAssetStore,
    private readonly mockImageEnabled = false,
    private readonly mockObjectDir: string | null = null,
    private readonly mockAvEnabled = false,
    private readonly mockSmEnabled = false,
    private readonly localComposeEnabled = false,
    private readonly composeObjectDir: string | null = null,
    private readonly episodeComposeEnabled = false,
    private readonly mockSampleVideoEnabled = false,
    private readonly qwenWebEnabled = false,
    private readonly nodeEnv: "development" | "test" | "production" = "production",
    private readonly qwenOperatorToken: string | null = null,
  ) {}

  get workspace(): string {
    return this.workspaceId;
  }

  async createProject(body: unknown, context: StudioContext) {
    const input = parse(projectBodySchema, rejectClientWorkspace(body));
    return this.jobs.runIdempotent(this.scope(context, "POST", "/projects", input), 201, (client) =>
      insertProject(client, { workspaceId: this.workspaceId, title: input.title, premise: input.premise }),
    );
  }

  async listProjects(cursor?: string) {
    return this.store.listProjects(this.workspaceId, 20, cursor);
  }

  async getProject(projectId: string) {
    return this.store.getProject(this.workspaceId, projectId);
  }

  getProjectCostSummary(projectId: string) {
    return this.store.readProjectCostSummary(this.workspaceId, projectId);
  }

  async createStoryRevision(
    projectId: string,
    body: unknown,
    ifMatch: string | undefined,
    context: StudioContext,
  ) {
    await this.store.getProject(this.workspaceId, projectId);
    const input = parse(storyRevisionBodySchema, rejectClientWorkspace(body));
    if (!containsOnlyFiniteJsonValues(input.content)) {
      throw new PersistenceError("INVALID_STORY", "Story content contains a value PostgreSQL jsonb cannot store");
    }
    const expectedVersion = parseAggregateVersion(ifMatch);
    const request = { content: input.content, expectedVersion };
    try {
      return await this.jobs.runIdempotent(
        this.scope(context, "POST", `/projects/${projectId}/stories`, request),
        201,
        (client) =>
          this.textChain.createStoryRevisionInTransaction(client, {
            workspaceId: this.workspaceId,
            projectId,
            content: input.content,
            createdBy: context.actorId,
            expectedVersion,
            traceId: context.traceId,
          }),
      );
    } catch (error) {
      if (isCanonicalContentError(error)) {
        throw new PersistenceError("INVALID_STORY", "Story content is invalid");
      }
      throw error;
    }
  }

  async listStoryRevisions(projectId: string, cursor?: string) {
    await this.store.getProject(this.workspaceId, projectId);
    return this.textChain.listStoryRevisions(this.workspaceId, projectId, cursor);
  }

  async listEpisodes(projectId: string) {
    await this.store.getProject(this.workspaceId, projectId);
    return { items: await this.textChain.listEpisodes(this.workspaceId, projectId) };
  }

  async listTextEntities(kind: TextEntityKind, projectId: string, cursor?: string, limit?: string) {
    await this.store.getProject(this.workspaceId, projectId);
    return this.textChain.listTextEntities(kind, this.workspaceId, projectId, cursor, parsePageLimit(limit));
  }

  async listScenes(projectId: string, episodeId: string, cursor?: string, limit?: string) {
    await this.store.getProject(this.workspaceId, projectId);
    return this.textChain.listScenes(
      this.workspaceId, projectId, episodeId, cursor, parsePageLimit(limit),
    );
  }

  async listShots(
    projectId: string, episodeId: string, sceneId: string, cursor?: string, limit?: string,
  ) {
    await this.store.getProject(this.workspaceId, projectId);
    return this.textChain.listShots(
      this.workspaceId, projectId, episodeId, sceneId, cursor, parsePageLimit(limit),
    );
  }

  async createTextEntity(
    kind: TextEntityKind, projectId: string, entityId: string | undefined,
    body: unknown, ifMatch: string | undefined, context: StudioContext,
  ) {
    await this.store.getProject(this.workspaceId, projectId);
    const input = parse(textEntityBodySchema, rejectClientWorkspace(body));
    if (input.projectId && input.projectId.toLowerCase() !== projectId) {
      throw new PersistenceError("VALIDATION_ERROR", "Project does not match route");
    }
    if (!entityId && !input.name) {
      throw new PersistenceError("VALIDATION_ERROR", "Name is required");
    }
    if (!containsOnlyFiniteJsonValues(input.content)) {
      throw new PersistenceError("VALIDATION_ERROR", "Entity content is invalid");
    }
    const expectedVersion = parseAggregateVersion(ifMatch);
    const sourceScriptRevisionId = input.sourceScriptRevisionId.toLowerCase();
    const route = entityId
      ? `/projects/${projectId}/${kind}s/${entityId}/revisions`
      : `/projects/${projectId}/${kind}s`;
    try {
      return await this.jobs.runIdempotent(
        this.scope(context, "POST", route, {
          name: entityId ? undefined : input.name, sourceScriptRevisionId, content: input.content, expectedVersion,
        }),
        201,
        (client) => this.textChain.createTextEntityRevisionInTransaction(client, {
          kind, workspaceId: this.workspaceId, projectId, entityId, name: input.name,
          sourceScriptRevisionId, content: input.content, createdBy: context.actorId,
          expectedVersion, traceId: context.traceId,
        }),
      );
    } catch (error) {
      if (isCanonicalContentError(error)) {
        throw new PersistenceError("VALIDATION_ERROR", "Entity content is invalid");
      }
      if (kind === "character" && error && typeof error === "object" &&
          "constraint" in error && error.constraint === "character_active_name_idx") {
        throw new PersistenceError("DUPLICATE_CHARACTER_NAME", "Name already exists in project");
      }
      throw error;
    }
  }

  async listTextEntityRevisions(kind: TextEntityKind, projectId: string, entityId: string) {
    await this.store.getProject(this.workspaceId, projectId);
    return this.textChain.listTextEntityRevisions(kind, this.workspaceId, projectId, entityId);
  }

  async reviewTextEntity(
    kind: TextEntityKind, projectId: string, entityId: string, revisionId: string,
    body: unknown, ifMatch: string | undefined, context: StudioContext,
  ) {
    await this.store.getProject(this.workspaceId, projectId);
    const input = parse(reviewBodySchema, rejectClientWorkspace(body));
    const expectedVersion = parseAggregateVersion(ifMatch);
    try {
      return await this.jobs.runIdempotent(
        this.scope(context, "POST", `/projects/${projectId}/${kind}s/${entityId}/revisions/${revisionId}/review`, {
          ...input, expectedVersion,
        }),
        200,
        (client) => this.textChain.reviewTextEntityInTransaction(client, {
          kind, workspaceId: this.workspaceId, projectId, entityId, revisionId,
          expectedVersion, expectedReviewVersion: input.expectedReviewVersion,
          to: input.to, reviewedBy: context.actorId, reviewNote: input.reviewNote,
          traceId: context.traceId,
        }),
      );
    } catch (error) {
      throwReviewTransitionError(error);
    }
  }

  async createSceneRevision(
    projectId: string, episodeId: string, sceneId: string | undefined,
    body: unknown, ifMatch: string | undefined, context: StudioContext,
  ) {
    await this.store.getProject(this.workspaceId, projectId);
    await this.textChain.requireEpisode(this.workspaceId, projectId, episodeId);
    if (sceneId) {
      await this.textChain.listSceneRevisions(this.workspaceId, projectId, episodeId, sceneId);
    }
    const input = parse(sceneBodySchema, rejectClientWorkspace(body));
    const expectedVersion = parseAggregateVersion(ifMatch);
    const request = {
      ...input,
      sourceScriptRevisionId: input.sourceScriptRevisionId.toLowerCase(),
      locationRevisionId: input.locationRevisionId?.toLowerCase() ?? null,
      expectedVersion,
    };
    const route = sceneId
      ? `/projects/${projectId}/episodes/${episodeId}/scenes/${sceneId}/revisions`
      : `/projects/${projectId}/episodes/${episodeId}/scenes`;
    return this.jobs.runIdempotent(this.scope(context, "POST", route, request), 201,
      (client) => this.textChain.createSceneRevisionInTransaction(client, {
        ...request, workspaceId: this.workspaceId, projectId, episodeId, sceneId,
        createdBy: context.actorId, traceId: context.traceId,
      }));
  }

  async listSceneRevisions(projectId: string, episodeId: string, sceneId: string) {
    await this.store.getProject(this.workspaceId, projectId);
    return this.textChain.listSceneRevisions(this.workspaceId, projectId, episodeId, sceneId);
  }

  async createShotRevision(
    projectId: string, episodeId: string, sceneId: string, shotId: string | undefined,
    body: unknown, ifMatch: string | undefined, context: StudioContext,
  ) {
    await this.store.getProject(this.workspaceId, projectId);
    await this.textChain.listSceneRevisions(this.workspaceId, projectId, episodeId, sceneId);
    if (shotId) await this.textChain.listShotRevisions(this.workspaceId, projectId, sceneId, shotId);
    const input = parse(shotBodySchema, rejectClientWorkspace(body));
    const expectedVersion = parseAggregateVersion(ifMatch);
    const request = {
      ...input, sourceSceneRevisionId: input.sourceSceneRevisionId.toLowerCase(),
      dialogue: input.dialogue ?? null, durationHint: input.durationHint ?? null,
      expectedVersion,
    };
    const route = shotId
      ? `/projects/${projectId}/episodes/${episodeId}/scenes/${sceneId}/shots/${shotId}/revisions`
      : `/projects/${projectId}/episodes/${episodeId}/scenes/${sceneId}/shots`;
    return this.jobs.runIdempotent(this.scope(context, "POST", route, request), 201,
      (client) => this.textChain.createShotScopedInTransaction(client, {
        ...request, workspaceId: this.workspaceId, projectId, sceneId, shotId,
        createdBy: context.actorId, traceId: context.traceId,
      }));
  }

  async listShotRevisions(projectId: string, episodeId: string, sceneId: string, shotId: string) {
    await this.store.getProject(this.workspaceId, projectId);
    await this.textChain.listSceneRevisions(this.workspaceId, projectId, episodeId, sceneId);
    return this.textChain.listShotRevisions(this.workspaceId, projectId, sceneId, shotId);
  }

  async reviewSceneShot(
    kind: "scene" | "shot", projectId: string, episodeId: string,
    sceneId: string, shotId: string | undefined, revisionId: string,
    body: unknown, ifMatch: string | undefined, context: StudioContext,
  ) {
    await this.store.getProject(this.workspaceId, projectId);
    await this.textChain.listSceneRevisions(this.workspaceId, projectId, episodeId, sceneId);
    if (shotId) await this.textChain.listShotRevisions(this.workspaceId, projectId, sceneId, shotId);
    const input = parse(reviewBodySchema, rejectClientWorkspace(body));
    const expectedVersion = parseAggregateVersion(ifMatch);
    const route = kind === "scene"
      ? `/projects/${projectId}/episodes/${episodeId}/scenes/${sceneId}/revisions/${revisionId}/review`
      : `/projects/${projectId}/episodes/${episodeId}/scenes/${sceneId}/shots/${shotId}/revisions/${revisionId}/review`;
    try {
      return await this.jobs.runIdempotent(
        this.scope(context, "POST", route, { ...input, expectedVersion }), 200,
        (client) => this.textChain.reviewSceneShotInTransaction(client, {
          kind, workspaceId: this.workspaceId, projectId, episodeId, sceneId, shotId, revisionId,
          expectedVersion, expectedReviewVersion: input.expectedReviewVersion, to: input.to,
          reviewedBy: context.actorId, reviewNote: input.reviewNote, traceId: context.traceId,
        }),
      );
    } catch (error) {
      throwReviewTransitionError(error);
    }
  }

  async createScriptRevision(
    projectId: string,
    episodeId: string,
    body: unknown,
    ifMatch: string | undefined,
    context: StudioContext,
  ) {
    await this.store.getProject(this.workspaceId, projectId);
    const episode = await this.textChain.requireEpisode(this.workspaceId, projectId, episodeId);
    const input = parse(scriptRevisionBodySchema, rejectClientWorkspace(body));
    if (!containsOnlyFiniteJsonValues(input.content)) {
      throw new PersistenceError("INVALID_SCRIPT", "Script content contains a non-finite number");
    }
    const expectedVersion = parseAggregateVersion(ifMatch);
    const sourceStoryRevisionId = (input.storyRevisionId ?? input.sourceStoryRevisionId)?.toLowerCase();
    if (!sourceStoryRevisionId) {
      throw new PersistenceError("VALIDATION_ERROR", "storyRevisionId is required");
    }
    const request = {
      storyRevisionId: sourceStoryRevisionId,
      content: input.content,
      expectedVersion,
    };
    try {
      return await this.jobs.runIdempotent(
        this.scope(
          context,
          "POST",
          `/episodes/${episode.id}/scripts`,
          request,
        ),
        201,
        (client) =>
          this.textChain.createScriptRevisionInTransaction(client, {
            workspaceId: this.workspaceId,
            projectId,
            episodeId: episode.id,
            sourceStoryRevisionId,
            content: input.content,
            createdBy: context.actorId,
            expectedVersion,
            traceId: context.traceId,
          }),
      );
    } catch (error) {
      if (error instanceof PersistenceError && error.code === "REVIEW_REQUIRED") {
        throw new PersistenceError("SOURCE_STORY_REQUIRED", error.message);
      }
      if (isCanonicalContentError(error)) {
        throw new PersistenceError("INVALID_SCRIPT", "Script content is invalid");
      }
      throw error;
    }
  }

  async listScriptRevisions(projectId: string, episodeId: string, cursor?: string) {
    await this.store.getProject(this.workspaceId, projectId);
    await this.textChain.requireEpisode(this.workspaceId, projectId, episodeId);
    return this.textChain.listScriptRevisions(this.workspaceId, projectId, episodeId, cursor);
  }

  async reviewStoryRevision(
    projectId: string,
    revisionId: string,
    body: unknown,
    ifMatch: string | undefined,
    context: StudioContext,
  ) {
    await this.store.getProject(this.workspaceId, projectId);
    const input = parse(reviewBodySchema, rejectClientWorkspace(body));
    const expectedVersion = parseAggregateVersion(ifMatch);
    const request = { ...input, expectedVersion };
    try {
      return await this.jobs.runIdempotent(
        this.scope(context, "POST", `/projects/${projectId}/stories/${revisionId}/review`, request),
        200,
        async (client) => {
        const revision = await this.textChain.requireStoryRevisionInTransaction(
          client,
          this.workspaceId,
          revisionId,
        );
        if (revision.projectId !== projectId) {
          throw new PersistenceError("NOT_FOUND", "Story revision not found in project");
        }
        if (input.to === "APPROVED") {
          return this.textChain.approveStoryInTransaction(client, {
            workspaceId: this.workspaceId,
            projectId,
            revisionId,
            expectedVersion,
            expectedReviewVersion: input.expectedReviewVersion,
            reviewedBy: context.actorId,
            reviewNote: input.reviewNote ?? null,
            traceId: context.traceId,
          });
        }
        return this.textChain.transitionReviewInTransaction(client, {
          table: "story_revision",
          revisionId,
          workspaceId: this.workspaceId,
          expectedVersion,
          expectedReviewVersion: input.expectedReviewVersion,
          to: input.to,
          reviewedBy: input.to === "REJECTED" ? context.actorId : undefined,
          reviewNote: input.reviewNote ?? null,
          traceId: context.traceId,
        });
        },
      );
    } catch (error) {
      throwReviewTransitionError(error);
    }
  }

  async reviewScriptRevisionById(
    revisionId: string,
    body: unknown,
    ifMatch: string | undefined,
    context: StudioContext,
  ) {
    const revision = await this.textChain.requireScriptRevision(this.workspaceId, revisionId);
    return this.reviewScriptRevisionWithRoute(
      revision.projectId,
      revision.episodeId,
      revisionId,
      body,
      ifMatch,
      context,
      `/script-revisions/${revisionId}/review`,
    );
  }

  async reviewScriptRevision(
    projectId: string,
    episodeId: string,
    revisionId: string,
    body: unknown,
    ifMatch: string | undefined,
    context: StudioContext,
  ) {
    return this.reviewScriptRevisionWithRoute(
      projectId,
      episodeId,
      revisionId,
      body,
      ifMatch,
      context,
      `/projects/${projectId}/episodes/${episodeId}/scripts/${revisionId}/review`,
    );
  }

  private async reviewScriptRevisionWithRoute(
    projectId: string,
    episodeId: string,
    revisionId: string,
    body: unknown,
    ifMatch: string | undefined,
    context: StudioContext,
    routeKey: string,
  ) {
    await this.store.getProject(this.workspaceId, projectId);
    const input = parse(reviewBodySchema, rejectClientWorkspace(body));
    const expectedVersion = parseAggregateVersion(ifMatch);
    const request = { ...input, expectedVersion };
    try {
      return await this.jobs.runIdempotent(
        this.scope(context, "POST", routeKey, request),
        200,
        async (client) => {
        const revision = await this.textChain.requireScriptRevisionInTransaction(
          client,
          this.workspaceId,
          revisionId,
        );
        if (revision.projectId !== projectId || revision.episodeId !== episodeId) {
          throw new PersistenceError("NOT_FOUND", "Script revision not found in route scope");
        }
        if (input.to === "APPROVED") {
          return this.textChain.approveScriptInTransaction(client, {
            workspaceId: this.workspaceId,
            episodeId,
            revisionId,
            expectedVersion,
            expectedReviewVersion: input.expectedReviewVersion,
            reviewedBy: context.actorId,
            reviewNote: input.reviewNote ?? null,
            traceId: context.traceId,
          });
        }
        return this.textChain.transitionReviewInTransaction(client, {
          table: "script_revision",
          revisionId,
          workspaceId: this.workspaceId,
          expectedVersion,
          expectedReviewVersion: input.expectedReviewVersion,
          to: input.to,
          reviewedBy: input.to === "REJECTED" ? context.actorId : undefined,
          reviewNote: input.reviewNote ?? null,
          traceId: context.traceId,
        });
        },
      );
    } catch (error) {
      throwReviewTransitionError(error);
    }
  }

  async listScriptRevisionsByEpisode(episodeId: string, cursor?: string) {
    const episode = await this.textChain.requireEpisode(this.workspaceId, undefined, episodeId);
    return this.textChain.listScriptRevisions(
      this.workspaceId,
      episode.projectId,
      episodeId,
      cursor,
    );
  }

  async createScriptRevisionByEpisode(
    episodeId: string,
    body: unknown,
    ifMatch: string | undefined,
    context: StudioContext,
  ) {
    const episode = await this.textChain.requireEpisode(this.workspaceId, undefined, episodeId);
    return this.createScriptRevision(episode.projectId, episodeId, body, ifMatch, context);
  }

  async createMockWorkflow(projectId: string, body: unknown, context: StudioContext) {
    await this.store.getProject(this.workspaceId, projectId);
    const input = parse(mockWorkflowSchema, rejectClientWorkspace(body));
    await this.store.ensureMockProvider(this.workspaceId);
    const snapshot = { outcome: input.outcome, label: input.label };
    return this.jobs.createAndQueueWorkflowJob(this.scope(context, "POST", `/projects/${projectId}/workflows/mock`, input), {
      workspaceId: this.workspaceId,
      projectId,
      type: "MOCK_GENERATION",
      requestedBy: context.actorId,
      kind: "MOCK",
      inputHash: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
      inputSnapshot: snapshot,
      traceId: context.traceId,
    });
  }

  async generateShotImage(shotRevisionId: string, body: unknown, context: StudioContext) {
    const input = parse(generateImageBodySchema, rejectClientWorkspace(body));
    if (!this.mockImageEnabled) {
      throw new PersistenceError("CONFIGURATION_ERROR", "Mock image worker storage is not enabled");
    }
    if (!this.mediaAssets) throw new PersistenceError("CONFIGURATION_ERROR", "Media assets unavailable");
    return this.jobs.createAndQueueWorkflowJob(
      this.scope(context, "POST", `/shot-revisions/${shotRevisionId}/generate-image`, input),
      async (client) => {
        const { projectId } = await this.mediaAssets!.prepareShotGenerationInTransaction(
          client, this.workspaceId, shotRevisionId,
        );
        const regeneration = regenerationSeed(input.seed ?? null, input.bypassCache === true, randomUUID());
        const snapshot = { schema: "m3.mock.image.v1", shotRevisionId,
          seed: regeneration.seed, outcome: "success", bypassCache: regeneration.bypassCache };
        return { workspaceId: this.workspaceId, projectId, sourceShotRevisionId: shotRevisionId,
          type: "MEDIA_IMAGE", requestedBy: context.actorId, kind: "MEDIA_IMAGE",
          inputHash: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
          inputSnapshot: snapshot, traceId: context.traceId };
      },
    );
  }

  async generateShotVideo(shotRevisionId: string, body: unknown, context: StudioContext) {
    return this.queueMockAv(shotRevisionId, body, context, "MEDIA_VIDEO");
  }

  async generateShotTts(shotRevisionId: string, body: unknown, context: StudioContext) {
    return this.queueMockAv(shotRevisionId, body, context, "MEDIA_TTS");
  }

  async generateShotSubtitle(shotRevisionId: string, body: unknown, context: StudioContext) {
    return this.queueMockSm(shotRevisionId, body, context, "MEDIA_SUBTITLE");
  }

  async generateShotMusic(shotRevisionId: string, body: unknown, context: StudioContext) {
    return this.queueMockSm(shotRevisionId, body, context, "MEDIA_MUSIC");
  }

  async listShotAssets(shotRevisionId: string) {
    if (!this.mediaAssets) throw new PersistenceError("CONFIGURATION_ERROR", "Media assets unavailable");
    const { projectId } = await this.mediaAssets.requireShotScope(this.workspaceId, shotRevisionId);
    return { items: await this.mediaAssets.listShotAssets(this.workspaceId, projectId, shotRevisionId) };
  }

  async preflightShotCompose(shotRevisionId: string, body: unknown) {
    let selection;
    try {
      selection = parseComposePreflightRequest(rejectClientWorkspace(body));
    } catch (error) {
      if (error instanceof DomainError) throw new PersistenceError(error.code, error.message);
      throw error;
    }
    if (!this.mockAvEnabled) {
      throw new PersistenceError("CONFIGURATION_ERROR", "Mock video and speech content is not enabled");
    }
    if ((selection.subtitleAssetId || selection.musicAssetId) && !this.mockSmEnabled) {
      throw new PersistenceError("CONFIGURATION_ERROR", "Mock subtitle and music content is not enabled");
    }
    if (!this.mediaAssets) throw new PersistenceError("CONFIGURATION_ERROR", "Media assets unavailable");
    return {
      status: 200,
      body: await this.mediaAssets.preflightCompose(this.workspaceId, shotRevisionId, selection),
    };
  }

  async listEpisodeComposeCandidates(projectId: string, episodeId: string, cursor?: string, limit?: string) {
    if (!this.mediaAssets) throw new PersistenceError("CONFIGURATION_ERROR", "Media assets unavailable");
    return this.mediaAssets.listEpisodeComposeCandidates(
      this.workspaceId, projectId, episodeId, cursor, parsePageLimit(limit),
    );
  }

  async preflightEpisodeCompose(projectId: string, episodeId: string, body: unknown) {
    let request;
    try {
      request = parseEpisodeComposePreflightRequest(rejectClientWorkspace(body));
    } catch (error) {
      if (error instanceof DomainError) throw new PersistenceError(error.code, error.message);
      throw error;
    }
    if (!this.mediaAssets) throw new PersistenceError("CONFIGURATION_ERROR", "Media assets unavailable");
    return {
      status: 200,
      body: await this.mediaAssets.preflightEpisodeCompose(
        this.workspaceId, projectId, episodeId, request.compositeAssetIds,
      ),
    };
  }

  async listEpisodeComposites(projectId: string, episodeId: string, cursor?: string, limit?: string) {
    if (!this.episodeComposeEnabled) {
      throw new PersistenceError("CONFIGURATION_ERROR", "Episode compose is not enabled");
    }
    if (!this.mediaAssets) throw new PersistenceError("CONFIGURATION_ERROR", "Media assets unavailable");
    return this.mediaAssets.listEpisodeComposites(this.workspaceId, projectId, episodeId, cursor, parsePageLimit(limit));
  }

  async composeEpisode(projectId: string, episodeId: string, body: unknown, context: StudioContext) {
    if (!this.episodeComposeEnabled) {
      throw new PersistenceError("CONFIGURATION_ERROR", "Episode compose is not enabled");
    }
    let request;
    try {
      request = parseEpisodeComposeRenderRequest(rejectClientWorkspace(body));
    } catch (error) {
      if (error instanceof DomainError) throw new PersistenceError(error.code, error.message);
      throw error;
    }
    if (!this.mediaAssets) throw new PersistenceError("CONFIGURATION_ERROR", "Media assets unavailable");
    return this.jobs.createAndQueueWorkflowJob(
      this.scope(context, "POST", `/projects/${projectId}/episodes/${episodeId}/compose`, request),
      async (client) => {
        const frozen = await this.mediaAssets!.freezeEpisodeComposeInput(client, this.workspaceId, projectId, episodeId, request);
        return {
          workspaceId: this.workspaceId,
          projectId,
          type: "MEDIA_COMPOSE",
          requestedBy: context.actorId,
          kind: "MEDIA_COMPOSE",
          inputHash: frozen.inputHash,
          inputSnapshot: frozen.snapshot,
          traceId: context.traceId,
        };
      },
    );
  }

  async composeShot(shotRevisionId: string, body: unknown, context: StudioContext) {
    if (!this.localComposeEnabled || !this.mockAvEnabled) {
      throw new PersistenceError("CONFIGURATION_ERROR", "Local compose is not enabled");
    }
    let request;
    try {
      request = parseComposeRenderRequest(rejectClientWorkspace(body));
    } catch (error) {
      if (error instanceof DomainError) throw new PersistenceError(error.code, error.message);
      throw error;
    }
    if ((request.subtitleAssetId || request.musicAssetId) && !this.mockSmEnabled) {
      throw new PersistenceError("CONFIGURATION_ERROR", "Mock subtitle and music content is not enabled");
    }
    if (!this.mediaAssets) throw new PersistenceError("CONFIGURATION_ERROR", "Media assets unavailable");
    return this.jobs.createAndQueueWorkflowJob(
      this.scope(context, "POST", `/shot-revisions/${shotRevisionId}/compose`, request),
      async (client) => {
        const frozen = await this.mediaAssets!.freezeComposeInput(client, this.workspaceId, shotRevisionId, request);
        return {
          workspaceId: this.workspaceId,
          projectId: frozen.projectId,
          sourceShotRevisionId: shotRevisionId,
          type: "MEDIA_COMPOSE",
          requestedBy: context.actorId,
          kind: "MEDIA_COMPOSE",
          inputHash: frozen.inputHash,
          inputSnapshot: frozen.snapshot,
          traceId: context.traceId,
        };
      },
    );
  }

  async reviewComposite(assetId: string, body: unknown, ifMatch: string | undefined, context: StudioContext) {
    if (!this.localComposeEnabled && !this.episodeComposeEnabled) {
      throw new PersistenceError("CONFIGURATION_ERROR", "Local compose review is not enabled");
    }
    let request;
    try {
      request = parseComposeReviewRequest(rejectClientWorkspace(body));
    } catch (error) {
      if (error instanceof DomainError) throw new PersistenceError(error.code, error.message);
      throw error;
    }
    const expectedRowVersion = parseAggregateVersion(ifMatch);
    if (!this.mediaAssets) throw new PersistenceError("CONFIGURATION_ERROR", "Media assets unavailable");
    return this.jobs.runIdempotent(
      this.scope(context, "POST", `/assets/${assetId}/review`, { ...request, expectedRowVersion }),
      200,
      (client) => this.mediaAssets!.reviewComposite(client, {
        workspaceId: this.workspaceId,
        assetId,
        expectedRowVersion,
        decision: request.decision,
        note: request.note,
        contentHash: request.contentHash,
        reviewedBy: context.actorId,
        traceId: context.traceId,
        shotReviewEnabled: this.localComposeEnabled,
        episodeReviewEnabled: this.episodeComposeEnabled,
      }),
    );
  }

  async readMockAssetContent(assetId: string): Promise<{ mimeType: string; bytes: Buffer }> {
    if (!this.mediaAssets) throw new PersistenceError("CONFIGURATION_ERROR", "Media assets unavailable");
    const asset = await this.mediaAssets.getWorkspaceAsset(this.workspaceId, assetId);
    if (asset.kind === "IMAGE") {
      if (!this.mockObjectDir) throw new PersistenceError("CONFIGURATION_ERROR", "Mock object storage is not configured");
      if (!this.mockImageEnabled) {
        throw new PersistenceError("CONFIGURATION_ERROR", "Mock image content is not enabled");
      }
      assertReadableMockImage(asset);
      return {
        mimeType: "image/png",
        bytes: await readBoundedMockPng(this.mockObjectDir, asset.objectKey, {
          byteSize: asset.byteSize,
          checksumSha256: asset.checksumSha256,
        }),
      };
    }
    if (asset.kind === "VIDEO" || asset.kind === "AUDIO") {
      if (!this.mockObjectDir) throw new PersistenceError("CONFIGURATION_ERROR", "Mock object storage is not configured");
      if (!this.mockAvEnabled) {
        throw new PersistenceError("CONFIGURATION_ERROR", "Mock video and speech content is not enabled");
      }
      assertReadableMockAv(asset);
      return { mimeType: asset.mimeType, bytes: await readBoundedMockAv(this.mockObjectDir, asset) };
    }
    if (asset.kind === "COMPOSITE") {
      const schema = await this.mediaAssets.compositeOutputSchema(this.workspaceId, assetId);
      const episodeOutput = schema === "m4.episode.compose.asset.v1";
      const shotOutput = schema === "m4.shot.compose.asset.v1";
      if (episodeOutput && !this.episodeComposeEnabled) {
        throw new PersistenceError("CONFIGURATION_ERROR", "Episode compose content is not enabled");
      }
      if (shotOutput && !this.localComposeEnabled) {
        throw new PersistenceError("CONFIGURATION_ERROR", "Local compose content is not enabled");
      }
      if ((!episodeOutput && !shotOutput) || !this.composeObjectDir) {
        throw new PersistenceError("ASSET_CONTENT_INVALID", "Asset content is not a local composite");
      }
      return readCompositeContent(this.composeObjectDir, this.workspaceId, asset);
    }
    if (asset.kind === "SUBTITLE" || asset.kind === "MUSIC") {
      if (!this.mockObjectDir) throw new PersistenceError("CONFIGURATION_ERROR", "Mock object storage is not configured");
      if (!this.mockSmEnabled) {
        throw new PersistenceError("CONFIGURATION_ERROR", "Mock subtitle and music content is not enabled");
      }
      return { mimeType: asset.mimeType, bytes: await readBoundedMockSm(this.mockObjectDir, asset) };
    }
    throw new PersistenceError("ASSET_CONTENT_INVALID", "Asset content is not a stored mock recording");
  }

  async exportEpisodeComposite(
    projectId: string,
    episodeId: string,
    assetId: string,
    query: Record<string, unknown>,
  ): Promise<{ filenameStem: string; bytes: Buffer; manifest: ReturnType<typeof episodeExportBody>["manifest"] }> {
    if (!this.episodeComposeEnabled || !this.composeObjectDir || !this.mediaAssets) {
      throw new PersistenceError("CONFIGURATION_ERROR", "Episode compose is not enabled");
    }
    const expectedContentHash = parseExpectedContentHash(query);
    const request = {
      workspaceId: this.workspaceId,
      projectId,
      episodeId,
      assetId,
      expectedContentHash,
    };
    const first = await this.mediaAssets.inspectEpisodeCompositeExport(request);
    const bytes = await readVerifiedCompositeBytes(this.composeObjectDir, first);
    await holdEpisodeExportLatch();
    const second = await this.mediaAssets.inspectEpisodeCompositeExport(request);
    if (
      exportIdentity(first) !== exportIdentity(second)
      || bytes.length !== second.byteSize
      || createHash("sha256").update(bytes).digest("hex") !== second.checksumSha256
    ) {
      throw new PersistenceError("COMPOSE_INPUT_CHANGED", "Episode export sources changed");
    }
    const built = episodeExportBody(second, new Date().toISOString());
    return { filenameStem: built.filenameStem, bytes, manifest: built.manifest };
  }

  async createMockSceneWorkflow(projectId: string, context: StudioContext) {
    await this.store.getProject(this.workspaceId, projectId);
    if (!this.mockText) throw new PersistenceError("CONFIGURATION_ERROR", "Mock text service unavailable");
    await this.store.ensureMockProvider(this.workspaceId);
    return this.jobs.createAndQueueWorkflowJob(
      this.scope(context, "POST", `/projects/${projectId}/workflows/mock-scenes`, {}),
      async (tx) => {
        const snapshot: MockSceneSnapshot = {
          schema: "m2.mock.scenes.v1", projectId, requestedBy: context.actorId,
          outcome: "success", episodes: await this.mockText!.currentSources(tx, this.workspaceId, projectId),
        };
        return { workspaceId: this.workspaceId, projectId, type: "MOCK_TEXT_SCENES",
          requestedBy: context.actorId, kind: "MOCK_TEXT_SCENES",
          inputHash: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
          inputSnapshot: snapshot, traceId: context.traceId };
      },
    );
  }

  async createMockShotWorkflow(projectId: string, context: StudioContext) {
    await this.store.getProject(this.workspaceId, projectId);
    if (!this.mockText) throw new PersistenceError("CONFIGURATION_ERROR", "Mock text service unavailable");
    await this.store.ensureMockProvider(this.workspaceId);
    return this.jobs.createAndQueueWorkflowJob(
      this.scope(context, "POST", `/projects/${projectId}/workflows/mock-shots`, {}),
      async (tx) => {
        const snapshot: MockShotSnapshot = {
          schema: "m2.mock.shots.v1", projectId, requestedBy: context.actorId,
          outcome: "success", scenes: await this.mockText!.currentShotSources(tx, this.workspaceId, projectId),
        };
        return { workspaceId: this.workspaceId, projectId, type: "MOCK_TEXT_SHOTS",
          requestedBy: context.actorId, kind: "MOCK_TEXT_SHOTS",
          inputHash: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
          inputSnapshot: snapshot, traceId: context.traceId };
      },
    );
  }

  async getJob(jobId: string) {
    return this.store.getJob(this.workspaceId, jobId);
  }

  async cancelJob(jobId: string, context: StudioContext) {
    return this.jobs.cancelJobIdempotent(
      this.scope(context, "POST", `/generation-jobs/${jobId}/cancel`, {}),
      { workspaceId: this.workspaceId, jobId, traceId: context.traceId },
    );
  }

  async retryJob(jobId: string, context: StudioContext) {
    const job = await this.store.getJob(this.workspaceId, jobId);
    if (job.kind === "MEDIA_COMPOSE") {
      throw new PersistenceError("JOB_NOT_RETRYABLE", "Compose must be submitted again after a new preflight");
    }
    if (isMockMediaJobKind(job.kind)) {
      throw new PersistenceError("JOB_NOT_RETRYABLE", "Media retry is unavailable; generate again with a new idempotency key");
    }
    const retryable =
      job.state === "CANCELED" ||
      (job.state === "FAILED" &&
        job.errorCode !== null &&
        new Set(["MOCK_RETRYABLE", "MOCK_EXTERNAL_FAILED", "LEASE_EXPIRED"]).has(job.errorCode));
    return this.jobs.manualRetryIdempotent(
      this.scope(context, "POST", `/generation-jobs/${jobId}/retry`, {}),
      {
        workspaceId: this.workspaceId,
        jobId,
        requestedBy: context.actorId,
        traceId: context.traceId,
        retryable,
      },
    );
  }

  async getWorkflow(workflowRunId: string) {
    return this.store.getWorkflow(this.workspaceId, workflowRunId);
  }

  async listWorkflows(projectId: string) {
    await this.store.getProject(this.workspaceId, projectId);
    return this.store.listWorkflows(this.workspaceId, projectId);
  }

  async cancelWorkflow(workflowRunId: string, context: StudioContext) {
    return this.jobs.cancelWorkflowRunIdempotent(
      this.scope(context, "POST", `/workflow-runs/${workflowRunId}/cancel`, {}),
      { workspaceId: this.workspaceId, workflowRunId, traceId: context.traceId },
    );
  }

  qwenWebCandidate(presentedToken: string | undefined) {
    const decision = qwenWebAccessDecision({
      nodeEnv: this.nodeEnv,
      enabled: this.qwenWebEnabled,
      storageReady: false,
      configuredToken: this.qwenOperatorToken,
      presentedToken: presentedToken ?? null,
    });
    return Promise.resolve({
      status: decision.status,
      body: {
        code: decision.code,
        replayPolicy: "NOT_REPLAY_SAFE" as const,
        billingStatus: "unknown" as const,
      },
    });
  }

  capabilities() {
    return {
      providerKey: "mock",
      capability: "mock.generate",
      outcomes: ["success", "retryable_failure", "terminal_failure", "cancel", "delayed"],
    };
  }

  private queueMockAv(
    shotRevisionId: string,
    body: unknown,
    context: StudioContext,
    kind: "MEDIA_VIDEO" | "MEDIA_TTS",
  ) {
    const videoInput = kind === "MEDIA_VIDEO" ? parse(generateVideoBodySchema, rejectClientWorkspace(body)) : null;
    const input = videoInput ?? parse(generateImageBodySchema, rejectClientWorkspace(body));
    const fixtureId: SampleVideoFixtureId | undefined = videoInput?.fixtureId;
    if (fixtureId && !this.mockSampleVideoEnabled) {
      throw new PersistenceError("CONFIGURATION_ERROR", "Mock sample video is not enabled");
    }
    if (!this.mockAvEnabled) {
      throw new PersistenceError("CONFIGURATION_ERROR", "Mock video and speech worker storage is not enabled");
    }
    if (!this.mediaAssets) throw new PersistenceError("CONFIGURATION_ERROR", "Media assets unavailable");
    const route = kind === "MEDIA_VIDEO" ? "generate-video" : "generate-tts";
    const capability = kind === "MEDIA_VIDEO" ? "video.generate" : "audio.tts";
    return this.jobs.createAndQueueWorkflowJob(
      this.scope(context, "POST", `/shot-revisions/${shotRevisionId}/${route}`, input),
      async (client) => {
        const source = await this.mediaAssets!.prepareShotGenerationInTransaction(
          client, this.workspaceId, shotRevisionId, capability,
        );
        const sourceText = kind === "MEDIA_VIDEO" ? source.promptText.trim() : (source.dialogue ?? "").trim();
        if (sourceText.length === 0) {
          throw new PersistenceError(
            "VALIDATION_ERROR",
            kind === "MEDIA_VIDEO"
              ? "Saved prompt text is required before mock video"
              : "Saved dialogue is required before mock speech",
          );
        }
        const sourceHash = createHash("sha256").update(sourceText).digest("hex");
        const regeneration = regenerationSeed(input.seed ?? null, input.bypassCache === true, randomUUID());
        const description = fixtureId ? sampleVideoDescription(fixtureId) : null;
        const snapshot = description
          ? {
            schema: SAMPLE_VIDEO_SCHEMA,
            fixtureId: description.fixtureId,
            checksumSha256: description.checksumSha256,
            byteSize: description.byteSize,
            width: description.width,
            height: description.height,
            frameRate: description.frameRate,
            frameCount: description.frameCount,
            durationMs: description.durationMs,
            hasAudio: false as const,
            shotRevisionId,
            seed: regeneration.seed,
            bypassCache: regeneration.bypassCache,
            outcome: "success",
            executionMode: "sync",
            capability,
            sourceText,
            sourceHash,
          }
          : {
            schema: kind === "MEDIA_VIDEO" ? "m3.mock.video.v1" : "m3.mock.tts.v1",
            shotRevisionId,
            seed: regeneration.seed,
            bypassCache: regeneration.bypassCache,
            outcome: "success",
            executionMode: "sync",
            capability,
            sourceText,
            sourceHash,
          };
        return {
          workspaceId: this.workspaceId,
          projectId: source.projectId,
          sourceShotRevisionId: shotRevisionId,
          type: kind,
          requestedBy: context.actorId,
          kind,
          inputHash: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
          inputSnapshot: snapshot,
          traceId: context.traceId,
        };
      },
    );
  }

  private queueMockSm(
    shotRevisionId: string,
    body: unknown,
    context: StudioContext,
    kind: "MEDIA_SUBTITLE" | "MEDIA_MUSIC",
  ) {
    const input = parse(generateImageBodySchema, rejectClientWorkspace(body));
    if (!this.mockSmEnabled) {
      throw new PersistenceError("CONFIGURATION_ERROR", "Mock subtitle and music worker storage is not enabled");
    }
    if (!this.mediaAssets) throw new PersistenceError("CONFIGURATION_ERROR", "Media assets unavailable");
    const route = kind === "MEDIA_SUBTITLE" ? "generate-subtitle" : "generate-music";
    const capability = kind === "MEDIA_SUBTITLE" ? "subtitle.generate" : "audio.music";
    return this.jobs.createAndQueueWorkflowJob(
      this.scope(context, "POST", `/shot-revisions/${shotRevisionId}/${route}`, input),
      async (client) => {
        const source = await this.mediaAssets!.prepareShotGenerationInTransaction(
          client, this.workspaceId, shotRevisionId, capability,
        );
        const sourceText = kind === "MEDIA_MUSIC" ? source.promptText.trim() : (source.dialogue ?? "").trim();
        if (sourceText.length === 0) {
          throw new PersistenceError(
            "VALIDATION_ERROR",
            kind === "MEDIA_MUSIC"
              ? "Saved prompt text is required before mock music"
              : "Saved dialogue is required before mock subtitle",
          );
        }
        const snapshot = {
          schema: kind === "MEDIA_SUBTITLE" ? "m3.mock.subtitle.v1" : "m3.mock.music.v1",
          shotRevisionId,
          seed: input.seed ?? null,
          outcome: "success",
          executionMode: "sync",
          capability,
          sourceText,
          sourceHash: createHash("sha256").update(sourceText).digest("hex"),
        };
        return {
          workspaceId: this.workspaceId,
          projectId: source.projectId,
          sourceShotRevisionId: shotRevisionId,
          type: kind,
          requestedBy: context.actorId,
          kind,
          inputHash: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
          inputSnapshot: snapshot,
          traceId: context.traceId,
        };
      },
    );
  }

  private scope(context: StudioContext, method: string, routeKey: string, body: unknown): IdempotencyScope {
    if (!context.idempotencyKey) {
      throw new PersistenceError("VALIDATION_ERROR", "Idempotency-Key is required");
    }
    return {
      workspaceId: this.workspaceId,
      actorId: context.actorId,
      httpMethod: method,
      routeKey,
      key: context.idempotencyKey,
      requestHash: requestHash(body),
    };
  }
}

function rejectClientWorkspace(body: unknown): unknown {
  if (body && typeof body === "object" && !Array.isArray(body) && "workspaceId" in body) {
    throw new PersistenceError("VALIDATION_ERROR", "workspaceId is assigned by the server");
  }
  return body;
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new PersistenceError("VALIDATION_ERROR", "Request body is invalid");
  return parsed.data;
}

function parseAggregateVersion(value: string | undefined): number {
  if (!value) {
    throw new PersistenceError("VALIDATION_ERROR", "If-Match aggregate version is required");
  }
  const match = /^"?([1-9][0-9]*)"?$/.exec(value.trim());
  if (!match) {
    throw new PersistenceError("VALIDATION_ERROR", "If-Match must contain a positive aggregate version");
  }
  const parsed = Number(match[1]);
  if (!Number.isSafeInteger(parsed) || parsed > 2_147_483_647) {
    throw new PersistenceError("VALIDATION_ERROR", "If-Match aggregate version is out of range");
  }
  return parsed;
}

function parsePageLimit(value: string | undefined): number {
  if (value === undefined) return 20;
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new PersistenceError("VALIDATION_ERROR", "limit must be an integer between 1 and 100");
  }
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit > 100) {
    throw new PersistenceError("VALIDATION_ERROR", "limit must be an integer between 1 and 100");
  }
  return limit;
}

function containsOnlyFiniteJsonValues(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return isPostgresJsonString(value);
  if (Array.isArray(value)) return value.every((item) => containsOnlyFiniteJsonValues(item));
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).every(
      ([key, item]) => isPostgresJsonString(key) && containsOnlyFiniteJsonValues(item),
    );
  }
  return true;
}

function isPostgresJsonString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0) return false;

    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
      continue;
    }

    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return false;
  }
  return true;
}

function throwReviewTransitionError(error: unknown): never {
  if (error && typeof error === "object") {
    const candidate = error as { name?: unknown; code?: unknown; message?: unknown };
    const isInvalidTransition =
      candidate.name === "DomainError" && candidate.code === "REVIEW_INVALID_TRANSITION";
    const isReviewVersionConflict =
      candidate.name === "PersistenceError" && candidate.code === "REVISION_CONFLICT";
    if (isInvalidTransition || isReviewVersionConflict) {
      throw new PersistenceError(
        "REVIEW_CONFLICT",
        typeof candidate.message === "string" ? candidate.message : "Review state changed",
      );
    }
  }
  throw error;
}

function isCanonicalContentError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return (
    candidate.name === "DomainError" &&
    typeof candidate.code === "string" &&
    candidate.code.startsWith("CANONICAL_")
  );
}

export function createTraceId(header: string | undefined): string {
  return header && header.length > 0 && header.length < 200 ? header : randomUUID();
}
