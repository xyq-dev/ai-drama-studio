import { Controller, Get, Inject, Param, Res } from "@nestjs/common";
import { PRODUCTION_STATE_READONLY_SERVICE } from "./tokens";
import type { ProductionStateReadonlyResult, ProductionStateReadonlyService } from "./production-state-readonly.service";

interface StatusResponse {
  status(code: number): void;
  setHeader(name: string, value: string): void;
}

/** Existing app-wide site authentication protects both read-only production-state endpoints. */
@Controller()
export class ProductionStateReadonlyController {
  constructor(
    @Inject(PRODUCTION_STATE_READONLY_SERVICE)
    private readonly productionState: ProductionStateReadonlyService,
  ) {}

  @Get("projects/:projectId/production-state")
  state(
    @Param("projectId") projectId: string,
    @Res({ passthrough: true }) response: StatusResponse,
  ): Promise<unknown> {
    return this.send(response, this.productionState.getState(projectId));
  }

  @Get("projects/:projectId/episodes/:episodeId/production-readiness")
  readiness(
    @Param("projectId") projectId: string,
    @Param("episodeId") episodeId: string,
    @Res({ passthrough: true }) response: StatusResponse,
  ): Promise<unknown> {
    return this.send(response, this.productionState.getReadiness(projectId, episodeId));
  }

  private async send(response: StatusResponse, pending: Promise<ProductionStateReadonlyResult>): Promise<unknown> {
    response.setHeader("Cache-Control", "private, no-store");
    const result = await pending;
    response.status(result.status);
    return result.body;
  }
}
