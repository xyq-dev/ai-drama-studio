import { Body, Controller, Get, Inject, Param, Post, Query, Res } from "@nestjs/common";
import type { ProjectLibraryService } from "./project-library.service";

export const PROJECT_LIBRARY_SERVICE = Symbol("PROJECT_LIBRARY_SERVICE");
interface ResponseHeaders { setHeader(name: string, value: string): void; status(code: number): void }

/** Existing app-wide session authentication and CSRF middleware protect all library endpoints. */
@Controller("library")
export class ProjectLibraryController {
  constructor(@Inject(PROJECT_LIBRARY_SERVICE) private readonly library: ProjectLibraryService) {}

  @Get("projects")
  list(@Query() query: unknown, @Res({ passthrough: true }) response: ResponseHeaders) {
    response.setHeader("Cache-Control", "no-store");
    return this.library.list(query);
  }

  @Post("categories")
  createCategory(@Body() body: unknown, @Res({ passthrough: true }) response: ResponseHeaders) {
    response.setHeader("Cache-Control", "no-store");
    response.status(200);
    return this.library.createCategory(body);
  }

  @Post("projects/:projectId/category")
  assignCategory(@Param("projectId") projectId: string, @Body() body: unknown,
    @Res({ passthrough: true }) response: ResponseHeaders) {
    response.setHeader("Cache-Control", "no-store");
    response.status(200);
    return this.library.assignCategory(projectId, body);
  }
}
