import { z } from "zod";
import { SPEECH_MAX_REQUEST_BYTES, speechBindingPutSchema, speechGenerateSchema, speechMixRequestSchema, speechPlanPutSchema,
  speechSelectionPutSchema, speechVoiceSchema, type SpeechCapabilities, type SpeechGenerationPort } from "@ai-drama/contracts";
import { DomainError, SpeechAudioOverflowError } from "@ai-drama/domain";
import { PersistenceError, type SpeechPersistence } from "@ai-drama/database";
import type { StudioContext } from "./studio.service";

export interface SpeechServiceDependencies { workspaceId: string; store: SpeechPersistence; generation: SpeechGenerationPort | null }
export interface SpeechResult { status: number; body: unknown }
const ERRORS: Record<string, { status: number; message: string }> = {
  SPEECH_DISABLED: { status: 409, message: "配音服务尚未开启，可先保存台词和选声草稿。" },
  SPEECH_STORAGE_UNAVAILABLE: { status: 503, message: "配音存储尚未启用，未创建生成任务。" },
  SPEECH_STORAGE_CORRUPT: { status: 503, message: "配音记录未通过完整性检查，请先处理存储问题。" },
  SPEECH_SOURCE_CHANGED: { status: 409, message: "对白来源已更新，请重新读取并确认台词。" },
  SPEECH_SOURCE_MISMATCH: { status: 422, message: "台词必须逐字对应已批准的对白，不能遗漏、重叠或更换说话人。" },
  SPEECH_PLAN_INVALID: { status: 422, message: "台词计划含重复或无效的逐句内容。" },
  SPEECH_PLAN_STALE: { status: 409, message: "台词计划已更新，请重新读取当前版本。" },
  SPEECH_VOICE_STALE: { status: 409, message: "角色声音已更新，请重新确认台词与声音。" },
  SPEECH_PARAMETER_UNSUPPORTED: { status: 422, message: "所选声音不支持这个情绪或语速，请使用服务实际支持的参数。" },
  SPEECH_LINE_TOO_LONG: { status: 422, message: "本句超过所选声音的字数限制，请按原文拆成更短的句子。" },
  SPEECH_PROVIDER_DISABLED: { status: 409, message: "所选声音暂不可用，请核对服务配置。" },
  SPEECH_CATALOG_CHANGED: { status: 409, message: "声音目录已更新，请重新读取后选择。" },
  SPEECH_IMPACT_CHANGED: { status: 409, message: "换声影响范围已变化，请重新查看并确认。" },
  SPEECH_TAKE_INVALID: { status: 409, message: "此音频不属于当前台词与声音，或尚未可用。" },
  SPEECH_SELECTION_MISSING: { status: 409, message: "请先试听并明确选用每句音频。" },
  SPEECH_SELECTION_STALE: { status: 409, message: "选中音频已变化，请重新确认当前版本。" },
  SPEECH_AUDIO_OVERFLOW: { status: 422, message: "配音与停顿超过实测画面时长，请修改台词或调整画面。人声不会被截断。" },
  SPEECH_VIDEO_INVALID: { status: 409, message: "请先选择本镜头可用的真实时长视频。" },
  SPEECH_MUSIC_INVALID: { status: 409, message: "所选音乐不可用，请关闭音乐或重新选择。" },
  SPEECH_SUBTITLE_INVALID: { status: 422, message: "字幕时间未通过校验，请重新确认所选音频。" },
  SERIES_MEDIA_NOT_ENABLED: { status: 409, message: "系列作品当前只开放文本创作。" },
  REVIEW_REQUIRED: { status: 409, message: "请先批准当前镜头、场景、剧本与相关角色。" },
  STALE_RECALCULATION_PENDING: { status: 409, message: "来源更新正在处理，请稍后重新读取。" },
  REVISION_CONFLICT: { status: 409, message: "内容已被更新，请重新读取后再保存。" },
  IDEMPOTENCY_KEY_REUSED: { status: 409, message: "该请求标识已用于不同内容，请核对原操作。" },
  IDEMPOTENCY_IN_PROGRESS: { status: 409, message: "原操作仍在处理，请保留请求标识并稍后查询。" },
  NOT_FOUND: { status: 404, message: "没有找到这部作品、镜头或配音记录。" },
  VALIDATION_ERROR: { status: 400, message: "配音请求无效。" },
  SPEECH_REQUEST_TOO_LARGE: { status: 413, message: "配音请求超过 64 KB。" },
  REAL_MEDIA_NOT_READY: { status: 503, message: "配音服务尚未准备好，未发出新调用。" },
  REAL_MEDIA_PROVIDER_DISABLED: { status: 409, message: "配音服务暂不可用，未发出新调用。" },
  REAL_MEDIA_INPUT_CHANGED: { status: 409, message: "本句来源或报价已变化，请重新核对。" },
  REAL_MEDIA_CONFIGURATION_CHANGED: { status: 409, message: "配音服务配置已更新，请重新查看费用。" },
  REAL_MEDIA_QUOTE_EXPIRED: { status: 409, message: "本句报价已过期，请重新查看费用。" },
  REAL_MEDIA_BUDGET_MISMATCH: { status: 409, message: "本句费用上限或历史任务确认已变化，请重新核对。" },
  REAL_MEDIA_UNCERTAIN_CHANGED: { status: 409, message: "历史任务结果已变化，请重新查看费用并确认重复收费风险；旧预算仍保留。" },
  REAL_MEDIA_AUTHORIZATION_USED: { status: 409, message: "本句调用授权已被使用，请查询原任务。" },
  SPEECH_VOICE_UNSUPPORTED: { status: 422, message: "此声音当前只支持自然语气和正常语速。" },
};
function failure(code: string, details?: Record<string, unknown>): SpeechResult {
  const e = ERRORS[code]!;
  return { status: e.status, body: { error: { code, message: e.message, ...(details ? { details } : {}) } } };
}
const keyValid = (key: string | undefined): key is string => typeof key === "string" && /^[\x21-\x7e]{1,200}$/.test(key);
function version(value: string | undefined): number {
  const match = /^(?:"(0|[1-9][0-9]*)"|(0|[1-9][0-9]*))$/.exec(value ?? "");
  const parsed = Number(match?.[1] ?? match?.[2]);
  if (!match || !Number.isSafeInteger(parsed)) throw new PersistenceError("VALIDATION_ERROR", "If-Match must contain the aggregate version");
  return parsed;
}
function body<T>(schema: z.ZodType<T>, value: unknown): T {
  let text: string;
  try { text = JSON.stringify(value) ?? ""; } catch { throw new PersistenceError("VALIDATION_ERROR", "Invalid JSON body"); }
  if (Buffer.byteLength(text, "utf8") > SPEECH_MAX_REQUEST_BYTES) throw new PersistenceError("SPEECH_REQUEST_TOO_LARGE", "Speech request is too large");
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new PersistenceError("VALIDATION_ERROR", "Speech request shape is invalid");
  return parsed.data;
}
/** Business orchestration only. Real paid submissions belong to the injected existing-Job port. */
export class SpeechService {
  constructor(private readonly deps: SpeechServiceDependencies) {}
  private async access(work: () => Promise<SpeechResult>, storage = true): Promise<SpeechResult> {
    try {
      if (storage && !await this.deps.store.storageReady()) return failure("SPEECH_STORAGE_UNAVAILABLE");
      return await work();
    } catch (error) {
      if ((error instanceof PersistenceError || error instanceof DomainError) && ERRORS[error.code]) {
        const details = error instanceof SpeechAudioOverflowError ? { overflowMs: error.overflowMs } : undefined;
        return failure(error.code, details);
      }
      throw error;
    }
  }
  private context(context: StudioContext): { actorId: string; traceId: string; idempotencyKey: string } {
    if (!keyValid(context.idempotencyKey)) throw new PersistenceError("VALIDATION_ERROR", "Idempotency-Key is required");
    return { ...context, idempotencyKey: context.idempotencyKey };
  }
  private async configured(projectId: string): Promise<SpeechCapabilities> {
    if (!this.deps.generation) return { available: false, reasonCode: "SPEECH_DISABLED", catalogVersion: "unconfigured", voices: [] };
    const capabilities = await this.deps.generation.capabilities(this.deps.workspaceId, projectId);
    return { ...capabilities, voices: capabilities.voices.map((voice) => speechVoiceSchema.parse(voice)) };
  }
  async capabilities(projectId: string): Promise<SpeechResult> {
    return this.access(async () => {
      await this.deps.store.requireProject(this.deps.workspaceId, projectId);
      const capabilities = await this.configured(projectId);
      const ready = await this.deps.store.storageReady();
      return { status: 200, body: ready ? capabilities : { ...capabilities, available: false, reasonCode: "SPEECH_STORAGE_UNAVAILABLE" } };
    }, false);
  }
  async bindings(projectId: string): Promise<SpeechResult> {
    return this.access(async () => ({ status: 200, body: await this.deps.store.bindings(this.deps.workspaceId, projectId) }));
  }
  async bindingImpact(projectId: string, speakerId: string): Promise<SpeechResult> {
    return this.access(async () => ({ status: 200, body: await this.deps.store.bindingImpact(this.deps.workspaceId, projectId, speakerId) }));
  }
  async putBinding(projectId: string, speakerId: string, input: unknown, ifMatch: string | undefined, context: StudioContext): Promise<SpeechResult> {
    return this.access(async () => {
      const request = body(speechBindingPutSchema, input), expectedVersion = version(ifMatch), ctx = this.context(context);
      const catalog = await this.configured(projectId);
      if (request.catalogVersion !== catalog.catalogVersion) return failure("SPEECH_CATALOG_CHANGED");
      const voice = catalog.voices.find((item) => item.catalogVoiceId === request.catalogVoiceId);
      if (!voice) return failure("SPEECH_PROVIDER_DISABLED");
      return { status: 200, body: await this.deps.store.putBinding(this.deps.workspaceId, projectId, speakerId, voice, request, expectedVersion, ctx) };
    });
  }
  async plan(shotRevisionId: string): Promise<SpeechResult> {
    return this.access(async () => ({ status: 200, body: await this.deps.store.plan(this.deps.workspaceId, shotRevisionId) }));
  }
  async putPlan(shotRevisionId: string, input: unknown, ifMatch: string | undefined, context: StudioContext): Promise<SpeechResult> {
    return this.access(async () => {
      const request = body(speechPlanPutSchema, input), expectedVersion = version(ifMatch), ctx = this.context(context);
      return { status: 200, body: await this.deps.store.putPlan(this.deps.workspaceId, shotRevisionId, request, expectedVersion, ctx) };
    });
  }
  async takes(planRevisionId: string, query: unknown = {}): Promise<SpeechResult> {
    return this.access(async () => {
      const parsed = body(z.object({ cursor: z.string().uuid().optional() }).strict(), query);
      return { status: 200, body: await this.deps.store.takes(this.deps.workspaceId, planRevisionId, parsed.cursor) };
    });
  }
  async quote(planRevisionId: string, lineId: string, input: unknown): Promise<SpeechResult> {
    return this.access(async () => {
      body(z.object({}).strict(), input);
      const frozen = await this.deps.store.generationInput(this.deps.workspaceId, planRevisionId, lineId);
      if (!this.deps.generation || !(await this.configured(frozen.projectId)).available) return failure("SPEECH_DISABLED");
      return { status: 200, body: await this.deps.generation.quote(frozen) };
    });
  }
  async generate(planRevisionId: string, lineId: string, input: unknown, context: StudioContext): Promise<SpeechResult> {
    return this.access(async () => {
      const request = body(speechGenerateSchema, input), ctx = this.context(context);
      const frozen = await this.deps.store.generationInput(this.deps.workspaceId, planRevisionId, lineId, true);
      if (!this.deps.generation) return failure("SPEECH_DISABLED");
      return { status: 202, body: await this.deps.generation.generate({ ...frozen, ...request, ...ctx }) };
    });
  }
  async select(planRevisionId: string, lineId: string, input: unknown, ifMatch: string | undefined, context: StudioContext): Promise<SpeechResult> {
    return this.access(async () => {
      const request = body(speechSelectionPutSchema, input), expectedVersion = version(ifMatch), ctx = this.context(context);
      return { status: 200, body: await this.deps.store.select(this.deps.workspaceId, planRevisionId, lineId, request, expectedVersion, ctx) };
    });
  }
  async mixPreflight(planRevisionId: string, input: unknown): Promise<SpeechResult> {
    return this.access(async () => ({ status: 200,
      body: await this.deps.store.mixPreflight(this.deps.workspaceId, planRevisionId, body(speechMixRequestSchema, input)) }));
  }
}
