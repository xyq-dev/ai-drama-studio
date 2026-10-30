import { Body, Controller, Get, Inject, Param, Post, Res } from "@nestjs/common";
import { PersistenceError } from "@ai-drama/database";
import { VIMAX_PREVIEW_SERVICE } from "./tokens";
import type { VimaxPreviewResult, VimaxPreviewService } from "./vimax-preview.service";

const UUID_PARAM_PIPE = {
  transform(value: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
      throw new PersistenceError("VALIDATION_ERROR", "Route parameter must be a UUID");
    }
    return value.toLowerCase();
  },
};
interface StatusResponse { status(code: number): void; setHeader(name: string, value: string): void }
const BASE = "projects/:projectId/episodes/:episodeId/vimax-preview";

/** App-wide site login and CSRF middleware protect these routes; a preview never calls or configures a model. */
@Controller()
export class VimaxPreviewController {
  constructor(@Inject(VIMAX_PREVIEW_SERVICE) private readonly previewService: VimaxPreviewService) {}

  @Get(`${BASE}/source`)
  source(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Param("episodeId", UUID_PARAM_PIPE) episodeId: string,
    @Res({ passthrough: true }) response: StatusResponse,
  ) {
    return this.send(response, this.previewService.source(projectId, episodeId));
  }

  @Post(BASE)
  preview(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Param("episodeId", UUID_PARAM_PIPE) episodeId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
  ) {
    return this.send(response, this.previewService.preview(projectId, episodeId, body));
  }

  private async send(response: StatusResponse, pending: Promise<VimaxPreviewResult>): Promise<unknown> {
    response.setHeader("Cache-Control", "no-store");
    const result = await pending;
    response.status(result.status);
    return result.body;
  }
}
