import { Body, Controller, Headers, Inject, Param, Post, Res } from "@nestjs/common";
import { PersistenceError } from "@ai-drama/database";
import { createTraceId } from "./studio.service";
import type { VoiceComposeService } from "./voice-compose.service";

export const VOICE_COMPOSE_SERVICE = Symbol.for("ai-drama.voice-compose-service");
function voiceComposeRouteId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new PersistenceError("VALIDATION_ERROR", "Route parameter must be a UUID");
  return value.toLowerCase();
}
interface Response { status(code: number): void; setHeader(name: string, value: string): void }

/** The application site authentication, Origin and CSRF guards protect this existing-Job write. */
@Controller()
export class VoiceComposeController {
  constructor(@Inject(VOICE_COMPOSE_SERVICE) private readonly voice: VoiceComposeService) {}
  @Post("shot-revisions/:revisionId/voice-compose")
  async render(@Param("revisionId", { transform: voiceComposeRouteId }) id: string, @Body() body: unknown, @Res({ passthrough: true }) res: Response,
    @Headers("idempotency-key") idempotencyKey?: string, @Headers("x-trace-id") trace?: string): Promise<unknown> {
    res.setHeader("Cache-Control", "private, no-store");
    const result = await this.voice.render(id, body, { actorId: "server-owner", traceId: createTraceId(trace), idempotencyKey });
    res.status(result.status);
    return result.body;
  }
}
