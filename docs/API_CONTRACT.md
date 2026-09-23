# V1 API 合约

## 通用约定

前缀为 `/api/v1`，JSON 使用 UTC ISO-8601 时间、ULID/UUID 字符串和显式分页 cursor。所有写入要求登录；V1 使用单工作区上下文，但服务端仍从认证主体确定 `workspaceId`，不信任客户端传入的工作区。创建异步工作返回 `202 { workflowRun, jobs[] }`。所有要求 `Idempotency-Key` 的写入由通用 IdempotencyRecord 以 `(workspaceId, actorId, httpMethod, routeKey, key)` 保存：同 key 与同规范化 request hash 返回原始 response，不同 hash 返回 `IDEMPOTENCY_KEY_REUSED`；记录与业务写入使用同事务占位/完成协议。GenerationJob inputHash 不承担 API 幂等。编辑带 `If-Match: aggregate-etag`，冲突返回 `REVISION_CONFLICT`。

错误体：`{ error: { code, message, traceId, details? } }`。所有端点可能有 `UNAUTHENTICATED`、`FORBIDDEN`、`NOT_FOUND`、`VALIDATION_ERROR`、`RATE_LIMITED`；下表仅列模块特有错误。权限中的 Owner 是当前单工作区操作者；未来成员模型加入前不推断角色权限。

## Projects

| Method / Path | 用途、输入、输出 | 权限 / 幂等 / 特有错误 |
| --- | --- | --- |
| `POST /projects` | 创建 `{title,premise}`；返回 Project | Owner；key 必需；`PROJECT_LIMIT_REACHED` |
| `GET /projects` | cursor 分页项目摘要；返回 items/page | Owner；安全 GET；无 |
| `GET /projects/:projectId` | 项目与当前版本指针 | Owner；安全 GET；`PROJECT_ARCHIVED` |
| `PATCH /projects/:projectId` | 更新非版本元数据；返回 Project | Owner；If-Match；`REVISION_CONFLICT` |
| `POST /projects/:projectId/archive` | 软归档；返回 Project | Owner；key 必需；`PROJECT_ACTIVE_JOBS` |

## Stories, Episodes, Scripts

| Method / Path | 用途、输入、输出 | 权限 / 幂等 / 特有错误 |
| --- | --- | --- |
| `POST /projects/:projectId/stories` | 创建故事修订 `{content}`；返回 StoryRevision | Owner；key；`INVALID_STORY` |
| `POST /projects/:projectId/stories/generate` | 从创意生成故事 job；返回 accepted workflow | Owner；key；`PROVIDER_UNAVAILABLE` |
| `GET /projects/:projectId/episodes` | 返回固定三集及当前剧本摘要 | Owner；安全 GET；无 |
| `GET /episodes/:episodeId` | 集、场景、当前剧本指针 | Owner；安全 GET；`EPISODE_NOT_FOUND` |
| `POST /episodes/:episodeId/scripts` | 创建剧本修订 `{content,storyRevisionId}` | Owner；key；`SOURCE_STORY_REQUIRED` |
| `POST /episodes/:episodeId/scripts/generate` | 生成剧本；返回 accepted workflow | Owner；key；`SOURCE_STORY_REQUIRED` |
| `POST /script-revisions/:id/review` | 审核剧本版本 | Owner；key；`REVIEW_CONFLICT` |

## Characters, Scenes, Shots

| Method / Path | 用途、输入、输出 | 权限 / 幂等 / 特有错误 |
| --- | --- | --- |
| `POST /projects/:projectId/characters/extract` | 从批准剧本提取角色；返回 workflow | Owner；key；`SCRIPT_REVIEW_REQUIRED` |
| `POST /characters` | 创建稳定角色与首个 revision | Owner；key；`DUPLICATE_CHARACTER_NAME` |
| `POST /characters/:characterId/revisions` | 新角色设定 `{appearance,persona,voice,...}` | Owner；key；`INVALID_CHARACTER_REFERENCE` |
| `POST /character-revisions/:id/reference-images/generate` | 生成角色参考图工作流；只要求来源剧本已审核、revision 非 STALE 和输入有效 | Owner；key；`SCRIPT_REVIEW_REQUIRED`,`SOURCE_STALE` |
| `POST /character-revisions/:id/review` | 审核角色版本及参考图 | Owner；key；`REVIEW_CONFLICT` |
| `GET /episodes/:episodeId/scenes` | 获取场景和排序 | Owner；安全 GET；无 |
| `POST /episodes/:episodeId/scenes/generate` | 由剧本生成场景/镜头草稿 | Owner；key；`SCRIPT_REVIEW_REQUIRED` |
| `POST /scenes/:sceneId/revisions` | 创建场景结构/排序 revision；返回新有效快照 | Owner；key、If-Match；`SCENE_HAS_ACTIVE_JOB` |
| `GET /scenes/:sceneId/shots` | 返回镜头与当前 revision | Owner；安全 GET；无 |
| `POST /shots/:shotId/revisions` | 创建镜头修订 `{duration,camera,action,dialogue,...}` | Owner；key；`INVALID_SOURCE_REFERENCE` |
| `POST /shot-revisions/:id/review` | 审核镜头分镜版本 | Owner；key；`REVIEW_CONFLICT` |
| `POST /shot-revisions/:id/generate-image` | 图像生成 workflow | Owner；key；`SOURCE_STALE` |
| `POST /shot-revisions/:id/generate-video` | 视频生成 workflow | Owner；key；`REVIEW_REQUIRED`,`SOURCE_STALE` |

## Assets, Generation Jobs, Workflow Runs

| Method / Path | 用途、输入、输出 | 权限 / 幂等 / 特有错误 |
| --- | --- | --- |
| `POST /assets/uploads` | 创建 `{projectId,assetType,mimeType,byteSize,contentHash?}` UploadSession；返回 uploadSession 与短期预签名上传 URL，不创建 Asset | Owner；key；`UNSUPPORTED_MEDIA`,`UPLOAD_LIMIT` |
| `POST /asset-upload-sessions/:uploadSessionId/complete` | HEAD/读取临时对象，校验 MIME、大小、SHA-256 与权限；事务创建最终 Asset 并将会话标为 COMPLETED；重复完成返回同一 Asset | Owner；key；`OBJECT_HASH_MISMATCH`,`UPLOAD_SESSION_EXPIRED` |
| `GET /assets/:assetId` | 获取元数据和授权下载 URL | Owner；安全 GET；`ASSET_UNAVAILABLE` |
| `GET /projects/:projectId/assets` | 按 kind/status/source 分页 | Owner；安全 GET；无 |
| `GET /generation-jobs/:jobId` | job、当前 attempt、错误摘要 | Owner；安全 GET；无 |
| `POST /generation-jobs/:jobId/cancel` | 请求取消；返回当前 job | Owner；key；`JOB_TERMINAL` |
| `POST /generation-jobs/:jobId/retry` | 仅对可重试 `FAILED`/`CANCELED` job 创建新的局部 WorkflowRun 与新的 GenerationJob；复制不可变输入快照，不修改旧 Job | Owner；key；`JOB_NOT_RETRYABLE`,`RETRY_LIMIT` |
| `GET /workflow-runs/:runId` | 工作流及子 job 摘要 | Owner；安全 GET；无 |
| `GET /projects/:projectId/workflow-runs` | 分页运行历史 | Owner；安全 GET；无 |

## Providers and Exports

| Method / Path | 用途、输入、输出 | 权限 / 幂等 / 特有错误 |
| --- | --- | --- |
| `GET /providers/capabilities` | 仅返回允许给当前工作区的能力/参数 schema | Owner；安全 GET；无 |
| `POST /provider-callbacks/:providerKey` | Provider 回调事件；验签后写入按 normalized event key 去重的 ProviderEvent；返回 204 | Provider signature；`INVALID_SIGNATURE`,`UNKNOWN_PROVIDER_REQUEST` |
| `POST /episodes/:episodeId/compose` | 合成当前有效镜头、音频、字幕；返回 workflow | Owner；key；`SOURCE_STALE`,`REVIEW_REQUIRED` |
| `POST /projects/:projectId/exports` | 创建全剧/单集 MP4 导出；返回 workflow | Owner；key；`EXPORT_INPUT_INVALID` |
| `GET /exports/:assetId` | 获取导出元数据与下载 URL | Owner；安全 GET；`EXPORT_NOT_READY` |

## SSE

`GET /events` 是认证 SSE，唯一读取已提交的 DomainEvent，支持 `Last-Event-ID`。DomainEvent 以可排序 id 作为 cursor；客户端须按 `eventId` 去重，断线后在保留窗口内重连重放。若 cursor 已过 `retention_until`，服务端返回 `EVENT_CURSOR_EXPIRED`，客户端重新 GET 资源并轮询。所有事件 `{eventId, occurredAt, traceId, data}`：

| 事件 | data 最小字段 |
| --- | --- |
| `job.queued` | `jobId, workflowRunId, kind, state` |
| `job.started` | `jobId, attemptId, state` |
| `job.progress` | `jobId, progress(0..100), stage?` |
| `job.waiting_external` | `jobId, providerRequestId, nextPollAt` |
| `job.succeeded` | `jobId, outputAssetIds, cost?` |
| `job.failed` | `jobId, error:{code,message}, retryable` |
| `job.canceled` | `jobId, canceledAt` |
| `asset.created` | `assetId, projectId, kind, sourceJobId` |
| `workflow.updated` | `workflowRunId, status, completedJobs, failedJobs` |

## 审查后资源并发、审核与缺失端点（本节优先）

所有 revision 创建端点创建新不可变行，绝不 `PATCH` revision 内容。下列端点统一要求 Owner、`Idempotency-Key`，并在切换当前指针或改变审核状态时要求 `If-Match: aggregate-etag`；成功响应返回新 aggregate ETag，冲突为 `REVISION_CONFLICT`：

| Method / Path | 契约 | 特有错误 |
| --- | --- | --- |
| `POST /projects/:projectId/story-revisions/:revisionId/set-current` | 将已存在故事版本设为当前，并事务性触发依赖重算 | `SOURCE_STALE`, `REVIEW_REQUIRED` |
| `POST /episodes/:episodeId/script-revisions/:revisionId/set-current` | 将已存在剧本版本设为当前 | `SOURCE_STALE`, `REVIEW_REQUIRED` |
| `POST /characters/:characterId/revisions/:revisionId/set-current` | 将角色版本设为当前 | `SOURCE_STALE` |
| `POST /scenes/:sceneId/revisions/:revisionId/set-current` | 将场景版本设为当前 | `SOURCE_STALE` |
| `POST /shots/:shotId/revisions/:revisionId/set-current` | 将镜头版本设为当前 | `SOURCE_STALE` |
| `POST /assets/:assetId/review` | `{decision: APPROVE|REJECT, note}`；成片 Asset 才允许批准 | `NOT_FINAL_CUT`, `REVIEW_CONFLICT` |
| `GET /projects/:projectId/stale` | cursor 分页，过滤 `entityType, reason, rootRevisionId`，返回 stale 依赖链及传播是否完成 | 无 |
| `POST /workflow-runs/:runId/cancel` | 取消尚未开始 job，并请求运行中 job 协作取消；不回滚完成结果 | `RUN_TERMINAL` |
| `GET /provider-configurations` | 返回已脱敏配置摘要与能力/启用状态 | 无 |
| `POST /provider-configurations` | 创建 provider、能力策略和 secret 引用；永不接受/回显明文 key | `PROVIDER_CONFIG_INVALID` |
| `PATCH /provider-configurations/:id` | 变更启用、模型/超时/重试策略或 secret 引用 | `PROVIDER_CONFIG_IN_USE` |

`approve` 不是 `review` 的第二条路由；最终实现只保留上述 `review` 端点。审核元数据唯一权威为 `review_status(DRAFT|APPROVED|REJECTED), reviewed_by, reviewed_at, review_note, reviewed_content_hash`，并在审核事务中写入 DomainEvent；审核不改写内容，历史审核事件不删除。上游依赖变化可使对象 `STALE` 并失去当前可用批准资格，但不会伪造或覆盖历史 reviewer/reviewedAt。未批准剧本不得生成角色/场景；视频前角色及其选定参考图和 ShotRevision 均须批准；未批准最终合成 Asset 不得创建 export。

列表端点使用稳定 cursor，默认 `createdAt DESC`，允许白名单 `sort`，并对 `status, assetType, provider, episodeId, shotId, workflowRunId, createdAt` 使用显式过滤；不得接受任意字段/SQL 排序。所有异步创建、取消、retry、上传完成和当前版本切换端点均由 IdempotencyRecord 幂等；普通元数据 PATCH 以 aggregate ETag 防止覆盖。
