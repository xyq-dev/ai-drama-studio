import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from "@nestjs/common";
import { PersistenceError } from "@ai-drama/database";
import { QWEN_WEB_SERVICE } from "./tokens";
import { QwenWebService } from "./qwen-web.service";
import { createTraceId } from "./studio.service";

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

@Controller()
export class QwenWebController {
  constructor(@Inject(QWEN_WEB_SERVICE) private readonly qwen: QwenWebService) {}

  @Get("writing/qwen-candidates/status")
  status(
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("x-operator-token") operatorToken?: string,
  ) {
    return this.send(response, this.qwen.status(operatorToken));
  }

  @Post("projects/:projectId/writing/qwen-candidates")
  request(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("x-operator-token") operatorToken?: string,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-trace-id") traceHeader?: string,
  ) {
    return this.send(response, this.qwen.request(projectId, body, operatorToken,
      { actorId: "server-owner", traceId: createTraceId(traceHeader), idempotencyKey }));
  }

  @Get("projects/:projectId/writing/qwen-candidates/:requestId")
  get(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Param("requestId", UUID_PARAM_PIPE) requestId: string,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("x-operator-token") operatorToken?: string,
  ) {
    return this.send(response, this.qwen.get(projectId, requestId, operatorToken));
  }

  private async send(response: StatusResponse, work: Promise<{ status: number; body: unknown }>): Promise<unknown> {
    const result = await work;
    response.setHeader("Cache-Control", "private, no-store");
    response.status(result.status);
    return result.body;
  }
}
