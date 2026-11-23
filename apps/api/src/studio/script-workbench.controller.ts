import { Body, Controller, Get, Headers, Inject, Injectable, Param, Post, Query, Res, UseGuards, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { SITE_AUTH, type RequestHeaders, type SiteAuthState } from "../auth/site-auth";
import type { ScriptWorkbenchService } from "./script-workbench.service";
export const SCRIPT_WORKBENCH_SERVICE = Symbol("SCRIPT_WORKBENCH_SERVICE");
interface Response { status(code: number): void; setHeader(name: string, value: string): void }
/** Staff accounts share the legacy project owner. Its personal recycle bin cannot represent staff authority or audit. */
@Injectable()
class CreatorRecycleBinGuard implements CanActivate {
  constructor(@Inject(SITE_AUTH) private readonly site: SiteAuthState) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.site.kind === "disabled") return true;
    if (this.site.kind !== "enabled") return false;
    const request = context.switchToHttp().getRequest<{ headers: RequestHeaders }>();
    return !this.site.auth.peek(request.headers).staffId;
  }
}

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
  @UseGuards(CreatorRecycleBinGuard)
  @Get("script-workbench/trash")
  trash(@Query("cursor") cursor: string | undefined, @Res({ passthrough: true }) response: Response) {
    response.setHeader("Cache-Control", "no-store"); return this.workbench.listTrash(cursor);
  }
  @UseGuards(CreatorRecycleBinGuard)
  @Get("projects/:projectId/script-workbench/deletion-preview")
  previewProject(@Param("projectId") projectId: string, @Res({ passthrough: true }) response: Response) {
    response.setHeader("Cache-Control", "no-store"); return this.workbench.previewProject(projectId);
  }
  @UseGuards(CreatorRecycleBinGuard)
  @Get("projects/:projectId/episodes/:episodeId/scripts/:revisionId/deletion-preview")
  previewRevision(@Param("projectId") projectId: string, @Param("episodeId") episodeId: string, @Param("revisionId") revisionId: string,
    @Res({ passthrough: true }) response: Response) {
    response.setHeader("Cache-Control", "no-store"); return this.workbench.previewRevision(projectId, episodeId, revisionId);
  }
  @UseGuards(CreatorRecycleBinGuard)
  @Post("projects/:projectId/script-workbench/trash")
  trashProject(@Param("projectId") projectId: string, @Body() body: unknown) { return this.workbench.trashProject(projectId, body); }
  @UseGuards(CreatorRecycleBinGuard)
  @Post("projects/:projectId/script-workbench/restore")
  restoreProject(@Param("projectId") projectId: string, @Body() body: unknown) { return this.workbench.restoreProject(projectId, body); }
  @UseGuards(CreatorRecycleBinGuard)
  @Post("projects/:projectId/episodes/:episodeId/scripts/:revisionId/trash")
  trashRevision(@Param("projectId") projectId: string, @Param("episodeId") episodeId: string, @Param("revisionId") revisionId: string, @Body() body: unknown) {
    return this.workbench.trashRevision(projectId, episodeId, revisionId, body);
  }
  @UseGuards(CreatorRecycleBinGuard)
  @Post("projects/:projectId/episodes/:episodeId/scripts/:revisionId/restore")
  restoreRevision(@Param("projectId") projectId: string, @Param("episodeId") episodeId: string, @Param("revisionId") revisionId: string, @Body() body: unknown) {
    return this.workbench.restoreRevision(projectId, episodeId, revisionId, body);
  }
}
