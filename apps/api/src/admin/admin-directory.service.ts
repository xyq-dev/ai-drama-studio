import {
  PersistenceError,
  type AdminOpsStore,
  type AssetSignalRow,
  type CreatorAccountStore,
  type JobSignalRow,
  type WorkSignalRow,
} from "@ai-drama/database";
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
  jobType,
  JOB_STATUS_LABEL,
  JOB_TYPE_LABEL,
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

export class AdminDirectoryService {
  constructor(private readonly deps: {
    store: AdminOpsStore;
    creators: CreatorAccountStore | null;
    workspaceId: string;
    logs: OperationLogStore | null;
    retry: (jobId: string, context: StudioContext) => Promise<unknown>;
    readContent: (assetId: string) => Promise<{ mimeType: string; bytes: Buffer }>;
  }) {}

  async works(query: { q?: string; status?: string; owner?: string; cursor?: string; limit?: number }) {
    const page = await this.deps.store.listWorks(this.deps.workspaceId, query);
    const legacy = page.items.some((item) => ownerPresentation({ username: item.ownerUsername, status: item.ownerStatus }).legacy);
    return {
      items: page.items.map((item) => this.work(item)),
      total: page.total,
      nextCursor: page.nextCursor,
      owners: [
        ...page.owners.map((owner) => ({ id: owner.id, name: owner.username, legacy: false })),
        ...(legacy ? [{ id: "legacy", name: "历史作品", legacy: true }] : []),
      ],
    };
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

  async logs(query: { q?: string; actor?: string; range?: string }) {
    if (!this.deps.logs) return { storage: "unconfigured" as const, items: [], total: 0 };
    const records = await this.deps.logs.list();
    const q = (query.q ?? "").trim().toLowerCase();
    const range = query.range && query.range !== "all" ? query.range : "7d";
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

  async logDetail(id: string) {
    if (!this.deps.logs) throw new AdminDirectoryError(503, "LOG_UNCONFIGURED", "操作日志存储尚未就绪。");
    const record = await this.deps.logs.get(id);
    if (!record) throw new AdminDirectoryError(404, "NOT_FOUND", RETRY_MESSAGES.NOT_FOUND!);
    return record;
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
        kind: row.latestKind,
        source: row.latestSource,
        state: row.latestState,
        errorCode: row.latestError,
      }),
      reviewHref: `/admin/works/${row.id}/review`,
    };
  }

  private asset(row: AssetSignalRow) {
    const type = assetType(row.kind);
    const source = row.jobKind
      ? `${JOB_TYPE_LABEL[jobType(row.jobKind, "generation")]} · ${row.jobId ? shortJobCode(row.jobId) : ""}`.trim()
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
    const type = jobType(row.kind, row.source);
    return {
      id: row.id,
      code: row.code || shortJobCode(row.id),
      type,
      typeLabel: JOB_TYPE_LABEL[type],
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
