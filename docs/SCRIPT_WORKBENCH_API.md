# 剧本工作台 V1

工作台复用 `story_revision`、`script_revision` 及原有审核、来源失效和制作门禁。它没有平行的剧本版本库。此版本的界面入口为 `/projects/:projectId/script`，接口统一在 `/api/v1` 下并沿用站点会话和 CSRF。

## 读写与版本

| 方法与路径 | 内容 |
| --- | --- |
| `GET /projects/:id/script-workbench` | `ScriptWorkbenchSnapshot`：作品、当前故事、故事历史、各集当前正文与历史 |
| `POST /projects/:id/script-workbench/plan` | `{plan: ScriptWorkbenchPlan}`；`If-Match` 为作品版本，必须有 `Idempotency-Key` |
| `POST /projects/:id/episodes/:eid/script-workbench` | `{script: ScriptWorkbenchScript,sourceStoryRevisionId}`；`If-Match` 为集版本，必须有 `Idempotency-Key` |
| `POST /projects/:id/stories/:rid/review` | 复用现有接口：`{to,expectedReviewVersion,reviewNote?}`；`If-Match` 为作品版本 |
| `POST /projects/:id/episodes/:eid/scripts/:rid/review` | 复用现有接口：同上，`If-Match` 为集版本 |

共享类型及估时函数位于 `packages/contracts/src/script-workbench.ts`。每次保存创建不可变的原生版本，返回 `revisionId/revisionNo/contentHash/rowVersion`。重复的保存幂等键重放原结果；同键改内容拒绝。快照在可重复读事务中返回，故事和每集历史各最多最近 100 个版本；版本记录中的“加载更早版本”复用 `GET /projects/:id/stories?cursor=...` 与 `GET /projects/:id/episodes/:eid/scripts?cursor=...`，每次继续加载最多 20 条。当前版本指针在最近 100 条之外时单独按作品、工作空间及集定位，不混入历史页改变游标。已删除稿件继续过滤；恢复仅使旧稿重新可读，不改当前或批准指针。

计划保存在 `story_revision.content_json.workbench`，包含 `schema: "script-workbench.v1"`、`plan`、`documentVersions`。`brief/synopsis/bible/outline` 分别编号，仅内容改变时递增。用户明确确认某个故事版本时，同时确认该不可变快照中显示的四个文档编号。保存新计划不会自动批准。批准前必须有题材、受众、制作边界、梗概、结局、角色定妆声线以及完整分集的开场、改变、交接。新计划版本继续触发原有来源失效规则。

正文保存在 `script_revision.content_json.workbench.script`，角色始终使用稳定 ID。系统根据该正文 `source_story_revision_id` 绑定的不可变计划，将出场与对白 ID 投影为姓名，生成 `content_json.text` 供分镜及制作链使用。分镜与 ViMax 读取同一冻结计划，并严格验算正文；旧 v1 的 ID 正文仅在与原规范投影逐字一致时兼容解析为姓名，不改写历史行或哈希。缺少来源、未知角色、损坏结构及不一致正文仍拒绝。旧版纯文本保留；用户显式转换后才会创建结构化新版本。

## 连续性与审稿

- 从第 2 集起，保存时必须引用上一集当前、已批准、未删除且未失效的具体版本；`previousHandoff` 与该版集尾交接一致。
- 场次及动作/对白 ID 唯一；对白角色 ID 必须存在于系列圣经并列入本场出场角色。
- 时长估算按动作、对白、声音和停顿顺序相加。对白取“显式秒数”与“非空白字符数 ÷ 4”较大值。这是写作估算，不是实际成片长度；没有自动调用配音服务。
- 保存可以超时或超对白配额；批准时拒绝超额版本。正文定稿还要求场景/事件非空、动作声音停顿有秒数、连续性信息及人工审稿五项检查齐全。
- 正文审核仍遵循 `DRAFT → IN_REVIEW → APPROVED`。用户确认具体版本后才使用现有 `APPROVED + CURRENT` 制作门禁。
- 前集改稿会递归使引用其旧版本的后集失效，并复用现有 `staleFromScript` 使后集分镜、素材等失效；仅超出同步处理上限时创建后台失效续算任务。
- 系列模式继续遵守原有仅文本约束，不因新工作台开放媒体生产。

## 删除与恢复

| 方法与路径 | 内容 |
| --- | --- |
| `GET /projects/:id/script-workbench/deletion-preview` | 作品名称、集数、版本、引用数量及引用明细、是否可删除及原因 |
| `GET /projects/:id/episodes/:eid/scripts/:rid/deletion-preview` | 具体作品/集/版本与分镜、配音、视频、后集等引用 |
| `POST /projects/:id/script-workbench/trash` 或 `/restore` | `{expectedVersion}`，版本来自预览或回收站 |
| `POST /projects/:id/episodes/:eid/scripts/:rid/trash` 或 `/restore` | `{expectedVersion}`，使用集版本 |
| `GET /script-workbench/trash?cursor=...` | 每页最多 50 项，返回 `nextCursor` |

删除和恢复使用事务及 CAS；不自动重试版本冲突。网络结果不明时先刷新回收站/预览，避免把旧版本覆盖为新请求。稿件删除保持原始内容、编号和内容哈希；恢复为历史版本，不覆盖当前稿、不自动批准，用户可从历史取回内容另存草稿。任何仍被引用的稿件禁止删除。项目有活动任务时禁止删除；归档后新任务和新版本的数据库触发器在同一项目锁下拒绝创建。

## 迁移与验收边界

删除字段与归档保护触发器仅编写于 `packages/database/prisma/drafts/20261111000300_script_workbench_trash.sql`，未放入自动 Migration 目录。未执行生产 Migration。未更新数据库时，回收站明确返回 `WORKBENCH_UNAVAILABLE`，不会伪装成成功。

工作台核心验收配置：`packages/database/vitest.script-workbench-acceptance.config.ts`；回收站配置：`packages/database/vitest.script-workbench-trash-acceptance.config.ts`。两者均要求显式临时数据库名称、连接串、允许写入及允许草稿迁移标记，并拒绝使用业务数据库。运行记录以本次交付报告为准。
