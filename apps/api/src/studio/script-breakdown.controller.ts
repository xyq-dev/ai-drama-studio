import { Body, Controller, Get, Headers, Inject, Optional, Param, Post, Res } from "@nestjs/common";
import { PersistenceError } from "@ai-drama/database";
import { SCRIPT_BREAKDOWN_SERVICE } from "./tokens";
import { createTraceId } from "./studio.service";
import { operatorProof } from "./operator-access";
import { SITE_AUTH, type RequestHeaders, type SiteAuthState } from "../auth/site-auth";
import type { ScriptBreakdownResult, ScriptBreakdownService } from "./script-breakdown.service";

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

const BASE = "projects/:projectId/episodes/:episodeId/script-breakdowns";

/** Script breakdown routes. Responses are private and never cached; error bodies use { error: { code, message } }. */
@Controller()
export class ScriptBreakdownController {
  constructor(
    @Inject(SCRIPT_BREAKDOWN_SERVICE) private readonly breakdown: ScriptBreakdownService,
    @Optional() @Inject(SITE_AUTH) private readonly site: SiteAuthState | null = null,
  ) {}

  @Get("writing/script-breakdowns/options")
  options(@Res({ passthrough: true }) response: StatusResponse) {
    return this.send(response, this.breakdown.options());
  }

  @Post(BASE)
  start(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Param("episodeId", UUID_PARAM_PIPE) episodeId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers() headers: RequestHeaders,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-trace-id") traceHeader?: string,
  ) {
    return this.send(response, this.breakdown.start(projectId, episodeId, body, operatorProof(this.site, headers),
      { actorId: "server-owner", traceId: createTraceId(traceHeader), idempotencyKey }));
  }

  @Get(`${BASE}/latest`)
  latest(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Param("episodeId", UUID_PARAM_PIPE) episodeId: string,
    @Res({ passthrough: true }) response: StatusResponse,
  ) {
    return this.send(response, this.breakdown.latest(projectId, episodeId));
  }

  // Declared before `:runId` so the fixed path is not read as a run id.
  @Get(`${BASE}/latest-saved`)
  latestSaved(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Param("episodeId", UUID_PARAM_PIPE) episodeId: string,
    @Res({ passthrough: true }) response: StatusResponse,
  ) {
    return this.send(response, this.breakdown.latestSaved(projectId, episodeId));
  }

  @Get(`${BASE}/:runId`)
  get(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Param("episodeId", UUID_PARAM_PIPE) episodeId: string,
    @Param("runId", UUID_PARAM_PIPE) runId: string,
    @Res({ passthrough: true }) response: StatusResponse,
  ) {
    return this.send(response, this.breakdown.get(projectId, episodeId, runId));
  }

  @Post(`${BASE}/:runId/cancel`)
  cancel(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Param("episodeId", UUID_PARAM_PIPE) episodeId: string,
    @Param("runId", UUID_PARAM_PIPE) runId: string,
    @Res({ passthrough: true }) response: StatusResponse,
  ) {
    return this.send(response, this.breakdown.cancel(projectId, episodeId, runId));
  }

  @Post(`${BASE}/:runId/resume`)
  resume(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Param("episodeId", UUID_PARAM_PIPE) episodeId: string,
    @Param("runId", UUID_PARAM_PIPE) runId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers() headers: RequestHeaders,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-trace-id") traceHeader?: string,
  ) {
    return this.send(response, this.breakdown.resume(projectId, episodeId, runId, body, operatorProof(this.site, headers),
      { actorId: "server-owner", traceId: createTraceId(traceHeader), idempotencyKey }));
  }

  @Post(`${BASE}/:runId/shots`)
  shots(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Param("episodeId", UUID_PARAM_PIPE) episodeId: string,
    @Param("runId", UUID_PARAM_PIPE) runId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("x-trace-id") traceHeader?: string,
  ) {
    return this.send(response, this.breakdown.placeShots(projectId, episodeId, runId, body,
      { actorId: "server-owner", traceId: createTraceId(traceHeader) }));
  }

  private async send(response: StatusResponse, work: Promise<ScriptBreakdownResult>): Promise<unknown> {
    const result = await work;
    response.setHeader("Cache-Control", "private, no-store");
    response.status(result.status);
    return result.body;
  }
}
