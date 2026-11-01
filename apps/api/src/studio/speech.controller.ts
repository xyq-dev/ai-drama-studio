import { Body, Controller, Get, Headers, Inject, Param, Post, Put, Query, Res } from "@nestjs/common";
import { PersistenceError } from "@ai-drama/database";
import { createTraceId, type StudioContext } from "./studio.service";
import type { SpeechResult, SpeechService } from "./speech.service";

export const SPEECH_SERVICE = Symbol.for("ai-drama.speech-service");
const UUID_PIPE = { transform(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new PersistenceError("VALIDATION_ERROR", "Route parameter must be a UUID");
  return value.toLowerCase();
} };
const SPEAKER_PIPE = { transform(value: string): string { return value === "narrator" ? value : UUID_PIPE.transform(value); } };
interface Response { status(code: number): void; setHeader(name: string, value: string): void }
/** Existing app-wide site authentication, Origin and CSRF guards apply to every write. */
@Controller()
export class SpeechController {
  constructor(@Inject(SPEECH_SERVICE) private readonly speech: SpeechService) {}
  @Get("projects/:projectId/speech-capabilities")
  capabilities(@Param("projectId", UUID_PIPE) projectId: string, @Res({ passthrough: true }) res: Response) {
    return this.send(res, this.speech.capabilities(projectId));
  }
  @Get("projects/:projectId/voice-bindings")
  bindings(@Param("projectId", UUID_PIPE) projectId: string, @Res({ passthrough: true }) res: Response) {
    return this.send(res, this.speech.bindings(projectId));
  }
  @Get("projects/:projectId/voice-bindings/:speakerId/impact")
  impact(@Param("projectId", UUID_PIPE) projectId: string, @Param("speakerId", SPEAKER_PIPE) speakerId: string, @Res({ passthrough: true }) res: Response) {
    return this.send(res, this.speech.bindingImpact(projectId, speakerId));
  }
  @Put("projects/:projectId/voice-bindings/:speakerId")
  putBinding(@Param("projectId", UUID_PIPE) projectId: string, @Param("speakerId", SPEAKER_PIPE) speakerId: string, @Body() body: unknown,
    @Res({ passthrough: true }) res: Response, @Headers("if-match") ifMatch?: string, @Headers("idempotency-key") key?: string, @Headers("x-trace-id") trace?: string) {
    return this.send(res, this.speech.putBinding(projectId, speakerId, body, ifMatch, this.context(key, trace)));
  }
  @Get("shot-revisions/:revisionId/speech-plan")
  plan(@Param("revisionId", UUID_PIPE) id: string, @Res({ passthrough: true }) res: Response) { return this.send(res, this.speech.plan(id)); }
  @Put("shot-revisions/:revisionId/speech-plan")
  putPlan(@Param("revisionId", UUID_PIPE) id: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response,
    @Headers("if-match") ifMatch?: string, @Headers("idempotency-key") key?: string, @Headers("x-trace-id") trace?: string) {
    return this.send(res, this.speech.putPlan(id, body, ifMatch, this.context(key, trace)));
  }
  @Get("speech-plans/:revisionId/takes")
  takes(@Param("revisionId", UUID_PIPE) id: string, @Query() query: unknown, @Res({ passthrough: true }) res: Response) { return this.send(res, this.speech.takes(id, query)); }
  @Post("speech-plans/:revisionId/lines/:lineId/quote")
  quote(@Param("revisionId", UUID_PIPE) id: string, @Param("lineId", UUID_PIPE) lineId: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    return this.send(res, this.speech.quote(id, lineId, body));
  }
  @Post("speech-plans/:revisionId/lines/:lineId/generate")
  generate(@Param("revisionId", UUID_PIPE) id: string, @Param("lineId", UUID_PIPE) lineId: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response,
    @Headers("idempotency-key") key?: string, @Headers("x-trace-id") trace?: string) {
    return this.send(res, this.speech.generate(id, lineId, body, this.context(key, trace)));
  }
  @Put("speech-plans/:revisionId/selections/:lineId")
  select(@Param("revisionId", UUID_PIPE) id: string, @Param("lineId", UUID_PIPE) lineId: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response,
    @Headers("if-match") ifMatch?: string, @Headers("idempotency-key") key?: string, @Headers("x-trace-id") trace?: string) {
    return this.send(res, this.speech.select(id, lineId, body, ifMatch, this.context(key, trace)));
  }
  @Post("speech-plans/:revisionId/mix-preflight")
  mix(@Param("revisionId", UUID_PIPE) id: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response) { return this.send(res, this.speech.mixPreflight(id, body)); }
  private context(idempotencyKey?: string, trace?: string): StudioContext { return { actorId: "server-owner", traceId: createTraceId(trace), idempotencyKey }; }
  private async send(res: Response, work: Promise<SpeechResult>): Promise<unknown> { res.setHeader("Cache-Control", "private, no-store"); const result = await work; res.status(result.status); return result.body; }
}
