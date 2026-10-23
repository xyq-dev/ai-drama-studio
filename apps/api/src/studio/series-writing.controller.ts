import { Body, Controller, Get, Headers, Inject, Optional, Param, Post, Query, Res } from "@nestjs/common";
import { PersistenceError } from "@ai-drama/database";
import { SERIES_WRITING_SERVICE } from "./tokens";
import { createTraceId } from "./studio.service";
import { operatorProof } from "./operator-access";
import { SITE_AUTH, type RequestHeaders, type SiteAuthState } from "../auth/site-auth";
import type { SeriesWritingResult, SeriesWritingService } from "./series-writing.service";

const UUID_PARAM_PIPE = {
  transform(value: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
      throw new PersistenceError("VALIDATION_ERROR", "Route parameter must be a UUID");
    }
    return value.toLowerCase();
  },
};

const BATCH_PARAM_PIPE = {
  transform(value: string): number {
    if (!/^([1-9]|1[0-9]|20)$/.test(value)) throw new PersistenceError("VALIDATION_ERROR", "Batch number must be 1 to 20");
    return Number(value);
  },
};

interface StatusResponse {
  status(code: number): void;
  setHeader(name: string, value: string): void;
}

/** Series writing routes. Private, never cached; errors use { error: { code, message } }. */
@Controller()
export class SeriesWritingController {
  constructor(
    @Optional() @Inject(SERIES_WRITING_SERVICE) private readonly series: SeriesWritingService | null = null,
    @Optional() @Inject(SITE_AUTH) private readonly site: SiteAuthState | null = null,
  ) {}

  @Get("writing/series/options")
  options(@Res({ passthrough: true }) response: StatusResponse) {
    return this.send(response, (service) => service.options());
  }

  @Post("writing/series")
  create(@Body() body: unknown, @Res({ passthrough: true }) response: StatusResponse, @Headers() headers: RequestHeaders,
    @Headers("idempotency-key") idempotencyKey?: string, @Headers("x-trace-id") traceHeader?: string) {
    return this.send(response, (service) => service.create(body, operatorProof(this.site, headers),
      { actorId: "server-owner", traceId: createTraceId(traceHeader), idempotencyKey }));
  }

  @Get("projects/:projectId/series")
  get(@Param("projectId", UUID_PARAM_PIPE) projectId: string, @Res({ passthrough: true }) response: StatusResponse) {
    return this.send(response, (service) => service.get(projectId));
  }

  @Get("projects/:projectId/series/package")
  package(@Param("projectId", UUID_PARAM_PIPE) projectId: string, @Query("format") format: string | undefined, @Res({ passthrough: true }) response: StatusResponse) {
    return this.send(response, (service) => service.package(projectId, format));
  }

  @Post("projects/:projectId/series/grants")
  grant(@Param("projectId", UUID_PARAM_PIPE) projectId: string, @Body() body: unknown, @Res({ passthrough: true }) response: StatusResponse,
    @Headers() headers: RequestHeaders, @Headers("idempotency-key") idempotencyKey?: string, @Headers("x-trace-id") traceHeader?: string) {
    return this.send(response, (service) => service.grant(projectId, body, operatorProof(this.site, headers),
      { actorId: "server-owner", traceId: createTraceId(traceHeader), idempotencyKey }));
  }

  @Post("projects/:projectId/series/grants/:grantId/cancel")
  cancel(@Param("projectId", UUID_PARAM_PIPE) projectId: string, @Param("grantId", UUID_PARAM_PIPE) grantId: string,
    @Res({ passthrough: true }) response: StatusResponse) {
    return this.send(response, (service) => service.cancel(projectId, grantId));
  }

  @Post("projects/:projectId/series/grants/:grantId/resume")
  resume(@Param("projectId", UUID_PARAM_PIPE) projectId: string, @Param("grantId", UUID_PARAM_PIPE) grantId: string, @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse, @Headers() headers: RequestHeaders, @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-trace-id") traceHeader?: string) {
    return this.send(response, (service) => service.resume(projectId, grantId, body, operatorProof(this.site, headers),
      { actorId: "server-owner", traceId: createTraceId(traceHeader), idempotencyKey }));
  }

  @Post("projects/:projectId/series/batches/:batchNo/scripts")
  place(@Param("projectId", UUID_PARAM_PIPE) projectId: string, @Param("batchNo", BATCH_PARAM_PIPE) batchNo: number, @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse, @Headers("x-trace-id") traceHeader?: string) {
    return this.send(response, (service) => service.placeBatch(projectId, batchNo, body, { actorId: "server-owner", traceId: createTraceId(traceHeader) }));
  }

  @Post("projects/:projectId/series/plan-revisions")
  plan(@Param("projectId", UUID_PARAM_PIPE) projectId: string, @Body() body: unknown, @Res({ passthrough: true }) response: StatusResponse,
    @Headers("x-trace-id") traceHeader?: string) {
    return this.send(response, (service) => service.savePlan(projectId, body, { actorId: "server-owner", traceId: createTraceId(traceHeader) }));
  }

  @Post("projects/:projectId/series/ledger-revisions")
  ledger(@Param("projectId", UUID_PARAM_PIPE) projectId: string, @Body() body: unknown, @Res({ passthrough: true }) response: StatusResponse,
    @Headers("x-trace-id") traceHeader?: string) {
    return this.send(response, (service) => service.saveLedger(projectId, body, { actorId: "server-owner", traceId: createTraceId(traceHeader) }));
  }

  @Post("projects/:projectId/series/decisions")
  decide(@Param("projectId", UUID_PARAM_PIPE) projectId: string, @Body() body: unknown, @Res({ passthrough: true }) response: StatusResponse,
    @Headers("x-trace-id") traceHeader?: string) {
    return this.send(response, (service) => service.decide(projectId, body, { actorId: "server-owner", traceId: createTraceId(traceHeader) }));
  }

  private async send(response: StatusResponse, work: (service: SeriesWritingService) => Promise<SeriesWritingResult>): Promise<unknown> {
    response.setHeader("Cache-Control", "private, no-store");
    if (!this.series) {
      response.status(404);
      return { error: { code: "SERIES_WRITING_DISABLED", message: "系列编剧没有开启。" } };
    }
    const result = await work(this.series);
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
