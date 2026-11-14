import { Body, Controller, Get, Headers, Inject, Optional, Param, Post, Query, Res } from "@nestjs/common";
import { PersistenceError } from "@ai-drama/database";
import { SITE_AUTH, type RequestHeaders, type SiteAuthState } from "../auth/site-auth";
import { operatorProof } from "./operator-access";
import type { ShortSequelAiService } from "./short-sequel-ai.service";
import { createTraceId } from "./studio.service";

export const SHORT_SEQUEL_AI_SERVICE = Symbol("SHORT_SEQUEL_AI_SERVICE");

const UUID = { transform(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new PersistenceError("VALIDATION_ERROR", "请求中的标识格式无效。");
  }
  return value.toLowerCase();
} };

const EPISODE = { transform(value: string) {
  if (!/^[2-6]$/.test(value)) throw new PersistenceError("VALIDATION_ERROR", "续写集数必须在第 2 集至第 6 集之间。");
  return Number(value);
} };

interface StatusResponse { status(code: number): void; setHeader(name: string, value: string): void }

@Controller("projects/:projectId/short-sequels/:episodeNo/ai")
export class ShortSequelAiController {
  constructor(@Optional() @Inject(SHORT_SEQUEL_AI_SERVICE) private readonly ai: ShortSequelAiService | null = null,
    @Optional() @Inject(SITE_AUTH) private readonly site: SiteAuthState | null = null) {}

  @Get()
  latest(@Param("projectId", UUID) projectId: string, @Param("episodeNo", EPISODE) episodeNo: number,
    @Res({ passthrough: true }) response: StatusResponse) {
    return this.send(response, ai => ai.latest(projectId, episodeNo));
  }

  @Get("history")
  history(@Param("projectId", UUID) projectId: string, @Param("episodeNo", EPISODE) episodeNo: number,
    @Query("cursor") cursor: unknown, @Res({ passthrough: true }) response: StatusResponse) {
    return this.send(response, ai => ai.history(projectId, episodeNo, cursor));
  }

  @Post()
  start(@Param("projectId", UUID) projectId: string, @Param("episodeNo", EPISODE) episodeNo: number,
    @Body() body: unknown, @Res({ passthrough: true }) response: StatusResponse, @Headers() headers: RequestHeaders,
    @Headers("idempotency-key") idempotencyKey?: string, @Headers("x-trace-id") traceHeader?: string) {
    return this.send(response, ai => ai.start(projectId, episodeNo, body, operatorProof(this.site, headers),
      { actorId: "server-owner", traceId: createTraceId(traceHeader), idempotencyKey }));
  }

  @Post(":taskId/resume")
  resume(@Param("projectId", UUID) projectId: string, @Param("episodeNo", EPISODE) episodeNo: number, @Param("taskId", UUID) taskId: string,
    @Body() body: unknown, @Res({ passthrough: true }) response: StatusResponse, @Headers() headers: RequestHeaders,
    @Headers("idempotency-key") idempotencyKey?: string, @Headers("x-trace-id") traceHeader?: string) {
    return this.send(response, ai => ai.resume(projectId, episodeNo, taskId, body, operatorProof(this.site, headers),
      { actorId: "server-owner", traceId: createTraceId(traceHeader), idempotencyKey }));
  }

  private async send(response: StatusResponse, work: (ai: ShortSequelAiService) => Promise<{ status: number; body: unknown }>) {
    response.setHeader("Cache-Control", "private, no-store");
    if (!this.ai) {
      response.status(404);
      return { error: { code: "SHORT_SEQUEL_AI_DISABLED", message: "AI 续写未开启。" } };
    }
    const result = await work(this.ai);
    response.status(result.status);
    return result.body;
  }
}
