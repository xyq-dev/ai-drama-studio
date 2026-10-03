# M3 下一轮：镜头 Mock 图片工作台

执行：Cursor，Grok 4.7 High Fast。方案与最终审查：Codex。

## 起点与目标

代码起点是 `3b349627c42b7dda26e412b18cf208417b874e92`，来自 `feat/m2-creator-ui`，包括已通过真实核心文本闭环的 M2 工作台。下一轮在 `feat/m3-image-workbench` 实现：**当前且已批准的镜头 → 生成 Mock 图片 → 查询真实任务 → Asset 列表 → 实际 PNG 预览**。

M3-A 模型/契约和 M3-B 图片后端已存在，不重复实现。设计文档的 M3-C 视频/音频/字幕/音乐、M3-D ComfyUI 留在之后。本轮不启用真实模型、GPU、付费 API 或生产 Mock。

## 已核对的现状

1. `POST /api/v1/shot-revisions/:revisionId/generate-image` 接受 `{seed?: string}` 和 Idempotency-Key。服务端校验当前、APPROVED、CURRENT 的镜头、上游来源及 STALE 重算门禁。
2. PostgreSQL outbox、BullMQ 和 Worker 的 MEDIA_IMAGE 路由已经接通，有重复投递及租约恢复测试。`mock-image-generation.ts` 顶部“尚未接队列”的注释过时。
3. 当前实际执行路径仅为同步成功的确定性 Mock，输出 1×1 PNG fixture。seed 进入快照/哈希，不保证画面随 seed 改变。异步 Adapter 契约不等于已完成真实异步媒体流程。
4. 文件存于显式配置的 LocalMockObjects 目录，Asset.storageProvider 为 `mock-object-store`。图片文件并未写到 MinIO；现有 MinIO readiness 不等于图片已落 S3。
5. `GET /api/v1/shot-revisions/:revisionId/assets` 已有，但公开 DTO 缺 status、reviewStatus、width、height、byteSize、storageProvider 和完整来源信息。数据库已有相应字段，不需要新 Migration。
6. 当前 JobView 未公开 sourceShotRevisionId，不能仅凭 MEDIA_IMAGE 类型把任务归到当前镜头。
7. 没有 PNG 内容、下载或签名 URL API。前端不能把 objectKey/本地路径拼成可用图片地址。
8. workspace:provision 只建 Workspace。现有集成测试手动插入 mock-media/image.generate Provider；开发环境需要明确初始化流程。
9. 现有 MEDIA_IMAGE 手工 retry 返回 JOB_NOT_RETRYABLE；本轮不开放媒体 retry。IMAGE Asset 的审核状态为 DRAFT，目前数据库只允许 COMPOSITE 被批准；本轮展示实际状态，不新增图片审核流程。

## 实现顺序

### 1. 图片资产与任务查询契约

- 对现有 Asset DTO 增补数据库已有的 status、reviewStatus、storageProvider、byteSize、width/height（允许 null）、sourceJobAttemptId、sourceGenerationJobId；保留既有字段，避免破坏旧调用。
- 给 JobView/查询增补 nullable sourceShotRevisionId。所有列表和 job 查询保持服务端 Workspace 与 Project 过滤，不返回环境凭据或原始 Provider 敏感数据。
- 使用实际 Asset status。ACTIVE 不代表 APPROVED，不把旧图默认写成可用或已通过。
- 如果新增字段需要读取更多 SQL 列，同时检查 Asset INSERT RETURNING 与列表映射的一致性。

### 2. 同源 PNG 内容读取

新增 `GET /api/v1/assets/:assetId/content`，范围仅是已入库的本地 Mock IMAGE：

- 只接收 Asset UUID；服务端从固定 Workspace 下的 Asset 记录确定 Project、storageProvider、objectKey、checksum、byteSize。跨 Workspace 或不存在的 Asset 返回 404。
- 仅允许非 production、明确启用 Mock 图片且配置了绝对 MOCK_OBJECT_DIR 的环境；API/Worker 使用同一个显式目录。保留当前生产保护。
- 仅处理 `mock-object-store`、IMAGE、image/png；禁止客户端传文件路径、objectKey、目录或 URL。
- 校验服务器保存的 key 符合既有 `mock-images/<projectId>/<jobId>/<64位hash>.png` 结构；对应段必须与 Asset.projectId、sourceGenerationJobId、checksumSha256 一致。验证解析后的真实路径位于配置根目录内，并拒绝越界或符号链接逃逸。不要暴露任意静态目录。
- 读取时检查文件大小、PNG 格式及 SHA-256 与 Asset 记录一致。缺失、损坏或不可读取时显式失败，不回退为占位假图，不在响应里泄露本地绝对路径。
- 返回 image/png、X-Content-Type-Options: nosniff、合适的私有缓存策略。旧 STALE/SUPERSEDED 图可按已有 Workspace 权限查看历史；DELETED/FAILED 不应显示为有效图片。
- 前端通过同源 `/api/v1/assets/<id>/content` 预览。不要直连文件系统或公开 MinIO bucket，也不要在 Web 中放存储凭据。

### 3. 显式开发配置初始化

- 增加开发用命令，例如 `pnpm --filter @ai-drama/database mock-media:provision`，从服务端配置读取精确 APP_WORKSPACE_ID。
- 要求非 production、M3_MOCK_IMAGE_ENABLED=true、绝对 MOCK_OBJECT_DIR、目标 Workspace 已 ACTIVE；显式 DATABASE_URL。只幂等创建/验证该 Workspace 的 `mock-media / image.generate` 配置，遇到不兼容既有配置应报错，不能覆盖其它 Provider 或静默启用真实 Provider。
- 不把 Provider 初始化自动塞进 API/Worker 启动或默认 workspace:provision。命令不得建/重置 schema 或执行 Migration。
- 在 `.env.example` 解释默认关闭的 M3_MOCK_IMAGE_ENABLED 和由用户设置的绝对 MOCK_OBJECT_DIR；页面不接收这些服务器配置值。

### 4. 镜头工作台图片区

- 继续现有工作台，在镜头区加入“生成 Mock 图片”、可选 seed 和图片列表，不重做创作界面。显式说明是确定性 1×1 Mock 测试图片。
- 生成仅绑定已加载且身份一致的当前 ShotRevision；当前指针、approved 指针、APPROVED 与 CURRENT 全部满足才可提交，来源不可用时显示原因。后端仍是最终门禁。
- 生成使用 Idempotency-Key；同一次请求的失败重试复用原 key，seed、revision 或请求内容变化使用新 key。提交中防止重复点击；202 只显示“已受理”，不能先显示生成成功或 Asset。
- MEDIA_IMAGE 单独加入媒体任务展示，标注准确镜头 revision，不把它当作 Mock 场景/镜头文本任务。取消依据现有 API 和合法状态。媒体手工 retry 目前不可用，隐藏/禁用重试并说明原因；用户显式再次生成才使用新幂等键。不新增错误的工作流状态机或顺带开放媒体 retry。
- 任务进入终态后重读对应 revision 的 Assets；终态停轮询，隐藏时暂停、恢复可见时重读。过期请求不得覆盖新镜头/新 revision；失败时保留正常的文本草稿和冲突基线。
- 显示真实 Asset 的状态、审核状态、尺寸、字节数、来源和生成时间。当前 revision 与历史 revision 分开读取；旧图保留可追溯，不能错归到新版本。预览读取失败应有明确错误。
- 图片操作、任务刷新和来源更新不得改写镜头正文、审核结果或历史 revision。保留 M2 在途输入、原始 If-Match、409 差异确认和明确 null 清空语义。
- 长哈希/来源在 390px 窄屏完整换行，桌面图片与版本区可读。

### 5. 文档与过期说明

更新 README 的当前功能及开发启动说明，修正 Worker 已接队列的过期注释。新增 `docs/M3_IMAGE_WORKBENCH_IMPLEMENTATION_REPORT.md`，区分模拟测试、真实 API/浏览器、原生服务与 Compose、Mock 本地对象与 MinIO。不将 fixture 称为真实 AI 图片。

## 验收条件

| 项目 | 必须验证的结果 |
| --- | --- |
| 正常闭环 | 已批准 CURRENT 镜头点击生成 → 实际 API 202 → Worker/job SUCCEEDED → Asset 入库 → 内容 API 200 → 浏览器图片完成解码 |
| 幂等 | 同 key/同请求只有一个 workflow/job/Asset；改变 seed 复用旧 key 得到既有幂等冲突；正常再次生成用新 key |
| 门禁 | DRAFT、STALE、旧批准 revision、上游不满足及重算 pending 均不能绕过；APPROVED 不等于 CURRENT |
| 镜头隔离 | 切换 A/B、迟到响应、失败读取、刷新和任务终态不串图/串来源、不覆盖草稿；其他镜头资产不变 |
| 历史 | 来源换版后旧资产按数据库实际状态显示；历史 PNG 仍可追溯，新批准 revision 生成独立新资产 |
| 预览范围 | 其它 Workspace/不存在 UUID、非法数据库 key、符号链接越界、错误 storageProvider、文件缺失/损坏等被拒绝；无本地路径泄露 |
| 配置 | 默认关闭和 production 保持禁用；开发初始化只作用于固定 Workspace 且可安全重跑 |
| 状态 | 成功/失败/取消状态依据查询，取消权限依据现有服务端规则；MEDIA_IMAGE 不出现可用重试按钮，显式重新生成使用新 key；终态停止轮询，隐藏暂停 |
| M2 回归 | 既有正文/版本/审核/草稿/409 测试仍通过；窄屏不横向溢出 |

添加必要的组件交互测试、API/文件读取边界测试、配置初始化测试及相关数据库隔离集成测试。不要用纯 class 字符串测试代替真实布局检查。

## 工具与 Git 约定

1. 在 `D:\Projects\ai-drama-studio` 核实工作区和已有修改。禁止 reset、clean、stash 或覆盖未提交内容；工作区干净时 fetch 后切换 `feat/m3-image-workbench`，跟踪同名远端分支。若与已有本地修改冲突，使用独立 worktree 保留原文件，不强行切换。
2. 分支应包含本执行单及祖先 `3b349627`。不要从 main 丢失 M2 UI 或重复合并 fsync 修复；原 fsync worktree 不改。
3. 使用 Node 24.21.0、pnpm 10.17.0，不能关闭 engine 校验。先针对改动执行相关 test/lint/typecheck，再运行 `pnpm verify`。如标准构建受环境限制，记录真实失败；替代 Webpack 通过不能写成标准 verify 通过。
4. 真实联调若使用新专用测试库，可在核验数据库归属后应用仓库既有迁移和 provision；不得重置已有库/生产库。不重复在 Windows 1809 安装失败的 Docker 上耗时，不把运行环境准备反复交给用户。单元/模拟通过与真实联调未执行分别报告。
5. 完成后选择性提交本轮代码、测试和文档，普通 push 到 `origin/feat/m3-image-workbench`；fetch 后核验远端 SHA。无需再次询问本轮 feature commit/push。不要推 main、force push、PR、merge、pack 或 deploy。
6. 返回 `M3_IMAGE_WORKBENCH_REPORT`：目录/分支/基线与最新 SHA、修改文件、功能完成项、每条实际测试命令与结果、真实浏览器/存储边界、未执行项的具体原因、GitHub commit 链接和远端核验。Codex 按提交 SHA 审查。

本执行单是方案准备；图片入口、内容 API 和初始化命令尚未实现或验证，不能记为已完成。
