import { Body, Controller, Get, Headers, Inject, Optional, Param, Post, Res } from "@nestjs/common";
import { PersistenceError } from "@ai-drama/database";
import { SITE_AUTH, type RequestHeaders, type SiteAuthState } from "../auth/site-auth";
import { operatorProof } from "./operator-access";
import { createTraceId } from "./studio.service";
import type { VimaxPlanningResult, VimaxPlanningService } from "./vimax-planning.service";
export const VIMAX_PLANNING_SERVICE = Symbol("VIMAX_PLANNING_SERVICE");
const BASE = "projects/:projectId/episodes/:episodeId/vimax-planning";
const ID = { transform(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new PersistenceError("VALIDATION_ERROR", "Invalid route id");
  return value.toLowerCase();
} };
interface StatusResponse { status(code: number): void; setHeader(name: string, value: string): void }
@Controller()
export class VimaxPlanningController {
  constructor(@Inject(VIMAX_PLANNING_SERVICE) private readonly planning: VimaxPlanningService | null,
    @Optional() @Inject(SITE_AUTH) private readonly site: SiteAuthState | null = null) {}
  @Get(`${BASE}/options`)
  options(@Param("projectId", ID) p: string, @Param("episodeId", ID) e: string, @Res({ passthrough: true }) r: StatusResponse) {
    return this.send(r, (s) => s.options(p, e));
  }
  @Get(`${BASE}/requests`)
  list(@Param("projectId", ID) p: string, @Param("episodeId", ID) e: string, @Res({ passthrough: true }) r: StatusResponse) {
    return this.send(r, (s) => s.list(p, e, "server-owner"));
  }
  @Get(`${BASE}/requests/:requestId`)
  get(@Param("projectId", ID) p: string, @Param("episodeId", ID) e: string, @Param("requestId", ID) id: string,
    @Res({ passthrough: true }) r: StatusResponse) { return this.send(r, (s) => s.get(p, e, "server-owner", id)); }
  @Post(`${BASE}/requests`)
  start(@Param("projectId", ID) p: string, @Param("episodeId", ID) e: string, @Body() body: unknown,
    @Headers() headers: RequestHeaders, @Res({ passthrough: true }) r: StatusResponse,
    @Headers("idempotency-key") key?: string, @Headers("x-trace-id") trace?: string) {
    return this.send(r, (s) => s.start(p, e, body, operatorProof(this.site, headers),
      { actorId: "server-owner", traceId: createTraceId(trace), idempotencyKey: key }));
  }
  @Post(`${BASE}/requests/:requestId/cancel`)
  cancel(@Param("projectId", ID) p: string, @Param("episodeId", ID) e: string, @Param("requestId", ID) id: string,
    @Headers() headers: RequestHeaders, @Res({ passthrough: true }) r: StatusResponse) {
    return this.send(r, (s) => s.cancel(p, e, "server-owner", id, operatorProof(this.site, headers)));
  }
  private async send(r: StatusResponse, work: (s: VimaxPlanningService) => Promise<VimaxPlanningResult>): Promise<unknown> {
    r.setHeader("Cache-Control", "private, no-store");
    const result = this.planning ? await work(this.planning) : { status: 404, body: { error: { code: "VIMAX_PLANNING_DISABLED", message: "在线规划未启用。" } } };
    r.status(result.status); return result.body;
  }
}
