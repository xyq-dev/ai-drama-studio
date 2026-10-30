import { Body, Controller, Get, Headers, Inject, Param, Post, Query, Res } from "@nestjs/common";
import { PersistenceError } from "@ai-drama/database";
import { VIMAX_CANDIDATE_SERVICE } from "./tokens";
import { createTraceId, type StudioContext } from "./studio.service";
import type { VimaxCandidateResult, VimaxCandidateService } from "./vimax-candidate.service";

const UUID_PARAM_PIPE = {
  transform(value: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
      throw new PersistenceError("VALIDATION_ERROR", "Route parameter must be a UUID");
    }
    return value.toLowerCase();
  },
};
interface StatusResponse { status(code: number): void; setHeader(name: string, value: string): void }
const BASE = "projects/:projectId/episodes/:episodeId/vimax-candidates";

/** Site login and CSRF are app-wide. No candidate route can configure, reserve or send a model request. */
@Controller()
export class VimaxCandidateController {
  constructor(@Inject(VIMAX_CANDIDATE_SERVICE) private readonly candidates: VimaxCandidateService) {}

  @Get(`${BASE}/targets`)
  targets(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Param("episodeId", UUID_PARAM_PIPE) episodeId: string,
    @Res({ passthrough: true }) response: StatusResponse,
  ) { return this.send(response, this.candidates.targets(projectId, episodeId)); }

  @Get(BASE)
  list(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Param("episodeId", UUID_PARAM_PIPE) episodeId: string,
    @Query() query: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
  ) { return this.send(response, this.candidates.list(projectId, episodeId, "server-owner", query)); }

  @Get(`${BASE}/:candidateId`)
  get(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Param("episodeId", UUID_PARAM_PIPE) episodeId: string,
    @Param("candidateId", UUID_PARAM_PIPE) candidateId: string,
    @Res({ passthrough: true }) response: StatusResponse,
  ) { return this.send(response, this.candidates.get(projectId, episodeId, candidateId, "server-owner")); }

  @Post(BASE)
  create(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Param("episodeId", UUID_PARAM_PIPE) episodeId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("idempotency-key") key?: string,
    @Headers("x-trace-id") traceHeader?: string,
  ) { return this.send(response, this.candidates.create(projectId, episodeId, body, this.context(key, traceHeader))); }

  @Post(`${BASE}/:candidateId/scene`)
  saveScene(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Param("episodeId", UUID_PARAM_PIPE) episodeId: string,
    @Param("candidateId", UUID_PARAM_PIPE) candidateId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("idempotency-key") key?: string,
    @Headers("x-trace-id") traceHeader?: string,
  ) { return this.send(response, this.candidates.saveScene(projectId, episodeId, candidateId, body, this.context(key, traceHeader))); }

  @Post(`${BASE}/:candidateId/shots`)
  placeShots(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Param("episodeId", UUID_PARAM_PIPE) episodeId: string,
    @Param("candidateId", UUID_PARAM_PIPE) candidateId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("idempotency-key") key?: string,
    @Headers("x-trace-id") traceHeader?: string,
  ) { return this.send(response, this.candidates.placeShots(projectId, episodeId, candidateId, body, this.context(key, traceHeader))); }

  private context(idempotencyKey?: string, traceHeader?: string): StudioContext {
    return { actorId: "server-owner", traceId: createTraceId(traceHeader), idempotencyKey };
  }

  private async send(response: StatusResponse, work: Promise<VimaxCandidateResult>): Promise<unknown> {
    response.setHeader("Cache-Control", "private, no-store");
    const result = await work;
    response.status(result.status);
    return result.body;
  }
}
