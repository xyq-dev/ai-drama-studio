# M3 Mock 图片工作台真实验收报告

验收日期：2026-09-30（UTC）。执行：Codex。代码基线：`0eee7cc8e23bcc33ce29a152c68a483ebb76c93d`，对应 `feat/m3-image-workbench`。

## 结论

Mock 图片工作台核心真实闭环通过：浏览器提交 → API 202 → Redis/BullMQ/Worker 执行 → PostgreSQL Asset 入库 → 同源 PNG 解码。浏览器 11 项通过，文件/API 边界 15 项通过，另验证旧批准 revision 被拒绝且未新增任务。本轮没有修改业务源码。

这是 Linux 原生服务的验收，不能替代 Windows 或 Compose 验收；图片仍是固定 1×1 Mock fixture，视频、音频和真实 AI Provider 未包含在本轮范围。真实隐藏标签页完成任务的用例未执行，不能记为全项验收通过。

## 隔离环境与数据库

实际工作区：`/workspace/scratch/62f2be8edb46/ai-drama-m3-review`，精确 checkout 上述 SHA。原有工作区及 Windows 文件没有被覆盖。

| 服务 | 实际版本/方式 | 本地端口 |
| --- | --- | --- |
| Web | 精确基线，Next.js Webpack production build | 3400 |
| API / Worker | Node 24.21.0、pnpm 10.17.0 | 3401 / 3402 |
| PostgreSQL | Ubuntu PostgreSQL 16.15 | 55434 |
| Redis | Ubuntu Redis 7.0.15；不是 Compose 的 7.4 | 56381 |
| MinIO | 官方 RELEASE.2025-09-07T16-13-09Z 源码本机构建，版本戳 DEVELOPMENT | 59020 / 59021 |
| 边界 API | 其它 Workspace / 默认关闭 / production+开启标志 | 3403 / 3404 / 3405 |

MinIO 官方源码提交为 `07c3a429bfed433e49018cb0f78a52145d4bedeb`，使用 Go 1.24.13；完整来源与二进制校验值保存在证据中。没有用占位存储服务替代 MinIO。

新建专用库 `ai_drama_m3_e2e`。迁移前真实查询确认：127.0.0.1:55434、用户 `m3_e2e_app`、public 表数 0、全新专用 data directory。应用用户没有 superuser/createdb/createrole 权限。只在此库应用仓库已有 5 个 Migration；没有重置 schema、既有库或生产库。

已实际运行 `workspace:provision`，并建立第二 Workspace 做隔离检查。`mock-media:provision` 运行两次，返回同一个配置，库内仅主 Workspace 存在该 `mock-media/image.generate` 配置。没有新增 Migration，也没有启动时自动 provision。

验收期间 Web、API、Worker、MinIO 健康检查均为 200；API ready 的 postgres/redis/objectStorage、Worker ready 的 postgres/redis/queue 均为 ok。服务只绑定隔离本地环境。

## 真实操作与结果

通过真实 HTTP 创建并审核故事、第一集剧本、角色、场地、场景和镜头；没有用 SQL 写入成功任务、Asset 或审核状态。最终浏览器测试项目为 `acd6224c-e0ee-42bb-a26d-48c2ec756378`。

| 检查 | 实际结果 |
| --- | --- |
| 当前批准镜头门禁 | UI 可生成；DRAFT UI 禁用，真实 API 400 REVIEW_REQUIRED |
| 受理文案 | POST 202 后仅显示已受理，未把 202 当作生成成功 |
| Worker 和来源 | 3 个 MEDIA_IMAGE job、workflow 均 SUCCEEDED；各有第 1 次 attempt，Asset/job/attempt/revision 来源一致 |
| 同源预览 | `/api/v1/assets/<id>/content` 200；浏览器 img.decode 成功，naturalWidth/naturalHeight 为 1 |
| 幂等 | 同 key/同请求返回原 workflow/job，Asset 仍 1 个；同 key 改 seed 返回 409 IDEMPOTENCY_KEY_REUSED |
| 再次生成 | 新 key、新 job、新 Asset；未保存动作草稿仍保留，切换镜头返回也恢复草稿 |
| 保存和审核新版本 | 实际 UI 保存 revision 2、提交审核、通过，再生成独立新 Asset |
| 版本归属 | 旧 revision 的 2 个 Asset 均 STALE、仅在历史；当前 revision 的 1 个 Asset ACTIVE，审核仍为 DRAFT |
| 旧批准 revision | 真实 API 400 REVIEW_REQUIRED；任务数前后均为 3 |
| 媒体 retry / 终态轮询 | UI retry 不可用；真实 retry API 409 JOB_NOT_RETRYABLE；4.5 秒观察窗口内无新增自动 workflow 轮询 |
| 390px | document/body scrollWidth 均为 390；64 位 checksum 实际换为 2 行，无横向溢出 |

最终当前 revision：`f8da3708-c0dc-4598-9004-e1f6b0c11c92`；当前 Asset：`756f2cb5-a12b-4980-96a9-1eaf79f70e1b`。三份 PNG 均为 69 字节，实际 SHA-256 与记录一致。图片写入显式 LocalMockObjects；真实 MinIO bucket 前后均为 0 个对象。

浏览器记录 132 次真实 API/PNG 请求，未拦截 fetch 或伪造响应，`pageErrors=[]`。console 中预期 409/400 来自负例；两条首屏非 API 404 经真实 GET/CDP 复现，均为缺少 `favicon.ico`，仅影响标签图标，不属于 API/PNG 失败。

## 真实文件与 API 边界

15 项通过：合法历史 PNG、跨 Workspace、不存在 UUID、非法 UUID、文件缺失、同大小损坏、大于记录大小、超过 1 MiB、目录代替文件、符号链接逃逸、默认关闭的读取和生成、production 即使开启标志的读取和生成、媒体手工 retry。

负例返回既有 400/404/409 与对应错误码，响应未泄露 Mock 目录或本地绝对路径。文件负例只临时修改此隔离测试 Asset 的本地文件，均在 finally 恢复；结束后逐份重新核对文件大小和哈希。未修改 Asset 不可变来源字段或禁用数据库保护。

PNG IDAT/CRC 结构负例此前的单元测试与代码审查已通过；本轮真实损坏文件通常先被大小或哈希检查拒绝，不能声称每个解析器分支都由真实 API 逐一覆盖。

## 命令、构建与证据

隔离环境变量由私有文件注入，没有放入仓库或证据包。实际运行数据库 `migrate`、`workspace:provision`、`mock-media:provision`；最终 `schema_migration` 只读快照记录 5 个名称和校验值。

后端及其依赖构建 exit 0；Web 使用 `next build --webpack` exit 0。默认沙箱内的第一次 Webpack build 因子进程 TypeScript 配置输出解析失败；相同命令在允许本地服务的执行环境中通过，未修改源码或关闭 engine 校验。本轮未重跑标准 `pnpm verify`，不把替代构建写成 verify 通过；Cursor 在本代码基线报告的 verify 通过仍是此前记录。

真实验收脚本（Node 24.21.0 执行）：

- `setup-chain.cjs`：真实 API 创作与审核来源链。
- `browser-acceptance.cjs`：实际 Chrome 154.0.8037.92、UI/HTTP/Worker/PNG/390px 检查，exit 0。
- `content-boundaries.cjs`：15 项真实 API/文件边界及 MinIO 对象数，exit 0。
- `final-snapshot.cjs`：隔离库身份、5 个迁移、job/attempt/workflow/Asset 来源、旧版本门禁和最终 ready，exit 0。

最初两次浏览器脚本遇到 selector 选错，不是产品失败；修正后使用新建测试项目完成本轮。三个项目均由真实 API 建立，未重置测试数据，初次失败日志保留。最终快照脚本也曾使用错误的 Prisma 默认表名，已按本仓库 `schema_migration` 表修正；没有为脚本错误改数据库。

证据包包含结构化请求、边界响应、快照、4 张成功截图、运行日志和验收脚本。包名为 `M3_E2E_Evidence_0eee7cc8_2026-09-30.zip`；不包含环境凭据、数据库目录、依赖、服务二进制或应用发布包。

## 未执行与范围

- 真实隐藏期间完成后恢复：headless Chrome 实际换 tab 仍为 visible，没有模拟 visibility；既有组件模拟覆盖不替代此项。
- Windows NTFS、Docker/Compose、Redis 7.4。未重复安装 Windows 1809 上此前失败的 Docker Desktop。
- 所有 STALE 上游/重算 pending、故障恢复、取消及迟到请求组合；本轮真实门禁覆盖 DRAFT 和旧批准 revision，不能扩大为全部状态机验收。
- 会重置 schema 的数据库集成测试、所有三集剧本完整生成。当前链路用于第一集镜头图片验收。
- 真实 AI 图片、GPU、ComfyUI、商业/付费 Provider、视频、配音、字幕、音乐、合成、部署及媒体手工 retry 开放。

本轮只提交验收文档到既有 feature 分支，仅允许远端快进更新；不操作 main、force push、PR、merge、应用 pack 或 deploy。Migration：YES，仅上述已核验新建隔离库；没有新增迁移文件。
