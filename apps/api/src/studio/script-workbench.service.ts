import { scriptWorkbenchPlanSchema, scriptWorkbenchScriptSchema } from "@ai-drama/contracts";
import { JobPersistenceService, PersistenceError, ScriptWorkbenchStore, ScriptWorkbenchTrashStore, requestHash, type DatabasePool } from "@ai-drama/database";
import { z } from "zod";
import { createTraceId } from "./studio.service";

const uuid = z.string().uuid();
const planBody = z.object({ plan: scriptWorkbenchPlanSchema, continuationEpisodeNo: z.number().int().min(2).max(6).optional() }).strict();
const continuation = z.object({ previousRevisionId: uuid.nullable(), originalRunId: uuid.nullable(),
  originalEpisodeHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(), episodeCount: z.number().int().min(2).max(6),
  planConfirmation: z.number().int().min(0), aiAttemptId: uuid.optional() }).strict();
const scriptBody = z.object({ script: scriptWorkbenchScriptSchema, sourceStoryRevisionId: uuid, continuation: continuation.optional() }).strict();
const versionBody = z.object({ expectedVersion: z.number().int().min(1).max(2147483646) }).strict();
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new PersistenceError("VALIDATION_ERROR", "工作台参数无效，请检查必填项和数值范围。");
  return result.data;
}
function id(value: string): string { return parse(uuid, value).toLowerCase(); }
function version(value: string | undefined): number {
  const match = value && /^"?([1-9][0-9]*)"?$/.exec(value.trim());
  if (!match) throw new PersistenceError("VALIDATION_ERROR", "需要 If-Match 版本号，请刷新后重试。");
  return parse(versionBody, { expectedVersion: Number(match[1]) }).expectedVersion;
}
export class ScriptWorkbenchService {
  private readonly store: ScriptWorkbenchStore;
  private readonly trash: ScriptWorkbenchTrashStore;
  private readonly jobs: JobPersistenceService;
  constructor(pool: DatabasePool, private readonly workspaceId: string) {
    this.store = new ScriptWorkbenchStore(pool); this.trash = new ScriptWorkbenchTrashStore(pool); this.jobs = new JobPersistenceService(pool);
  }
  snapshot(projectId: string) { return this.store.snapshot(this.workspaceId, id(projectId)); }
  savePlan(projectId: string, body: unknown, ifMatch: string | undefined, key: string | undefined, trace?: string) {
    const project = id(projectId); const input = parse(planBody, body); const expectedVersion = version(ifMatch);
    return this.jobs.runIdempotent(this.scope(`/projects/${project}/script-workbench/plan`, key, { ...input, expectedVersion }), 201,
      client => this.store.savePlan(client, { workspaceId: this.workspaceId, projectId: project, plan: input.plan,
        continuationEpisodeNo: input.continuationEpisodeNo,
        expectedVersion, actorId: "server-owner", traceId: createTraceId(trace) }));
  }
  saveScript(projectId: string, episodeId: string, body: unknown, ifMatch: string | undefined, key: string | undefined, trace?: string) {
    const project = id(projectId); const episode = id(episodeId); const input = parse(scriptBody, body); const expectedVersion = version(ifMatch);
    return this.jobs.runIdempotent(this.scope(`/projects/${project}/episodes/${episode}/script-workbench`, key, { ...input, expectedVersion }), 201,
      client => this.store.saveScript(client, { workspaceId: this.workspaceId, projectId: project, episodeId: episode,
        sourceStoryRevisionId: input.sourceStoryRevisionId, script: input.script, continuation: input.continuation,
        expectedVersion, actorId: "server-owner", traceId: createTraceId(trace) }));
  }
  previewProject(projectId: string) { return this.trash.previewProject(this.workspaceId, id(projectId)); }
  previewRevision(projectId: string, episodeId: string, revisionId: string) { return this.trash.previewRevision(this.workspaceId, id(projectId), id(episodeId), id(revisionId)); }
  listTrash(cursor?: string) { return this.trash.listTrash(this.workspaceId, cursor); }
  trashProject(projectId: string, body: unknown) { return this.trash.trashProject(this.workspaceId, id(projectId), parse(versionBody, body)); }
  restoreProject(projectId: string, body: unknown) { return this.trash.restoreProject(this.workspaceId, id(projectId), parse(versionBody, body)); }
  trashRevision(projectId: string, episodeId: string, revisionId: string, body: unknown) {
    return this.trash.trashRevision(this.workspaceId, id(projectId), id(episodeId), id(revisionId), { ...parse(versionBody, body), actorId: "server-owner" });
  }
  restoreRevision(projectId: string, episodeId: string, revisionId: string, body: unknown) {
    return this.trash.restoreRevision(this.workspaceId, id(projectId), id(episodeId), id(revisionId), parse(versionBody, body));
  }
  private scope(routeKey: string, key: string | undefined, body: unknown) {
    if (!key || key.length > 200 || /[^\x21-\x7e]/.test(key)) throw new PersistenceError("VALIDATION_ERROR", "需要有效的 Idempotency-Key。");
    return { workspaceId: this.workspaceId, actorId: "server-owner", httpMethod: "POST", routeKey, key, requestHash: requestHash(body) };
  }
}
