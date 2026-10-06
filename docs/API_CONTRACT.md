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

M2 Mock 文本切片另提供 `POST /projects/:projectId/workflows/mock-scenes`（空 JSON、
`Idempotency-Key` 必需）。要求项目三集当前 Script 均已审核且 CURRENT；创建时冻结三集
Script revision 与 Episode 版本，返回 `202` 的 WorkflowRun/Job。Worker 在同一事务内
为每集创建一个来源精确的 Scene DRAFT 并完成 Job；Job attempt 的
`response_snapshot.sceneRevisionIds` 返回三个新修订 ID。来源改变时整批不落库且 Job 失败；
正常消费及恢复路径共用事务落库。Scene 工作流不直接生成 Shot；Scene 审核通过后由
`POST /projects/:projectId/workflows/mock-shots` 触发 Mock Shot 草稿生成。
若任一集已存在 current Scene ordinal 1，新 Job 以 `MOCK_SCENE_SLOT_OCCUPIED` 终态失败，
不覆盖已有草稿，也不会部分创建其他集 Scene。

M2 Mock Shot 切片提供 `POST /projects/:projectId/workflows/mock-shots`（空 JSON、
`Idempotency-Key` 必需）。每集须有 ordinal 1 的 current、approved、CURRENT Scene，
来源 Script 也须可用，且项目不能有待完成的 STALE 传播。入队事务冻结三集 Scene revision
与 Scene 版本；Worker 正常/恢复完成时重验来源并在一个事务中创建三集 Shot DRAFT 与
完成 Job，attempt 的 `response_snapshot.shotRevisionIds` 返回三个修订 ID。若 Scene
来源变化，整批失败；若当前 Shot ordinal 1 已占用，以 `MOCK_SHOT_SLOT_OCCUPIED`
终态失败且不覆盖已有 Shot。其他 Scene/Shot 仍按项目作用域文本 API 人工编辑与审核。

M2-C 文本切片采用项目作用域路径。下表中的 extract、reference-images、
旧的无项目作用域 Scenes/Shots 路由、generate、set-current 和媒体生成端点仍是规划合同，
尚未由该切片实现。
当前实现的创建请求要求 `Idempotency-Key` 和 `If-Match`（首版匹配 Project.version，
后续修订匹配角色/场地 rowVersion），`sourceScriptRevisionId` 必须指向本项目当前已审核剧本。
审核请求还要求 `expectedReviewVersion`；历史 GET 返回该实体全部修订，暂未分页。
Scene/Shot 文本切片也使用项目与所属 Episode/Scene 的完整路径：新 Scene 的
`If-Match` 匹配 Episode.rowVersion，新 Shot 匹配 Scene.rowVersion，后续修订匹配各自
rowVersion；Scene 来源剧本和 Shot 来源场景均要求当前、已审核、非 STALE。
四个文本 aggregate 集合 GET 接受可选 `limit`（默认 20，范围 1..100）和不透明
`cursor`，响应为 `{items,nextCursor}`，其中 `nextCursor:null` 表示结束。cursor 绑定
workspace、project 及完整 episode/scene scope。revision 历史保留 `items` 并增加
`aggregate:{entityId,projectId,episodeId?,sceneId?,rowVersion,currentRevisionId,approvedRevisionId}`。

| Method / Path | 用途、输入、输出 | 权限 / 幂等 / 特有错误 |
| --- | --- | --- |
| `POST /projects/:projectId/characters/extract` | 从批准剧本提取角色；返回 workflow | Owner；key；`SCRIPT_REVIEW_REQUIRED` |
| `POST /projects/:projectId/characters` | 创建角色首版 `{name,sourceScriptRevisionId,content}`；返回 entityId/revisionId | Owner；key、If-Match；`SCRIPT_REVIEW_REQUIRED`,`DUPLICATE_CHARACTER_NAME` |
| `GET /projects/:projectId/characters` | 当前未归档角色集合与当前 revision 摘要 | Owner；安全 GET；cursor 分页 |
| `POST /projects/:projectId/characters/:characterId/revisions` | 创建角色新修订 `{sourceScriptRevisionId,content}` | Owner；key、If-Match；`SCRIPT_REVIEW_REQUIRED`,`REVISION_CONFLICT` |
| `GET /projects/:projectId/characters/:characterId/revisions` | 查询修订历史及精确来源剧本 | Owner；安全 GET；无 |
| `POST /projects/:projectId/characters/:characterId/revisions/:revisionId/review` | `DRAFT → IN_REVIEW → APPROVED/REJECTED` | Owner；key、If-Match；`REVIEW_CONFLICT` |
| `POST /projects/:projectId/locations` | 创建场地首版 `{name,sourceScriptRevisionId,content}` | Owner；key、If-Match；`SCRIPT_REVIEW_REQUIRED` |
| `GET /projects/:projectId/locations` | 当前未归档场地集合与当前 revision 摘要 | Owner；安全 GET；cursor 分页 |
| `POST /projects/:projectId/locations/:locationId/revisions` | 创建场地新修订 `{sourceScriptRevisionId,content}` | Owner；key、If-Match；`REVISION_CONFLICT` |
| `GET /projects/:projectId/locations/:locationId/revisions` | 查询场地修订历史及来源 | Owner；安全 GET；无 |
| `POST /projects/:projectId/locations/:locationId/revisions/:revisionId/review` | 审核场地版本 | Owner；key、If-Match；`REVIEW_CONFLICT` |
| `POST /character-revisions/:id/reference-images/generate` | 生成角色参考图工作流；只要求来源剧本已审核、revision 非 STALE 和输入有效 | Owner；key；`SCRIPT_REVIEW_REQUIRED`,`SOURCE_STALE` |
| `POST /character-revisions/:id/review` | 规划：审核角色参考图（当前仅实现项目作用域文本审核路由） | Owner；key；`REVIEW_CONFLICT` |
| `POST /projects/:projectId/episodes/:episodeId/scenes` | 创建 Scene 首版 `{sourceScriptRevisionId,locationRevisionId?,ordinal,heading,timeOfDay?,summary}` | Owner；key、If-Match；`SCRIPT_REVIEW_REQUIRED` |
| `GET /projects/:projectId/episodes/:episodeId/scenes` | 当前未归档 Scene 集合，按 `(ordinal,id)` 排序 | Owner；安全 GET；cursor 分页 |
| `POST /projects/:projectId/episodes/:episodeId/scenes/:sceneId/revisions` | 创建 Scene 新修订，并失效旧版下游 | Owner；key、If-Match；`REVISION_CONFLICT` |
| `GET /projects/:projectId/episodes/:episodeId/scenes/:sceneId/revisions` | Scene 修订历史与精确来源 | Owner；安全 GET；无 |
| `POST /projects/:projectId/episodes/:episodeId/scenes/:sceneId/revisions/:revisionId/review` | 审核 Scene 文本版本 | Owner；key、If-Match；`REVIEW_CONFLICT` |
| `POST /projects/:projectId/episodes/:episodeId/scenes/:sceneId/shots` | 从已审核 Scene 创建 Shot 首版 | Owner；key、If-Match；`REVIEW_REQUIRED` |
| `GET /projects/:projectId/episodes/:episodeId/scenes/:sceneId/shots` | 当前未归档 Shot 集合，按 `(ordinal,id)` 排序 | Owner；安全 GET；cursor 分页 |
| `POST /projects/:projectId/episodes/:episodeId/scenes/:sceneId/shots/:shotId/revisions` | Shot 新修订并失效旧版素材 | Owner；key、If-Match；`REVISION_CONFLICT` |
| `GET /projects/:projectId/episodes/:episodeId/scenes/:sceneId/shots/:shotId/revisions` | Shot 修订历史与精确场景来源 | Owner；安全 GET；无 |
| `POST /projects/:projectId/episodes/:episodeId/scenes/:sceneId/shots/:shotId/revisions/:revisionId/review` | 审核 Shot 文本版本 | Owner；key、If-Match；`REVIEW_CONFLICT` |
| `GET /episodes/:episodeId/scenes` | 规划中的非项目作用域兼容路径；当前请使用上述项目作用域路径 | Owner；安全 GET；无 |
| `POST /episodes/:episodeId/scenes/generate` | 由剧本生成场景/镜头草稿 | Owner；key；`SCRIPT_REVIEW_REQUIRED` |
| `POST /scenes/:sceneId/revisions` | 创建场景结构/排序 revision；返回新有效快照 | Owner；key、If-Match；`SCENE_HAS_ACTIVE_JOB` |
| `GET /scenes/:sceneId/shots` | 规划中的非项目作用域兼容路径；当前请使用上述项目作用域路径 | Owner；安全 GET；无 |
| `POST /shots/:shotId/revisions` | 创建镜头修订 `{duration,camera,action,dialogue,...}` | Owner；key；`INVALID_SOURCE_REFERENCE` |
| `POST /shot-revisions/:id/review` | 审核镜头分镜版本 | Owner；key；`REVIEW_CONFLICT` |
| `POST /shot-revisions/:id/generate-image` | 图像生成 workflow | Owner；key；`SOURCE_STALE` |
| `POST /shot-revisions/:id/generate-video` | 视频生成 workflow | Owner；key；`REVIEW_REQUIRED`,`SOURCE_STALE` |
| `POST /shot-revisions/:revisionId/compose-preflight` | 同步单镜合成预检。请求仅 `{videoAssetId, audioAssetId?, musicAssetId?, subtitleAssetId?}`，缺失的可选项规范为 null。成功 `200`，`Cache-Control: private, no-store`，返回 `{schema:"m4.shot.compose.preflight.v1", manifest, inputHash, guards}`。不创建任务、资产、账本、outbox 或领域事件，不使用 IdempotencyRecord，也不执行 FFmpeg | Owner；无幂等结果缓存；`NOT_FOUND`,`REVIEW_REQUIRED`,`STALE_RECALCULATION_PENDING`,`COMPOSE_INPUT_INVALID`,`VALIDATION_ERROR`,`CONFIGURATION_ERROR` |
| `GET /projects/:projectId/episodes/:episodeId/compose-candidates` | 分页返回本集当前可用的已批准单镜成片。稳定顺序为场景序号、镜头序号、assetId。响应不含磁盘路径、objectKey 或凭据。`Cache-Control: private, no-store` | Owner；安全 GET；`NOT_FOUND`,`STALE_RECALCULATION_PENDING`,`VALIDATION_ERROR` |
| `POST /projects/:projectId/episodes/:episodeId/compose-preflight` | 同步集级多镜只读预检。请求仅 `{compositeAssetIds}`，顺序即编排顺序。成功 `200`，`Cache-Control: private, no-store`，返回 `{schema:"m4.episode.compose.preflight.v1", verification:"metadata", manifest, inputHash, guards}`。声明尚未执行多镜合成，不写 Job、Workflow、Attempt、Asset、成本、Outbox、DomainEvent、依赖边或 IdempotencyRecord，也不执行 FFmpeg | Owner；无幂等结果缓存；`NOT_FOUND`,`REVIEW_REQUIRED`,`STALE_RECALCULATION_PENDING`,`COMPOSE_INPUT_INVALID`,`VALIDATION_ERROR`,`CONFIGURATION_ERROR` |
| `POST /shot-revisions/:revisionId/compose` | 受理单镜本地合成。请求仅 `{videoAssetId, audioAssetId?, musicAssetId?, subtitleAssetId?, expectedInputHash}`。`202` 只表示任务受理。`expectedInputHash` 必须等于服务端刚生成的预检 hash。任务 kind 为 `MEDIA_COMPOSE`，不使用 Provider 配置。需要 `M4_LOCAL_COMPOSE_ENABLED`，production 强制关闭 | Owner；`Idempotency-Key`；`NOT_FOUND`,`REVIEW_REQUIRED`,`STALE_RECALCULATION_PENDING`,`COMPOSE_INPUT_INVALID`,`COMPOSE_INPUT_CHANGED`,`VALIDATION_ERROR`,`CONFIGURATION_ERROR`,`IDEMPOTENCY_KEY_REUSED` |
| `POST /assets/:assetId/review` | 审核本地 `COMPOSITE`。请求仅 `{decision:"APPROVE"\|"REJECT", note, contentHash}`。只允许 `DRAFT` 到 `APPROVED` 或 `REJECTED`。`contentHash` 必须等于正在预览的成片 checksum。不批准原始媒体，不自动发布 | Owner；`Idempotency-Key` 与 `If-Match`；`NOT_FOUND`,`REVIEW_INVALID_TRANSITION`,`REVIEW_CONFLICT`,`REVISION_CONFLICT`,`COMPOSE_CONTENT_HASH_MISMATCH`,`REVIEW_REQUIRED`,`STALE_RECALCULATION_PENDING`,`VALIDATION_ERROR`,`CONFIGURATION_ERROR` |

## Assets, Generation Jobs, Workflow Runs

| Method / Path | 用途、输入、输出 | 权限 / 幂等 / 特有错误 |
| --- | --- | --- |
| `POST /assets/uploads` | 创建 `{projectId,assetType,mimeType,byteSize,contentHash?}` UploadSession；返回 uploadSession 与短期预签名上传 URL，不创建 Asset | Owner；key；`UNSUPPORTED_MEDIA`,`UPLOAD_LIMIT` |
| `POST /asset-upload-sessions/:uploadSessionId/complete` | HEAD/读取临时对象，校验 MIME、大小、SHA-256 与权限；事务创建最终 Asset 并将会话标为 COMPLETED；重复完成返回同一 Asset | Owner；key；`OBJECT_HASH_MISMATCH`,`UPLOAD_SESSION_EXPIRED` |
| `GET /assets/:assetId` | 获取元数据和授权下载 URL | Owner；安全 GET；`ASSET_UNAVAILABLE` |
| `GET /projects/:projectId/assets` | 按 kind/status/source 分页 | Owner；安全 GET；无 |
| `GET /generation-jobs/:jobId` | job、当前 attempt、错误摘要 | Owner；安全 GET；无 |
| `POST /generation-jobs/:jobId/cancel` | 请求取消；返回当前 job | Owner；key；`JOB_TERMINAL` |
| `POST /generation-jobs/:jobId/retry` | 仅对可重试 `FAILED`/`CANCELED` job 创建新的局部 WorkflowRun 与新的 GenerationJob；复制不可变输入快照，不修改旧 Job。返回 `202 {workflowRunId, jobId, dispatchSeq, retry?}`；媒体规则见下方「Mock 媒体手工 retry」 | Owner；key；`JOB_NOT_RETRYABLE`,`RETRY_LIMIT`,`RETRY_LINEAGE_INVALID` |
| `GET /workflow-runs/:runId` | 工作流及子 job 摘要 | Owner；安全 GET；无 |
| `GET /projects/:projectId/workflow-runs` | 分页运行历史 | Owner；安全 GET；无 |

### Mock 媒体手工 retry

适用 `MEDIA_IMAGE`、`MEDIA_VIDEO`、`MEDIA_TTS`、`MEDIA_SUBTITLE`、`MEDIA_MUSIC`。`MEDIA_COMPOSE` 仍返回 `JOB_NOT_RETRYABLE`，须重新预检后提交。文本任务的 retry 规则不变。

- 可重试：`CANCELED`；`FAILED` 且错误码为 `MOCK_IMAGE_RUNTIME_FAILED`、`MOCK_AV_RUNTIME_FAILED`、`MOCK_SM_RUNTIME_FAILED` 或 `LEASE_EXPIRED`。`MOCK_REQUEST_UNKNOWN`、输出/配置/路由类错误、成功和非终态任务返回 `JOB_NOT_RETRYABLE`，`details.reason` 给出原因。
- 服务端在锁住源任务行的同一事务中重新检查：任务仍在固定 Mock 路由上（快照 schema、能力、来源镜头一致，已有 attempt 均为 `mock-media` 对应能力）；对应功能开关开启（关闭时 `CONFIGURATION_ERROR`）；原生成端点的镜头门槛（图片用预览门，其余用审核门，STALE 或重算中拒绝，`REVIEW_REQUIRED` / `STALE_RECALCULATION_PENDING`）；`mock-media` 配置仍启用（`PROVIDER_CONFIG_INVALID`）；视频、配音、字幕、音乐的已保存提示词或对白仍与快照 `sourceText/sourceHash` 一致。
- 新任务原样复制 `sourceShotRevisionId`、`inputSnapshot`（含 seed、`bypassCache`）与 `inputHash`。旧任务、旧 attempt 与旧成本不改；新任务按既有 Mock 机制另记成本。自动重试上限仍是新任务自己的 `max_attempts`。
- 每个源任务最多一个后继。已有后继时返回 `409 JOB_NOT_RETRYABLE`，`details: {retryJobId, rootJobId, manualRetryCount}`。同一 Idempotency-Key 重放仍返回首次创建的 `202` 结果。
- 一条链从初始任务起最多手工重试 2 次；第三次返回 `409 RETRY_LIMIT`，`details: {rootJobId, manualRetryCount, limit}`。
- 成功时 `retry: {sourceJobId, rootJobId, manualRetryCount}`，并追加两条 DomainEvent：源任务上的 `job.retried` 与新任务上的 `job.retry_of`。服务端用二者双向核对父任务与根任务；不一致时返回 `409 RETRY_LINEAGE_INVALID`。无需数据库结构变更。

### Mock 媒体输入复用

`generate-image`、`generate-video`、`generate-tts`、`generate-subtitle`、`generate-music` 的非显式请求（未设置 `bypassCache=true`）在通过原生成门槛后，先在同一事务内查找可复用结果：

- 身份：同一 workspace、project、`source_shot_revision_id`、任务类型与 `inputHash`（快照已含 schema、镜头修订、seed、来源文本哈希、能力和样片 fixture），且结果由当前仍启用的同能力 `mock-media` 配置产生。
- 资格：原任务 `SUCCEEDED`；资产 `ACTIVE`、类型匹配、`source_kind = PROVIDER`；对象内容按记录的大小与 SHA-256 读回成功。`STALE`、失败、取消、未知或损坏的结果不复用，按时间倒序最多检查 5 个候选，均不合格则照常建新任务。
- 命中：`200 {cache:"HIT", assetId, sourceJobId, sourceShotRevisionId, jobKind, inputHash, newCost:"none"}`，写入同一幂等记录，同 key 重放返回同一结果；不创建 WorkflowRun、Job、Attempt、outbox 或成本，不复制历史账本。
- `bypassCache=true` 永不复用并创建新任务；`POST /generation-jobs/:jobId/retry` 不经过复用。
- 并发：不同 key 的同输入请求各自独立判断；尚未完成的任务不会被当作可复用结果。

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
| `job.retried` | `jobId, retryJobId, workflowRunId, rootJobId, manualRetryCount`（仅媒体手工 retry） |
| `job.retry_of` | `jobId, sourceJobId, rootJobId, manualRetryCount`（仅媒体手工 retry） |
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
