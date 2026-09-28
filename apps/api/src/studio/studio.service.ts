import { createHash, randomUUID } from "node:crypto";
import {
  JobPersistenceService,
  PersistenceError,
  RuntimeStore,
  TextChainService,
  insertProject,
  requestHash,
  type IdempotencyScope,
} from "@ai-drama/database";
import { z } from "zod";

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
  sourceStoryRevisionId: z.string().uuid(),
  content: z.record(z.string(), z.unknown()),
});

const reviewBodySchema = z.object({
  to: z.enum(["IN_REVIEW", "REJECTED", "APPROVED"]),
  expectedReviewVersion: z.number().int().min(1).max(2_147_483_647),
  reviewNote: z.string().max(4000).nullable().optional(),
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

  async createStoryRevision(
    projectId: string,
    body: unknown,
    ifMatch: string | undefined,
    context: StudioContext,
  ) {
    await this.store.getProject(this.workspaceId, projectId);
    const input = parse(storyRevisionBodySchema, rejectClientWorkspace(body));
    if (!containsOnlyFiniteJsonNumbers(input.content)) {
      throw new PersistenceError("INVALID_STORY", "Story content contains a non-finite number");
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

  async createScriptRevision(
    projectId: string,
    episodeId: string,
    body: unknown,
    ifMatch: string | undefined,
    context: StudioContext,
  ) {
    await this.store.getProject(this.workspaceId, projectId);
    const input = parse(scriptRevisionBodySchema, rejectClientWorkspace(body));
    if (!containsOnlyFiniteJsonNumbers(input.content)) {
      throw new PersistenceError("INVALID_SCRIPT", "Script content contains a non-finite number");
    }
    const expectedVersion = parseAggregateVersion(ifMatch);
    const request = {
      sourceStoryRevisionId: input.sourceStoryRevisionId,
      content: input.content,
      expectedVersion,
    };
    try {
      return await this.jobs.runIdempotent(
        this.scope(
          context,
          "POST",
          `/projects/${projectId}/episodes/${episodeId}/scripts`,
          request,
        ),
        201,
        (client) =>
          this.textChain.createScriptRevisionInTransaction(client, {
            workspaceId: this.workspaceId,
            projectId,
            episodeId,
            sourceStoryRevisionId: input.sourceStoryRevisionId,
            content: input.content,
            createdBy: context.actorId,
            expectedVersion,
            traceId: context.traceId,
          }),
      );
    } catch (error) {
      if (isCanonicalContentError(error)) {
        throw new PersistenceError("INVALID_SCRIPT", "Script content is invalid");
      }
      throw error;
    }
  }

  async listScriptRevisions(projectId: string, episodeId: string, cursor?: string) {
    await this.store.getProject(this.workspaceId, projectId);
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

  capabilities() {
    return {
      providerKey: "mock",
      capability: "mock.generate",
      outcomes: ["success", "retryable_failure", "terminal_failure", "cancel", "delayed"],
    };
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

function containsOnlyFiniteJsonNumbers(value: unknown): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => containsOnlyFiniteJsonNumbers(item));
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).every((item) => containsOnlyFiniteJsonNumbers(item));
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
