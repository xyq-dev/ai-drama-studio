import { Body, Controller, Get, Headers, Inject, Optional, Param, Post, Query, Req, Res, StreamableFile } from "@nestjs/common";
import { PersistenceError } from "@ai-drama/database";
import { SITE_AUTH, SiteAuthError, type RequestHeaders, type SiteAuth, type SiteAuthState } from "../auth/site-auth";
import { setAdminResponseHeaders } from "./admin-auth";
import { AdminDirectoryError, AdminDirectoryService } from "./admin-directory.service";

export const ADMIN_DIRECTORY_SERVICE = "ADMIN_DIRECTORY_SERVICE";

interface AdminResponse {
  setHeader(name: string, value: string): void;
  status(code: number): void;
}

interface ContentRequest {
  method?: string;
}

/**
 * Operator directory for works, assets, jobs, users, and operation logs.
 * Creators are rejected before any lookup, so a guessed id does not reveal whether the row exists.
 */
@Controller("admin")
export class AdminDirectoryController {
  constructor(
    @Inject(ADMIN_DIRECTORY_SERVICE) private readonly directory: AdminDirectoryService | null,
    @Optional() @Inject(SITE_AUTH) private readonly site: SiteAuthState | null = null,
  ) {}

  @Get("works")
  works(@Headers() headers: RequestHeaders, @Query() query: Record<string, string | undefined>, @Res({ passthrough: true }) response: AdminResponse) {
    return this.send(response, () => {
      const { directory } = this.operator(headers);
      return directory.works({ q: query.q, status: query.status, owner: query.owner, cursor: query.cursor, limit: number(query.limit) });
    });
  }

  @Get("works/:id")
  work(@Headers() headers: RequestHeaders, @Param("id") id: string, @Res({ passthrough: true }) response: AdminResponse) {
    return this.send(response, () => {
      const { directory } = this.operator(headers);
      return directory.workDetail(id);
    });
  }

  @Get("assets")
  assets(@Headers() headers: RequestHeaders, @Query() query: Record<string, string | undefined>, @Res({ passthrough: true }) response: AdminResponse) {
    return this.send(response, () => {
      const { directory } = this.operator(headers);
      return directory.assets({ q: query.q, type: query.type, project: query.project, cursor: query.cursor, limit: number(query.limit) });
    });
  }

  @Get("assets/:id")
  asset(@Headers() headers: RequestHeaders, @Param("id") id: string, @Res({ passthrough: true }) response: AdminResponse) {
    return this.send(response, () => {
      const { directory } = this.operator(headers);
      return directory.assetDetail(id);
    });
  }

  @Get("assets/:id/content")
  assetContent(
    @Headers() headers: RequestHeaders,
    @Param("id") id: string,
    @Req() request: ContentRequest,
    @Res({ passthrough: true }) response: AdminResponse,
  ) {
    return this.send(response, async () => {
      const { directory, session } = this.operator(headers);
      const payload = await directory.assetContent(session, id);
      response.setHeader("Content-Type", payload.mimeType);
      response.setHeader("Content-Length", String(payload.bytes.length));
      response.setHeader("X-Content-Type-Options", "nosniff");
      if (request.method === "HEAD") return undefined;
      return new StreamableFile(payload.bytes);
    });
  }

  @Get("jobs")
  jobs(@Headers() headers: RequestHeaders, @Query() query: Record<string, string | undefined>, @Res({ passthrough: true }) response: AdminResponse) {
    return this.send(response, () => {
      const { directory } = this.operator(headers);
      return directory.jobs({ q: query.q, type: query.type, status: query.status, cursor: query.cursor, limit: number(query.limit) });
    });
  }

  @Get("jobs/:id")
  job(@Headers() headers: RequestHeaders, @Param("id") id: string, @Res({ passthrough: true }) response: AdminResponse) {
    return this.send(response, () => {
      const { directory } = this.operator(headers);
      return directory.jobDetail(id);
    });
  }

  @Post("jobs/:id/retry")
  retry(
    @Headers() headers: RequestHeaders,
    @Param("id") id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: AdminResponse,
  ) {
    return this.send(response, () => {
      const { directory, auth, session } = this.operator(headers);
      authorizeJsonWrite(auth, headers);
      const input = record(body);
      return directory.retryJob(session, id, {
        confirmed: input.confirmed === true,
        idempotencyKey: header(headers, "idempotency-key"),
      });
    });
  }

  @Get("users")
  users(@Headers() headers: RequestHeaders, @Query() query: Record<string, string | undefined>, @Res({ passthrough: true }) response: AdminResponse) {
    return this.send(response, () => {
      const { directory, session } = this.operator(headers);
      return directory.users(session, { q: query.q, role: query.role, status: query.status });
    });
  }

  @Post("users/:id/status")
  userStatus(
    @Headers() headers: RequestHeaders,
    @Param("id") id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: AdminResponse,
  ) {
    return this.send(response, () => {
      const { directory, auth } = this.operator(headers);
      authorizeJsonWrite(auth, headers);
      const input = record(body);
      return directory.setUserStatus(id, { confirmed: input.confirmed === true, status: typeof input.status === "string" ? input.status : "" });
    });
  }

  @Get("logs")
  logs(@Headers() headers: RequestHeaders, @Query() query: Record<string, string | undefined>, @Res({ passthrough: true }) response: AdminResponse) {
    return this.send(response, () => {
      const { directory } = this.operator(headers);
      return directory.logs({ q: query.q, actor: query.actor, range: query.range });
    });
  }

  @Get("logs/:id")
  log(@Headers() headers: RequestHeaders, @Param("id") id: string, @Res({ passthrough: true }) response: AdminResponse) {
    return this.send(response, () => {
      const { directory } = this.operator(headers);
      return directory.logDetail(id);
    });
  }

  private operator(headers: RequestHeaders): { directory: AdminDirectoryService; auth: SiteAuth; session: { username: string; accountId: string; role: string } } {
    if (!this.directory || this.site?.kind !== "enabled") throw new SiteAuthError(503, "AUTH_NOT_CONFIGURED");
    const session = this.site.auth.session(headers);
    if (session.role !== "operator") throw new SiteAuthError(401, "AUTH_REQUIRED");
    return { directory: this.directory, auth: this.site.auth, session };
  }

  private async send(response: AdminResponse, work: () => unknown | Promise<unknown>, status = 200): Promise<unknown> {
    setAdminResponseHeaders(response);
    try {
      const body = await work();
      response.status(status);
      return body;
    } catch (cause) {
      if (cause instanceof SiteAuthError) {
        response.status(cause.status);
        return { error: { code: cause.code, message: cause.message } };
      }
      if (cause instanceof AdminDirectoryError) {
        response.status(cause.status);
        return { error: { code: cause.code, message: cause.message } };
      }
      if (cause instanceof PersistenceError && cause.code === "VALIDATION_ERROR") {
        response.status(400);
        return { error: { code: "VALIDATION_ERROR", message: "查询参数无效。" } };
      }
      response.status(503);
      return { error: { code: "ADMIN_DIRECTORY_UNAVAILABLE", message: "暂时无法读取运营数据。本次没有改动作品、素材或任务。" } };
    }
  }
}

function number(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function record(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null && !Array.isArray(body) ? body as Record<string, unknown> : {};
}

function header(headers: RequestHeaders, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return typeof value === "string" ? value : undefined;
}

function authorizeJsonWrite(auth: SiteAuth, headers: RequestHeaders): void {
  auth.authorizeWrite(headers);
  const contentType = headers["content-type"];
  if (typeof contentType !== "string" || contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    throw new SiteAuthError(415, "AUTH_CONTENT_TYPE_REJECTED");
  }
}
