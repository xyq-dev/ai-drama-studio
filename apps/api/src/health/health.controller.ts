import { Controller, Get, HttpStatus, Res } from "@nestjs/common";
import type { ReadyHealthResponse, ServiceHealthResponse } from "@ai-drama/contracts";
import { HealthService } from "./health.service";

interface StatusResponse {
  status(code: number): void;
}

@Controller("health")
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get("live")
  live(): ServiceHealthResponse {
    return this.health.live();
  }

  @Get("ready")
  async ready(@Res({ passthrough: true }) response: StatusResponse): Promise<ReadyHealthResponse> {
    const body = await this.health.ready();
    response.status(body.status === "ok" ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return body;
  }
}
