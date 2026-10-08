import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from "@nestjs/common";
import { PersistenceError } from "@ai-drama/database";
import { TITLE_WRITING_SERVICE } from "./tokens";
import { createTraceId } from "./studio.service";
import type { TitleWritingResult, TitleWritingService } from "./title-writing.service";

const UUID_PARAM_PIPE = {
  transform(value: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
      throw new PersistenceError("VALIDATION_ERROR", "Route parameter must be a UUID");
    }
    return value.toLowerCase();
  },
};

interface StatusResponse {
  status(code: number): void;
  setHeader(name: string, value: string): void;
}

/** Title-driven writing routes. Responses are private and never cached; error bodies use { error: { code, message } }. */
@Controller()
export class TitleWritingController {
  constructor(@Inject(TITLE_WRITING_SERVICE) private readonly writing: TitleWritingService) {}

  @Get("writing/title-runs/options")
  options(@Res({ passthrough: true }) response: StatusResponse) {
    return this.send(response, this.writing.options());
  }

  @Post("projects/:projectId/title-runs")
  start(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("x-operator-token") operatorToken?: string,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-trace-id") traceHeader?: string,
  ) {
    return this.send(response, this.writing.start(projectId, body, operatorToken,
      { actorId: "server-owner", traceId: createTraceId(traceHeader), idempotencyKey }));
  }

  @Get("projects/:projectId/title-runs/latest")
  latest(@Param("projectId", UUID_PARAM_PIPE) projectId: string, @Res({ passthrough: true }) response: StatusResponse) {
    return this.send(response, this.writing.latest(projectId));
  }

  @Get("projects/:projectId/title-runs/:runId")
  get(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Param("runId", UUID_PARAM_PIPE) runId: string,
    @Res({ passthrough: true }) response: StatusResponse,
  ) {
    return this.send(response, this.writing.get(projectId, runId));
  }

  @Post("projects/:projectId/title-runs/:runId/cancel")
  cancel(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Param("runId", UUID_PARAM_PIPE) runId: string,
    @Res({ passthrough: true }) response: StatusResponse,
  ) {
    return this.send(response, this.writing.cancel(projectId, runId));
  }

  @Post("projects/:projectId/title-runs/:runId/resume")
  resume(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Param("runId", UUID_PARAM_PIPE) runId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("x-operator-token") operatorToken?: string,
  ) {
    return this.send(response, this.writing.resume(projectId, runId, body, operatorToken));
  }

  @Post("projects/:projectId/title-runs/:runId/scripts")
  scripts(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Param("runId", UUID_PARAM_PIPE) runId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("x-trace-id") traceHeader?: string,
  ) {
    return this.send(response, this.writing.placeScripts(projectId, runId, body,
      { actorId: "server-owner", traceId: createTraceId(traceHeader) }));
  }

  private async send(response: StatusResponse, work: Promise<TitleWritingResult>): Promise<unknown> {
    const result = await work;
    response.setHeader("Cache-Control", "private, no-store");
    response.status(result.status);
    return result.body;
  }
}
