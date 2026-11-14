import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from "@nestjs/common";
import { PersistenceError, ShortSequelStore } from "@ai-drama/database";
import { z } from "zod";
import { createTraceId } from "./studio.service";

export const SHORT_SEQUEL_STORE = Symbol("SHORT_SEQUEL_STORE");
export const SHORT_SEQUEL_WORKSPACE = Symbol("SHORT_SEQUEL_WORKSPACE");

const projectIdSchema = z.string().uuid();
const episodeNoSchema = z.number().int().min(2).max(6);
const episodeParam = z.string().regex(/^[2-6]$/).transform(Number);
const confirmSchema = z.object({ episodeNo: episodeNoSchema }).strict();

type Response = { setHeader(name: string, value: string): void };

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new PersistenceError("VALIDATION_ERROR", "续写参数无效，请刷新后重试。");
  return result.data;
}

@Controller("projects/:projectId/short-sequels")
export class ShortSequelController {
  constructor(
    @Inject(SHORT_SEQUEL_STORE) private readonly store: ShortSequelStore,
    @Inject(SHORT_SEQUEL_WORKSPACE) private readonly workspaceId: string,
  ) {}

  @Get()
  list(@Param("projectId") projectId: string, @Res({ passthrough: true }) response: Response) {
    response.setHeader("Cache-Control", "no-store");
    return this.store.list(this.workspaceId, parse(projectIdSchema, projectId));
  }

  @Post("confirm")
  confirm(@Param("projectId") projectId: string, @Body() body: unknown, @Headers("x-trace-id") trace: string | undefined) {
    const { episodeNo } = parse(confirmSchema, body);
    return this.store.confirm(this.workspaceId, parse(projectIdSchema, projectId), episodeNo, createTraceId(trace));
  }

  @Get(":episodeNo")
  context(@Param("projectId") projectId: string, @Param("episodeNo") episodeNo: string, @Res({ passthrough: true }) response: Response) {
    response.setHeader("Cache-Control", "no-store");
    return this.store.context(this.workspaceId, parse(projectIdSchema, projectId), parse(episodeParam, episodeNo));
  }

  @Get(":episodeNo/previous/:revisionId")
  previous(@Param("projectId") projectId: string, @Param("episodeNo") episodeNo: string, @Param("revisionId") revisionId: string,
    @Res({ passthrough: true }) response: Response) {
    response.setHeader("Cache-Control", "no-store");
    return this.store.previous(this.workspaceId, parse(projectIdSchema, projectId), parse(episodeParam, episodeNo), parse(projectIdSchema, revisionId));
  }
}
