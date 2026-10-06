# V1 待授权与配置清单

本清单列出本轮代码已经准备好、但需要专项授权或外部配置才能验收的事项。未授权前，相关入口保持关闭或明确拒绝，现有数据库与站点行为不变。

## 1. 执行两份 SQL 草案

| 项目 | 内容 |
| --- | --- |
| SQL | `packages/database/prisma/drafts/20261005000100_qwen_web_writing.sql`（新表 `qwen_writing_request` 与 3 个索引）；`packages/database/prisma/drafts/20261005000200_character_reference_image.sql`（`asset` 增加 2 列、替换 `asset_approval_kind_check`、增加 2 个约束与 1 个唯一键，新表 `character_reference_selection`） |
| 第一步环境 | 新建、专用、可丢弃的 PostgreSQL 16 库：先 `runMigrations` 应用已有 5 个 migration，再执行草案。不得指向现有开发库、测试站点库或生产库 |
| 预计影响 | 千问草案只新增表与索引。参考图草案在 `asset` 上加可空列和约束；`ADD CONSTRAINT ... UNIQUE` 与外键会扫描并锁 `asset` 表，数据量大时需要维护窗口。已有 `asset` 行的两列为空，满足新约束 |
| 兼容 | 不执行时：千问路由 503、参考图接口 503、视频门保持 legacy。执行后：代码自动识别结构就绪；`M3_CHARACTER_REFERENCE_GATE` 仍默认 legacy，严格门需显式打开 |
| 验证命令 | `QWEN_WEB_DRAFT_SQL_AUTHORIZED=true CHARACTER_REFERENCE_DRAFT_SQL_AUTHORIZED=true DATABASE_URL=<隔离库> corepack pnpm --filter @ai-drama/database integration` |
| 正式使用 | 隔离库验证通过后，草案需转为正式 migration（新文件、经 Review 与 CI）再在目标库执行；不要直接对目标库执行草案文件 |

## 2. 千问网页调用（真实付费调用）

- 授权一次或若干次真实调用，指定预算上限。
- API 进程环境（只放进程环境，不写 `.env`、Git、日志）：`DASHSCOPE_API_KEY`、`BAILIAN_BASE_URL`（官方 `compatible-mode/v1` 地址）、可选 `QWEN_WEB_MODEL`；`QWEN_WEB_WRITING_ENABLED=true`；`QWEN_WEB_OPERATOR_TOKEN`（≥16 字符，交给操作者）。`NODE_ENV=production` 时入口强制关闭。
- 调用前确认：所选模型接受 `max_completion_tokens`；默认模型名在所选地域可用（见 [`PROVIDER_READINESS.md`](PROVIDER_READINESS.md)）。
- 验收：网页「检查工作区调用」→ 请求候选 → 预览 → 采纳到草稿 → 保存新版本；同 key 重放不再调用；结果 unknown 时不自动重发。

## 3. 角色参考图严格视频门

- 前提：第 1 项参考图草案已在目标库就绪。
- API：`M3_CHARACTER_REFERENCE_GATE=strict`；`M3_MOCK_IMAGE_ENABLED=true` 与绝对 `MOCK_OBJECT_DIR`（参考图仍是 Mock 图）。Worker 同样需要 `M3_MOCK_IMAGE_ENABLED`。
- 验收：生成 → 审核 → 选择 → 角色与分镜审核 → 视频成功；修改角色后参考图 STALE、视频被拒。

## 4. 真实媒体 Provider

需要负责人选定供应商并提供能力、接口、凭据、配额、费率与许可资料，见 [`PROVIDER_READINESS.md`](PROVIDER_READINESS.md)。本轮没有选择或开通任何服务。

## 5. FFmpeg 分发许可

在部署服务器运行 `node scripts/ffmpeg-sbom.mjs --output ffmpeg-sbom.json`，交法务对外部库与依赖包 copyright 逐项复核。

## 6. 测试站点部署

本机没有 `drama.playhubs.cn` 的连接配置。PR 合并后，由有服务器权限的 Agent 部署精确的 main SHA，步骤见 PR #48 描述。上述草案未执行时部署是兼容的：新入口全部关闭或返回 503，视频门为 legacy。
