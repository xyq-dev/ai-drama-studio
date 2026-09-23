import { Controller, Get, HttpStatus, Res } from "@nestjs/common";
import type { AdapterHealthResponse } from "@ai-drama/contracts";
import { HealthService } from "./health.service";

interface StatusResponse {
  status(code: number): void;
}

@Controller("health")
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get("live")
  live(@Res({ passthrough: true }) response: StatusResponse): AdapterHealthResponse {
    const body = this.health.snapshot();
    response.status(body.status === "ok" ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return body;
  }

  @Get("ready")
  ready(@Res({ passthrough: true }) response: StatusResponse): AdapterHealthResponse {
    const body = this.health.snapshot();
    response.status(body.status === "ok" ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return body;
  }
}
