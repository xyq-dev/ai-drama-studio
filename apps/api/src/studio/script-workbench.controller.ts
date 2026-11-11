import { Body, Controller, Get, Headers, Inject, Param, Post, Query, Res } from "@nestjs/common";
import type { ScriptWorkbenchService } from "./script-workbench.service";
export const SCRIPT_WORKBENCH_SERVICE = Symbol("SCRIPT_WORKBENCH_SERVICE");
interface Response { status(code: number): void; setHeader(name: string, value: string): void }
/** Covered by the same site-session and CSRF middleware as every existing studio mutation. */
@Controller()
export class ScriptWorkbenchController {
  constructor(@Inject(SCRIPT_WORKBENCH_SERVICE) private readonly workbench: ScriptWorkbenchService) {}
  @Get("projects/:projectId/script-workbench")
  snapshot(@Param("projectId") projectId: string, @Res({ passthrough: true }) response: Response) {
    response.setHeader("Cache-Control", "no-store"); return this.workbench.snapshot(projectId);
  }
  @Post("projects/:projectId/script-workbench/plan")
  async plan(@Param("projectId") projectId: string, @Body() body: unknown,
    @Headers("if-match") version: string | undefined, @Headers("idempotency-key") key: string | undefined,
    @Headers("x-trace-id") trace: string | undefined, @Res({ passthrough: true }) response: Response) {
    const result = await this.workbench.savePlan(projectId, body, version, key, trace); response.status(result.status); return result.body;
  }
  @Post("projects/:projectId/episodes/:episodeId/script-workbench")
  async script(@Param("projectId") projectId: string, @Param("episodeId") episodeId: string, @Body() body: unknown,
    @Headers("if-match") version: string | undefined, @Headers("idempotency-key") key: string | undefined,
    @Headers("x-trace-id") trace: string | undefined, @Res({ passthrough: true }) response: Response) {
    const result = await this.workbench.saveScript(projectId, episodeId, body, version, key, trace); response.status(result.status); return result.body;
  }
  @Get("script-workbench/trash")
  trash(@Query("cursor") cursor: string | undefined, @Res({ passthrough: true }) response: Response) {
    response.setHeader("Cache-Control", "no-store"); return this.workbench.listTrash(cursor);
  }
  @Get("projects/:projectId/script-workbench/deletion-preview")
  previewProject(@Param("projectId") projectId: string, @Res({ passthrough: true }) response: Response) {
    response.setHeader("Cache-Control", "no-store"); return this.workbench.previewProject(projectId);
  }
  @Get("projects/:projectId/episodes/:episodeId/scripts/:revisionId/deletion-preview")
  previewRevision(@Param("projectId") projectId: string, @Param("episodeId") episodeId: string, @Param("revisionId") revisionId: string,
    @Res({ passthrough: true }) response: Response) {
    response.setHeader("Cache-Control", "no-store"); return this.workbench.previewRevision(projectId, episodeId, revisionId);
  }
  @Post("projects/:projectId/script-workbench/trash")
  trashProject(@Param("projectId") projectId: string, @Body() body: unknown) { return this.workbench.trashProject(projectId, body); }
  @Post("projects/:projectId/script-workbench/restore")
  restoreProject(@Param("projectId") projectId: string, @Body() body: unknown) { return this.workbench.restoreProject(projectId, body); }
  @Post("projects/:projectId/episodes/:episodeId/scripts/:revisionId/trash")
  trashRevision(@Param("projectId") projectId: string, @Param("episodeId") episodeId: string, @Param("revisionId") revisionId: string, @Body() body: unknown) {
    return this.workbench.trashRevision(projectId, episodeId, revisionId, body);
  }
  @Post("projects/:projectId/episodes/:episodeId/scripts/:revisionId/restore")
  restoreRevision(@Param("projectId") projectId: string, @Param("episodeId") episodeId: string, @Param("revisionId") revisionId: string, @Body() body: unknown) {
    return this.workbench.restoreRevision(projectId, episodeId, revisionId, body);
  }
}
