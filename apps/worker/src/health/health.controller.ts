import { Controller, Get, HttpStatus, Res } from "@nestjs/common";
import type { WorkerLiveResponse, WorkerReadyResponse } from "@ai-drama/contracts";
import { HealthService } from "./health.service";

interface StatusResponse {
  status(code: number): void;
}

@Controller("health")
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get("live")
  live(): WorkerLiveResponse {
    return this.health.live();
  }

  @Get("ready")
  async ready(@Res({ passthrough: true }) response: StatusResponse): Promise<WorkerReadyResponse> {
    const body = await this.health.ready();
    response.status(body.status === "ok" ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return body;
  }
}
