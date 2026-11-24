import {
  PersistenceError,
  type AdminOpsStore,
  type AssetSignalRow,
  type CreatorAccountStore,
  type JobSignalRow,
  type WorkSignalRow,
} from "@ai-drama/database";
import { z } from "zod";
import type { StudioContext } from "../studio/studio.service";
import { runWithCreatorAccess } from "../auth/creator-access";
import {
  PRODUCTION_LABEL,
  assetName,
  assetType,
  adminRetryAllowed,
  deriveProductionStatus,
  episodeProgress,
  jobAction,
  jobDisplayStatus,
  jobTypeLabel,
  JOB_STATUS_LABEL,
  ownerPresentation,
  recentTaskLabel,
  shortJobCode,
  workEpisodeLabel,
  type ProductionStatus,
} from "./admin-ops-present";
import { noteOperation, type OperationLogStore } from "./operation-log-store";

export class AdminDirectoryError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "AdminDirectoryError";
  }
}

export interface DirectorySession {
  username: string;
  accountId: string;
}

const RETRY_MESSAGES: Record<string, string> = {
  RETRY_UNCONFIRMED: "还没有确认重试，没有向服务商发起调用。",
  IDEMPOTENCY_REQUIRED: "缺少幂等键，没有向服务商发起调用。",
  UNKNOWN_OUTCOME: "结果未知的任务不能重试，没有向服务商发起调用。",
  NOT_RETRYABLE: "这次任务不能重试，没有向服务商发起调用。",
  NOT_MEDIA: "这类任务不能从这里重试，没有向服务商发起调用。",
  ERROR_NOT_RETRYABLE: "这次失败不能重试，没有向服务商发起调用。",
  COMPOSE: "成片合成需要重新预检，没有向服务商发起调用。",
  NOT_FOUND: "没有找到这条记录。",
};

function retryError(reason: string): AdminDirectoryError {
  return new AdminDirectoryError(409, reason, RETRY_MESSAGES[reason] ?? RETRY_MESSAGES.NOT_RETRYABLE!);
}

const workId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i).toLowerCase();
const workVersions = z.array(z.object({
  id: workId, version: z.number().int().min(1).max(2_147_483_646),
}).strict()).min(1).max(50).refine((items) => new Set(items.map(({ id }) => id)).size === items.length);
const previewBody = z.object({
  ids: z.array(workId).min(1).max(50).refine((ids) => new Set(ids).size === ids.length),
}).strict();
const restoreBody = z.object({ confirmed: z.literal(true), items: workVersions }).strict();
const trashBody = restoreBody.extend({ reason: z.string().trim().min(1).max(300).refine((reason) => !reason.includes("\0")) });

function workChangeError(cause: unknown): { status: "skipped" | "unknown"; message: string } {
  if (cause instanceof PersistenceError) {
    if (cause.code === "NOT_FOUND") return { status: "skipped", message: "作品不存在或已移出当前列表。" };
    if (cause.code === "REVISION_CONFLICT") return { status: "skipped", message: "作品状态已变化或仍有任务在处理，请刷新核对。" };
    if (cause.code === "WORKBENCH_UNAVAILABLE") return { status: "skipped", message: "回收站尚未就绪。" };
    if (cause.code === "VALIDATION_ERROR") return { status: "skipped", message: "作品版本无效，请刷新核对。" };
  }
  return { status: "unknown", message: "结果未确认，请刷新作品列表与回收站核对。" };
}

type WorkAuditRow = Awaited<ReturnType<AdminOpsStore["listAdminWorkLogs"]>>[number];

function workAuditRecord(row: WorkAuditRow) {
  return {
    id: row.id, at: row.at, actor: row.actor, action: row.action === "trash" ? "作品移入回收站" : "恢复作品",
    target: row.title, result: "success" as const, source: "管理后台 /admin/works",
    secretStatus: null, secretMask: null, detail: row.action === "trash" ? row.reason ?? "未记录操作原因。" : "作品已恢复至原创作者名下。",
  };
}

export class AdminDirectoryService {
  constructor(private readonly deps: {
    store: AdminOpsStore;
    creators: CreatorAccountStore | null;
    workspaceId: string;
    logs: OperationLogStore | null;
    retry: (jobId: string, context: StudioContext) => Promise<unknown>;
    readContent: (assetId: string) => Promise<{ mimeType: string; bytes: Buffer }>;
    /** Called after a creator is disabled so an existing cookie cannot keep writing. */
    revokeSessions?: (accountId: string) => void;
  }) {}

  async works(query: { q?: string; status?: string; owner?: string; cursor?: string; limit?: number }, canManageWorks: boolean) {
    const page = await this.deps.store.listWorks(this.deps.workspaceId, query);
    const legacy = page.items.some((item) => ownerPresentation({ username: item.ownerUsername, status: item.ownerStatus }).legacy);
    return {
      items: page.items.map((item) => this.work(item)),
      canManageWorks: canManageWorks && page.workManagementReady === true,
      total: page.total,
      nextCursor: page.nextCursor,
      owners: [
        ...page.owners.map((owner) => ({ id: owner.id, name: owner.username, legacy: false })),
        ...(legacy ? [{ id: "legacy", name: "历史作品", legacy: true }] : []),
      ],
    };
  }

  trashedWorks(query: { q?: string; cursor?: string; limit?: number }) {
    return this.deps.store.listTrashedWorks(this.deps.workspaceId, query);
  }

  async previewWorkTrash(body: unknown) {
    const parsed = previewBody.safeParse(body);
    if (!parsed.success) throw new AdminDirectoryError(400, "INVALID_SELECTION", "请选择 1 至 50 部不同的作品。");
    const items = [];
    for (const id of parsed.data.ids) {
      try {
        items.push(await this.deps.store.previewAdminWorkTrash(this.deps.workspaceId, id));
      } catch (error) {
        const result = workChangeError(error);
        items.push({ id, version: null, eligible: false, message: result.status === "unknown" ? "暂时无法核对这部作品。" : result.message });
      }
    }
    return { items };
  }

  async changeWorkTrash(session: DirectorySession, action: "trash" | "restore", body: unknown) {
    if (action === "trash") {
      const parsed = trashBody.safeParse(body);
      if (!parsed.success) throw new AdminDirectoryError(400, "INVALID_WORK_CHANGE", "请核对所选作品，填写 1 至 300 字的操作原因并确认移入。");
      const { items, reason } = parsed.data;
      return this.applyWorkChanges(items, (id, version) => this.deps.store.adminTrashWork(this.deps.workspaceId, id, {
        expectedVersion: version, actor: session.username, reason,
      }));
    }
    const parsed = restoreBody.safeParse(body);
    if (!parsed.success) throw new AdminDirectoryError(400, "INVALID_WORK_CHANGE", "请重新核对所选作品并确认恢复。");
    return this.applyWorkChanges(parsed.data.items, (id, version) => this.deps.store.adminRestoreWork(this.deps.workspaceId, id, {
      expectedVersion: version, actor: session.username,
    }));
  }

  private async applyWorkChanges(items: z.infer<typeof workVersions>, apply: (id: string, version: number) => Promise<unknown>) {
    const results = [];
    for (const { id, version } of items) {
      try {
        await apply(id, version);
        results.push({ id, status: "succeeded" as const, message: null });
      } catch (cause) {
        results.push({ id, ...workChangeError(cause) });
      }
    }
    return { items: results };
  }

  async workDetail(id: string) {
    const row = await this.deps.store.getWork(this.deps.workspaceId, id);
    if (!row) throw new AdminDirectoryError(404, "NOT_FOUND", RETRY_MESSAGES.NOT_FOUND!);
    return this.work(row);
  }

  async assets(query: { q?: string; type?: string; project?: string; cursor?: string; limit?: number }) {
    const page = await this.deps.store.listAssets(this.deps.workspaceId, {
      q: query.q,
      type: query.type,
      owner: query.project,
      cursor: query.cursor,
      limit: query.limit,
    });
    return {
      items: page.items.map((item) => this.asset(item)),
      total: page.total,
      nextCursor: page.nextCursor,
      projects: page.projects,
    };
  }

  async assetDetail(id: string) {
    const row = await this.deps.store.getAsset(this.deps.workspaceId, id);
    if (!row) throw new AdminDirectoryError(404, "NOT_FOUND", RETRY_MESSAGES.NOT_FOUND!);
    return this.asset(row);
  }

  async assetContent(session: DirectorySession, id: string) {
    const row = await this.deps.store.getAsset(this.deps.workspaceId, id);
    if (!row) throw new AdminDirectoryError(404, "NOT_FOUND", RETRY_MESSAGES.NOT_FOUND!);
    try {
      return await runWithCreatorAccess({
        kind: "scoped",
        role: "operator",
        accountId: session.accountId,
        username: session.username,
        opsView: true,
      }, () => this.deps.readContent(id));
    } catch (error) {
      if (error instanceof PersistenceError && error.code === "NOT_FOUND") {
        throw new AdminDirectoryError(404, "NOT_FOUND", RETRY_MESSAGES.NOT_FOUND!);
      }
      throw new AdminDirectoryError(503, "CONTENT_UNAVAILABLE", "暂时无法预览这份素材。没有对外发布。");
    }
  }

  async jobs(query: { q?: string; type?: string; status?: string; cursor?: string; limit?: number }) {
    const page = await this.deps.store.listJobs(this.deps.workspaceId, query);
    return {
      items: page.items.map((item) => this.job(item)),
      total: page.total,
      nextCursor: page.nextCursor,
    };
  }

  async jobDetail(id: string) {
    const row = await this.deps.store.getJob(this.deps.workspaceId, id);
    if (!row) throw new AdminDirectoryError(404, "NOT_FOUND", RETRY_MESSAGES.NOT_FOUND!);
    return this.job(row);
  }

  /**
   * Confirmed operator retry only. Unconfirmed and UNKNOWN return before the retry function runs,
   * so no manualRetryIdempotent / vendor call is started.
   */
  async retryJob(session: DirectorySession, id: string, input: { confirmed?: boolean; idempotencyKey?: string }) {
    if (input.confirmed !== true) throw new AdminDirectoryError(400, "RETRY_UNCONFIRMED", RETRY_MESSAGES.RETRY_UNCONFIRMED!);
    if (!input.idempotencyKey || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 200) {
      throw new AdminDirectoryError(400, "IDEMPOTENCY_REQUIRED", RETRY_MESSAGES.IDEMPOTENCY_REQUIRED!);
    }
    const row = await this.deps.store.getJob(this.deps.workspaceId, id);
    if (!row) throw new AdminDirectoryError(404, "NOT_FOUND", RETRY_MESSAGES.NOT_FOUND!);
    const decision = adminRetryAllowed({ kind: row.kind, state: row.state, errorCode: row.errorCode });
    if (!decision.ok) throw retryError(decision.reason);
    const view = this.job(row);
    try {
      const body = await runWithCreatorAccess({
        kind: "scoped",
        role: "operator",
        accountId: session.accountId,
        username: session.username,
        opsView: true,
      }, () => this.deps.retry(id, {
        actorId: "server-owner",
        traceId: "admin-job-retry",
        idempotencyKey: input.idempotencyKey,
      }));
      await noteOperation({
        action: "确认重试生成任务",
        target: `${view.code} · ${view.typeLabel} · ${view.subject}`,
        result: "success",
        source: "管理后台 /admin/jobs",
        detail: "管理员确认后才重试。失败或结果未知不会自动重新发起调用。",
      });
      return { ok: true, job: view, result: body };
    } catch (error) {
      await noteOperation({
        action: "确认重试生成任务",
        target: `${view.code} · ${view.typeLabel} · ${view.subject}`,
        result: "failed",
        source: "管理后台 /admin/jobs",
        detail: "确认后的重试被拒绝，没有向服务商发起调用。",
      });
      if (error instanceof AdminDirectoryError) throw error;
      throw retryError("NOT_RETRYABLE");
    }
  }

  async users(session: DirectorySession, query: { q?: string; role?: string; status?: string }) {
    const q = (query.q ?? "").trim().toLowerCase();
    const creators = this.deps.creators ? await this.deps.creators.listManaged(this.deps.workspaceId, 100) : [];
    const items = [
      {
        id: "operator",
        displayName: "平台管理员",
        username: session.username,
        role: "operator" as const,
        roleLabel: "平台管理员",
        status: "ACTIVE" as const,
        statusLabel: "已启用",
        activityAt: null as string | null,
        activitySource: "unknown" as const,
        loginable: true,
        mutable: false,
      },
      ...creators.map((account) => ({
        id: account.id,
        displayName: account.username,
        username: account.username,
        role: "creator" as const,
        roleLabel: "创作者",
        status: account.status,
        statusLabel: account.status === "DISABLED" ? "已停用" : "已启用",
        activityAt: account.updatedAt,
        activitySource: "updated_at" as const,
        loginable: account.status === "ACTIVE",
        mutable: true,
      })),
    ].filter((item) => {
      if (q && !`${item.displayName} ${item.username}`.toLowerCase().includes(q)) return false;
      if (query.role && query.role !== "all" && item.role !== query.role) return false;
      if (query.status === "ACTIVE" || query.status === "DISABLED") return item.status === query.status;
      return true;
    });
    return {
      items,
      total: items.length,
      publicRegistrationEnabled: false,
      displayNamePersisted: false,
    };
  }

  async setUserStatus(id: string, input: { confirmed?: boolean; status?: string }) {
    if (input.confirmed !== true) throw new AdminDirectoryError(400, "STATUS_UNCONFIRMED", "还没有确认，没有调整账号状态。");
    if (id === "operator") throw new AdminDirectoryError(400, "STATUS_FORBIDDEN", "不能在此修改平台管理员。");
    if (input.status !== "ACTIVE" && input.status !== "DISABLED") throw new AdminDirectoryError(400, "STATUS_INVALID", "账号状态无效。");
    if (!this.deps.creators) throw new AdminDirectoryError(503, "NOT_READY", "创作者账号存储尚未就绪。");
    try {
      const account = await this.deps.creators.setStatus(this.deps.workspaceId, id, input.status);
      if (account.status === "DISABLED") this.deps.revokeSessions?.(account.id);
      await noteOperation({
        action: "调整用户状态",
        target: `${account.username} · 创作者 · ${account.status === "DISABLED" ? "已停用" : "已启用"}`,
        result: "success",
        source: "管理后台 /admin/users",
        detail: "只调整创作者的现有状态列。没有新增角色或工作区。",
      });
      return { id: account.id, username: account.username, status: account.status, role: "creator" as const };
    } catch (error) {
      if (error instanceof PersistenceError && error.code === "NOT_FOUND") {
        throw new AdminDirectoryError(404, "NOT_FOUND", RETRY_MESSAGES.NOT_FOUND!);
      }
      throw error;
    }
  }

  async logs(query: { q?: string; actor?: string; range?: string }, includeWorkAudit: boolean) {
    const [fileRecords, workRecords] = await Promise.all([
      this.deps.logs?.list() ?? [],
      includeWorkAudit ? this.deps.store.listAdminWorkLogs(this.deps.workspaceId) : [],
    ]);
    const records = [...fileRecords, ...workRecords.map(workAuditRecord)].sort((a, b) => b.at.localeCompare(a.at));
    if (!this.deps.logs && !records.length) return { storage: "unconfigured" as const, items: [], total: 0 };
    const q = (query.q ?? "").trim().toLowerCase();
    const range = query.range === "30d" || query.range === "all" ? query.range : "7d";
    const cutoff = range === "30d" ? Date.now() - 30 * 86_400_000 : range === "7d" ? Date.now() - 7 * 86_400_000 : 0;
    const items = records.filter((record) => {
      if (cutoff && Date.parse(record.at) < cutoff) return false;
      if (query.actor && query.actor !== "all" && record.actor !== query.actor) return false;
      if (q && !`${record.action} ${record.target}`.toLowerCase().includes(q)) return false;
      return true;
    });
    return {
      storage: "ready" as const,
      items,
      total: items.length,
      actors: [...new Set(records.map((record) => record.actor))],
    };
  }

  async logDetail(id: string, includeWorkAudit: boolean) {
    const record = await this.deps.logs?.get(id);
    if (record) return record;
    const workRecord = includeWorkAudit ? await this.deps.store.getAdminWorkLog(this.deps.workspaceId, id) : null;
    if (!workRecord) throw new AdminDirectoryError(404, "NOT_FOUND", RETRY_MESSAGES.NOT_FOUND!);
    return workAuditRecord(workRecord);
  }

  private work(row: WorkSignalRow) {
    const status = (["draft", "script_review", "storyboard", "producing", "finished", "unknown"].includes(row.productionStatus)
      ? row.productionStatus
      : deriveProductionStatus(row)) as ProductionStatus;
    const owner = ownerPresentation({ username: row.ownerUsername, status: row.ownerStatus });
    return {
      id: row.id,
      title: row.title,
      updatedAt: row.updatedAt,
      ownerName: owner.name,
      ownerLegacy: owner.legacy,
      ownerLoginable: owner.loginable,
      productionStatus: status,
      productionLabel: PRODUCTION_LABEL[status],
      episodeProgress: episodeProgress({ episodeCount: row.episodeCount, episodeNo: row.episodeNo, status }),
      recentTask: recentTaskLabel({
        type: row.latestType,
        demo: row.latestDemo,
        state: row.latestState,
        errorCode: row.latestError,
      }),
      reviewHref: `/admin/works/${row.id}/review`,
    };
  }

  private asset(row: AssetSignalRow) {
    const type = assetType(row.kind);
    const source = row.jobId && row.jobType
      ? `${jobTypeLabel(row.jobType, row.isDemo)} · ${shortJobCode(row.jobId)}`
      : "制作任务产出";
    return {
      id: row.id,
      name: assetName(row),
      type: type.code,
      typeLabel: type.label,
      projectId: row.projectId,
      projectTitle: row.projectTitle,
      updatedAt: row.createdAt,
      updatedFrom: "created_at" as const,
      sourceTask: source,
      mimeType: row.mimeType,
      contentHref: `/api/v1/admin/assets/${row.id}/content`,
    };
  }

  private job(row: JobSignalRow) {
    const status = jobDisplayStatus(row.state, row.errorCode);
    const type = row.jobType;
    return {
      id: row.id,
      code: row.code || shortJobCode(row.id),
      type,
      typeLabel: jobTypeLabel(type, row.isDemo),
      subject: workEpisodeLabel(row.projectTitle, row.episodeNo),
      projectTitle: row.projectTitle,
      episodeNo: row.episodeNo,
      updatedAt: row.updatedAt,
      status,
      statusLabel: JOB_STATUS_LABEL[status],
      action: jobAction(status),
      source: row.source,
    };
  }
}
