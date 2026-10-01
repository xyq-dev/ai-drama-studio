import { Body, Controller, Get, Head, Headers, Inject, Param, Post, Query, Req, Res, StreamableFile } from "@nestjs/common";
import { PersistenceError, RuntimeStore } from "@ai-drama/database";
import { RUNTIME_STORE, STUDIO_SERVICE } from "./tokens";
import { StudioService, createTraceId, type StudioContext } from "./studio.service";

const UUID_PARAM_PIPE = {
  transform(value: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
      throw new PersistenceError("VALIDATION_ERROR", "Route parameter must be a UUID");
    }
    return value.toLowerCase();
  },
};

interface StatusResponse {
  status(code: number): void;
  setHeader(name: string, value: string): void;
}

interface ContentRequest {
  method: string;
}

interface ContentResponse {
  status(code: number): void;
  setHeader(name: string, value: string): void;
}

interface SseResponse {
  status(code: number): SseResponse;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
  write(chunk: string): void;
  flushHeaders(): void;
  end(): void;
}

interface SseRequest {
  on(event: "close", listener: () => void): void;
}

@Controller()
export class StudioController {
  constructor(@Inject(STUDIO_SERVICE) private readonly studio: StudioService) {}

  @Post("projects")
  createProject(
    @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-trace-id") traceHeader?: string,
  ) {
    return this.send(response, this.studio.createProject(body, this.context(idempotencyKey, traceHeader)));
  }

  @Get("projects")
  listProjects(@Query("cursor") cursor?: string) {
    return this.studio.listProjects(cursor);
  }

  @Get("projects/:projectId")
  getProject(@Param("projectId", UUID_PARAM_PIPE) projectId: string) {
    return this.studio.getProject(projectId);
  }

  @Post("projects/:projectId/stories")
  createStoryRevision(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("if-match") ifMatch?: string,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-trace-id") traceHeader?: string,
  ) {
    return this.send(
      response,
      this.studio.createStoryRevision(projectId, body, ifMatch, this.context(idempotencyKey, traceHeader)),
    );
  }

  @Get("projects/:projectId/stories")
  listStoryRevisions(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Query("cursor") cursor?: string,
  ) {
    return this.studio.listStoryRevisions(projectId, cursor);
  }

  @Get("projects/:projectId/episodes")
  listEpisodes(@Param("projectId", UUID_PARAM_PIPE) projectId: string) {
    return this.studio.listEpisodes(projectId);
  }

  @Get("projects/:projectId/characters")
  listCharacters(@Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Query("cursor") cursor?: string, @Query("limit") limit?: string) {
    return this.studio.listTextEntities("character", projectId, cursor, limit);
  }

  @Get("projects/:projectId/locations")
  listLocations(@Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Query("cursor") cursor?: string, @Query("limit") limit?: string) {
    return this.studio.listTextEntities("location", projectId, cursor, limit);
  }

  @Get("projects/:projectId/episodes/:episodeId/scenes")
  listScenes(@Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Param("episodeId", UUID_PARAM_PIPE) episodeId: string,
    @Query("cursor") cursor?: string, @Query("limit") limit?: string) {
    return this.studio.listScenes(projectId, episodeId, cursor, limit);
  }

  @Get("projects/:projectId/episodes/:episodeId/scenes/:sceneId/shots")
  listShots(@Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Param("episodeId", UUID_PARAM_PIPE) episodeId: string,
    @Param("sceneId", UUID_PARAM_PIPE) sceneId: string,
    @Query("cursor") cursor?: string, @Query("limit") limit?: string) {
    return this.studio.listShots(projectId, episodeId, sceneId, cursor, limit);
  }

  @Post("projects/:projectId/episodes/:episodeId/scenes")
  createScene(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Param("episodeId", UUID_PARAM_PIPE) episodeId: string, @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("if-match") ifMatch?: string, @Headers("idempotency-key") key?: string,
    @Headers("x-trace-id") trace?: string,
  ) {
    return this.send(response, this.studio.createSceneRevision(
      projectId, episodeId, undefined, body, ifMatch, this.context(key, trace),
    ));
  }

  @Post("projects/:projectId/episodes/:episodeId/scenes/:sceneId/revisions")
  reviseScene(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Param("episodeId", UUID_PARAM_PIPE) episodeId: string,
    @Param("sceneId", UUID_PARAM_PIPE) sceneId: string, @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("if-match") ifMatch?: string, @Headers("idempotency-key") key?: string,
    @Headers("x-trace-id") trace?: string,
  ) {
    return this.send(response, this.studio.createSceneRevision(
      projectId, episodeId, sceneId, body, ifMatch, this.context(key, trace),
    ));
  }

  @Get("projects/:projectId/episodes/:episodeId/scenes/:sceneId/revisions")
  sceneHistory(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Param("episodeId", UUID_PARAM_PIPE) episodeId: string,
    @Param("sceneId", UUID_PARAM_PIPE) sceneId: string,
  ) {
    return this.studio.listSceneRevisions(projectId, episodeId, sceneId);
  }

  @Post("projects/:projectId/episodes/:episodeId/scenes/:sceneId/revisions/:revisionId/review")
  reviewScene(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Param("episodeId", UUID_PARAM_PIPE) episodeId: string,
    @Param("sceneId", UUID_PARAM_PIPE) sceneId: string,
    @Param("revisionId", UUID_PARAM_PIPE) revisionId: string, @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("if-match") ifMatch?: string, @Headers("idempotency-key") key?: string,
    @Headers("x-trace-id") trace?: string,
  ) {
    return this.send(response, this.studio.reviewSceneShot(
      "scene", projectId, episodeId, sceneId, undefined, revisionId,
      body, ifMatch, this.context(key, trace),
    ));
  }

  @Post("projects/:projectId/episodes/:episodeId/scenes/:sceneId/shots")
  createShot(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Param("episodeId", UUID_PARAM_PIPE) episodeId: string,
    @Param("sceneId", UUID_PARAM_PIPE) sceneId: string, @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("if-match") ifMatch?: string, @Headers("idempotency-key") key?: string,
    @Headers("x-trace-id") trace?: string,
  ) {
    return this.send(response, this.studio.createShotRevision(
      projectId, episodeId, sceneId, undefined, body, ifMatch, this.context(key, trace),
    ));
  }

  @Post("projects/:projectId/episodes/:episodeId/scenes/:sceneId/shots/:shotId/revisions")
  reviseShot(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Param("episodeId", UUID_PARAM_PIPE) episodeId: string,
    @Param("sceneId", UUID_PARAM_PIPE) sceneId: string,
    @Param("shotId", UUID_PARAM_PIPE) shotId: string, @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("if-match") ifMatch?: string, @Headers("idempotency-key") key?: string,
    @Headers("x-trace-id") trace?: string,
  ) {
    return this.send(response, this.studio.createShotRevision(
      projectId, episodeId, sceneId, shotId, body, ifMatch, this.context(key, trace),
    ));
  }

  @Get("projects/:projectId/episodes/:episodeId/scenes/:sceneId/shots/:shotId/revisions")
  shotHistory(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Param("episodeId", UUID_PARAM_PIPE) episodeId: string,
    @Param("sceneId", UUID_PARAM_PIPE) sceneId: string,
    @Param("shotId", UUID_PARAM_PIPE) shotId: string,
  ) {
    return this.studio.listShotRevisions(projectId, episodeId, sceneId, shotId);
  }

  @Post("projects/:projectId/episodes/:episodeId/scenes/:sceneId/shots/:shotId/revisions/:revisionId/review")
  reviewShot(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Param("episodeId", UUID_PARAM_PIPE) episodeId: string,
    @Param("sceneId", UUID_PARAM_PIPE) sceneId: string,
    @Param("shotId", UUID_PARAM_PIPE) shotId: string,
    @Param("revisionId", UUID_PARAM_PIPE) revisionId: string, @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("if-match") ifMatch?: string, @Headers("idempotency-key") key?: string,
    @Headers("x-trace-id") trace?: string,
  ) {
    return this.send(response, this.studio.reviewSceneShot(
      "shot", projectId, episodeId, sceneId, shotId, revisionId,
      body, ifMatch, this.context(key, trace),
    ));
  }

  @Post("projects/:projectId/characters")
  createCharacter(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string, @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("if-match") ifMatch?: string, @Headers("idempotency-key") key?: string,
    @Headers("x-trace-id") trace?: string,
  ) {
    return this.send(response, this.studio.createTextEntity(
      "character", projectId, undefined, body, ifMatch, this.context(key, trace),
    ));
  }

  @Post("projects/:projectId/locations")
  createLocation(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string, @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("if-match") ifMatch?: string, @Headers("idempotency-key") key?: string,
    @Headers("x-trace-id") trace?: string,
  ) {
    return this.send(response, this.studio.createTextEntity(
      "location", projectId, undefined, body, ifMatch, this.context(key, trace),
    ));
  }

  @Post("projects/:projectId/characters/:entityId/revisions")
  reviseCharacter(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Param("entityId", UUID_PARAM_PIPE) entityId: string, @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("if-match") ifMatch?: string, @Headers("idempotency-key") key?: string,
    @Headers("x-trace-id") trace?: string,
  ) {
    return this.send(response, this.studio.createTextEntity(
      "character", projectId, entityId, body, ifMatch, this.context(key, trace),
    ));
  }

  @Post("projects/:projectId/locations/:entityId/revisions")
  reviseLocation(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Param("entityId", UUID_PARAM_PIPE) entityId: string, @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("if-match") ifMatch?: string, @Headers("idempotency-key") key?: string,
    @Headers("x-trace-id") trace?: string,
  ) {
    return this.send(response, this.studio.createTextEntity(
      "location", projectId, entityId, body, ifMatch, this.context(key, trace),
    ));
  }

  @Get("projects/:projectId/characters/:entityId/revisions")
  characterHistory(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Param("entityId", UUID_PARAM_PIPE) entityId: string,
  ) {
    return this.studio.listTextEntityRevisions("character", projectId, entityId);
  }

  @Get("projects/:projectId/locations/:entityId/revisions")
  locationHistory(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Param("entityId", UUID_PARAM_PIPE) entityId: string,
  ) {
    return this.studio.listTextEntityRevisions("location", projectId, entityId);
  }

  @Post("projects/:projectId/characters/:entityId/revisions/:revisionId/review")
  reviewCharacter(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Param("entityId", UUID_PARAM_PIPE) entityId: string,
    @Param("revisionId", UUID_PARAM_PIPE) revisionId: string, @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("if-match") ifMatch?: string, @Headers("idempotency-key") key?: string,
    @Headers("x-trace-id") trace?: string,
  ) {
    return this.send(response, this.studio.reviewTextEntity(
      "character", projectId, entityId, revisionId, body, ifMatch, this.context(key, trace),
    ));
  }

  @Post("projects/:projectId/locations/:entityId/revisions/:revisionId/review")
  reviewLocation(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Param("entityId", UUID_PARAM_PIPE) entityId: string,
    @Param("revisionId", UUID_PARAM_PIPE) revisionId: string, @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("if-match") ifMatch?: string, @Headers("idempotency-key") key?: string,
    @Headers("x-trace-id") trace?: string,
  ) {
    return this.send(response, this.studio.reviewTextEntity(
      "location", projectId, entityId, revisionId, body, ifMatch, this.context(key, trace),
    ));
  }

  @Get("episodes/:episodeId/scripts")
  listScriptRevisionsByEpisode(
    @Param("episodeId", UUID_PARAM_PIPE) episodeId: string,
    @Query("cursor") cursor?: string,
  ) {
    return this.studio.listScriptRevisionsByEpisode(episodeId, cursor);
  }

  @Post("episodes/:episodeId/scripts")
  createScriptRevisionByEpisode(
    @Param("episodeId", UUID_PARAM_PIPE) episodeId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("if-match") ifMatch?: string,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-trace-id") traceHeader?: string,
  ) {
    return this.send(
      response,
      this.studio.createScriptRevisionByEpisode(
        episodeId,
        body,
        ifMatch,
        this.context(idempotencyKey, traceHeader),
      ),
    );
  }

  @Post("projects/:projectId/episodes/:episodeId/scripts")
  createScriptRevision(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Param("episodeId", UUID_PARAM_PIPE) episodeId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("if-match") ifMatch?: string,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-trace-id") traceHeader?: string,
  ) {
    return this.send(
      response,
      this.studio.createScriptRevision(
        projectId,
        episodeId,
        body,
        ifMatch,
        this.context(idempotencyKey, traceHeader),
      ),
    );
  }

  @Get("projects/:projectId/episodes/:episodeId/scripts")
  listScriptRevisions(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Param("episodeId", UUID_PARAM_PIPE) episodeId: string,
    @Query("cursor") cursor?: string,
  ) {
    return this.studio.listScriptRevisions(projectId, episodeId, cursor);
  }

  @Post("projects/:projectId/stories/:revisionId/review")
  reviewStoryRevision(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Param("revisionId", UUID_PARAM_PIPE) revisionId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("if-match") ifMatch?: string,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-trace-id") traceHeader?: string,
  ) {
    return this.send(
      response,
      this.studio.reviewStoryRevision(
        projectId,
        revisionId,
        body,
        ifMatch,
        this.context(idempotencyKey, traceHeader),
      ),
    );
  }

  @Post("script-revisions/:revisionId/review")
  reviewScriptRevisionById(
    @Param("revisionId", UUID_PARAM_PIPE) revisionId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("if-match") ifMatch?: string,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-trace-id") traceHeader?: string,
  ) {
    return this.send(
      response,
      this.studio.reviewScriptRevisionById(
        revisionId,
        body,
        ifMatch,
        this.context(idempotencyKey, traceHeader),
      ),
    );
  }

  @Post("projects/:projectId/episodes/:episodeId/scripts/:revisionId/review")
  reviewScriptRevision(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Param("episodeId", UUID_PARAM_PIPE) episodeId: string,
    @Param("revisionId", UUID_PARAM_PIPE) revisionId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("if-match") ifMatch?: string,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-trace-id") traceHeader?: string,
  ) {
    return this.send(
      response,
      this.studio.reviewScriptRevision(
        projectId,
        episodeId,
        revisionId,
        body,
        ifMatch,
        this.context(idempotencyKey, traceHeader),
      ),
    );
  }

  @Post("projects/:projectId/workflows/mock")
  createMockWorkflow(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-trace-id") traceHeader?: string,
  ) {
    return this.send(
      response,
      this.studio.createMockWorkflow(projectId, body, this.context(idempotencyKey, traceHeader)),
    );
  }

  @Post("shot-revisions/:revisionId/generate-image")
  generateShotImage(
    @Param("revisionId", UUID_PARAM_PIPE) revisionId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("idempotency-key") key?: string,
    @Headers("x-trace-id") trace?: string,
  ) {
    return this.send(response,
      this.studio.generateShotImage(revisionId, body, this.context(key, trace)));
  }

  @Post("shot-revisions/:revisionId/generate-video")
  generateShotVideo(
    @Param("revisionId", UUID_PARAM_PIPE) revisionId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("idempotency-key") key?: string,
    @Headers("x-trace-id") trace?: string,
  ) {
    return this.send(response,
      this.studio.generateShotVideo(revisionId, body, this.context(key, trace)));
  }

  @Post("shot-revisions/:revisionId/generate-subtitle")
  generateShotSubtitle(
    @Param("revisionId", UUID_PARAM_PIPE) revisionId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("idempotency-key") key?: string,
    @Headers("x-trace-id") trace?: string,
  ) {
    return this.send(response,
      this.studio.generateShotSubtitle(revisionId, body, this.context(key, trace)));
  }

  @Post("shot-revisions/:revisionId/generate-music")
  generateShotMusic(
    @Param("revisionId", UUID_PARAM_PIPE) revisionId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("idempotency-key") key?: string,
    @Headers("x-trace-id") trace?: string,
  ) {
    return this.send(response,
      this.studio.generateShotMusic(revisionId, body, this.context(key, trace)));
  }

  @Post("shot-revisions/:revisionId/generate-tts")
  generateShotTts(
    @Param("revisionId", UUID_PARAM_PIPE) revisionId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("idempotency-key") key?: string,
    @Headers("x-trace-id") trace?: string,
  ) {
    return this.send(response,
      this.studio.generateShotTts(revisionId, body, this.context(key, trace)));
  }

  @Post("shot-revisions/:revisionId/compose")
  composeShot(
    @Param("revisionId", UUID_PARAM_PIPE) revisionId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-trace-id") traceHeader?: string,
  ) {
    return this.send(response, this.studio.composeShot(revisionId, body, this.context(idempotencyKey, traceHeader)));
  }

  @Post("assets/:assetId/review")
  reviewAsset(
    @Param("assetId", UUID_PARAM_PIPE) assetId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("if-match") ifMatch?: string,
    @Headers("x-trace-id") traceHeader?: string,
  ) {
    return this.send(response, this.studio.reviewComposite(assetId, body, ifMatch, this.context(idempotencyKey, traceHeader)));
  }

  @Post("shot-revisions/:revisionId/compose-preflight")
  composePreflight(
    @Param("revisionId", UUID_PARAM_PIPE) revisionId: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusResponse,
  ) {
    response.setHeader("Cache-Control", "private, no-store");
    return this.send(response, this.studio.preflightShotCompose(revisionId, body));
  }

  @Get("shot-revisions/:revisionId/assets")
  listShotAssets(@Param("revisionId", UUID_PARAM_PIPE) revisionId: string) {
    return this.studio.listShotAssets(revisionId);
  }

  @Get("assets/:assetId/content")
  @Head("assets/:assetId/content")
  async readAssetContent(
    @Param("assetId", UUID_PARAM_PIPE) assetId: string,
    @Req() request: ContentRequest,
    @Res({ passthrough: true }) response: ContentResponse,
  ) {
    const payload = await this.studio.readMockAssetContent(assetId);
    response.status(200);
    response.setHeader("Content-Type", payload.mimeType);
    response.setHeader("Content-Length", String(payload.bytes.length));
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "private, no-store");
    if (request.method === "HEAD") return undefined;
    return new StreamableFile(payload.bytes);
  }

  @Post("projects/:projectId/workflows/mock-scenes")
  createMockScenes(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-trace-id") traceHeader?: string,
  ) {
    return this.send(response,
      this.studio.createMockSceneWorkflow(projectId, this.context(idempotencyKey, traceHeader)));
  }

  @Post("projects/:projectId/workflows/mock-shots")
  createMockShots(
    @Param("projectId", UUID_PARAM_PIPE) projectId: string,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-trace-id") traceHeader?: string,
  ) {
    return this.send(response,
      this.studio.createMockShotWorkflow(projectId, this.context(idempotencyKey, traceHeader)));
  }

  @Get("projects/:projectId/workflow-runs")
  listWorkflows(@Param("projectId", UUID_PARAM_PIPE) projectId: string) {
    return this.studio.listWorkflows(projectId);
  }

  @Get("generation-jobs/:jobId")
  getJob(@Param("jobId", UUID_PARAM_PIPE) jobId: string) {
    return this.studio.getJob(jobId);
  }

  @Post("generation-jobs/:jobId/cancel")
  cancelJob(
    @Param("jobId", UUID_PARAM_PIPE) jobId: string,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-trace-id") traceHeader?: string,
  ) {
    return this.send(response, this.studio.cancelJob(jobId, this.context(idempotencyKey, traceHeader)));
  }

  @Post("generation-jobs/:jobId/retry")
  retryJob(
    @Param("jobId", UUID_PARAM_PIPE) jobId: string,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-trace-id") traceHeader?: string,
  ) {
    return this.send(response, this.studio.retryJob(jobId, this.context(idempotencyKey, traceHeader)));
  }

  @Get("workflow-runs/:runId")
  getWorkflow(@Param("runId", UUID_PARAM_PIPE) runId: string) {
    return this.studio.getWorkflow(runId);
  }

  @Post("workflow-runs/:runId/cancel")
  cancelWorkflow(
    @Param("runId", UUID_PARAM_PIPE) runId: string,
    @Res({ passthrough: true }) response: StatusResponse,
    @Headers("idempotency-key") idempotencyKey?: string,
    @Headers("x-trace-id") traceHeader?: string,
  ) {
    return this.send(response, this.studio.cancelWorkflow(runId, this.context(idempotencyKey, traceHeader)));
  }

  @Get("providers/capabilities")
  capabilities() {
    return this.studio.capabilities();
  }

  private context(idempotencyKey: string | undefined, traceHeader: string | undefined): StudioContext {
    return { actorId: "server-owner", traceId: createTraceId(traceHeader), idempotencyKey };
  }

  private async send<T>(response: StatusResponse, work: Promise<{ status: number; body: T }>): Promise<T> {
    const result = await work;
    response.status(result.status);
    return result.body;
  }
}

@Controller()
export class EventsController {
  constructor(
    @Inject(STUDIO_SERVICE) private readonly studio: StudioService,
    @Inject(RUNTIME_STORE) private readonly store: RuntimeStore,
  ) {}

  @Get("events")
  async events(
    @Req() request: SseRequest,
    @Res() response: SseResponse,
    @Headers("last-event-id") lastEventHeader?: string,
  ): Promise<void> {
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    request.on("close", () => {
      closed = true;
      if (timer) clearTimeout(timer);
    });

    const cursor = lastEventHeader && lastEventHeader.length > 0 ? lastEventHeader : "0";
    try {
      if (cursor !== "0") await this.store.assertCursor(this.studio.workspace, cursor);
    } catch (error) {
      if (closed) return;
      if (error instanceof PersistenceError) {
        response.status(error.code === "EVENT_CURSOR_EXPIRED" ? 409 : 400).json({
          error: { code: error.code, message: error.message, traceId: "sse" },
        });
        return;
      }
      throw error;
    }
    if (closed) return;

    response.status(200);
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();

    let current = cursor;
    const send = async (): Promise<void> => {
      const events = await this.store.listEventsAfter(this.studio.workspace, current, 100);
      if (closed) return;
      for (const event of events) {
        if (BigInt(event.eventId) <= BigInt(current)) continue;
        current = event.eventId;
        response.write(`id: ${event.eventId}\n`);
        response.write(`event: ${event.eventType}\n`);
        response.write(
          `data: ${JSON.stringify({
            eventId: event.eventId,
            occurredAt: event.occurredAt,
            traceId: event.traceId,
            data: event.data,
          })}\n\n`,
        );
      }
    };
    const stop = (): void => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      response.end();
    };
    const schedule = (): void => {
      if (closed) return;
      timer = setTimeout(() => {
        void send().then(schedule).catch(stop);
      }, 250);
    };

    try {
      await send();
    } catch {
      stop();
      return;
    }
    schedule();
  }
}
