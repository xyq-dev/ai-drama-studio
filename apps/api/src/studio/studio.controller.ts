import { Body, Controller, Get, Headers, Inject, Param, Post, Query, Req, Res } from "@nestjs/common";
import { PersistenceError, RuntimeStore } from "@ai-drama/database";
import { RUNTIME_STORE, STUDIO_SERVICE } from "./tokens";
import { StudioService, createTraceId, type StudioContext } from "./studio.service";

interface StatusResponse {
  status(code: number): void;
}

interface SseResponse {
  status(code: number): SseResponse;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
  write(chunk: string): void;
}

interface SseRequest {
  on(event: "close", listener: () => void): void;
}

@Controller()
export class StudioController {
  constructor(@Inject(STUDIO_SERVICE) private readonly studio: StudioService) {}

  @Post("projects")
  createProject(
    @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-trace-id") traceHeader?: string,
  ) {
    return this.send(response, this.studio.createProject(body, this.context(idempotencyKey, traceHeader)));
  }

  @Get("projects")
  listProjects(@Query("cursor") cursor?: string) {
    return this.studio.listProjects(cursor);
  }

  @Get("projects/:projectId")
  getProject(@Param("projectId") projectId: string) {
    return this.studio.getProject(projectId);
  }

  @Post("projects/:projectId/workflows/mock")
  createMockWorkflow(
    @Param("projectId") projectId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-trace-id") traceHeader?: string,
  ) {
    return this.send(
      response,
      this.studio.createMockWorkflow(projectId, body, this.context(idempotencyKey, traceHeader)),
    );
  }

  @Get("projects/:projectId/workflow-runs")
  listWorkflows(@Param("projectId") projectId: string) {
    return this.studio.listWorkflows(projectId);
  }

  @Get("generation-jobs/:jobId")
  getJob(@Param("jobId") jobId: string) {
    return this.studio.getJob(jobId);
  }

  @Post("generation-jobs/:jobId/cancel")
  cancelJob(
    @Param("jobId") jobId: string,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-trace-id") traceHeader?: string,
  ) {
    return this.send(response, this.studio.cancelJob(jobId, this.context(idempotencyKey, traceHeader)));
  }

  @Post("generation-jobs/:jobId/retry")
  retryJob(
    @Param("jobId") jobId: string,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-trace-id") traceHeader?: string,
  ) {
    return this.send(response, this.studio.retryJob(jobId, this.context(idempotencyKey, traceHeader)));
  }

  @Get("workflow-runs/:runId")
  getWorkflow(@Param("runId") runId: string) {
    return this.studio.getWorkflow(runId);
  }

  @Post("workflow-runs/:runId/cancel")
  cancelWorkflow(
    @Param("runId") runId: string,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-trace-id") traceHeader?: string,
  ) {
    return this.send(response, this.studio.cancelWorkflow(runId, this.context(idempotencyKey, traceHeader)));
  }

  @Get("providers/capabilities")
  capabilities() {
    return this.studio.capabilities();
  }

  private context(idempotencyKey: string | undefined, traceHeader: string | undefined): StudioContext {
    return { actorId: "server-owner", traceId: createTraceId(traceHeader), idempotencyKey };
  }

  private async send<T>(response: StatusResponse, work: Promise<{ status: number; body: T }>): Promise<T> {
    const result = await work;
    response.status(result.status);
    return result.body;
  }
}

@Controller()
export class EventsController {
  constructor(
    @Inject(STUDIO_SERVICE) private readonly studio: StudioService,
    @Inject(RUNTIME_STORE) private readonly store: RuntimeStore,
  ) {}

  @Get("events")
  async events(
    @Req() request: SseRequest,
    @Res() response: SseResponse,
    @Headers("last-event-id") lastEventHeader?: string,
  ): Promise<void> {
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    request.on("close", () => {
      closed = true;
      if (timer) clearTimeout(timer);
    });

    const cursor = lastEventHeader && lastEventHeader.length > 0 ? lastEventHeader : "0";
    try {
      if (cursor !== "0") await this.store.assertCursor(this.studio.workspace, cursor);
    } catch (error) {
      if (closed) return;
      if (error instanceof PersistenceError) {
        response.status(error.code === "EVENT_CURSOR_EXPIRED" ? 409 : 400).json({
          error: { code: error.code, message: error.message, traceId: "sse" },
        });
        return;
      }
      throw error;
    }
    if (closed) return;

    response.status(200);
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("Connection", "keep-alive");
    let current = cursor;
    const send = async (): Promise<void> => {
      const events = await this.store.listEventsAfter(this.studio.workspace, current, 100);
      if (closed) return;
      for (const event of events) {
        if (BigInt(event.eventId) <= BigInt(current)) continue;
        current = event.eventId;
        response.write(`id: ${event.eventId}\n`);
        response.write(`event: ${event.eventType}\n`);
        response.write(
          `data: ${JSON.stringify({
            eventId: event.eventId,
            occurredAt: event.occurredAt,
            traceId: event.traceId,
            data: event.data,
          })}\n\n`,
        );
      }
    };
    const schedule = (): void => {
      if (closed) return;
      timer = setTimeout(() => {
        void send().finally(schedule);
      }, 250);
    };

    await send();
    schedule();
  }
}
