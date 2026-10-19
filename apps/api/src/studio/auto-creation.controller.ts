import { Body, Controller, Get, Headers, Inject, Optional, Param, Post, Query, Res } from "@nestjs/common";
import { PersistenceError } from "@ai-drama/database";
import { AUTO_CREATION_SERVICE } from "./tokens";
import { createTraceId } from "./studio.service";
import { operatorProof } from "./operator-access";
import { SITE_AUTH, type RequestHeaders, type SiteAuthState } from "../auth/site-auth";
import type { AutoCreationResult, AutoCreationService } from "./auto-creation.service";

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

/** AI automatic creation routes. Private, never cached; errors use { error: { code, message } }. */
@Controller()
export class AutoCreationController {
  constructor(
    @Optional() @Inject(AUTO_CREATION_SERVICE) private readonly auto: AutoCreationService | null = null,
    @Optional() @Inject(SITE_AUTH) private readonly site: SiteAuthState | null = null,
  ) {}

  @Get("writing/auto-runs/options")
  options(@Res({ passthrough: true }) response: StatusResponse) {
    return this.send(response, (service) => service.options());
  }

  @Post("projects/:projectId/auto-runs")
  start(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers() headers: RequestHeaders,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-trace-id") traceHeader?: string,
  ) {
    return this.send(response, (service) => service.start(projectId, body, operatorProof(this.site, headers),
      { actorId: "server-owner", traceId: createTraceId(traceHeader), idempotencyKey }));
  }

  @Get("projects/:projectId/auto-runs/latest")
  latest(@Param("projectId", UUID_PARAM_PIPE) projectId: string, @Res({ passthrough: true }) response: StatusResponse) {
    return this.send(response, (service) => service.latest(projectId));
  }

  @Get("projects/:projectId/auto-runs/:runId")
  get(@Param("projectId", UUID_PARAM_PIPE) projectId: string, @Param("runId", UUID_PARAM_PIPE) runId: string,
    @Res({ passthrough: true }) response: StatusResponse) {
    return this.send(response, (service) => service.get(projectId, runId));
  }

  @Get("projects/:projectId/auto-runs/:runId/package")
  package(@Param("projectId", UUID_PARAM_PIPE) projectId: string, @Param("runId", UUID_PARAM_PIPE) runId: string,
    @Query("format") format: string | undefined, @Res({ passthrough: true }) response: StatusResponse) {
    return this.send(response, (service) => service.package(projectId, runId, format));
  }

  @Post("projects/:projectId/auto-runs/:runId/cancel")
  cancel(@Param("projectId", UUID_PARAM_PIPE) projectId: string, @Param("runId", UUID_PARAM_PIPE) runId: string,
    @Res({ passthrough: true }) response: StatusResponse) {
    return this.send(response, (service) => service.cancel(projectId, runId));
  }

  @Post("projects/:projectId/auto-runs/:runId/resume")
  resume(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Param("runId", UUID_PARAM_PIPE) runId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers() headers: RequestHeaders,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-trace-id") traceHeader?: string,
  ) {
    return this.send(response, (service) => service.resume(projectId, runId, body, operatorProof(this.site, headers),
      { actorId: "server-owner", traceId: createTraceId(traceHeader), idempotencyKey }));
  }

  @Post("projects/:projectId/auto-runs/:runId/scripts")
  scripts(@Param("projectId", UUID_PARAM_PIPE) projectId: string, @Param("runId", UUID_PARAM_PIPE) runId: string, @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse, @Headers("x-trace-id") traceHeader?: string) {
    return this.send(response, (service) => service.placeScripts(projectId, runId, body, { actorId: "server-owner", traceId: createTraceId(traceHeader) }));
  }

  private async send(response: StatusResponse, work: (service: AutoCreationService) => Promise<AutoCreationResult>): Promise<unknown> {
    response.setHeader("Cache-Control", "private, no-store");
    if (!this.auto) {
      response.status(404);
      return { error: { code: "AUTO_CREATION_DISABLED", message: "AI 自动创作没有开启。" } };
    }
    const result = await work(this.auto);
    response.status(result.status);
    if (result.download) {
      response.setHeader("Content-Type", result.download.contentType);
      response.setHeader("Content-Disposition", `attachment; filename="${result.download.fileName}"`);
      response.setHeader("X-Content-Type-Options", "nosniff");
      return result.download.text;
    }
    return result.body;
  }
}
