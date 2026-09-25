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
  return Number(match[1]);
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
