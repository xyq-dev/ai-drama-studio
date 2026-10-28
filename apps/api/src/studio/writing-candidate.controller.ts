import { Body, Controller, Get, Headers, Inject, Optional, Param, Post, Query, Res } from "@nestjs/common";
import { PersistenceError } from "@ai-drama/database";
import { SITE_AUTH, type RequestHeaders, type SiteAuthState } from "../auth/site-auth";
import { operatorProof } from "./operator-access";
import { createTraceId } from "./studio.service";
import { WRITING_CANDIDATE_SERVICE } from "./tokens";
import type { WritingCandidateResult, WritingCandidateService } from "./writing-candidate.service";

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

/** Online candidates of the workbench writing assistant. Responses are private and never cached. */
@Controller()
export class WritingCandidateController {
  constructor(
    @Inject(WRITING_CANDIDATE_SERVICE) private readonly candidates: WritingCandidateService | null,
    @Optional() @Inject(SITE_AUTH) private readonly site: SiteAuthState | null = null,
  ) {}

  @Get("writing/candidates/options")
  options(@Res({ passthrough: true }) response: StatusResponse) {
    return this.send(response, (service) => service.options());
  }

  @Post("projects/:projectId/writing/candidates")
  start(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Body() body: unknown,
    @Headers() headers: RequestHeaders,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-trace-id") traceHeader?: string,
  ) {
    return this.send(response, (service) => service.start(projectId, body, operatorProof(this.site, headers),
      { actorId: "server-owner", traceId: createTraceId(traceHeader), idempotencyKey }));
  }

  @Get("projects/:projectId/writing/candidates")
  list(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Query() query: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
  ) {
    return this.send(response, (service) => service.list(projectId, query));
  }

  @Get("projects/:projectId/writing/candidates/:requestId")
  get(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Param("requestId", UUID_PARAM_PIPE) requestId: string,
    @Res({ passthrough: true }) response: StatusResponse,
  ) {
    return this.send(response, (service) => service.get(projectId, requestId));
  }

  private async send(response: StatusResponse, work: (service: WritingCandidateService) => Promise<WritingCandidateResult>): Promise<unknown> {
    response.setHeader("Cache-Control", "private, no-store");
    if (!this.candidates) {
      response.status(404);
      return { error: { code: "WRITING_CANDIDATE_DISABLED", message: "在线创作没有开启。" } };
    }
    const result = await work(this.candidates);
    response.status(result.status);
    return result.body;
  }
}
